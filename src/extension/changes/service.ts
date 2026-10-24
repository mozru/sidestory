// The branch's comparison, without a view of its own (docs/CHANGES-PLAN.md §4, §6, §7, §9.3, §9.6): browsing the
// merge diff is left to Git Tree Compare, GitLens and Source Control. This owns the comparison for the chosen
// repository (merge-base, file list, recomputed on git state), the read-only `sidestory-git:`/`sidestory-empty:`
// documents, merge diffs for steps (`diffContext`), coverage by the sidestories that belong, and what shows it:
// decorations on the real files, unexplained marks in diffs (§7.3) and the "This branch" rows of the Sidestories view.
// And the palette commands: Next/Previous Changed File and Unexplained Change from the active editor, the copied
// prompts, Mark as Trivial, Re-pin This Step and Set Base.
//
// No git work while nothing asks (§4.6): the comparison and coverage run only while a sidestory with a base is in the
// workspace, one is open, or a command needs them.
import * as vscode from 'vscode';
import { displayText, escapeIcons, plainForMessage } from '../../core/display-text.ts';
import type { ChangeCoverage } from '../../core/coverage.ts';
import { decodePair, oldToNew, type ChangeBlock } from '../../core/hunks.ts';
import { isValidBase, latchStep, resolveBase, storyBasesOf, type BaseSource, type StoryLatch } from './base.ts';
import { chooseRepository, Comparison, repoKey, sameRepo, type ComparisonState, type Snapshot } from './comparison.ts';
import { branchRows, changeKind, changeLabel, COVERAGE_COLORS, fileDecoration, isDone, type BranchProblem, type BranchRow, type CoverageMark } from './coverage-labels.ts';
import { CoverageService, type Belonging, type CoverageResult } from './coverage-service.ts';
import { apiPath, gitApi, refReader, relPath, type GitApi, type GitRepo } from './git-api.ts';
import { emptyUri, EMPTY_SCHEME, GitFileSystem, gitUri, GIT_SCHEME, parseGitUri, RepoIds } from './git-fs.ts';
import { baseName, comparePaths, short, step, type ChangeEntry } from './model.ts';
import { openTarget, type DiffContext } from './open.ts';
import { fileRanks, nextChange, type OpenChange } from './order.ts';
import { changePrompt, COPIED, explainBranchPrompt, updatePrompt } from './prompts.ts';
import { emptySideKey, gitSideKey, vscodeGitSideKey, type SideKey } from './targets.ts';
import { markTrivial } from './trivial.ts';
import type { SessionDiffs } from '../session.ts';
import { branchDiffersFromBase, PICKS_KEY, watchBranches } from './probe.ts';

const KEYS = {
  picks: PICKS_KEY,
  recent: 'sidestory.changes.recentBases',
  noSuggest: 'sidestory.changes.noExplainSuggestion',
} as const;
const MAX_PICKS = 50;
const MAX_RECENT = 10;
/** Coverage a command waits for at most. */
const COMMAND_WAIT_MS = 30_000;

const setContext = (key: string, value: unknown) => void vscode.commands.executeCommand('setContext', key, value);
const name = (s: string, max = 60) => displayText(s, max);
const config = () => vscode.workspace.getConfiguration('sidestory.changes');
const setting = () => config().get<string>('defaultBase')?.trim() || undefined;

/** A change of the comparison with its file. */
interface Found {
  path: string;
  entry: ChangeEntry;
  c: ChangeCoverage;
  b: ChangeBlock;
}

export interface ChangesHost {
  /** The workspace's sidestory folders (the index). */
  sidestoryDirs(): vscode.Uri[];
  /** Sidestories with a `base` in their manifest (the index), with their titles. */
  sidestoryBases(): { dir: vscode.Uri; title: string; base: string }[];
  /** Re-pins one anchor where its code is now (Re-pin This Step). */
  repin(dir: vscode.Uri, anchor: string): Promise<void>;
}

