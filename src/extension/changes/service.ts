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
import { placeCursor } from '../reveal.ts';
import { displayText, escapeIcons, plainForMessage } from '../../core/display-text.ts';
import type { ChangeCoverage } from '../../core/coverage.ts';
import { decodePair, moveFiles, moveLabel, oldToNew, textLines, type ChangeBlock, type MoveGroup } from '../../core/hunks.ts';
import { trivialGlobFor } from '../../core/manifest.ts';
import { isStoryBase, isValidBase, latchStep, resolveBase, storyBasesOf, type BaseSource, type StoryLatch } from './base.ts';
import { chooseRepository, Comparison, headSideReadable, isSafeFsPath, repoKey, sameRepo, type ComparisonState, type Snapshot } from './comparison.ts';
import { branchRows, changeKind, changeLabel, COVERAGE_COLORS, everyChangeMessage, fileDecoration, isDone, moveMarkNote, moveMarkTarget, WHOLE_WORDS, type BranchProblem, type BranchRow, type CoverageMark } from './coverage-labels.ts';
import { COVERAGE_WORK, CoverageService, type Belonging, type CoverageResult } from './coverage-service.ts';
import { apiPath, gitApi, refReader, relPath, type GitApi, type GitRepo } from './git-api.ts';
import { GitBlobs, isUnknownPath } from './git-blobs.ts';
import { emptyUri, EMPTY_SCHEME, GitFileSystem, gitUri, GIT_SCHEME, parseGitUri, RepoIds } from './git-fs.ts';
import { baseName, comparePaths, short, step, type ChangeEntry } from './model.ts';
import { editorFor, inDiffEditor, openTarget, type DiffContext } from './open.ts';
import { fileRanks, nextChange, walkPos, type OpenChange } from './order.ts';
import { changePrompt, COPIED, explainBranchPrompt, updatePrompt } from './prompts.ts';
import { emptySideKey, entryIndex, gitSideKey, vscodeGitSideKey, type SideKey } from './targets.ts';
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

/** A file whose change has no lines: counted whole (binary, LFS, link…), or moved without a line changed. */
const lineless = (f: { whole?: unknown; move?: unknown; movedWith?: string; diff: { changes: readonly unknown[] } }) => !!f.whole || ((!!f.move || !!f.movedWith) && !f.diff.changes.length);

const setContext = (key: string, value: unknown) => void vscode.commands.executeCommand('setContext', key, value);
const name = (s: string, max = 60) => displayText(s, max);
const config = () => vscode.workspace.getConfiguration('sidestory.changes');
const setting = () => config().get<string>('defaultBase')?.trim() || undefined;

/** A file whose merge diff has two sides worth comparing: modified, renamed or copied (not added or deleted). */
const hasTwoSides = (e: ChangeEntry) => e.status === 'M' || e.status === 'R' || e.status === 'C';
/**
 * A URI as the `resourcePath` context key holds it, a key to match, never read from disk: VS Code's workbench sets it
 * to `fsPath` for a `file:` URI and to `path` for any other scheme. In a remote window the workbench sees the file as
 * `vscode-remote:` (so `path`) while this extension host sees `file:`.
 */