export class ChangesService implements vscode.Disposable {
  private readonly memento: vscode.Memento;
  readonly ids: RepoIds;
  readonly coverage: CoverageService;
  readonly decorations: CoverageDecorations;
  private readonly host: ChangesHost;
  private readonly subscriptions: vscode.Disposable[] = [];
  private api: GitApi | undefined;
  private initializing: Promise<void> = Promise.resolve();
  private comparison: Comparison | undefined;
  private comparisonSubs: vscode.Disposable[] = [];
  private apiSubs: vscode.Disposable[] = [];
  /** The probe's answer (§9.1): the branch has commits its default base doesn't, before any comparison ran. */
  private probed: boolean | undefined;
  private probeSeq = 0;
  private repoTimer: ReturnType<typeof setTimeout> | undefined;
  private commandTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * The base of a sidestory added on this branch (§11.4), latched: read only from a snapshot whose base didn't come
   * from a sidestory (compared with that sidestory's own base, its manifest may not look added), and kept while that
   * sidestory is in the index with that base and HEAD, the pick and the setting are unchanged.
   */
  private latch: StoryLatch | undefined;
  /** The last (head, pick, setting, base) a latch refreshed the comparison for: at most one refresh each. */
  private latchRefreshedFor: string | undefined;
  /** The snapshot coverage was last asked to run for (a command doesn't ask again while that run is pending). */
  private coverageAskedFor: Snapshot | undefined;
  /** Sessions holding this comparison (§11.4): the comparison doesn't follow the active editor into another repository meanwhile. */
  private readonly holders = new Set<string>();
  /** Whether another base a sidestory names resolves to another commit than the comparison's ("Use develop" row). */
  private readonly otherBases = new Map<string, 'pending' | 'differs' | 'same' | 'missing'>();
  private disposed = false;
  private readonly emitter = new vscode.EventEmitter<void>();
  /** The comparison or its coverage changed: the "This branch" rows and This File repaint. */
  readonly onDidChange = this.emitter.event;
  private readonly diffsEmitter = new vscode.EventEmitter<void>();
  /** Unexplained lines in diffs (§7.3), while the author's sidestory is open or the setting is on. */
  private readonly unexplainedType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderColor: new vscode.ThemeColor('sidestory.unexplainedBorder'),
    borderStyle: 'dotted',
    borderWidth: '0 0 0 3px',
    overviewRulerColor: new vscode.ThemeColor('sidestory.unexplainedBorder'),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });

  constructor(context: vscode.ExtensionContext, host: ChangesHost) {
    this.memento = context.workspaceState;
    this.host = host;
    this.ids = new RepoIds(context.globalState);
    this.coverage = new CoverageService({ snapshot: () => this.snapshot, order: () => this.openPaths(), sidestoryDirs: () => this.host.sidestoryDirs() });
    this.decorations = new CoverageDecorations(this);
    this.subscriptions.push(
      this.coverage,
      this.emitter,
      this.diffsEmitter,
      this.unexplainedType,
      this.decorations,
      this.coverage.onDidChange(() => {
        setContext('sidestory.changes.layer', !!this.result()?.belonging.length);
        this.paintUnexplained();
        this.decorations.update();
        this.diffsEmitter.fire();
        this.emitter.fire();
      }),
      GitFileSystem.register(this.ids),
      vscode.window.registerFileDecorationProvider(this.decorations),
      vscode.window.onDidChangeVisibleTextEditors(() => this.paintUnexplained()),
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.updateActiveFile();
        this.followRepo();
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        this.initializing = this.init();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('sidestory.changes.defaultBase') || e.affectsConfiguration('sidestory.changes.includeUncommitted')) {
          if (this.coverage.active) void this.comparison?.refresh(true);
          else this.comparison?.invalidate();
          void this.probe();
        }
        if (e.affectsConfiguration('sidestory.changes.suggestExplain')) this.emitter.fire();
        if (e.affectsConfiguration('sidestory.changes.markUnexplained')) this.paintUnexplained();
      }),
    );
    this.initializing = this.init();
    void this.probe();
    // The probe again when a HEAD or the uncommitted state moves (a new branch, a first commit after startup).
    void watchBranches(() => void this.probe()).then((d) => (this.disposed ? d.dispose() : this.subscriptions.push(d)));
  }

  // ---- who needs the comparison ----

  /** A sidestory with a base is in the workspace: compute the comparison and its coverage (decorations, This branch). */
  setWorkspaceWants(on: boolean): void {
    this.coverage.want('workspace', on);
    this.updateActive();
  }

  /**
   * The file list is computed while coverage is wanted, or while the probe says the branch has changes: a branch with
   * no sidestory yet needs it for Explain This Change, Mark as Trivial and the chords (the onboarding path).
   * Coverage itself still waits for a sidestory with a base or a command.
   */
  private updateActive(): void {
    if (this.comparison) this.comparison.active = this.coverage.active || !!this.probed;
  }

  /** Asks the probe again (a HEAD change, a setting): one merge-base per candidate base, no file list. */
  async probe(): Promise<void> {
    const mine = ++this.probeSeq;
    const answer = await branchDiffersFromBase(10_000, {
      pick: (root, branch) => this.picks().find(([k]) => k === `${this.ids.idOfPath(root)}\n${branch}`)?.[1],
    });
    if (mine !== this.probeSeq) return; // a newer probe started meanwhile
    const was = this.probed;
    this.probed = answer;
    this.updateActive();
    if (was !== this.probed) this.emitter.fire();
  }

  /** The probe's last answer: the branch has work of its own (full turns `sidestory.available` on with it). */
  get branchHasWork(): boolean {
    return !!this.probed;
  }

  /**
   * Multi-root: follows the active editor into another open repository (debounced). Not while a session holds this
   * comparison (an open sidestory of this repository): switching would take its diffs away; the session's repository
   * stays until its panels close.
   */
  private followRepo(): void {
    clearTimeout(this.repoTimer);
    this.repoTimer = setTimeout(() => {
      const api = this.api;
      const uri = vscode.window.activeTextEditor?.document.uri;
      if (!api || !uri || uri.scheme !== 'file' || this.holders.size) return;
      const repo = api.getRepository(uri);
      if (repo && !sameRepo(repo, this.comparison?.repo)) this.useRepo(repo);
    }, 500);
  }

  /**
   * The sidestories added on this branch (their manifest is added or renamed in, in the comparison), the first by
   * folder; and one that names another base than the comparison's (This branch offers to switch).
   */
  private storyBases(s: Snapshot): { first?: { dir: vscode.Uri; title: string; base: string }; other?: { title: string; base: string } } {
    const stories = this.host.sidestoryBases().flatMap((x) => {
      const folder = relPath(s.repo, x.dir);
      return folder ? [{ ...x, folder }] : [];
    });
    return storyBasesOf(stories, s.entries, s.base.spec, refReader(s.repo).remotes());
  }

  private branchOf(repo: GitRepo): string {
    const name = repo.state.HEAD?.name;
    return name && isValidBase(name) ? name : 'HEAD';
  }
  private pickOf(repo: GitRepo, branch = this.branchOf(repo)): string | undefined {
    return this.picks().find(([k]) => k === this.pickKey(repo, branch))?.[1];
  }

  /** The latched sidestory base while it still holds (the comparison's `sidestoryBase`). */
  private storyBase(repo: GitRepo): string | undefined {
    const l = this.latch;
    if (!l) return undefined;
    if (l.head !== repo.state.HEAD?.commit || l.pick !== this.pickOf(repo) || l.setting !== setting()) return undefined;
    return this.host.sidestoryBases().some((x) => x.dir.toString() === l.dir && x.base === l.base) ? l.base : undefined;
  }

  /**
   * Re-reads the sidestory base after the comparison or the index changed (§11.4). Never from a snapshot compared
   * with a sidestory's base, so the base can't toggle (a sidestory whose manifest already exists at its own base's
   * merge-base, a base naming the branch itself); and at most one refresh per (head, pick, setting, base).
   */
  private evaluateStoryBase(c: Comparison): void {
    const s = c.snapshot;
    if (!s) return;
    const first = s.base.source === 'sidestory' ? undefined : this.storyBases(s).first;
    const step = latchStep(
      this.latch,
      this.latchRefreshedFor,
      { source: s.base.source, head: s.head.sha },
      first && { dir: first.dir.toString(), title: first.title, base: first.base },
      { pick: this.pickOf(s.repo), setting: setting(), stillValid: this.storyBase(c.repo) !== undefined },
    );
    this.latch = step.latch;
    this.latchRefreshedFor = step.refreshedFor;
    if (step.refresh) void c.refresh();
  }

  /** The index changed: coverage again, and the sidestory base and "Use develop" row may have changed. */
  indexChanged(): void {
    this.scheduleCoverage();
    if (this.comparison) this.evaluateStoryBase(this.comparison);
    this.emitter.fire();
  }

  /** Coverage soon, noting the snapshot it is for. */
  private scheduleCoverage(delay?: number): void {
    this.coverageAskedFor = this.snapshot;
    this.coverage.schedule(delay);
  }

  // ---- the git API and the repository ----

  private async init(): Promise<void> {
    this.apiSubs.forEach((d) => d.dispose());
    this.apiSubs = [];
    const s = await gitApi();
    if (s.kind !== 'ok') {
      this.api = undefined;
      this.useRepo(undefined);
      if (s.kind === 'disabled' && s.ext) this.apiSubs.push(s.ext.onDidChangeEnablement(() => (this.initializing = this.init())));
      return;
    }
    this.api = s.api;
    this.apiSubs.push(
      s.ext.onDidChangeEnablement(() => (this.initializing = this.init())),
      s.api.onDidOpenRepository(() => this.pickRepo()),
      s.api.onDidCloseRepository((r) => {
        this.ids.forget(r);
        if (sameRepo(this.comparison?.repo, r)) this.useRepo(undefined);
        this.pickRepo();
      }),
      s.api.onDidChangeState(() => this.pickRepo()),
    );
    this.pickRepo();
  }

  private pickRepo(): void {
    const api = this.api;
    if (!api) return;
    // By root: every call and event of the git API hands out new wrapper objects. The same root keeps its comparison.
    if (this.comparison && api.repositories.some((r) => sameRepo(r, this.comparison?.repo))) return;
    this.useRepo(chooseRepository(api, undefined));
  }

  private useRepo(repo: GitRepo | undefined): void {
    this.comparisonSubs.forEach((d) => d.dispose());
    this.comparisonSubs = [];
    this.comparison = undefined;
    this.latch = undefined;
    this.latchRefreshedFor = undefined;
    this.coverageAskedFor = undefined;
    this.otherBases.clear();
    this.holders.clear(); // sessions that still belong say so again when they ask (diffsEmitter below)
    setContext('sidestory.changes.repo', !!repo);
    setContext('sidestory.changes.activeFileChanged', false);
    // The old repository's marks and rows go (repository closed, git turned off, another repository followed).
    this.coverage.clear();
    this.decorations.update();
    // Sessions ask again: their comparison is gone (or is another repository's now).
    this.diffsEmitter.fire();
    if (!repo) {
      this.emitter.fire();
      return;
    }
    const c = new Comparison(repo, {
      pick: (branch) => this.pickOf(repo, branch),
      mode: () => (config().get<boolean>('includeUncommitted', true) ? 'workingTree' : 'committed'),
      setting,
      sidestoryBase: () => this.storyBase(repo),
    });
    this.comparison = c;
    this.comparisonSubs.push(
      c,
      c.onDidChange(() => {
        // A sidestory added on the branch gives the base (§11.4): compare again when that changes.
        this.evaluateStoryBase(c);
        // Coverage for a new snapshot only: the same one (new details, git busy) keeps its run (onDidRecheck re-reads files).
        if (c.snapshot && c.snapshot !== this.coverageAskedFor) this.scheduleCoverage();
        this.updateActiveFile();
        this.diffsEmitter.fire();
        this.emitter.fire();
      }),
      // The same snapshot, but in working tree mode files may have changed on disk: coverage reads them again.
      c.onDidRecheck(() => {
        if (c.snapshot?.mode === 'workingTree' && this.coverage.active) this.scheduleCoverage();
      }),
    );
    this.updateActive();
  }

  /** The current comparison's files, recomputed first when stale (a command, a session asking). */
  async current(): Promise<Snapshot | undefined> {
    await this.initializing;
    const c = this.comparison;
    if (!c) return undefined;
    c.active = true;
    await c.settled();
    this.updateActive();
    return this.comparison === c ? c.snapshot : undefined;
  }

  get snapshot(): Snapshot | undefined {
    return this.comparison?.snapshot;
  }

  /** The coverage result for this snapshot's merge-base, if computed. */
  result(s: Snapshot | undefined = this.snapshot): CoverageResult | undefined {
    const r = this.coverage.result;
    return s && r && r.mergeBase === s.mergeBase ? r : undefined;
  }

  /** For a command: the comparison and its coverage, computed now (and kept computing from here on, §4.6). */
  private async withCoverage(): Promise<{ s: Snapshot; r: CoverageResult | undefined } | undefined> {
    // Wanted for a minute after the last command (repeated Next Unexplained stays quick), then let go.
    const wasActive = this.coverage.active;
    this.coverage.want('command', true);
    // Becoming wanted starts a run at once (for the snapshot there is, if any).
    if (!wasActive) this.coverageAskedFor = this.snapshot;
    clearTimeout(this.commandTimer);
    this.commandTimer = setTimeout(() => {
      this.coverage.want('command', false);
      this.updateActive();
    }, 60_000);
    this.updateActive();
    const first = await this.current();
    if (!first) return undefined;
    // Ready once a run for the live snapshot drained its queue (files skipped as unreadable or over budget included).
    // The live one: a status refresh may have replaced the snapshot since (a recompute that changes nothing keeps it).
    const ready = () => {
      const live = this.snapshot;
      return live && this.coverage.resultFor === live ? this.result(live) : undefined;
    };
    if (!ready()) {
      // Not again while a run for this snapshot is pending or in flight: that would run it twice.
      if (this.coverageAskedFor !== this.snapshot) this.scheduleCoverage(0);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, COMMAND_WAIT_MS);
        const sub = this.coverage.onDidChange(() => {
          if (ready()) done();
        });
        function done() {
          clearTimeout(timer);
          sub.dispose();
          resolve();
        }
      });
    }
    const s = this.snapshot ?? first;
    return { s, r: this.result(s) };
  }

  /** Paths of files open in editors: diffed first. */
  private openPaths(): string[] {
    const s = this.snapshot;
    if (!s) return [];
    return vscode.window.visibleTextEditors.map((e) => this.pathOf(e.document.uri)).filter((p): p is string => !!p);
  }

  // ---- remembered bases (Set Base…) ----

  private pickKey(repo: GitRepo, branch: string) {
    return `${this.ids.idOf(repo)}\n${branch}`;
  }
  private picks(): [string, string][] {
    const v = this.memento.get<unknown>(KEYS.picks);
    return Array.isArray(v) ? v.filter((x): x is [string, string] => Array.isArray(x) && typeof x[0] === 'string' && typeof x[1] === 'string') : [];
  }
  private async setPick(repo: GitRepo, branch: string, spec: string | undefined): Promise<void> {
    const key = this.pickKey(repo, branch);
    const rest = this.picks().filter(([k]) => k !== key);
    await this.memento.update(KEYS.picks, (spec ? [[key, spec], ...rest] : rest).slice(0, MAX_PICKS));
    if (spec) {
      const recent = (this.memento.get<string[]>(KEYS.recent) ?? []).filter((s) => typeof s === 'string' && s !== spec);
      await this.memento.update(KEYS.recent, [spec, ...recent].slice(0, MAX_RECENT));
    }
  }

  // ---- URIs and sides ----

  /**
   * A document as (repo path, side) in this comparison (§8), for what reads its lines: unexplained marks and session
   * cursor-follow. Keys never hold a commit: any commit of ours but the merge-base is the head side. Never the empty
   * side of an added or deleted file (its lines are nobody's); `locate` finds that one for commands.
   */
  keyOf(s: Snapshot, uri: vscode.Uri): SideKey | undefined {
    if (uri.scheme === 'file') {
      const p = relPath(s.repo, uri);
      return p ? { path: p, side: 'head' } : undefined;
    }
    // VS Code's own git documents (Source Control, Git Tree Compare): only at the merge-base, or HEAD in committed mode.
    if (uri.scheme === 'git') return vscodeGitSideKey(uri.query, (p) => relPath(s.repo, vscode.Uri.file(p)), s.mergeBase, s.mode === 'committed' ? s.head.sha : undefined);
    if (uri.scheme !== GIT_SCHEME) return undefined;
    return gitSideKey(parseGitUri(this.ids, uri), s, sameRepo);
  }

  /** Where a document is, for commands: `keyOf`, and the empty side of an added or deleted file as its other side. */
  locate(s: Snapshot, uri: vscode.Uri): SideKey | undefined {
    if (uri.scheme === EMPTY_SCHEME) return emptySideKey(uri.path.slice(1), s.entries);
    return this.keyOf(s, uri);
  }

  entryFor(s: Snapshot, k: SideKey): ChangeEntry | undefined {
    return k.side === 'head' ? s.entries.find((e) => e.path === k.path && e.status !== 'D') : s.entries.find((e) => (e.oldPath ?? e.path) === k.path && e.status !== 'A');
  }

  /** A document's head path in the current comparison: a file, either side of a diff (the left side of a rename names the new path). */
  pathOf(uri: vscode.Uri | undefined): string | undefined {
    const s = this.snapshot;
    if (!uri || !s) return undefined;
    if (uri.scheme === EMPTY_SCHEME) return uri.path.slice(1);
    const k = this.keyOf(s, uri);
    if (!k) return undefined;
    return k.side === 'head' ? k.path : (this.entryFor(s, k)?.path ?? k.path);
  }

  private fileUri(s: Snapshot, path: string): vscode.Uri {
    return vscode.Uri.joinPath(s.repo.rootUri, ...path.split('/'));
  }

  /** The two sides of a file's merge diff (§7.1): merge-base ↔ working tree file, or ↔ HEAD's blob. */
  diffUris(s: Snapshot, e: ChangeEntry): { left: vscode.Uri; right: vscode.Uri; title: string } {
    const left = e.status === 'A' ? emptyUri(e.path) : gitUri(this.ids, s.repo, s.mergeBase, e.oldPath ?? e.path);
    const right = e.status === 'D' ? emptyUri(e.path) : s.mode === 'workingTree' ? this.fileUri(s, e.path) : gitUri(this.ids, s.repo, s.head.sha, e.path);
    const what = s.mode === 'workingTree' ? 'working tree' : 'HEAD';
    const file = e.oldPath ? `${name(baseName(e.oldPath))} → ${name(baseName(e.path))}` : name(baseName(e.path));
    return { left, right, title: `${file} (${name(s.base.branch ?? s.base.label, 40)} ↔ ${what})` };
  }

  /** The URIs a decoration of a path shows on: the file, and the git sides of its diff. */
  urisOf(s: Snapshot, e: ChangeEntry): vscode.Uri[] {
    const out: vscode.Uri[] = [];
    try {
      // A deleted file too: Source Control lists deletions by their file URI.
      out.push(this.fileUri(s, e.path));
      const { left, right } = this.diffUris(s, e);
      if (left.scheme === GIT_SCHEME) out.push(left);
      if (right.scheme === GIT_SCHEME) out.push(right);
    } catch {
      // an unsafe path: nothing to decorate
    }
    return out;
  }

  // ---- what sessions use (§7, §8, §11.4) ----

  /** The comparison as steps need it: URIs, sides, entries, line maps. */
  diffContext(): DiffContext | undefined {
    const s = this.snapshot;
    if (!s) return undefined;
    return {
      snapshot: s,
      diffUris: (e) => this.diffUris(s, e),
      keyOf: (uri) => this.keyOf(s, uri),
      uriFor: (k) => {
        try {
          if (k.side === 'base') return gitUri(this.ids, s.repo, s.mergeBase, k.path);
          return s.mode === 'workingTree' ? this.fileUri(s, k.path) : gitUri(this.ids, s.repo, s.head.sha, k.path);
        } catch {
          return undefined; // an unsafe path
        }
      },
      entryFor: (k) => this.entryFor(s, k),
      lineMap: (p) => this.result(s)?.files.get(p)?.diff,
    };
  }

  /** For sessions of sidestories with a base (§11.4): the comparison when the base gives its merge-base. */
  readonly sessionDiffs: SessionDiffs = {
    context: async (base, who, dir) => {
      if (!isValidBase(base)) return undefined;
      // Wanted first: the comparison computes for this session from here on.
      this.coverage.want(who, true);
      const s = await this.current();
      // Only a sidestory of this comparison's repository (multi-root: another repository's sidestory opens as a file story).
      const inRepo = !!s && relPath(s.repo, dir) !== undefined;
      const own = s && inRepo ? await this.coverage.ownMergeBase(s, base) : undefined;
      if (!s || !inRepo || own !== this.snapshot?.mergeBase) {
        this.holders.delete(who);
        this.coverage.want(who, false);
        this.updateActive();
        return undefined;
      }
      this.holders.add(who);
      return this.diffContext();
    },
    release: (who) => {
      this.holders.delete(who);
      this.coverage.want(who, false);
      this.updateActive();
    },
    onDidChange: this.diffsEmitter.event,
  };

  /** A sidestory's own merge-base equals the comparison's (Re-anchor's base side, Pin's base-side reads). */
  async sameMergeBase(base: string | undefined): Promise<Snapshot | undefined> {
    if (!base || !isValidBase(base)) return undefined;
    const s = await this.current();
    if (!s) return undefined;
    return (await this.coverage.ownMergeBase(s, base)) === s.mergeBase ? s : undefined;
  }

  /**
   * Pin's base-side reads (§7.6): files of a sidestory under `root` at its base's merge-base, never from the working
   * tree. Undefined with a reason when there is no such comparison here.
   */
  async baseSide(root: vscode.Uri, base: string | undefined): Promise<{ read(file: string): Promise<string | undefined> } | { why: string }> {
    if (!base || !isValidBase(base)) return { why: 'its manifest has no valid "base"' };
    const s = await this.current();
    if (!s) return { why: 'no git comparison here' };
    const mb = await this.coverage.ownMergeBase(s, base);
    if (!mb) return { why: `its base “${name(base, 40)}” isn't found` };
    return {
      read: async (file) => {
        const p = relPath(s.repo, vscode.Uri.joinPath(root, ...file.split('/')));
        if (!p) return undefined;
        try {
          if ((await s.repo.getObjectDetails(mb, apiPath(s.repo, p))).size > 10_000_000) return undefined;
          const b = await s.repo.buffer(mb, apiPath(s.repo, p));
          return decodePair(b, b).old;
        } catch {
          return undefined;
        }
      },
    };
  }

  // ---- unexplained marks in diffs (§7.3) ----

  private paintUnexplained(): void {
    const s = this.snapshot;
    const r = this.result(s);
    const on = !!r?.belonging.length && (config().get<boolean>('markUnexplained', false) || this.coverage.wantedBySession);
    for (const ed of vscode.window.visibleTextEditors) {
      const key = on && s ? this.keyOf(s, ed.document.uri) : undefined;
      const ranges: vscode.Range[] = [];
      if (key && r && s) {
        const path = key.side === 'head' ? key.path : this.entryFor(s, key)?.path;
        const f = path ? r.files.get(path)?.coverage : undefined;
        const last = ed.document.lineCount - 1;
        for (const c of f?.changes ?? []) {
          if (isDone(c.state)) continue;
          for (const u of c.uncovered) if (u.side === key.side) ranges.push(new vscode.Range(Math.min(u.range.start - 1, last), 0, Math.min(u.range.end - 1, last), 0));
        }
      }
      ed.setDecorations(this.unexplainedType, ranges);
    }
  }

  private updateActiveFile(): void {
    const p = this.activePlace();
    setContext('sidestory.changes.activeFileChanged', !!p);
  }

  // ---- the active editor's place ----

  /**
   * The active editor's file in the comparison and its cursor (or selection) on that file's side. With focus in a
   * panel or a view (no active text editor), the visible editor of a changed file, so the commands work from there.
   */
  private activePlace(s: Snapshot | undefined = this.snapshot): { key: SideKey; entry: ChangeEntry; editor: vscode.TextEditor } | undefined {
    if (!s) return undefined;
    const active = vscode.window.activeTextEditor;
    for (const ed of active ? [active] : vscode.window.visibleTextEditors) {
      const key = this.locate(s, ed.document.uri);
      const entry = key && this.entryFor(s, key);
      if (key && entry) return { key, entry, editor: ed };
    }
    return undefined;
  }

  /**
   * A file's changes with their coverage. With no sidestory explaining the branch, coverage diffs nothing: the file is
   * diffed alone then, every change unexplained (Explain This Change and Mark as Trivial on a new branch).
   */
  private async fileChanges(s: Snapshot, r: CoverageResult | undefined, entry: ChangeEntry): Promise<{ changes: ChangeCoverage[]; blocks: ReadonlyMap<string, ChangeBlock> } | undefined> {
    const f = r?.files.get(entry.path);
    if (f?.coverage) return { changes: f.coverage.changes, blocks: f.blocks };
    if (r?.belonging.length) return undefined; // not counted (a sidestory's own file)
    const d = await this.coverage.diffOne(s, entry);
    if (!d) return undefined;
    return {
      changes: d.changes.map((b) => ({ key: b.key, state: 'unexplained' as const, by: [], uncovered: [], coveredLines: 0, changedLines: b.added + b.removed })),
      blocks: new Map(d.changes.map((b) => [b.key, b])),
    };
  }

  /** The change not done yet at the cursor, or the first one the selection touches, in the active editor. */
  private async changeAtCursor(s: Snapshot, r: CoverageResult | undefined): Promise<Found | undefined> {
    const at = this.activePlace(s);
    if (!at) return undefined;
    const f = await this.fileChanges(s, r, at.entry);
    if (!f) return undefined;
    const sel = at.editor.selection;
    const start = sel.start.line + 1;
    const end = sel.isEmpty ? start : sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
    // Only a change that isn't explained or trivial: never act on an explained one the cursor happens to be next to.
    const c = f.changes.find((x) => {
      const b = f.blocks.get(x.key);
      if (!b || isDone(x.state)) return false;
      const span = at.key.side === 'head' ? (b.new ?? { start: b.newAt, end: b.newAt }) : (b.old ?? { start: b.oldAt, end: b.oldAt });
      return span.start <= end && start <= span.end;
    });
    const b = c && f.blocks.get(c.key);
    return c && b ? { path: at.entry.path, entry: at.entry, c, b } : undefined;
  }

  /** A change named by `{ path, key }` (This File's rows), else the one at the active editor's cursor. */
  private async changeFrom(s: Snapshot, r: CoverageResult | undefined, arg: unknown): Promise<Found | undefined> {
    const a = (arg && typeof arg === 'object' ? arg : {}) as { path?: unknown; key?: unknown };
    if (typeof a.path === 'string' && typeof a.key === 'string') {
      const f = r?.files.get(a.path);
      const c = f?.coverage?.changes.find((x) => x.key === a.key);
      const b = c && f?.blocks.get(c.key);
      return f && c && b ? { path: a.path, entry: f.entry, c, b } : undefined;
    }
    return this.changeAtCursor(s, r);
  }

  /** Opens the diff at a change (§9.6: the left side for pure deletions). */
  private async openChange(s: Snapshot, r: CoverageResult, path: string, key: string, column = vscode.ViewColumn.Active): Promise<void> {
    const f = r.files.get(path);
    const b = f?.blocks.get(key);
    const ctx = this.diffContext();
    if (!f || !b || !ctx) return;
    const side: SideKey = b.new ? { path, side: 'head' } : { path: f.entry.oldPath ?? path, side: 'base' };
    const range = b.new ?? b.old ?? { start: b.newAt, end: b.newAt };
    await openTarget(ctx, { ...side, range }, undefined, { moveCursor: true, viewColumn: column, preserveFocus: false, mode: 'diff' });
  }

  // ---- next / previous ----

  /** Files in the first belonging sidestory's step order (the order its steps first touch them). */
  private stepFiles(s: Snapshot, r: CoverageResult): string[] {
    const b = r.belonging[0];
    if (!b) return [];
    const order = new Map(b.steps.map((x, i) => [x.id, i]));
    const anchors = [...b.manifest.anchors.values()]
      .map((a) => ({ a, at: order.get(b.stepOf.get(a.id) ?? '') ?? Number.MAX_SAFE_INTEGER }))
      .filter((x) => x.at < Number.MAX_SAFE_INTEGER)
      .sort((x, y) => x.at - y.at);
    const out: string[] = [];
    for (const { a } of anchors) {
      const p = b.prefix ? `${b.prefix}/${a.file}` : a.file;
      const e = a.side === 'base' ? this.entryFor(s, { path: p, side: 'base' }) : this.entryFor(s, { path: p, side: 'head' });
      if (e) out.push(e.path);
    }
    return out;
  }

  private async moveUnexplained(dir: 1 | -1): Promise<void> {
    const got = await this.withCoverage();
    const r = got?.r;
    if (!got || !r?.belonging.length) {
      vscode.window.setStatusBarMessage(got && r ? 'No sidestory explains this branch yet' : 'No comparison with a base here', 3000);
      return;
    }
    const { s } = got;
    const list: OpenChange[] = [];
    for (const [path, f] of r.files) {
      for (const c of f.coverage?.changes ?? []) {
        const b = f.blocks.get(c.key);
        if (b && !isDone(c.state)) list.push({ path, key: c.key, pos: b.new?.start ?? b.newAt });
      }
    }
    if (!list.length) {
      vscode.window.setStatusBarMessage(`Every change is explained or marked trivial${r.incomplete ? ' · incomplete: some files weren’t counted' : ''}`, 3000);
      return;
    }
    const rank = fileRanks([...r.files.keys()], this.stepFiles(s, r));
    const place = this.activePlace(s);
    let at: { path: string; pos: number } | undefined;
    if (place) {
      const line = place.editor.selection.active.line + 1;
      const diff = r.files.get(place.entry.path)?.diff;
      at = { path: place.entry.path, pos: place.key.side === 'base' && diff ? oldToNew(diff, line) : line };
    }
    const next = nextChange(list, rank, at, dir);
    if (!next) return;
    if (next.wrapped) vscode.window.setStatusBarMessage(dir === 1 ? 'Back to the first unexplained change' : 'Back to the last unexplained change', 3000);
    await this.openChange(s, r, next.target.path, next.target.key, place?.editor.viewColumn);
  }

  private async moveFile(dir: 1 | -1): Promise<void> {
    const s = await this.current();
    if (!s) {
      vscode.window.setStatusBarMessage('No comparison with a base here', 3000);
      return;
    }
    const order = [...s.entries].sort((a, b) => comparePaths(a.path, b.path));
    if (!order.length) {
      vscode.window.setStatusBarMessage('No changed files', 3000);
      return;
    }
    const place = this.activePlace(s);
    const from = place?.entry.path;
    const r = step(order.length, from ? order.findIndex((e) => e.path === from) : -1, dir);
    if (!r) return;
    if (r.wrapped && order.length > 1) vscode.window.setStatusBarMessage(dir === 1 ? 'Back to the first changed file' : 'Back to the last changed file', 3000);
    const { left, right, title } = this.diffUris(s, order[r.index]!);
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true, ...(place?.editor.viewColumn ? { viewColumn: place.editor.viewColumn } : {}) });
  }

  // ---- the "This branch" group (§9.6) ----

  private branchKey(s: Snapshot): string {
    return `${this.ids.idOf(s.repo)}\n${s.head.name ?? s.head.sha}`;
  }

  /** "Copy Prompt: Explain This Branch" is offered: the setting, and not dismissed for this branch. */
  private suggestExplain(s: Snapshot | undefined): boolean {
    if (!config().get<boolean>('suggestExplain', true)) return false;
    if (!s) return true;
    const off = this.memento.get<string[]>(KEYS.noSuggest) ?? [];
    return !off.includes(this.branchKey(s));
  }

  /**
   * "Use develop": a sidestory added on the branch names another base, and it resolves to another commit than the
   * comparison's (`origin/main` and `main` at one commit are the same base). Resolved once per (base, commit).
   */
  private otherBase(s: Snapshot | undefined): { title: string; base: string } | undefined {
    if (!s) return undefined;
    const o = this.storyBases(s).other;
    if (!o) return undefined;
    const key = `${o.base}\n${s.base.sha}`;
    const known = this.otherBases.get(key);
    if (!known) {
      if (this.otherBases.size > 100) this.otherBases.clear();
      this.otherBases.set(key, 'pending');
      void resolveBase(refReader(s.repo), o.base).then(
        (b) => {
          this.otherBases.set(key, !b ? 'missing' : b.sha === s.base.sha ? 'same' : 'differs');
          this.emitter.fire();
        },
        () => this.otherBases.set(key, 'missing'),
      );
      return undefined;
    }
    return known === 'differs' ? o : undefined;
  }

  /** Why there is no snapshot, said in the group (a base not found, no merge-base, no base, git's error). */
  private problemOf(st: ComparisonState): BranchProblem | undefined {
    switch (st.kind) {
      case 'baseNotFound':
        return { kind: 'baseNotFound', spec: name(st.spec, 40) };
      case 'noMergeBase':
        return { kind: 'noMergeBase', base: name(st.base.label, 40) };
      case 'noBase':
        return { kind: 'noBase' };
      case 'error':
        return { kind: 'error', message: displayText(st.message, 120) };
      default:
        return undefined;
    }
  }

  /** The rows of the Sidestories view's "This branch" group, with the group's description; no rows: no group. */
  branchGroup(): { description: string | undefined; rows: BranchRow[] } {
    const c = this.comparison;
    if (!c) return { description: undefined, rows: [] };
    const s = this.snapshot;
    const r = this.result(s);
    const problem = s ? undefined : this.problemOf(c.state);
    const hasChanges = s ? s.entries.length > 0 && !s.onBase : !!this.probed && !problem;
    // Coverage is on its way for this snapshot: no "Explain This Branch" flash on a branch a sidestory explains.
    const pending = !!s && this.coverage.active && !r;
    const o = this.otherBase(s);
    const rows = branchRows({
      belonging: (r?.belonging ?? []).map((b) => ({ folder: displayText(b.folder, 120), title: displayText(b.manifest.title, 80), base: name(b.manifest.base ?? '', 40), dir: b.dir.toString(), totals: b.totals })),
      totals: r?.totals,
      hasChanges,
      suggest: this.suggestExplain(s) && !pending,
      ...(o ? { otherBase: { title: displayText(o.title, 60), base: name(o.base, 40) } } : {}),
      ...(r?.belonging.length && r.incomplete ? { incomplete: true } : {}),
      ...(problem ? { problem } : {}),
    });
    // Multi-root: which repository, when more than one is open.
    const roots = new Set((this.api?.repositories ?? []).map(repoKey));
    const where = roots.size > 1 ? `${name(c.repo.rootUri.path.split('/').filter(Boolean).pop() ?? '', 30)}: ` : '';
    const head = c.repo.state.HEAD;
    const branch = s ? s.head : head?.commit ? { name: head.name, sha: head.commit } : undefined;
    const headWords = branch ? (branch.name ? name(branch.name, 40) : `detached ${short(branch.sha)}`) : undefined;
    const description = s ? `${where}${headWords} vs ${name(s.base.label, 40)}` : problem && headWords ? `${where}${headWords}` : undefined;
    return { description, rows };
  }

  // ---- This File's view of a file's changes ----

  /** The changes of a file that aren't done, and the steps whose code changed since they were written (This File). */
  changesOf(file: vscode.Uri): { path: string; open: { key: string; label: string; state: ChangeCoverage['state']; c: ChangeCoverage }[]; needsLook: Set<string> } | undefined {
    const s = this.snapshot;
    const r = this.result(s);
    if (!s || !r?.belonging.length) return undefined;
    const path = this.pathOf(file);
    const f = path ? r.files.get(path) : undefined;
    if (!path || !f?.coverage) return undefined;
    const open: { key: string; label: string; state: ChangeCoverage['state']; c: ChangeCoverage }[] = [];
    const needsLook = new Set<string>();
    for (const c of f.coverage.changes) {
      const b = f.blocks.get(c.key);
      if (b && !isDone(c.state)) open.push({ key: c.key, label: changeLabel(b), state: c.state, c });
      for (const n of c.needsLook ?? []) {
        const dir = r.belonging.find((x) => x.folder === n.sidestory)?.dir;
        if (dir) needsLook.add(`${dir.toString()}\0${n.anchor}`);
      }
    }
    return { path, open, needsLook };
  }

  // ---- commands ----

  private async copy(text: string): Promise<void> {
    await vscode.env.clipboard.writeText(text);
    void vscode.window.showInformationMessage(COPIED);
  }

  /** One belonging sidestory: the only one, or the one picked. */
  private async pickBelonging(r: CoverageResult, title: string): Promise<Belonging | undefined> {
    if (r.belonging.length <= 1) return r.belonging[0];
    const pick = await vscode.window.showQuickPick(
      r.belonging.map((b) => ({ label: escapeIcons(displayText(b.manifest.title, 80) || b.folder), description: escapeIcons(displayText(b.folder, 80)), b })),
      { title },
    );
    return pick?.b;
  }

  private async markTrivialCmd(arg: unknown): Promise<void> {
    const got = await this.withCoverage();
    if (!got) return;
    const { s, r } = got;
    let target: { path: string; side: 'head' | 'base'; range: { start: number; end: number } } | undefined;
    const place = this.activePlace(s);
    const named = arg && typeof arg === 'object' && typeof (arg as { key?: unknown }).key === 'string';
    // A change not done yet: named, at the cursor, or one the selection touches.
    const one = await this.changeFrom(s, r, arg);
    if (one && !named && place && !place.editor.selection.isEmpty) {
      // A selection: those lines, on the side they are on.
      const sel = place.editor.selection;
      const end = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
      target = { path: place.key.path, side: place.key.side, range: { start: sel.start.line + 1, end } };
    } else if (one) {
      target = one.b.new ? { path: one.path, side: 'head', range: one.b.new } : one.b.old ? { path: one.entry.oldPath ?? one.path, side: 'base', range: one.b.old } : undefined;
    }
    if (!target) {
      void vscode.window.showInformationMessage('Put the cursor in a change of this branch that isn’t explained yet (in its diff, or the changed file), or select its lines, then Mark as Trivial.');
      return;
    }
    const text = await this.sideText(s, target);
    if (text === undefined) return;
    try {
      const written = await markTrivial(s, r?.belonging ?? [], { ...target, text });
      if (written) this.scheduleCoverage(500);
    } catch (e) {
      void vscode.window.showErrorMessage(`Couldn't mark it trivial: ${plainForMessage((e as Error).message)}`);
    }
  }

  /**
   * The text of a side of a path, for Mark as Trivial: both sides decoded together as coverage does (§5.2: Latin-1
   * for both when either isn't UTF-8), and an open document's unsaved text on the head side while its file is UTF-8.
   */
  private async sideText(s: Snapshot, k: SideKey): Promise<string | undefined> {
    const e = this.entryFor(s, k);
    if (!e) return undefined;
    const { left, right } = this.diffUris(s, e);
    const read = async (u: vscode.Uri) => (u.scheme === EMPTY_SCHEME ? undefined : vscode.workspace.fs.readFile(u));
    try {
      const [ob, nb] = await Promise.all([read(left), read(right)]);
      const d = decodePair(ob, nb);
      if (k.side === 'base') return d.old;
      const doc = vscode.workspace.textDocuments.find((x) => x.uri.toString() === right.toString());
      return doc?.isDirty && !d.latin1 ? doc.getText() : d.new;
    } catch {
      return undefined;
    }
  }

  private async repinStep(arg: unknown): Promise<void> {
    // `{ dir, anchor }`, or a This File step row carrying it as `repin`.
    const raw = (arg && typeof arg === 'object' ? arg : {}) as { dir?: unknown; anchor?: unknown; repin?: { dir?: unknown; anchor?: unknown } };
    const a = raw.repin ?? raw;
    const got = await this.withCoverage();
    const r = got?.r;
    // Explicit arguments only for an anchor the current result says needs a look; anything else goes to the picker.
    if (typeof a.dir === 'string' && typeof a.anchor === 'string') {
      const dir = a.dir;
      const anchor = a.anchor;
      const known = !!r && [...r.files.values()].some((f) => f.coverage?.changes.some((c) => c.needsLook?.some((n) => n.anchor === anchor && r.belonging.find((b) => b.folder === n.sidestory)?.dir.toString() === dir)));
      if (known) {
        await this.host.repin(vscode.Uri.parse(dir), anchor);
        this.scheduleCoverage(500);
        return;
      }
    }
    const one = got && r ? await this.changeFrom(got.s, r, raw.repin ? undefined : arg) : undefined;
    const looks = one?.c.needsLook ?? [];
    if (!r || !looks.length) {
      void vscode.window.showInformationMessage('Put the cursor in a change whose step was written before code was added to it, then Re-pin This Step.');
      return;
    }
    const items = looks.flatMap((n) => {
      const b = r.belonging.find((x) => x.folder === n.sidestory);
      if (!b) return [];
      const step = b.stepOf.get(n.anchor) ?? n.anchor;
      return [{ label: escapeIcons(`${displayText(b.manifest.title, 40)} › ${displayText(b.steps.find((x) => x.id === step)?.title ?? step, 60)}`), description: escapeIcons(n.anchor), b, anchor: n.anchor }];
    });
    const pick = items.length === 1 ? items[0] : await vscode.window.showQuickPick(items, { title: 'Re-pin Which Step?' });
    if (!pick) return;
    await this.host.repin(pick.b.dir, pick.anchor);
    this.scheduleCoverage(500);
  }

  /** How the comparison came by its base, for Set Base…'s first item. */
  private sourceWords(source: BaseSource): string {
    switch (source) {
      case 'pick':
        return 'set for this branch';
      case 'sidestory':
        return this.latch ? `from “${escapeIcons(name(this.latch.title, 40))}”` : 'from a sidestory on this branch';
      case 'git-config':
        return 'the branch’s recorded base';
      case 'setting':
        return 'the defaultBase setting';
      case 'remote-default':
        return 'the remote’s default branch';
      default:
        return 'the default';
    }
  }

  /** Set Base… (§9.4): a branch, tag or remote branch to compare this branch with, remembered per repository and branch. */
  private async setBase(arg?: unknown): Promise<void> {
    await this.initializing;
    const c = this.comparison;
    if (!c) {
      void vscode.window.showInformationMessage('Setting a base needs a git repository.');
      return;
    }
    const repo = c.repo;
    const head = repo.state.HEAD;
    const branch = this.branchOf(repo);
    // Only a base that resolves here is saved: a typo or an unfetched branch is said, and the base stays as it was.
    const save = async (spec: string | undefined) => {
      if (spec && !(await resolveBase(refReader(repo), spec))) {
        void vscode.window.showWarningMessage(`“${name(spec)}” isn't a branch, tag or commit in this repository (not fetched?). The base wasn't changed.`);
        return;
      }
      await this.setPick(repo, branch, spec);
      await c.refresh(true);
    };
    // From the This branch row "Use develop": that base, no picker.
    if (typeof arg === 'string' && isValidBase(arg)) {
      await save(arg);
      return;
    }
    const current = this.pickOf(repo, branch);
    type Item = vscode.QuickPickItem & { spec?: string; clear?: boolean; keep?: boolean };
    const items: Item[] = [];
    // First, the base in use and where it came from (the pick, a sidestory, the recorded base, the setting, a default).
    const st = c.state;
    if (st.kind === 'ready') items.push({ label: `$(git-compare) Merge-base with ${escapeIcons(name(st.snapshot.base.label))}`, description: `${this.sourceWords(st.snapshot.base.source)} · current`, keep: true });
    else if (st.kind === 'baseNotFound') items.push({ label: `$(warning) ${escapeIcons(name(st.spec))} not found`, description: 'set for this branch · current', keep: true });
    if (current) {
      const story = this.storyBase(repo);
      const def = story ? undefined : await c.defaultBase().catch(() => undefined);
      const back = story ? `${name(story, 40)} (from “${name(this.latch?.title ?? '', 40)}”)` : (def?.label ?? 'main');
      items.push({ label: '$(discard) Use the Default Base', description: `back to ${escapeIcons(name(back))}`, clear: true });
    }
    const recent = (this.memento.get<string[]>(KEYS.recent) ?? []).filter((x) => typeof x === 'string' && isValidBase(x));
    const refs = repo.getRefs ? await repo.getRefs({ pattern: 'refs/heads/', count: 300, sort: 'committerdate' }).catch(() => []) : repo.state.refs.filter((x) => x.type === 0);
    const remotes = repo.getRefs ? await repo.getRefs({ pattern: 'refs/remotes/', count: 300, sort: 'committerdate' }).catch(() => []) : repo.state.refs.filter((x) => x.type === 1);
    const seen = new Set<string>();
    const add = (label: string, list: readonly (string | undefined)[]) => {
      const valid = list.filter((n): n is string => !!n && isValidBase(n) && !n.endsWith('/HEAD') && n !== head?.name && !seen.has(n));
      if (!valid.length) return;
      items.push({ label, kind: vscode.QuickPickItemKind.Separator });
      for (const n of valid) {
        seen.add(n);
        items.push({ label: escapeIcons(name(n, 100)), description: n === current ? 'current' : undefined, spec: n });
      }
    };
    add('Recent', recent);
    add('Branches', refs.map((x) => x.name));
    add('Remote Branches', remotes.map((x) => x.name));
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = `Set Base for ${name(branch, 60)}`;
    qp.placeholder = 'A branch to compare with (the diff is from the merge-base); type a name to use another';
    qp.items = items;
    qp.matchOnDescription = true;
    const chosen = await new Promise<Item | 'typed' | undefined>((resolve) => {
      qp.onDidAccept(() => resolve(qp.selectedItems[0] ?? (qp.value.trim() ? 'typed' : undefined)));
      qp.onDidHide(() => resolve(undefined));
      qp.show();
    });
    const typed = qp.value.trim();
    qp.dispose();
    if (!chosen || (chosen !== 'typed' && chosen.keep)) return;
    if (chosen === 'typed') {
      if (!isValidBase(typed)) {
        void vscode.window.showWarningMessage(`“${name(typed)}” isn't a branch name Sidestory can use.`);
        return;
      }
      await save(typed);
      return;
    }
    await save(chosen.clear ? undefined : chosen.spec);
  }

  readonly commands: Record<string, (...args: unknown[]) => unknown> = {
    'sidestory.changes.nextFile': () => this.moveFile(1),
    'sidestory.changes.prevFile': () => this.moveFile(-1),
    'sidestory.changes.nextUnexplained': () => this.moveUnexplained(1),
    'sidestory.changes.prevUnexplained': () => this.moveUnexplained(-1),
    'sidestory.changes.openChange': async (arg?: unknown) => {
      const got = await this.withCoverage();
      const one = got?.r ? await this.changeFrom(got.s, got.r, arg) : undefined;
      if (got?.r && one) await this.openChange(got.s, got.r, one.path, one.c.key);
    },
    'sidestory.changes.copyExplainPrompt': async () => {
      const s = await this.current();
      if (!s) {
        void vscode.window.showInformationMessage('Explaining a branch needs a git repository with a base to compare with.');
        return;
      }
      await this.copy(explainBranchPrompt(s.base.spec));
    },
    'sidestory.changes.dismissExplain': async () => {
      const s = await this.current();
      if (!s) return;
      const off = (this.memento.get<string[]>(KEYS.noSuggest) ?? []).filter((x) => typeof x === 'string');
      await this.memento.update(KEYS.noSuggest, [this.branchKey(s), ...off].slice(0, 200));
      this.emitter.fire();
    },
    'sidestory.changes.copyUpdatePrompt': async () => {
      const got = await this.withCoverage();
      const b = got?.r ? await this.pickBelonging(got.r, 'Update Which Sidestory?') : undefined;
      if (got && b) await this.copy(updatePrompt(b.folder, b.manifest.base ?? got.s.base.spec));
    },
    'sidestory.changes.copyChangePrompt': async (arg?: unknown) => {
      const got = await this.withCoverage();
      if (!got?.r) return;
      const c = await this.changeFrom(got.s, got.r, arg);
      if (!c) {
        void vscode.window.showInformationMessage('Put the cursor in a change of this branch (in its diff, or the changed file), then Copy Prompt: Explain This Change.');
        return;
      }
      const b = got.r.belonging.length ? await this.pickBelonging(got.r, 'Explain It in Which Sidestory?') : undefined;
      if (got.r.belonging.length && !b) return;
      const file = c.b.new ? c.path : (c.entry.oldPath ?? c.path);
      await this.copy(changePrompt({ sidestory: b?.folder, base: b?.manifest.base ?? got.s.base.spec, file, lines: changeLabel(c.b), kind: changeKind(c.b) }));
    },
    'sidestory.changes.markTrivial': (arg?: unknown) => this.markTrivialCmd(arg),
    'sidestory.changes.repinStep': (arg?: unknown) => this.repinStep(arg),
    'sidestory.changes.setBase': (arg?: unknown) => this.setBase(arg),
  };

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.repoTimer);
    clearTimeout(this.commandTimer);
    this.apiSubs.forEach((d) => d.dispose());
    this.comparisonSubs.forEach((d) => d.dispose());
    this.subscriptions.forEach((d) => d.dispose());
  }
}

/**
 * Coverage marks on the real files (§9.6): a FileDecorationProvider, so they show wherever VS Code decorates files
 * (the Explorer, Source Control, Git Tree Compare, tabs) and on the `sidestory-git:` sides of diffs. Only files in the
 * merge diff of a comparison that has a belonging sidestory; changes are announced for the URIs whose mark changed,
 * debounced; folders don't inherit them (`propagate: false`).
 */
export class CoverageDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  /** Marks by head path, as last announced. */
  private marks = new Map<string, CoverageMark>();
  /** The URIs each path's mark was announced on (to clear them when the mark goes). */
  private uris = new Map<string, vscode.Uri[]>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly svc: ChangesService;

  constructor(svc: ChangesService) {
    this.svc = svc;
  }

  /** The marks for the current result (pure over it: steps named "Step 3 of Retry with jitter"). */
  static marksOf(r: CoverageResult | undefined): Map<string, CoverageMark> {
    const out = new Map<string, CoverageMark>();
    if (!r?.belonging.length) return out;
    for (const [path, f] of r.files) {
      if (!f.coverage) continue;
      const steps: string[] = [];
      for (const c of f.coverage.changes) {
        if (c.state !== 'explained') continue;
        for (const x of c.by) {
          const b = r.belonging.find((y) => y.folder === x.sidestory);
          if (!b) continue;
          const id = b.stepOf.get(x.anchor) ?? x.anchor;
          const i = b.steps.findIndex((y) => y.id === id);
          const label = `${i >= 0 ? `Step ${i + 1}` : displayText(id, 40)} of ${displayText(b.manifest.title, 60)}`;
          if (!steps.includes(label)) steps.push(label);
        }
      }
      const m = fileDecoration(f.coverage, steps);
      if (m) out.set(path, m);
    }
    return out;
  }

  /** Recomputes the marks soon and announces the URIs whose mark changed. */
  update(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.apply(), 300);
  }

  private apply(): void {
    const s = this.svc.snapshot;
    const next = CoverageDecorations.marksOf(this.svc.result(s));
    const changed: vscode.Uri[] = [];
    const nextUris = new Map<string, vscode.Uri[]>();
    for (const [path, m] of next) {
      const e = s?.entries.find((x) => x.path === path);
      const uris = s && e ? this.svc.urisOf(s, e) : [];
      nextUris.set(path, uris);
      const was = this.marks.get(path);
      if (!was || was.badge !== m.badge || was.tooltip !== m.tooltip || was.color !== m.color) changed.push(...uris);
    }
    for (const [path, uris] of this.uris) if (!next.has(path)) changed.push(...uris);
    this.marks = next;
    this.uris = nextUris;
    if (changed.length) this.emitter.fire(changed);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (!this.marks.size || (uri.scheme !== 'file' && uri.scheme !== GIT_SCHEME)) return undefined;
    const path = this.svc.pathOf(uri);
    const m = path ? this.marks.get(path) : undefined;
    if (!m) return undefined;
    const d = new vscode.FileDecoration(m.badge, m.tooltip, new vscode.ThemeColor(COVERAGE_COLORS[m.color]));
    d.propagate = false;
    return d;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.emitter.dispose();
  }
}