const resourcePath = (u: vscode.Uri) => (u.scheme === 'file' && !vscode.env.remoteName ? u.fsPath : u.path);

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
  /** Blobs read through git, shared by the diff editors, coverage and the comparison. */
  private readonly blobs = new GitBlobs(COVERAGE_WORK.blobBytes);
  readonly coverage: CoverageService;
  readonly decorations: CoverageDecorations;
  private readonly host: ChangesHost;
  private readonly subscriptions: vscode.Disposable[] = [];
  private api: GitApi | undefined;
  private initializing: Promise<void> = Promise.resolve();
  private comparison: Comparison | undefined;
  private comparisonSubs: vscode.Disposable[] = [];
  private apiSubs: vscode.Disposable[] = [];
  /** Bumped by each init: an older one that finishes later leaves the newer answer alone. */
  private initSeq = 0;
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
  /** Where Next/Previous Unexplained Change last went, and what the editor area looked like after. */
  private lastWalk: { snapshot: Snapshot; target: OpenChange; sig: string } | undefined;
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
    this.coverage = new CoverageService({ snapshot: () => this.snapshot, order: () => this.openPaths(), sidestoryDirs: () => this.host.sidestoryDirs() }, this.blobs);
    this.decorations = new CoverageDecorations(this);
    this.subscriptions.push(
      this.coverage,
      this.emitter,
      this.diffsEmitter,
      this.unexplainedType,
      this.decorations,
      this.coverage.onDidChange(() => {
        setContext('sidestory.changes.layer', !!this.result()?.belonging.length);
        this.updateComparable(); // an unstaged rename coverage paired
        this.paintUnexplained();
        this.decorations.update();
        this.diffsEmitter.fire();
        this.emitter.fire();
      }),
      GitFileSystem.register(this.ids, this.blobs),
      vscode.window.registerFileDecorationProvider(this.decorations),
      vscode.window.onDidChangeVisibleTextEditors(() => {
        this.paintUnexplained();
        this.updateComparable();
      }),
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

  /** What a latch is kept for: the branch (a detached HEAD by its commit), so a commit on the branch keeps it. */
  private latchBranch(repo: GitRepo): string {
    const b = this.branchOf(repo);
    return b === 'HEAD' ? `HEAD@${repo.state.HEAD?.commit ?? ''}` : b;
  }

  /** The latched sidestory base while it still holds (the comparison's `sidestoryBase`), checked when asked. */
  private storyBase(repo: GitRepo): string | undefined {
    const l = this.latch;
    if (!l) return undefined;
    if (l.branch !== this.latchBranch(repo) || l.pick !== this.pickOf(repo) || l.setting !== setting()) return undefined;
    return this.host.sidestoryBases().some((x) => x.dir.toString() === l.dir && x.base === l.base) ? l.base : undefined;
  }

  /**
   * Re-reads the sidestory base after the comparison or the index changed (§11.4). Never from a snapshot compared
   * with a sidestory's base, so the base can't toggle (a sidestory whose manifest already exists at its own base's
   * merge-base, a base naming the branch itself); and at most one refresh per (branch, pick, setting, base).
   */
  private evaluateStoryBase(c: Comparison): void {
    const s = c.snapshot;
    if (!s) {
      // A latch this branch no longer accepts (another branch's, a pick or setting since) goes first.
      if (this.latch && this.storyBase(c.repo) === undefined) this.latch = undefined;
      if (c.state.kind === 'noBase') void this.rescueStoryBase(c);
      return;
    }
    const first = s.base.source === 'sidestory' ? undefined : this.storyBases(s).first;
    const step = latchStep(
      this.latch,
      this.latchRefreshedFor,
      { source: s.base.source, branch: this.latchBranch(s.repo) },
      first && { dir: first.dir.toString(), title: first.title, base: first.base },
      { pick: this.pickOf(s.repo), setting: setting(), stillValid: this.storyBase(c.repo) !== undefined },
    );
    this.latch = step.latch;
    this.latchRefreshedFor = step.refreshedFor;
    if (step.refresh) void c.refresh();
  }

  /**
   * No base from the default chain (no main or master), yet a sidestory names one (`develop`): there is no snapshot
   * to read "added on this branch" from, so ask the sidestory's own merge-base whether its manifest is there. Not
   * there (added on this branch, or not committed yet): latch its base. Once per (branch, pick, setting, sidestory).
   */
  private async rescueStoryBase(c: Comparison): Promise<void> {
    const repo = c.repo;
    const head = repo.state.HEAD?.commit;
    if (this.latch && this.storyBase(repo) === undefined) this.latch = undefined; // another branch's: not this one's
    if (!head || this.latch || this.pickOf(repo)) return;
    const reader = refReader(repo);
    const stories = this.host
      .sidestoryBases()
      .flatMap((x) => {
        const folder = relPath(repo, x.dir);
        return folder && isStoryBase(x.base) ? [{ ...x, folder }] : [];
      })
      .sort((a, b) => (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0));
    for (const x of stories) {
      const b = await resolveBase(reader, x.base);
      if (!b || b.sha === head) continue;
      const mb = await reader.mergeBase(b.sha, head);
      if (!mb) continue;
      const there = await repo.getObjectDetails(mb, apiPath(repo, `${x.folder}/manifest.json`)).then(
        () => true,
        (e: unknown) => (isUnknownPath(e) ? false : undefined),
      );
      if (there !== false) continue;
      if (this.comparison !== c || c.state.kind !== 'noBase' || this.latch) return;
      const step = latchStep(undefined, this.latchRefreshedFor, { source: 'fallback', branch: this.latchBranch(repo) }, { dir: x.dir.toString(), title: x.title, base: x.base }, { pick: undefined, setting: setting(), stillValid: false });
      this.latch = step.latch;
      this.latchRefreshedFor = step.refreshedFor;
      if (step.refresh) void c.refresh();
      return;
    }
  }

  /** The index changed: coverage again, and the sidestory base and "Use develop" row may have changed. */
  indexChanged(): void {
    this.scheduleCoverage();
    if (this.comparison) this.evaluateStoryBase(this.comparison);
    this.emitter.fire();
  }

  /** Sidestory pages changed and their outlines didn't: only coverage (the anchors a page uses) can differ. */
  pagesChanged(): void {
    this.scheduleCoverage();
  }

  /** Coverage soon, noting the snapshot it is for. */
  private scheduleCoverage(delay?: number): void {
    this.coverageAskedFor = this.snapshot;
    this.coverage.schedule(delay);
  }

  // ---- the git API and the repository ----

  private async init(): Promise<void> {
    const mine = ++this.initSeq;
    this.apiSubs.forEach((d) => d.dispose());
    this.apiSubs = [];
    const s = await gitApi();
    // A newer init (trust granted, the git extension appeared) started meanwhile: its answer counts.
    if (mine !== this.initSeq || this.disposed) return;
    if (s.kind !== 'ok') {
      this.api = undefined;
      this.useRepo(undefined);
      if (s.kind === 'disabled' && s.ext) this.apiSubs.push(s.ext.onDidChangeEnablement(() => (this.initializing = this.init())));
      // The git extension doesn't run in Restricted Mode: after trust is granted it is enabled a moment later, and
      // the trust event can come first (the extension still missing then). Try again when it appears.
      if (s.kind === 'missing' || s.kind === 'untrusted') {
        this.apiSubs.push(
          vscode.extensions.onDidChange(() => {
            if (vscode.workspace.isTrusted && vscode.extensions.getExtension('vscode.git')) this.initializing = this.init();
          }),
        );
      }
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
    this.updateComparable();
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
      blobs: this.blobs,
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
        this.updateComparable();
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
        // The comparison stopped being ready (a base gone, the repository closed): nothing to wait for.
        const left = this.onDidChange(() => {
          if (!this.snapshot) done();
        });
        function done() {
          clearTimeout(timer);
          sub.dispose();
          left.dispose();
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
    if (uri.scheme === EMPTY_SCHEME) {
      const p = uri.path.slice(1);
      // Else coverage's own entry: the right side of a code-renamed-onto-a-sidestory's-file deletion has no snapshot entry.
      const own = this.result(s)?.files.get(p)?.entry;
      return emptySideKey(p, s.entries) ?? (own ? emptySideKey(p, [own]) : undefined);
    }
    return this.keyOf(s, uri);
  }

  /**
   * The comparison's entry for a side of a path. An unstaged rename coverage paired (a deleted tracked file and an
   * untracked one) is one renamed entry: either side of either half finds it, so it has one diff and one walk.
   */
  entryFor(s: Snapshot, k: SideKey): ChangeEntry | undefined {
    const paired = this.pairedEntry(s, k);
    if (paired) return paired;
    // Code renamed onto a sidestory's own file: coverage counts only its old side, a deletion under the old path.
    const r = this.result(s);
    if (r && k.side === 'base') {
      const f = r.files.get(k.path);
      if (f?.entry.status === 'D' && entryIndex(s.entries).renamedFrom.has(k.path)) return f.entry;
    }
    return entryIndex(s.entries)[k.side].get(k.path);
  }

  private pairedEntry(s: Snapshot, k: SideKey): ChangeEntry | undefined {
    const r = this.result(s);
    if (!r?.paired?.size) return undefined;
    const newPath = r.paired.get(k.path) ?? k.path;
    const f = r.files.get(newPath);
    return f?.entry.status === 'R' && f.entry.untracked && (r.paired.get(k.path) !== undefined || k.side === 'head') ? f.entry : undefined;
  }

  /** A document's head path in the current comparison: a file, either side of a diff (the left side of a rename names the new path). */
  pathOf(uri: vscode.Uri | undefined): string | undefined {
    const s = this.snapshot;
    if (!uri || !s) return undefined;
    const k = uri.scheme === EMPTY_SCHEME ? this.locate(s, uri) : this.keyOf(s, uri);
    if (!k) return uri.scheme === EMPTY_SCHEME ? uri.path.slice(1) : undefined;
    return this.entryFor(s, k)?.path ?? k.path;
  }

  /** A working tree file, only for a path the file system rule passes (never a Windows device, `a.` or `a:b`). */
  private fileUri(s: Snapshot, path: string): vscode.Uri {
    if (!isSafeFsPath(path)) throw new Error('a path Sidestory does not read from disk');
    return vscode.Uri.joinPath(s.repo.rootUri, ...path.split('/'));
  }

  /**
   * The two sides of a file's merge diff (§7.1): merge-base ↔ working tree file, or ↔ HEAD's blob. Undefined when
   * the working tree side's path isn't one Sidestory reads from disk (it still counts, as one change).
   */
  diffUris(s: Snapshot, e: ChangeEntry): { left: vscode.Uri; right: vscode.Uri; title: string } | undefined {
    if (!headSideReadable(s.mode, e)) return undefined;
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
      if (isSafeFsPath(e.path)) out.push(this.fileUri(s, e.path));
      const pair = this.diffUris(s, e);
      if (pair?.left.scheme === GIT_SCHEME) out.push(pair.left);
      if (pair?.right.scheme === GIT_SCHEME) out.push(pair.right);
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
      // Released while this was in flight (the panel closed): don't hold the comparison for it.
      if (!this.coverage.isWanted(who)) return undefined;
      this.holders.add(who);
      return this.diffContext();
    },
    release: (who) => {
      const held = this.holders.delete(who);
      this.coverage.want(who, false);
      this.updateActive();
      if (held && !this.holders.size) {
        // The last session of this repository let go: follow the active editor again, and let other sessions ask.
        this.followRepo();
        this.diffsEmitter.fire();
      }
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
        const d = await this.blobs.stat(s.repo, mb, p);
        if (!d || d === 'missing' || d.size > 10_000_000) return undefined;
        const b = await this.blobs.read(s.repo, mb, p).catch(() => undefined);
        return b && decodePair(b, b).old;
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
    const r = this.result(s);
    for (const ed of active ? [active] : vscode.window.visibleTextEditors) {
      const key = this.locate(s, ed.document.uri);
      let entry = key && this.entryFor(s, key);
      // An R entry coverage split to its old side (code renamed onto a sidestory's own file): that deletion.
      if (key && entry && r && !r.files.has(entry.path) && entry.oldPath !== undefined && r.files.get(entry.oldPath)?.entry.status === 'D') {
        const oldKey: SideKey = { path: entry.oldPath, side: 'base' };
        return { key: oldKey, entry: r.files.get(entry.oldPath)!.entry, editor: ed };
      }
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
    // A whole-file change (a file too large to compare, say): the cursor anywhere in it is in it.
    const whole = r?.files.get(at.entry.path);
    if (whole?.whole) {
      const c = whole.coverage?.changes.find((x) => !isDone(x.state));
      const b = c && whole.blocks.get(c.key);
      return c && b ? { path: at.entry.path, entry: whole.entry, c, b } : undefined;
    }
    // In a moved file, the cursor off any line change is in its group's move (carried by the group's first file).
    const moveHere = (): Found | undefined => {
      const carrier = whole?.move ? whole : whole?.movedWith ? r?.files.get(whole.movedWith) : undefined;
      const c = carrier?.coverage?.changes.find((x) => carrier.blocks.get(x.key)?.move && !isDone(x.state));
      const b = c && carrier!.blocks.get(c.key);
      return c && b ? { path: carrier!.entry.path, entry: carrier!.entry, c, b } : undefined;
    };
    const f = await this.fileChanges(s, r, at.entry);
    if (!f) return moveHere();
    const sel = at.editor.selection;
    const start = sel.start.line + 1;
    const end = sel.isEmpty ? start : sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
    // Only a change that isn't explained or trivial: never act on an explained one the cursor happens to be next to.
    const c = f.changes.find((x) => {
      const b = f.blocks.get(x.key);
      if (!b || isDone(x.state)) return false;
      if (b.move) return false;
      const span = at.key.side === 'head' ? (b.new ?? { start: b.newAt, end: b.newAt }) : (b.old ?? { start: b.oldAt, end: b.oldAt });
      return span.start <= end && start <= span.end;
    });
    const b = c && f.blocks.get(c.key);
    return c && b ? { path: at.entry.path, entry: at.entry, c, b } : moveHere();
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

  /**
   * Opens the diff at a change (§9.6: the left side for pure deletions). A whole-file change (binary, link, submodule,
   * too large) has no lines: its diff opens without a range (a binary diff has no text editor), or, when the file
   * isn't read from disk, its place is said.
   */
  private async openChange(s: Snapshot, r: CoverageResult, path: string, key: string, column = vscode.ViewColumn.Active): Promise<void> {
    const f = r.files.get(path);
    const b = f?.blocks.get(key);
    const ctx = this.diffContext();
    if (!f || !b || !ctx) return;
    if (f.whole || b.move) {
      // No range: a whole file, or a move group (its first file's diff).
      const pair = this.diffUris(s, f.entry);
      if (!pair) {
        void vscode.window.showInformationMessage(`${plainForMessage(path, 100)} (${b.move ? 'moved' : WHOLE_WORDS[f.whole!]}) counts as one change; its path isn't read from disk. Cover it with a trivialFiles glob.`);
        return;
      }
      await vscode.commands.executeCommand('vscode.diff', pair.left, pair.right, pair.title, { preview: true, viewColumn: column });
      return;
    }
    const side: SideKey = b.new ? { path, side: 'head' } : { path: f.entry.oldPath ?? path, side: 'base' };
    const range = b.new ?? b.old ?? { start: b.newAt, end: b.newAt };
    await openTarget(ctx, { ...side, range }, undefined, { moveCursor: true, viewColumn: column, preserveFocus: false, mode: 'diff' });
  }

  /** What the active tab and cursor are: unchanged since the last walk means "continue after its target". */
  private walkSignature(): string {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const input = tab?.input as { uri?: vscode.Uri; original?: vscode.Uri; modified?: vscode.Uri } | undefined;
    const ed = vscode.window.activeTextEditor;
    return JSON.stringify([tab?.label, input?.uri?.toString(), input?.original?.toString(), input?.modified?.toString(), ed?.document.uri.toString(), ed?.selection.active.line]);
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
        // Changes with no lines (a move, a whole file) sit before the file's lines, so a line-1 edit is its own stop.
        if (b && !isDone(c.state)) list.push({ path, key: c.key, pos: walkPos(b, !!f.whole) });
      }
    }
    if (!list.length) {
      vscode.window.setStatusBarMessage(everyChangeMessage(r), 5000);
      return;
    }
    const rank = fileRanks([...r.files.keys()], this.stepFiles(s, r));
    const place = this.activePlace(s);
    let at: { path: string; pos: number; key?: string } | undefined;
    const last = this.lastWalk;
    if (last && last.snapshot === s && last.sig === this.walkSignature() && list.some((x) => x.path === last.target.path && x.key === last.target.key)) {
      // Nothing moved since the last walk (a whole-file diff has no cursor to read): continue after its target.
      at = { path: last.target.path, pos: last.target.pos, key: last.target.key };
    } else if (place) {
      const line = place.editor.selection.active.line + 1;
      const f = r.files.get(place.entry.path);
      at = { path: place.entry.path, pos: f && lineless(f) ? 0 : place.key.side === 'base' && f?.diff ? oldToNew(f.diff, line) : line };
    }
    const next = nextChange(list, rank, at, dir);
    if (!next) return;
    if (next.wrapped) vscode.window.setStatusBarMessage(dir === 1 ? 'Back to the first unexplained change' : 'Back to the last unexplained change', 3000);
    await this.openChange(s, r, next.target.path, next.target.key, place?.editor.viewColumn);
    this.lastWalk = { snapshot: s, target: next.target, sig: this.walkSignature() };
  }

  private async moveFile(dir: 1 | -1): Promise<void> {
    const s = await this.current();
    if (!s) {
      vscode.window.setStatusBarMessage('No comparison with a base here', 3000);
      return;
    }
    // Files whose working tree side Sidestory won't open (a Windows device name, `a.`) are skipped; an unstaged
    // rename coverage paired is one file (its renamed entry), not a deletion and an untracked file.
    const paired = this.result(s)?.paired;
    const order = s.entries
      .filter((e) => !(e.status === 'D' && paired?.has(e.path)))
      .map((e) => (e.status === 'A' ? (this.pairedEntry(s, { path: e.path, side: 'head' }) ?? e) : e))
      .filter((e) => headSideReadable(s.mode, e))
      .sort((a, b) => comparePaths(a.path, b.path));
    if (!order.length) {
      vscode.window.setStatusBarMessage('No changed files', 3000);
      return;
    }
    const place = this.activePlace(s);
    const from = place?.entry.path;
    const r = step(order.length, from ? order.findIndex((e) => e.path === from) : -1, dir);
    if (!r) return;
    if (r.wrapped && order.length > 1) vscode.window.setStatusBarMessage(dir === 1 ? 'Back to the first changed file' : 'Back to the last changed file', 3000);
    const pair = this.diffUris(s, order[r.index]!);
    if (!pair) return;
    const { left, right, title } = pair;
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true, ...(place?.editor.viewColumn ? { viewColumn: place.editor.viewColumn } : {}) });
  }

  // ---- switching between a file and its merge diff (§7.1) ----

  /**
   * `sidestory.changes.comparable`, for **Open Changes with Base** in the editor's title bar (as the git extension's
   * Open Changes): the documents (by `resourcePath`, as the title bar's context has it) whose file has a merge diff
   * worth opening: modified or renamed, both sides. Not a file the branch added or deleted: its diff is one colour.
   * A side counts only when the command resolves it to that entry too (`entryFor`), so the button never shows where
   * the command would refuse. VS Code evaluates the title bar for the focused editor, so, as git's Open Changes, the
   * button shows while the file's editor has focus; the palette command also finds the step's editor from a panel.
   * (A `sidestory-git:` document at another commit has the same path and gets the button too; the command then opens
   * the comparison's diff of that file.)
   */
  private updateComparable(): void {
    const s = this.snapshot;
    const paired = s && this.result(s)?.paired;
    if (this.comparableFor.s !== s || this.comparableFor.paired !== paired) {
      this.comparableFor = { s, paired };
      const keys: string[] = [];
      for (const e of s?.entries ?? []) {
        const entry = e.status === 'A' && s ? (this.pairedEntry(s, { path: e.path, side: 'head' }) ?? e) : e;
        if (!s || !hasTwoSides(entry)) continue;
        try {
          const pair = this.diffUris(s, entry);
          if (!pair) continue;
          if (this.entryFor(s, { path: entry.oldPath ?? entry.path, side: 'base' }) === entry) keys.push(resourcePath(pair.left));
          if (this.entryFor(s, { path: entry.path, side: 'head' }) === entry) keys.push(resourcePath(pair.right));
        } catch {
          // an unsafe path: no button
        }
      }
      this.comparableKeys = keys;
      this.comparableBaseSig = keys.join('\0');
    }
    // The open files too, as their editors spell them: a root git spells otherwise (case on Windows, a symlink) still
    // resolves through `keyOf`, as the command does.
    const shown = new Set(this.comparableKeys);
    const extra: string[] = [];
    for (const ed of s ? vscode.window.visibleTextEditors : []) {
      const k = resourcePath(ed.document.uri);
      if (shown.has(k)) continue;
      const key = this.keyOf(s!, ed.document.uri);
      const entry = key && this.entryFor(s!, key);
      if (entry && hasTwoSides(entry)) {
        shown.add(k);
        extra.push(k);
      }
    }
    const keys = extra.length ? [...this.comparableKeys, ...extra] : this.comparableKeys;
    const sig = `${this.comparableBaseSig}\0${extra.join('\0')}`;
    if (sig === this.comparableSig) return;
    this.comparableSig = sig;
    this.comparable = keys;
    setContext('sidestory.changes.comparable', Object.fromEntries(keys.map((k) => [k, true])));
  }

  /** What `comparable` was computed from: a new snapshot, or coverage pairing an unstaged rename, computes it again. */
  private comparableFor: { s: Snapshot | undefined; paired: unknown } = { s: undefined, paired: undefined };
  private comparableKeys: readonly string[] = [];
  private comparableBaseSig = '';
  private comparableSig = '';
  /** The `sidestory.changes.comparable` keys (tests). */
  comparable: readonly string[] = [];

  /**
   * The editor showing `uri` (the title bar's resource): the active one when it does, else a visible plain one. With
   * no `uri` (the palette): the active editor, or from a panel, the one visible plain editor of a comparable file.
   */
  private editorOf(uri: vscode.Uri | undefined): vscode.TextEditor | undefined {
    const active = vscode.window.activeTextEditor;
    if (!uri) {
      if (active) return active;
      const keys = new Set(this.comparable);
      const plain = vscode.window.visibleTextEditors.filter((e) => !inDiffEditor(e) && keys.has(resourcePath(e.document.uri)));
      return plain.length === 1 ? plain[0] : undefined;
    }
    const key = uri.toString();
    if (active?.document.uri.toString() === key) return active;
    return vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === key && !inDiffEditor(e));
  }

  /**
   * Open Changes with Base: the merge diff of the file in the editor (`uri` from the title bar, else the active
   * editor), in its column, at its cursor and scroll position, on the side it showed (a read-only old file: the left).
   */
  private async openChangesOf(uri: vscode.Uri | undefined): Promise<void> {
    const s = this.snapshot;
    const ed = this.editorOf(uri);
    const doc = uri ?? ed?.document.uri;
    const key = s && doc ? this.keyOf(s, doc) : undefined;
    const entry = s && key ? this.entryFor(s, key) : undefined;
    const pair = s && entry && hasTwoSides(entry) ? this.diffUris(s, entry) : undefined;
    if (!key || !pair) {
      if (!doc) {
        vscode.window.setStatusBarMessage('Open Changes with Base: click into the file’s editor first', 3000);
        return;
      }
      const why = entry?.status === 'A' ? 'the branch added this file: its diff would be all new lines' : entry?.status === 'D' ? 'the branch deleted this file' : 'this file has no changes from the base';
      vscode.window.setStatusBarMessage(`Nothing to compare: ${why}`, 3000);
      return;
    }
    const { left, right, title } = pair;
    const selection = ed?.selection;
    const top = ed?.visibleRanges[0];
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true, viewColumn: ed?.viewColumn ?? vscode.ViewColumn.Active });
    const side = await editorFor(key.side === 'base' ? left : right, 1000, { left, right });
    if (side) {
      if (selection) side.selection = selection;
      if (top) side.revealRange(top, vscode.TextEditorRevealType.AtTop);
      return;
    }
    // The left side of an inline diff has no editor: the old line's place on the right.
    const map = s && entry ? this.result(s)?.files.get(entry.path)?.diff : undefined;
    const onRight = key.side === 'base' && selection && map ? await editorFor(right, 300, { left, right }) : undefined;
    if (onRight && selection && map) {
      const line = oldToNew(map, selection.active.line + 1) - 1;
      onRight.selection = new vscode.Selection(line, 0, line, 0);
      onRight.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  }

  /**
   * Open File from a diff (`uri`: its right side, from the title bar; else the active diff tab's). In the title bar
   * only for a right side from git (committed mode): with the working tree file on the right, the git extension's own
   * Open File shows there; the palette has it for any diff of a changed file. The right side's document in a plain
   * editor, at the cursor: the right side's, or the left side's line mapped to the new lines.
   */
  private async openFileOf(uri: vscode.Uri | undefined): Promise<void> {
    const s = this.snapshot;
    const active = vscode.window.activeTextEditor;
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    const target = uri ?? (tab instanceof vscode.TabInputTextDiff && tab.modified.scheme !== EMPTY_SCHEME ? tab.modified : undefined);
    if (!target) {
      vscode.window.setStatusBarMessage('No file to open here (a file the branch deleted has none)', 3000);
      return;
    }
    let selection: vscode.Selection | undefined;
    let top: vscode.Range | undefined;
    if (active?.document.uri.toString() === target.toString()) {
      selection = active.selection;
      top = active.visibleRanges[0];
    } else if (active && s) {
      // The left side: its cursor line on the new side.
      const key = this.keyOf(s, active.document.uri);
      const entry = key?.side === 'base' ? this.entryFor(s, key) : undefined;
      const map = entry ? this.result(s)?.files.get(entry.path)?.diff : undefined;
      // Without coverage's line map (no sidestory counts on the branch), the same line number.
      const line = map ? oldToNew(map, active.selection.active.line + 1) - 1 : active.selection.active.line;
      if (entry) selection = new vscode.Selection(line, 0, line, 0);
    }
    // With a scroll position to keep, the cursor goes in without showTextDocument's own reveal: one scroll, not two.
    const ed = await vscode.window.showTextDocument(target, { viewColumn: active?.viewColumn ?? vscode.ViewColumn.Active, preview: false, ...(top ? {} : { selection }) });
    if (top) {
      if (selection) placeCursor(ed, selection.active.line);
      ed.revealRange(top, vscode.TextEditorRevealType.AtTop);
    }
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
      ...(r?.belonging.length && r.unsupportedLeft?.length ? { unsupported: r.unsupportedLeft.map((p) => `${displayText(p, 120)}${trivialGlobFor(p) ? '' : ' (no trivialFiles glob can match it)'}`) } : {}),
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
  changesOf(file: vscode.Uri): { path: string; open: { key: string; label: string; state: ChangeCoverage['state']; c: ChangeCoverage; whole?: boolean; detail?: string }[]; needsLook: Set<string>; notes: { label: string; tooltip: string }[] } | undefined {
    const s = this.snapshot;
    const r = this.result(s);
    if (!s || !r?.belonging.length) return undefined;
    const path = this.pathOf(file);
    const f = path ? r.files.get(path) : undefined;
    if (!path || !f?.coverage) return undefined;
    const open: { key: string; label: string; state: ChangeCoverage['state']; c: ChangeCoverage; whole?: boolean; detail?: string }[] = [];
    const notes: { label: string; tooltip: string }[] = [];
    const needsLook = new Set<string>();
    // What a move group moved, listed wherever its change is shown (§5.1), covered or not.
    const files = (g: MoveGroup) => displayText(moveFiles(g, 20), 4000);
    if (f.movedWith) {
      const carrier = r.files.get(f.movedWith);
      const g = carrier?.move;
      const state = carrier?.coverage?.changes.find((c) => carrier.blocks.get(c.key)?.move)?.state;
      notes.push({ label: `moved with ${displayText(f.movedWith, 80)} · 1 change for the group`, tooltip: `${g ? `${displayText(moveLabel(g), 200)}: ${files(g)}` : ''}${state ? `\n${isDone(state) ? state : 'not explained yet'}` : ''}` });
    }
    for (const c of f.coverage.changes) {
      const b = f.blocks.get(c.key);
      // A whole-file change is named by its kind ("binary file"), not by lines it doesn't have.
      const label = b?.move ? displayText(moveLabel(b.move), 120) : f.whole ? WHOLE_WORDS[f.whole] : b && changeLabel(b);
      const detail = b?.move ? `${files(b.move)}${c.uncoveredFiles?.length && c.uncoveredFiles.length < b.move.files.length ? `\nWithout a step or their own trivial mark: ${displayText(c.uncoveredFiles.slice(0, 20).join(', '), 2000)}` : ''}` : undefined;
      if (b && label && !isDone(c.state)) open.push({ key: c.key, label, state: c.state, c, ...(f.whole && !b.move ? { whole: true } : {}), ...(detail ? { detail } : {}) });
      else if (b?.move && label) notes.push({ label: `${label} · ${c.state}`, tooltip: detail ?? '' });
      for (const n of c.needsLook ?? []) {
        const dir = r.belonging.find((x) => x.folder === n.sidestory)?.dir;
        if (dir) needsLook.add(`${dir.toString()}\0${n.anchor}`);
      }
    }
    return { path, open, needsLook, notes };
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
    let groupNote: string | undefined;
    const named = arg && typeof arg === 'object' && typeof (arg as { key?: unknown }).key === 'string';
    // A change not done yet: named, at the cursor, or one the selection touches.
    const one = await this.changeFrom(s, r, arg);
    const whole = one && !one.b.move ? r?.files.get(one.path)?.whole : undefined;
    if (whole) {
      void vscode.window.showInformationMessage(`${plainForMessage(one!.path, 100)} counts as one change as a whole (${WHOLE_WORDS[whole]}): a trivial mark can't cover it. Add a narrow trivialFiles glob for it to the sidestory's manifest.`);
      return;
    }
    if (one?.b.move) {
      // A trivial mark covers only its own file's move (§5.1): mark the move of the cursor's file (else the group's
      // first), on its first non-blank line no change touches, so the mark explains nothing else.
      const g = one.b.move;
      const prompt = 'Copy Prompt: Explain This Change asks for one sentence on the move in a step';
      const preferred = place && g.files.some((x) => x.path === place.entry.path) ? place.entry.path : one.path;
      // A file already covered isn't marked again: the first file still without cover is.
      const { path, rest } = moveMarkTarget(preferred, g.files.map((x) => x.path), one.c.uncoveredFiles);
      const fr = r?.files.get(path);
      const touched = [...(fr?.blocks.values() ?? [])].flatMap((b) => (b.new ? [b.new] : []));
      const text = await this.sideText(s, { path, side: 'head' });
      const line = text === undefined ? -1 : textLines(text).findIndex((l, i) => l.trim() !== '' && !touched.some((x) => i + 1 >= x.start && i + 1 <= x.end));
      if (line < 0) {
        void vscode.window.showInformationMessage(`${plainForMessage(path, 100)} has no unchanged line to put a trivial mark on. ${prompt}.`);
        return;
      }
      target = { path, side: 'head', range: { start: line + 1, end: line + 1 } };
      // The other files of a group still need their own mark, or one step covers them all.
      groupNote = moveMarkNote(rest.map((p) => plainForMessage(p, 80)));
    } else if (one && !named && place && !place.editor.selection.isEmpty) {
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
    const entry = this.entryFor(s, target);
    if (entry && !headSideReadable(s.mode, entry)) {
      void vscode.window.showInformationMessage('This file’s path isn’t one Sidestory reads from disk (a Windows device name, or a name ending in a dot or a space): list it in trivialFiles instead.');
      return;
    }
    const text = await this.sideText(s, target);
    if (text === undefined) return;
    try {
      const written = await markTrivial(s, r?.belonging ?? [], { ...target, text });
      if (written) this.scheduleCoverage(500);
      if (written && groupNote) void vscode.window.showInformationMessage(groupNote);
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
    const pair = e && this.diffUris(s, e);
    if (!pair) return undefined;
    const { left, right } = pair;
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
        void vscode.window.showWarningMessage(`“${plainForMessage(spec, 60)}” isn't a branch, tag or commit in this repository (not fetched?). The base wasn't changed.`);
        return;
      }
      await this.setPick(repo, branch, spec);
      // A new pick (or none): the sidestory base may be latched again from scratch, with its one refresh.
      this.latchRefreshedFor = undefined;
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
        void vscode.window.showWarningMessage(`“${plainForMessage(typed, 60)}” isn't a branch name Sidestory can use.`);
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
    'sidestory.changes.openChangesWithBase': (arg?: unknown) => this.openChangesOf(arg instanceof vscode.Uri ? arg : undefined),
    'sidestory.changes.openFile': (arg?: unknown) => this.openFileOf(arg instanceof vscode.Uri ? arg : undefined),
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
      const move = c.b.move;
      const whole = move ? undefined : got.r.files.get(c.path)?.whole;
      const file = c.b.new || whole || move ? c.path : (c.entry.oldPath ?? c.path);
      const kind = whole || move ? (c.entry.status === 'A' ? 'added' : c.entry.status === 'D' ? 'removed' : 'replaced') : changeKind(c.b);
      const lines = whole ? `whole file, ${WHOLE_WORDS[whole]}` : move ? (move.files.length === 1 ? 'moved' : `moved (${move.files.length} files)`) : changeLabel(c.b);
      const moved = move && (move.files.length === 1 ? { from: move.files[0]!.oldPath, to: move.files[0]!.path } : { from: move.from || '.', to: move.to || '.' });
      await this.copy(changePrompt({ sidestory: b?.folder, base: b?.manifest.base ?? got.s.base.spec, file, lines, kind, ...(whole ? { whole: true } : {}), ...(moved ? { moved } : {}) }));
    },
    'sidestory.changes.copyUnsupported': async () => {
      const r = this.result();
      const paths = r?.unsupportedLeft ?? [];
      if (!paths.length) return;
      // One valid trivialFiles glob per path (`?` for each character a glob refuses), as JSON strings to paste.
      // Relative to the folder holding .sidestory/ when exactly one sidestory belongs (its trivialFiles are).
      const prefix = r?.belonging.length === 1 ? r.belonging[0]!.prefix : '';
      const rel = (p: string) => (!prefix ? p : p.startsWith(`${prefix}/`) ? p.slice(prefix.length + 1) : undefined);
      const globs = paths
        .map((p) => {
          const x = rel(p);
          return x === undefined ? undefined : trivialGlobFor(x);
        })
        .filter((g): g is string => g !== undefined);
      const none = paths.length - globs.length;
      if (globs.length) await vscode.env.clipboard.writeText(JSON.stringify(globs, null, 2));
      void vscode.window.showInformationMessage(
        `${globs.length ? `Copied ${globs.length} trivialFiles ${globs.length === 1 ? 'glob' : 'globs'} (relative to ${prefix ? `${plainForMessage(prefix, 60)}/, where the sidestory is` : r && r.belonging.length > 1 ? 'the repository root; for a sidestory in a subfolder, make them relative to that folder' : 'the repository root'}).` : ''}${none ? ` ${none} ${none === 1 ? 'path has' : 'paths have'} no trivialFiles glob that can match ${none === 1 ? 'it' : 'them'}: rename ${none === 1 ? 'it' : 'them'}.` : ''}`.trim(),
      );
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
      if (m && f.move) m.tooltip = `${m.tooltip} · ${displayText(moveLabel(f.move), 120)}: ${displayText(moveFiles(f.move, 10), 2000)}`;
      // An edited file of a group another file carries: its own changes, and where its move is counted.
      if (m && f.movedWith) m.tooltip = `${m.tooltip} · moved with ${displayText(f.movedWith, 120)} · 1 change for the group`;
      if (m) out.set(path, m);
      else if (f.movedWith) out.set(path, { badge: '', tooltip: `moved with ${displayText(f.movedWith, 120)} · 1 change for the group` });
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
    const r = this.svc.result(s);
    const next = CoverageDecorations.marksOf(r);
    const changed: vscode.Uri[] = [];
    const nextUris = new Map<string, vscode.Uri[]>();
    for (const [path, m] of next) {
      // The entry coverage counted (marks come from its files): a paired unstaged rename's R entry, so its diff's left
      // side is decorated too. One lookup per path.
      const e = r?.files.get(path)?.entry;
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
    const d = new vscode.FileDecoration(m.badge || undefined, m.tooltip, m.color ? new vscode.ThemeColor(COVERAGE_COLORS[m.color]) : undefined);
    d.propagate = false;
    return d;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.emitter.dispose();
  }
}
