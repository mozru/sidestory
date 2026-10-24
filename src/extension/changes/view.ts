// The Changes view (docs/CHANGES-PLAN.md §9.1–§9.5, §9.7–§9.9, release 1a): the branch's merge diff as a file
// navigator, with no sidestory needed. It owns the comparison for the chosen repository, the tree, the title bar
// (description, message, toggles), the states, and the commands: open a file's merge diff, next/previous changed
// file, Open All Changes, the base picker, the filter. Release 1b adds the coverage layer on top (§9.6): the
// belonging sidestories' rows, coverage marks, change items, Next/Previous Unexplained Change, the copied prompts,
// Mark as Trivial, unexplained marks in diffs (§7.3), and the comparison sessions use for steps (`diffContext`).
import * as vscode from 'vscode';
import { displayText, escapeIcons, plainForMessage } from '../../core/display-text.ts';
import { AVAILABLE_KEY } from '../bootstrap-shared.ts';
import { log } from '../log.ts';
import { COMMIT_INPUT, FULL_SHA, isValidBase } from './base.ts';
import type { Mode, Snapshot } from './comparison.ts';
import { chooseRepository, Comparison } from './comparison.ts';
import type { ApiState, GitApi, GitRepo } from './git-api.ts';
import { configValue, gitApi, refReader, relPath } from './git-api.ts';
import { ChangeDecorations, emptyUri, EMPTY_SCHEME, GitFileSystem, gitUri, GIT_SCHEME, parseGitUri, RepoIds } from './git-fs.ts';
import type { ChangeEntry, SortKey } from './model.ts';
import { baseName, commitsLabel, countLines, filterEntries, patchCounts, MAX_LISTED, parseFilter, short, SORT_KEYS, step } from './model.ts';
import type { ChangesNode, Layer, LayerRow } from './tree.ts';
import { ChangesTree } from './tree.ts';
import { decodePair, oldToNew, type ChangeBlock } from '../../core/hunks.ts';
import type { ChangeCoverage, FileCoverage } from '../../core/coverage.ts';
import { changeKind, changeLabel, isDone, totalsLabel } from './coverage-labels.ts';
import type { CoverageResult } from './coverage-service.ts';
import { CoverageService } from './coverage-service.ts';
import type { DiffContext } from './open.ts';
import { openTarget } from './open.ts';
import { changePrompt, COPIED, explainBranchPrompt, updatePrompt } from './prompts.ts';
import type { SideKey } from './targets.ts';
import { markTrivial } from './trivial.ts';
import type { SessionDiffs } from '../session.ts';

export const VIEW_ID = 'sidestory.changes';
const KEYS = {
  listMode: 'sidestory.changes.listMode',
  sort: 'sidestory.changes.sort',
  filter: (mode: Mode) => `sidestory.changes.filter.${mode}`,
  uncommitted: 'sidestory.changes.includeUncommitted',
  picks: 'sidestory.changes.picks',
  recent: 'sidestory.changes.recentBases',
  repo: 'sidestory.changes.repository',
  onlyUnexplained: 'sidestory.changes.onlyUnexplained',
  noSuggest: 'sidestory.changes.noExplainSuggestion',
} as const;
const MAX_PICKS = 50;
const MAX_RECENT = 10;
const OPEN_ALL_CAP = 500;
/**
 * Files without counts from the list (untracked files, which numstat doesn't see, and every file when the API has no
 * numstat call) get counted one by one, in view order: at most this many, untracked ones up to this size.
 */
const COUNT_LATER = { files: 2000, bytes: 2 * 1024 * 1024, parallel: 4 } as const;

type State = 'untrusted' | 'missing' | 'disabled' | 'noRepo' | 'loading' | 'noCommits' | 'noBase' | 'baseNotFound' | 'noMergeBase' | 'onBase' | 'noChanges' | 'filteredOut' | 'error' | 'ready';

const setContext = (key: string, value: unknown) => void vscode.commands.executeCommand('setContext', key, value);
const name = (s: string, max = 60) => displayText(s, max);

export class ChangesView implements vscode.Disposable {
  private readonly context: vscode.ExtensionContext;
  private readonly memento: vscode.Memento;
  readonly ids: RepoIds;
  readonly tree = new ChangesTree();
  readonly view: vscode.TreeView<ChangesNode>;
  private readonly subscriptions: vscode.Disposable[] = [];
  private api: GitApi | undefined;
  private initializing: Promise<void> = Promise.resolve();
  private comparison: Comparison | undefined;
  private comparisonSubs: vscode.Disposable[] = [];
  private apiSubs: vscode.Disposable[] = [];
  private stateKey: State | undefined;
  private shownPaths = new Set<string>();
  private filterText = '';
  /** Our own reveals change the selection: those never open a diff (openOnSelect). */
  private revealing = false;
  private lastOpened: { path: string; at: number } | undefined;
  /** The comparison and epoch counted last (epochs restart with each comparison). */
  private counted: { comparison: Comparison; epoch: number } | undefined;
  /** The last path opened because the selection moved (openOnSelect): a refresh re-selecting it opens nothing. */
  private lastSelected: string | undefined;
  /** Counts of files on disk by (merge-base, path, size, time): kept while a file doesn't change. */
  private readonly diskCounts = new Map<string, { added?: number; removed?: number; noText?: boolean }>();
  /** The merge-base rendered last: a new one starts expanded again after Collapse All. */
  private renderedBase: string | undefined;
  private repaintTimer: ReturnType<typeof setTimeout> | undefined;
  /** For tests and the perf smoke: how long the last render took. */
  readonly stats = { renders: 0, lastRenderMs: 0, files: 0 };
  /** Coverage of the comparison by the sidestories that belong to it (§6). */
  readonly coverage: CoverageService;
  /** The workspace's sidestory folders (the index), set by the extension. */
  sidestoryDirs: () => vscode.Uri[] = () => [];
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
  /** The change Next/Previous Unexplained Change moved to last. */
  private lastChange: { path: string; key: string } | undefined;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.memento = context.workspaceState;
    this.ids = new RepoIds(context.globalState);
    this.view = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: this.tree, canSelectMany: false });
    this.coverage = new CoverageService({ snapshot: () => this.snapshot, order: () => this.tree.order.map((e) => e.path), sidestoryDirs: () => this.sidestoryDirs() });
    this.subscriptions.push(
      this.coverage,
      this.diffsEmitter,
      this.unexplainedType,
      this.coverage.onDidChange(() => {
        this.render();
        this.paintUnexplained();
        this.diffsEmitter.fire();
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.paintUnexplained()),
      this.tree,
      this.view,
      GitFileSystem.register(this.ids),
      vscode.window.registerFileDecorationProvider(new ChangeDecorations()),
      this.view.onDidChangeVisibility(() => {
        this.updateActive();
        this.coverage.want('view', this.view.visible);
        const snap = this.snapshot;
        if (this.view.visible && snap && this.comparison) this.countLater(snap, this.comparison.epoch);
      }),
      this.view.onDidChangeSelection((e) => this.onSelect(e.selection)),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateActiveFile()),
      vscode.window.tabGroups.onDidChangeTabs(() => this.updateActiveFile()),
      vscode.workspace.onDidGrantWorkspaceTrust(() => void this.init()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('sidestory.changes.defaultBase') || e.affectsConfiguration('sidestory.changes.includeUncommitted')) {
          // Filters are kept per mode: the mode may have changed with the setting.
          this.filterText = this.memento.get<string>(KEYS.filter(this.mode()), '') ?? '';
          this.syncToggles();
          if (this.view.visible) void this.comparison?.refresh(true);
          else this.comparison?.invalidate();
        }
        if (e.affectsConfiguration('sidestory.changes.suggestExplain')) this.render();
        if (e.affectsConfiguration('sidestory.changes.markUnexplained')) this.paintUnexplained();
      }),
    );
    this.filterText = this.memento.get<string>(KEYS.filter(this.mode()), '') ?? '';
    this.syncToggles();
    this.setState('loading');
    this.coverage.want('view', this.view.visible);
    this.initializing = this.init();
  }

  // ---- settings and remembered choices ----

  private mode(): Mode {
    const remembered = this.memento.get<boolean>(KEYS.uncommitted);
    const on = remembered ?? vscode.workspace.getConfiguration('sidestory.changes').get<boolean>('includeUncommitted', true);
    return on ? 'workingTree' : 'committed';
  }
  private listMode(): boolean {
    return this.memento.get<boolean>(KEYS.listMode, false) ?? false;
  }
  private sort(): SortKey {
    const s = this.memento.get<string>(KEYS.sort);
    return SORT_KEYS.includes(s as SortKey) ? (s as SortKey) : 'path';
  }
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
  private syncToggles(): void {
    setContext('sidestory.changes.listMode', this.listMode());
    setContext('sidestory.changes.includeUncommitted', this.mode() === 'workingTree');
    setContext('sidestory.changes.filtered', !!this.filterText);
  }

  // ---- the git API and the repository ----

  private async init(): Promise<void> {
    this.apiSubs.forEach((d) => d.dispose());
    this.apiSubs = [];
    const s: ApiState = await gitApi();
    if (s.kind !== 'ok') {
      this.api = undefined;
      this.useRepo(undefined);
      this.setState(s.kind === 'untrusted' ? 'untrusted' : s.kind === 'missing' ? 'missing' : 'disabled');
      if (s.kind === 'disabled' && s.ext) this.apiSubs.push(s.ext.onDidChangeEnablement(() => void this.init()));
      return;
    }
    this.api = s.api;
    this.apiSubs.push(
      s.ext.onDidChangeEnablement(() => void this.init()),
      s.api.onDidOpenRepository(() => this.pickRepo()),
      s.api.onDidCloseRepository((r) => {
        this.ids.forget(r);
        if (this.comparison?.repo === r) this.useRepo(undefined);
        this.pickRepo();
      }),
      s.api.onDidChangeState(() => this.pickRepo()),
    );
    this.pickRepo();
  }

  private pickRepo(): void {
    const api = this.api;
    if (!api) return;
    if (this.comparison && api.repositories.includes(this.comparison.repo)) {
      this.render(); // the repository row may have appeared
      return;
    }
    const repo = chooseRepository(api, this.memento.get<string>(KEYS.repo));
    if (!repo) {
      this.useRepo(undefined);
      this.setState(api.state === 'initialized' ? 'noRepo' : 'loading');
      return;
    }
    this.useRepo(repo);
  }

  private useRepo(repo: GitRepo | undefined): void {
    this.comparisonSubs.forEach((d) => d.dispose());
    this.comparisonSubs = [];
    this.comparison = undefined;
    this.tree.resetExpansion();
    if (!repo) {
      this.tree.set(undefined);
      setContext('sidestory.changes.hasFiles', false);
      this.updateTitle();
      return;
    }
    const c = new Comparison(repo, {
      pick: (branch) => this.picks().find(([k]) => k === this.pickKey(repo, branch))?.[1],
      mode: () => this.mode(),
      setting: () => vscode.workspace.getConfiguration('sidestory.changes').get<string>('defaultBase')?.trim() || undefined,
    });
    this.comparison = c;
    this.comparisonSubs.push(
      c,
      c.onDidChange(() => {
        this.render();
        this.coverage.schedule();
        this.diffsEmitter.fire();
      }),
    );
    this.setState('loading');
    this.updateActive();
  }

  /** Only a visible view recomputes (§9.1); a command that needs the comparison activates it itself. */
  private updateActive(): void {
    if (this.comparison) this.comparison.active = this.view.visible;
  }

  /** The current comparison's files, recomputed first when stale (commands run while the view is hidden). */
  private async current(): Promise<Snapshot | undefined> {
    const c = this.comparison;
    if (!c) return undefined;
    c.active = true;
    await c.settled();
    if (!this.view.visible) c.active = false;
    return c.snapshot;
  }

  get snapshot(): Snapshot | undefined {
    return this.comparison?.snapshot;
  }

  /** The first answer to "does this branch have changes?", waiting at most `ms` for git (extension.ts's container rule). */
  async relevantSoon(ms = 30_000): Promise<boolean> {
    const end = Date.now() + ms;
    await this.initializing;
    // The extension that owns the repositories opens them after it starts.
    while (!this.comparison && this.api && this.api.state !== 'initialized' && Date.now() < end) await new Promise((r) => setTimeout(r, 250));
    if (!this.comparison) return false;
    const s = await Promise.race([this.current(), new Promise<undefined>((r) => setTimeout(() => r(undefined), Math.max(0, end - Date.now())))]);
    return !!s?.entries.length;
  }

  /** Whether the Changes view has something to show here (the container's visibility, §9.1). */
  get relevant(): boolean {
    return !!this.snapshot?.entries.length;
  }

  // ---- rendering ----

  private setState(s: State): void {
    if (s === this.stateKey) return;
    this.stateKey = s;
    setContext('sidestory.changes.state', s);
  }

  private render(): void {
    const t0 = Date.now();
    const c = this.comparison;
    const st = c?.state;
    if (!c || !st) return;
    if (st.kind !== 'ready') {
      this.tree.set(undefined);
      this.shownPaths = new Set();
      setContext('sidestory.changes.hasFiles', false);
      this.setState(st.kind === 'error' ? 'error' : st.kind);
      if (st.kind === 'error') log.warn(`Changes: ${st.message}`);
      this.updateTitle();
      this.updateActiveFile();
      return;
    }
    const snap = st.snapshot;
    const filter = parseFilter(this.filterText);
    const result = this.result(snap);
    // Counts from the change blocks where coverage diffed the file (§5.2): exact, renames included.
    if (result) {
      for (const e of snap.entries) {
        const f = result.files.get(e.path);
        if (f && !f.diff.tooLarge && e.added === undefined) {
          e.added = f.entry.added;
          e.removed = f.entry.removed;
        }
      }
    }
    const layer = this.layer(snap, result);
    let entries = filterEntries(snap.entries, filter);
    if (layer && result?.belonging.length && this.onlyUnexplained()) entries = entries.filter((e) => (result.files.get(e.path)?.coverage?.left ?? 0) > 0);
    const multi = (this.api?.repositories.length ?? 0) > 1;
    if (this.renderedBase !== snap.mergeBase) {
      this.renderedBase = snap.mergeBase;
      this.tree.resetExpansion();
    }
    this.tree.set({
      entries,
      listMode: this.listMode(),
      sort: this.sort(),
      onDisk: snap.mode === 'workingTree',
      repoLabel: multi ? baseName(snap.repo.rootUri.path) : undefined,
      layer,
    });
    const own = !!result?.belonging.length;
    setContext('sidestory.changes.layer', own);
    this.view.badge = own && result!.totals.left ? { value: result!.totals.left, tooltip: `${result!.totals.left} ${result!.totals.left === 1 ? 'change' : 'changes'} not explained yet` } : undefined;
    this.shownPaths = new Set(snap.entries.map((e) => e.path));
    this.setState(snap.entries.length ? (entries.length ? 'ready' : 'filteredOut') : snap.onBase ? 'onBase' : 'noChanges');
    setContext('sidestory.changes.hasFiles', snap.entries.length > 0);
    if (snap.entries.length && this.memento.get(AVAILABLE_KEY) === undefined) {
      // The navigator is useful on any branch with changes: keep the container (§9.1).
      void this.memento.update(AVAILABLE_KEY, 'shown');
      setContext('sidestory.available', true);
    }
    this.updateTitle();
    this.updateActiveFile();
    if (this.view.visible) this.countLater(snap, c.epoch);
    this.stats.renders++;
    this.stats.files = snap.entries.length;
    this.stats.lastRenderMs = Date.now() - t0;
  }

  private updateTitle(): void {
    const c = this.comparison;
    const st = c?.state;
    const view = this.view;
    if (!c || !st || st.kind !== 'ready') {
      view.description = undefined;
      view.message =
        st?.kind === 'baseNotFound'
          ? `Base “${name(st.spec)}” isn't in this repository. Fetch it, or pick another.`
          : st?.kind === 'noMergeBase'
            ? `${name(st.base.label)} and this branch share no history here. A shallow clone? Run git fetch --unshallow, or pick another base.`
            : st?.kind === 'error'
              ? `Couldn't compare: ${displayText(st.message, 200)}`
              : undefined;
      return;
    }
    const s = st.snapshot;
    const parts: string[] = [];
    if (!s.head.name) parts.push(`detached ${short(s.head.sha)}`);
    parts.push(`vs ${name(s.base.label, 48)} @ ${short(s.mergeBase)}`);
    if (s.commits && (s.commits.count || !s.uncommitted)) parts.push(commitsLabel(s.commits.count, s.commits.capped));
    if (s.uncommitted) parts.push('+ uncommitted');
    const cov = this.result(s);
    if (cov?.belonging.length) parts.push(totalsLabel(cov.totals) + (cov.done < cov.total ? ` · computing ${cov.done} of ${cov.total}` : ''));
    view.description = parts.join(' · ');
    const msg: string[] = [];
    if (c.busy) msg.push('Rebase or merge in progress: showing the last state.');
    if (s.onBase && s.entries.length && s.mode === 'workingTree') msg.push(`Uncommitted changes on ${name(s.base.branch ?? s.base.label)}.`);
    if (s.head.name && s.head.upstream && (s.head.ahead ?? 0) > 0 && (s.head.behind ?? 0) > 0) {
      msg.push(`${name(s.head.name)} and ${name(s.head.upstream)} have diverged (${s.head.ahead} ahead, ${s.head.behind} behind): showing your local branch.`);
    }
    if (s.total > s.entries.length) msg.push(`Showing ${MAX_LISTED.toLocaleString('en-US')} of ${s.total.toLocaleString('en-US')} changed files.`);
    if (s.unsafe) msg.push(`${s.unsafe} changed ${s.unsafe === 1 ? 'file has a path' : 'files have paths'} with control characters, “..”, “.git” or a backslash in them: not listed.`);
    if (s.partialClone) msg.push('Partial clone: no line counts (computing them could download every file).');
    if (this.filterText) {
      const shown = this.tree.order.length;
      msg.push(`Filtered by “${displayText(this.filterText, 60)}”: ${shown.toLocaleString('en-US')} of ${s.entries.length.toLocaleString('en-US')} files`);
    }
    view.message = msg.length ? msg.join(' ') : undefined;
  }

  /** Counts lines the list didn't come with, a few files at a time and in view order, then repaints. */
  private countLater(snap: Snapshot, epoch: number): void {
    const c = this.comparison;
    if (!c || (this.counted?.comparison === c && this.counted.epoch === epoch) || snap.partialClone) return;
    this.counted = { comparison: c, epoch };
    const live = () => this.comparison === c && c.epoch === epoch;
    // Renames and copies: a one-path patch can't pair the two sides, so they stay uncounted here.
    // What the view shows first, then files the filter hides.
    const covered = this.result(snap)?.files;
    const todo = [...new Set([...this.tree.order, ...snap.entries])]
      .filter((e) => e.added === undefined && !e.noText && !covered?.has(e.path) && (e.untracked || e.status === 'A' || e.status === 'M' || e.status === 'D'))
      .slice(0, COUNT_LATER.files);
    if (!todo.length) return;
    for (const e of todo) e.counting = true;
    const repo = snap.repo;
    // A per-file `git diff` runs the user's diff.external: never in the background then (§20.2).
    const external = Promise.all([configValue(repo, 'diff.external'), repo.getGlobalConfig?.('diff.external').catch(() => '')]).then(
      (v) => !!process.env.GIT_EXTERNAL_DIFF || v.some((x) => !!x?.trim()),
    );
    let next = 0;
    const work = async () => {
      while (next < todo.length && live()) {
        const e = todo[next++]!;
        e.counting = false;
        try {
          const uri = vscode.Uri.joinPath(repo.rootUri, ...e.path.split('/'));
          // A file on disk (working tree mode): its count is reused while its size and time stay the same.
          const onDisk = snap.mode === 'workingTree' && e.status !== 'D';
          const st = onDisk ? await vscode.workspace.fs.stat(uri) : undefined;
          const diskKey = st ? `${snap.mergeBase}\n${e.path}\n${st.size}\n${st.mtime}` : '';
          const known = st && this.diskCounts.get(diskKey);
          if (known) {
            Object.assign(e, known);
            continue;
          }
          if (e.untracked) {
            if (!st || st.type !== vscode.FileType.File || st.size > COUNT_LATER.bytes) continue;
            const bytes = await vscode.workspace.fs.readFile(uri);
            if (bytes.subarray(0, 8000).includes(0)) e.noText = true;
            else e.added = countLines(bytes);
            e.removed = 0;
          } else {
            if (await external) continue;
            // At most 2 MB on both sides: a patch is read whole.
            const newSize = e.status === 'D' ? 0 : st ? st.size : (await repo.getObjectDetails(snap.head.sha, uri.fsPath)).size;
            const oldSize = e.status === 'A' ? 0 : (await repo.getObjectDetails(snap.mergeBase, uri.fsPath)).size;
            if (newSize > COUNT_LATER.bytes || oldSize > COUNT_LATER.bytes) continue;
            const patch = snap.mode === 'workingTree' ? await repo.diffWith(snap.mergeBase, uri.fsPath) : await repo.diffBetween(snap.mergeBase, snap.head.sha, uri.fsPath);
            if (!live()) return;
            Object.assign(e, patchCounts(patch));
          }
          const counted = { added: e.added, removed: e.removed, noText: e.noText };
          // Kept by the comparison (dropped while the file is changing) and, for a changing file, by its size and time.
          if (!e.unsaved) c.remember(e.path, counted);
          if (st && !e.unsaved) {
            if (this.diskCounts.size > 5000) this.diskCounts.clear();
            this.diskCounts.set(diskKey, counted);
          }
          this.scheduleRepaint();
        } catch {
          // gone or unreadable: no count
        } finally {
          this.scheduleRepaint();
        }
      }
      for (const e of todo) e.counting = false;
    };
    for (let i = 0; i < COUNT_LATER.parallel; i++) void work();
  }

  private scheduleRepaint(): void {
    this.repaintTimer ??= setTimeout(() => {
      this.repaintTimer = undefined;
      this.tree.repaint();
    }, 500);
  }

  /**
   * The file of the active editor tab: either side of a diff (the empty side of an added or deleted file says
   * nothing), or a plain editor. The tab, not the focused text editor: focus may be in the tree.
   */
  private activePath(): string | undefined {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (input instanceof vscode.TabInputTextDiff) return this.pathOf(input.modified) ?? this.pathOf(input.original);
    if (input instanceof vscode.TabInputText) return this.pathOf(input.uri);
    return this.pathOf(vscode.window.activeTextEditor?.document.uri);
  }

  private updateActiveFile(): void {
    const p = this.activePath();
    setContext('sidestory.changes.activeFileChanged', !!p && this.shownPaths.has(p));
  }

  // ---- the coverage layer (§9.6) ----

  /** The coverage result for this snapshot's merge-base, if computed. */
  private result(s: Snapshot): CoverageResult | undefined {
    const r = this.coverage.result;
    return r && r.mergeBase === s.mergeBase ? r : undefined;
  }

  private onlyUnexplained(): boolean {
    return this.memento.get<boolean>(KEYS.onlyUnexplained, false) ?? false;
  }

  private branchKey(s: Snapshot): string {
    return `${this.ids.idOf(s.repo)}\n${s.head.name ?? s.head.sha}`;
  }

  /** "Copy Prompt: Explain This Branch" is offered: the setting, and not dismissed for this branch. */
  private suggestExplain(s: Snapshot): boolean {
    if (!vscode.workspace.getConfiguration('sidestory.changes').get<boolean>('suggestExplain', true)) return false;
    const off = this.memento.get<string[]>(KEYS.noSuggest) ?? [];
    return !off.includes(this.branchKey(s));
  }

  /** "Retry with jitter › The retry loop": a sidestory's title and the step an anchor is in. */
  private stepName(r: CoverageResult | undefined, folder: string, anchor: string): string {
    const b = r?.belonging.find((x) => x.folder === folder);
    if (!b) return anchor;
    const step = b.stepOf.get(anchor) ?? anchor;
    const title = b.steps.find((x) => x.id === step)?.title ?? step;
    return `${displayText(b.manifest.title, 40)} › ${displayText(title, 40)}`;
  }

  private layer(s: Snapshot, r: CoverageResult | undefined): Layer | undefined {
    const rows: LayerRow[] = [];
    for (const b of r?.belonging ?? []) {
      const steps = b.steps.length;
      rows.push({
        id: `s:${b.folder}`,
        label: displayText(b.manifest.title, 80) || b.folder,
        description: `${totalsLabel({ ...b.totals, left: r!.totals.left })} · ${steps} ${steps === 1 ? 'step' : 'steps'}`,
        tooltip: `${displayText(b.manifest.title, 200)}\n${displayText(b.folder, 200)} · vs ${displayText(b.manifest.base ?? '', 60)}\n${b.totals.explained} explained and ${b.totals.trivial} marked trivial by it; ${r!.totals.left} left on the branch\nClick to open`,
        icon: 'book',
        command: { command: 'sidestory.openAt', title: 'Open Sidestory', arguments: [{ dir: b.dir.toString(), source: 'tree' }] },
        contextValue: 'sidestory',
      });
    }
    if (r?.belonging.length && r.totals.left > 0) {
      rows.push({
        id: 'update',
        label: 'Copy Prompt: Update the Sidestory for New Changes',
        tooltip: `${r.totals.left} ${r.totals.left === 1 ? 'change isn’t' : 'changes aren’t'} explained yet. Copies a prompt for Claude Code (or your agent) to extend the sidestory.`,
        icon: 'sparkle',
        command: { command: 'sidestory.changes.copyUpdatePrompt', title: 'Copy Prompt: Update the Sidestory for New Changes' },
        contextValue: 'updatePrompt',
      });
    }
    if (r && !r.belonging.length && s.entries.length && !s.onBase && this.suggestExplain(s)) {
      rows.push({
        id: 'explain',
        label: 'Copy Prompt: Explain This Branch',
        tooltip: 'Copies a prompt for Claude Code (or your agent) to write a sidestory that explains this branch’s changes, step by step',
        icon: 'sparkle',
        command: { command: 'sidestory.changes.copyExplainPrompt', title: 'Copy Prompt: Explain This Branch' },
        contextValue: 'explainPrompt',
      });
    }
    if (!rows.length && !r?.belonging.length) return undefined;
    const files = new Map<string, { coverage: FileCoverage | undefined; blocks: ReadonlyMap<string, ChangeBlock> }>();
    for (const [p, f] of r?.files ?? []) files.set(p, { coverage: f.coverage, blocks: f.blocks });
    return { rows, files, onlyUnexplained: this.onlyUnexplained(), stepName: (folder, anchor) => this.stepName(r, folder, anchor) };
  }

  /** Unexplained lines in the visible diff sides (§7.3): the right side, the left for removed lines. */
  private paintUnexplained(): void {
    const s = this.snapshot;
    const r = s ? this.result(s) : undefined;
    const on = !!r?.belonging.length && (vscode.workspace.getConfiguration('sidestory.changes').get<boolean>('markUnexplained', false) || this.coverage.wantedBySession);
    for (const ed of vscode.window.visibleTextEditors) {
      const key = on && s ? this.keyOf(s, ed.document.uri) : undefined;
      const ranges: vscode.Range[] = [];
      if (key && r) {
        const path = key.side === 'head' ? key.path : this.entryFor(s!, key)?.path;
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

  /** Changes that aren't done, in view order (§9.3). */
  private openChanges(r: CoverageResult): { path: string; c: ChangeCoverage; b: ChangeBlock; fi: number; pos: number }[] {
    const out: { path: string; c: ChangeCoverage; b: ChangeBlock; fi: number; pos: number }[] = [];
    this.tree.order.forEach((e, fi) => {
      const f = r.files.get(e.path);
      for (const c of f?.coverage?.changes ?? []) {
        const b = f!.blocks.get(c.key);
        if (b && !isDone(c.state)) out.push({ path: e.path, c, b, fi, pos: b.new?.start ?? b.newAt });
      }
    });
    return out.sort((x, y) => x.fi - y.fi || x.pos - y.pos);
  }

  private async moveUnexplained(dir: 1 | -1): Promise<void> {
    const s = await this.current();
    const r = s ? this.result(s) : undefined;
    if (!s || !r?.belonging.length) {
      vscode.window.setStatusBarMessage(r ? 'No sidestory explains this branch yet' : 'Coverage is still being computed', 3000);
      return;
    }
    const list = this.openChanges(r);
    if (!list.length) {
      vscode.window.setStatusBarMessage('Every change is explained or marked trivial', 3000);
      return;
    }
    // From the cursor in the active editor when its file is in the list, else from the change visited last.
    let at: { fi: number; pos: number } | undefined;
    const ed = vscode.window.activeTextEditor;
    const key = ed ? this.keyOf(s, ed.document.uri) : undefined;
    const fi = key ? this.tree.order.findIndex((e) => e.path === (key.side === 'head' ? key.path : this.entryFor(s, key)?.path)) : -1;
    if (ed && key && fi >= 0) {
      const line = ed.selection.active.line + 1;
      const diff = r.files.get(this.tree.order[fi]!.path)?.diff;
      at = { fi, pos: key.side === 'base' && diff ? oldToNew(diff, line) : line };
    } else if (this.lastChange) {
      const i = list.findIndex((x) => x.path === this.lastChange!.path && x.c.key === this.lastChange!.key);
      if (i >= 0) at = list[i]!;
    }
    const cmp = (x: { fi: number; pos: number }) => (at ? x.fi - at.fi || x.pos - at.pos : dir);
    let target = dir === 1 ? list.find((x) => cmp(x) > 0) : [...list].reverse().find((x) => cmp(x) < 0);
    if (!target) {
      target = dir === 1 ? list[0]! : list.at(-1)!;
      if (at) vscode.window.setStatusBarMessage(dir === 1 ? 'Back to the first unexplained change' : 'Back to the last unexplained change', 3000);
    }
    await this.openChange(target.path, target.c.key);
  }

  /** Opens the diff at a change (§9.6: the left side for pure deletions) and selects its row while visible. */
  private async openChange(path: string, key: string): Promise<void> {
    const s = this.snapshot;
    const r = s ? this.result(s) : undefined;
    const f = r?.files.get(path);
    const b = f?.blocks.get(key);
    const ctx = this.diffContext();
    if (!s || !f || !b || !ctx) return;
    this.lastChange = { path, key };
    this.lastOpened = { path, at: Date.now() };
    this.lastSelected = path;
    const side: SideKey = b.new ? { path, side: 'head' } : { path: f.entry.oldPath ?? path, side: 'base' };
    const range = b.new ?? b.old ?? { start: b.newAt, end: b.newAt };
    await openTarget(ctx, { ...side, range }, undefined, { moveCursor: true, viewColumn: vscode.ViewColumn.Active, preserveFocus: false, mode: 'diff' });
    const node = this.tree.changeNode(path, key);
    if (node && this.view.visible) {
      this.revealing = true;
      try {
        await this.view.reveal(node, { select: true, focus: false, expand: true });
      } catch {
        // gone meanwhile
      } finally {
        this.revealing = false;
      }
    }
  }

  /** A change from a tree node or `{ path, key }` of the current comparison; a file gives its first open change. */
  private changeFrom(arg: unknown): { path: string; c: ChangeCoverage; b: ChangeBlock } | undefined {
    const s = this.snapshot;
    const r = s ? this.result(s) : undefined;
    if (!r || !arg || typeof arg !== 'object') return undefined;
    const a = arg as { kind?: string; path?: unknown; key?: unknown; change?: { key?: unknown }; entry?: { path?: unknown } };
    const path = a.path ?? a.entry?.path;
    const key = a.key ?? a.change?.key;
    if (typeof path !== 'string') return undefined;
    const f = r.files.get(path);
    const c = typeof key === 'string' ? f?.coverage?.changes.find((x) => x.key === key) : f?.coverage?.changes.find((x) => !isDone(x.state));
    const b = c ? f?.blocks.get(c.key) : undefined;
    return c && b ? { path, c, b } : undefined;
  }

  /** Opens the step that explains a change (or, for a file, one of its changes; a quick pick when several). */
  private async openStep(arg: unknown): Promise<void> {
    const s = this.snapshot;
    const r = s ? this.result(s) : undefined;
    if (!r) return;
    const one = this.changeFrom(arg);
    const a = arg as { kind?: string; entry?: { path?: string } } | undefined;
    const changes = a?.kind === 'file' && a.entry?.path ? (r.files.get(a.entry.path)?.coverage?.changes ?? []) : one ? [one.c] : [];
    const seen = new Map<string, { dir: string; anchor: string; label: string }>();
    for (const c of changes) {
      if (c.state === 'trivial') continue;
      for (const x of c.by) {
        const b = r.belonging.find((y) => y.folder === x.sidestory);
        if (!b) continue;
        const step = b.stepOf.get(x.anchor) ?? x.anchor;
        seen.set(`${b.folder}\0${step}`, { dir: b.dir.toString(), anchor: step, label: this.stepName(r, b.folder, x.anchor) });
      }
    }
    const list = [...seen.values()];
    if (!list.length) {
      vscode.window.setStatusBarMessage('No step explains this change yet', 3000);
      return;
    }
    const pick = list.length === 1 ? list[0] : await vscode.window.showQuickPick(list.map((x) => ({ label: escapeIcons(x.label), x })), { title: 'Open Explaining Step' }).then((p) => p?.x);
    if (pick) await vscode.commands.executeCommand('sidestory.openAt', { dir: pick.dir, anchor: pick.anchor, source: 'tree' });
  }

  private async copy(text: string): Promise<void> {
    await vscode.env.clipboard.writeText(text);
    void vscode.window.showInformationMessage(COPIED);
  }

  private baseSpec(s: Snapshot): string {
    return s.base.spec;
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

  /** For sessions of sidestories with a base (§11.4): the view's comparison when the base gives its merge-base. */
  readonly sessionDiffs: SessionDiffs = {
    context: async (base, who) => {
      if (!isValidBase(base)) return undefined;
      await this.initializing;
      const s = await this.current();
      if (!s) return undefined;
      const own = await this.coverage.ownMergeBase(s, base);
      if (own !== s.mergeBase) {
        this.coverage.want(who, false);
        return undefined;
      }
      this.coverage.want(who, true);
      return this.diffContext();
    },
    release: (who) => this.coverage.want(who, false),
    onDidChange: this.diffsEmitter.event,
  };

  private entryFor(s: Snapshot, k: SideKey): ChangeEntry | undefined {
    return k.side === 'head' ? s.entries.find((e) => e.path === k.path && e.status !== 'D') : s.entries.find((e) => (e.oldPath ?? e.path) === k.path && e.status !== 'A');
  }

  /** A document as (repo path, side) in this comparison (§8); a commit that is neither side gives nothing. */
  keyOf(s: Snapshot, uri: vscode.Uri): SideKey | undefined {
    if (uri.scheme === 'file') {
      const p = relPath(s.repo, uri);
      return p ? { path: p, side: 'head' } : undefined;
    }
    if (uri.scheme !== GIT_SCHEME) return undefined;
    const g = parseGitUri(this.ids, uri);
    if (!g || g.repo !== s.repo) return undefined;
    if (g.sha === s.mergeBase) return { path: g.path, side: 'base' };
    if (g.sha === s.head.sha) return { path: g.path, side: 'head' };
    return undefined;
  }

  /** The text of a side of a path, for Mark as Trivial: the open document, the file, or the blob. */
  private async sideText(s: Snapshot, k: SideKey): Promise<string | undefined> {
    const uri = this.diffContext()?.uriFor(k);
    if (!uri) return undefined;
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (doc) return doc.getText();
    try {
      const b = await vscode.workspace.fs.readFile(uri);
      return decodePair(b, b).old;
    } catch {
      return undefined;
    }
  }

  private async markTrivialCmd(arg: unknown): Promise<void> {
    const s = await this.current();
    if (!s) return;
    const r = this.result(s);
    let target: { path: string; side: 'head' | 'base'; range: { start: number; end: number } } | undefined;
    const one = this.changeFrom(arg);
    if (one) {
      const entry = r!.files.get(one.path)!.entry;
      target = one.b.new ? { path: one.path, side: 'head', range: one.b.new } : one.b.old ? { path: entry.oldPath ?? one.path, side: 'base', range: one.b.old } : undefined;
    } else {
      // The editor context menu: the selection, on the side it is on.
      const ed = vscode.window.activeTextEditor;
      const key = ed ? this.keyOf(s, ed.document.uri) : undefined;
      if (ed && key && !ed.selection.isEmpty) {
        const end = ed.selection.end.character === 0 && ed.selection.end.line > ed.selection.start.line ? ed.selection.end.line : ed.selection.end.line + 1;
        target = { path: key.path, side: key.side, range: { start: ed.selection.start.line + 1, end } };
      }
    }
    if (!target) {
      void vscode.window.showInformationMessage('Select the changed lines in the diff of this branch (or pick a change in the Changes view), then Mark as Trivial.');
      return;
    }
    const text = await this.sideText(s, target);
    if (text === undefined) return;
    try {
      const written = await markTrivial(s, r?.belonging ?? [], { ...target, text });
      if (written) this.coverage.schedule(500);
    } catch (e) {
      void vscode.window.showErrorMessage(`Couldn't mark it trivial: ${plainForMessage((e as Error).message)}`);
    }
  }

  // ---- URIs ----

  /** A document's repo-relative path in the current comparison: a file, either side of a diff. */
  pathOf(uri: vscode.Uri | undefined): string | undefined {
    const s = this.snapshot;
    if (!uri || !s) return undefined;
    if (uri.scheme === 'file') return relPath(s.repo, uri);
    if (uri.scheme === GIT_SCHEME) {
      const g = parseGitUri(this.ids, uri);
      if (!g || g.repo !== s.repo) return undefined;
      // The left side of a rename names the old path.
      return (g.sha === s.mergeBase ? s.entries.find((e) => e.oldPath === g.path)?.path : undefined) ?? g.path;
    }
    if (uri.scheme === EMPTY_SCHEME) return uri.path.slice(1);
    return undefined;
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

  private async openDiff(e: ChangeEntry, opts: { preserveFocus?: boolean; preview?: boolean; side?: boolean } = {}): Promise<void> {
    const s = this.snapshot;
    if (!s) return;
    const { left, right, title } = this.diffUris(s, e);
    this.lastOpened = { path: e.path, at: Date.now() };
    this.lastSelected = e.path;
    await vscode.commands.executeCommand('vscode.diff', left, right, title, {
      preview: opts.preview ?? true,
      preserveFocus: opts.preserveFocus ?? false,
      ...(opts.side ? { viewColumn: vscode.ViewColumn.Beside } : {}),
    });
  }

  private async openFile(e: ChangeEntry, side = false): Promise<void> {
    const s = this.snapshot;
    if (!s || e.status === 'D') return;
    const uri = s.mode === 'workingTree' ? this.fileUri(s, e.path) : gitUri(this.ids, s.repo, s.head.sha, e.path);
    await vscode.window.showTextDocument(uri, { preview: true, ...(side ? { viewColumn: vscode.ViewColumn.Beside } : {}) });
  }

  // ---- selection and next/previous ----

  private onSelect(selection: readonly ChangesNode[]): void {
    if (this.revealing || selection.length !== 1 || selection[0]!.kind !== 'file') return;
    if (!vscode.workspace.getConfiguration('sidestory.changes').get<boolean>('openOnSelect', false)) return;
    const e = selection[0]!.entry;
    if (this.lastSelected === e.path) return;
    this.lastSelected = e.path;
    // A click also runs the item's command: open once.
    setTimeout(() => {
      if (this.lastOpened?.path === e.path && Date.now() - this.lastOpened.at < 500) return;
      void this.openDiff(e, { preserveFocus: true });
    }, 50);
  }

  /** The entry an item command or menu names: a node of ours or `{ path }` of a file in the current comparison. */
  private entryFrom(arg: unknown): ChangeEntry | undefined {
    const s = this.snapshot;
    if (!s || !arg || typeof arg !== 'object') return undefined;
    const path = (arg as { entry?: { path?: unknown }; path?: unknown }).entry?.path ?? (arg as { path?: unknown }).path;
    if (typeof path !== 'string') return undefined;
    return s.entries.find((e) => e.path === path);
  }

  private async move(dir: 1 | -1): Promise<void> {
    const s = await this.current();
    if (!s) return;
    const order = this.tree.order;
    if (!order.length) {
      vscode.window.setStatusBarMessage(s.entries.length ? 'No changed file matches the filter' : 'No changed files', 3000);
      return;
    }
    const active = this.activePath();
    const selected = this.view.selection[0];
    const fromPath = active && order.some((e) => e.path === active) ? active : selected?.kind === 'file' ? selected.entry.path : undefined;
    const r = step(order.length, fromPath ? order.findIndex((e) => e.path === fromPath) : -1, dir);
    if (!r) return;
    const e = order[r.index]!;
    if (r.wrapped && order.length > 1) vscode.window.setStatusBarMessage(dir === 1 ? 'Back to the first changed file' : 'Back to the last changed file', 3000);
    await this.openDiff(e);
    await this.reveal(e.path);
  }

  /** Selects a file's row (expanding its folders) without focus, and only while the view is visible (§9.3). */
  private async reveal(path: string): Promise<void> {
    const node = this.tree.nodeFor(path);
    if (!node || !this.view.visible) return;
    this.revealing = true;
    try {
      await this.view.reveal(node, { select: true, focus: false, expand: true });
    } catch {
      // the row went away meanwhile
    } finally {
      this.revealing = false;
    }
  }

  // ---- commands ----

  readonly commands: Record<string, (...args: unknown[]) => unknown> = {
    'sidestory.showChanges': async () => {
      if (this.memento.get(AVAILABLE_KEY) === undefined) await this.memento.update(AVAILABLE_KEY, 'shown');
      setContext('sidestory.available', true);
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    },
    'sidestory.changes.open': async (arg?: unknown) => {
      const e = this.entryFrom(arg);
      if (e) await this.openDiff(e);
    },
    'sidestory.changes.openDiff': async (arg?: unknown) => {
      const e = this.entryFrom(arg);
      if (e) await this.openDiff(e, { preview: false });
    },
    'sidestory.changes.openDiffToSide': async (arg?: unknown) => {
      const e = this.entryFrom(arg);
      if (e) await this.openDiff(e, { side: true, preview: false });
    },
    'sidestory.changes.openFile': async (arg?: unknown) => {
      const e = this.entryFrom(arg);
      if (e) await this.openFile(e);
    },
    'sidestory.changes.openFileToSide': async (arg?: unknown) => {
      const e = this.entryFrom(arg);
      if (e) await this.openFile(e, true);
    },
    'sidestory.changes.revealInExplorer': async (arg?: unknown) => {
      const e = this.entryFrom(arg);
      const s = this.snapshot;
      if (e && s && e.status !== 'D') await vscode.commands.executeCommand('revealInExplorer', this.fileUri(s, e.path));
    },
    'sidestory.changes.copyPath': async (arg?: unknown) => {
      const e = this.entryFrom(arg);
      const s = this.snapshot;
      if (e && s) await vscode.env.clipboard.writeText(this.fileUri(s, e.path).fsPath);
    },
    'sidestory.changes.copyRelativePath': async (arg?: unknown) => {
      const e = this.entryFrom(arg);
      if (e) await vscode.env.clipboard.writeText(e.path);
    },
    'sidestory.changes.nextFile': () => this.move(1),
    'sidestory.changes.prevFile': () => this.move(-1),
    'sidestory.changes.openAll': () => this.openAll(),
    'sidestory.changes.refresh': async () => {
      await this.comparison?.refresh(true);
    },
    'sidestory.changes.viewAsList': async () => {
      await this.memento.update(KEYS.listMode, true);
      this.syncToggles();
      this.render();
    },
    'sidestory.changes.viewAsTree': async () => {
      await this.memento.update(KEYS.listMode, false);
      this.syncToggles();
      this.render();
    },
    'sidestory.changes.collapseAll': () => this.tree.collapseAll(),
    'sidestory.changes.sort': async () => {
      const current = this.sort();
      const partial = this.snapshot && !this.snapshot.countsKnown ? ' (partial: some counts are unknown)' : '';
      const items: (vscode.QuickPickItem & { key: SortKey })[] = [
        { key: 'path', label: 'By Path' },
        { key: 'status', label: 'By Status', description: 'added, modified, renamed, deleted' },
        { key: 'size', label: `By Size of Change${partial}`, description: 'lines added plus removed' },
      ];
      for (const i of items) if (i.key === current) i.description = i.description ? `current · ${i.description}` : 'current';
      const pick = await vscode.window.showQuickPick(items, { title: 'Sort Changed Files' });
      if (!pick) return;
      await this.memento.update(KEYS.sort, pick.key);
      this.render();
    },
    'sidestory.changes.filter': () => this.editFilter(),
    'sidestory.changes.clearFilter': () => this.setFilter(''),
    'sidestory.changes.includeUncommitted': () => this.setMode(true),
    'sidestory.changes.committedOnly': () => this.setMode(false),
    'sidestory.changes.pickBase': () => this.pickBase(),
    'sidestory.changes.pickRepository': () => this.pickRepository(),
    'sidestory.changes.fetch': () => this.fetch(),
    // The coverage layer (§9.6, §9.8).
    'sidestory.changes.openChange': async (arg?: unknown) => {
      const c = this.changeFrom(arg);
      if (c) await this.openChange(c.path, c.c.key);
    },
    'sidestory.changes.nextUnexplained': () => this.moveUnexplained(1),
    'sidestory.changes.prevUnexplained': () => this.moveUnexplained(-1),
    'sidestory.changes.onlyUnexplained': async () => {
      await this.memento.update(KEYS.onlyUnexplained, true);
      setContext('sidestory.changes.onlyUnexplained', true);
      this.render();
    },
    'sidestory.changes.showAll': async () => {
      await this.memento.update(KEYS.onlyUnexplained, false);
      setContext('sidestory.changes.onlyUnexplained', false);
      this.render();
    },
    'sidestory.changes.openStep': (arg?: unknown) => this.openStep(arg),
    'sidestory.changes.copyExplainPrompt': async () => {
      const s = await this.current();
      if (!s) {
        void vscode.window.showInformationMessage('Explaining a branch needs a git repository with a base to compare with.');
        return;
      }
      await this.copy(explainBranchPrompt(this.baseSpec(s)));
      if (!this.view.visible) await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    },
    'sidestory.changes.dismissExplain': async () => {
      const s = this.snapshot;
      if (!s) return;
      const off = (this.memento.get<string[]>(KEYS.noSuggest) ?? []).filter((x) => typeof x === 'string');
      await this.memento.update(KEYS.noSuggest, [this.branchKey(s), ...off].slice(0, 200));
      this.render();
    },
    'sidestory.changes.copyUpdatePrompt': async () => {
      const s = this.snapshot;
      const b = s ? this.result(s)?.belonging[0] : undefined;
      if (s && b) await this.copy(updatePrompt(b.folder, b.manifest.base ?? this.baseSpec(s)));
    },
    'sidestory.changes.copyChangePrompt': async (arg?: unknown) => {
      const s = this.snapshot;
      const c = this.changeFrom(arg);
      if (!s || !c) return;
      const b = this.result(s)?.belonging[0];
      const entry = this.result(s)!.files.get(c.path)!.entry;
      const file = c.b.new ? c.path : (entry.oldPath ?? c.path);
      await this.copy(changePrompt({ sidestory: b?.folder, base: b?.manifest.base ?? this.baseSpec(s), file, lines: changeLabel(c.b), kind: changeKind(c.b) }));
    },
    'sidestory.changes.markTrivial': (arg?: unknown) => this.markTrivialCmd(arg),
  };

  private async setMode(include: boolean): Promise<void> {
    await this.memento.update(KEYS.uncommitted, include);
    this.filterText = this.memento.get<string>(KEYS.filter(this.mode()), '') ?? '';
    this.syncToggles();
    await this.comparison?.refresh();
  }

  private async setFilter(text: string): Promise<void> {
    this.filterText = text.trim().slice(0, 200);
    await this.memento.update(KEYS.filter(this.mode()), this.filterText);
    this.syncToggles();
    this.render();
  }

  /** A live filter (§9.5): narrows the view as you type, until Enter; Escape puts the previous filter back. */
  private editFilter(): Promise<void> {
    const before = this.filterText;
    const box = vscode.window.createInputBox();
    box.title = 'Filter Changed Files';
    box.placeholder = 'Part of a path, a glob (src/**/*.ts, *.md), or !text to exclude; every term must match';
    box.value = before;
    box.ignoreFocusOut = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let accepted = false;
    return new Promise((resolve) => {
      box.onDidChangeValue((v) => {
        clearTimeout(timer);
        timer = setTimeout(() => void this.setFilter(v), 100);
      });
      box.onDidAccept(() => {
        accepted = true;
        clearTimeout(timer);
        void this.setFilter(box.value);
        box.hide();
      });
      box.onDidHide(() => {
        clearTimeout(timer);
        if (!accepted) void this.setFilter(before);
        box.dispose();
        resolve();
      });
      box.show();
    });
  }

  /** Open All Changes (§9.3): the multi-diff editor over the files in view order, at most 500. */
  private async openAll(): Promise<void> {
    const s = await this.current();
    if (!s) return;
    const files = this.tree.order.filter((e) => !e.noText || e.unsaved);
    if (!files.length) {
      vscode.window.setStatusBarMessage('No changed files to open', 3000);
      return;
    }
    const shown = files.slice(0, OPEN_ALL_CAP);
    const resources = shown.map((e) => {
      const { left, right } = this.diffUris(s, e);
      return [this.fileUri(s, e.path), e.status === 'A' ? undefined : left, e.status === 'D' ? undefined : right];
    });
    // VS Code adds "(N files)" to the title itself.
    const title = `Changes vs ${name(s.base.branch ?? s.base.label, 40)}`;
    try {
      await vscode.commands.executeCommand('vscode.changes', title, resources);
    } catch (e) {
      void vscode.window.showErrorMessage(`Couldn't open the changes: ${plainForMessage((e as Error).message)}`);
      return;
    }
    if (files.length > shown.length) void vscode.window.showInformationMessage(`Opened the first ${OPEN_ALL_CAP} of ${files.length} changed files.`);
  }

  // ---- the base picker (§9.4) ----

  private async pickBase(): Promise<void> {
    const c = this.comparison;
    if (!c) {
      void vscode.window.showInformationMessage('Changes need a git repository.');
      return;
    }
    const repo = c.repo;
    const head = repo.state.HEAD;
    const branch = head?.name && isValidBase(head.name) ? head.name : 'HEAD';
    type Item = vscode.QuickPickItem & { spec?: string; kind2?: 'default' | 'commit' };
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = 'Compare With';
    qp.placeholder = 'Pick a branch, tag or commit to compare with';
    qp.busy = true;
    qp.matchOnDescription = true;
    let hidden = false;
    const chosenP = new Promise<Item | undefined>((resolve) => {
      qp.onDidAccept(() => resolve(qp.selectedItems[0]));
      qp.onDidHide(() => {
        hidden = true;
        resolve(undefined);
      });
    });
    qp.show();
    const currentSpec = this.picks().find(([k]) => k === this.pickKey(repo, branch))?.[1];
    const items: Item[] = [];
    const def = await c.defaultBase().catch(() => undefined);
    const mb = def && head?.commit ? await repo.getMergeBase(def.sha, head.commit).catch(() => undefined) : undefined;
    items.push({
      label: `$(git-compare) Merge-base with ${escapeIcons(name(def?.label ?? 'main'))}`,
      description: mb && FULL_SHA.test(mb) ? short(mb) : def ? '' : 'not found',
      detail: def ? `The default base. The diff is always from the merge-base${currentSpec ? '' : ' · current'}` : 'No default base here: pick one below',
      kind2: 'default',
    });
    const recent = (this.memento.get<string[]>(KEYS.recent) ?? []).filter((x) => typeof x === 'string' && isValidBase(x));
    if (recent.length) {
      items.push({ label: 'Recent', kind: vscode.QuickPickItemKind.Separator });
      for (const r of recent) items.push({ label: escapeIcons(name(r, 100)), description: r === currentSpec ? 'current' : undefined, spec: r });
    }
    const refs = async (pattern: string, count: number) => {
      if (repo.getRefs) return repo.getRefs({ pattern, count, sort: 'committerdate' }).catch(() => []);
      return repo.state.refs.filter((r) => (pattern === 'refs/heads/' ? r.type === 0 : pattern === 'refs/remotes/' ? r.type === 1 : r.type === 2)).slice(0, count);
    };
    const [locals, remotes, tags] = await Promise.all([refs('refs/heads/', 300), refs('refs/remotes/', 300), refs('refs/tags/', 200)]);
    const group = (label: string, list: { name?: string; commit?: string }[]) => {
      const valid = list.filter((r) => r.name && isValidBase(r.name) && !r.name.endsWith('/HEAD') && r.name !== head?.name);
      if (!valid.length) return;
      items.push({ label, kind: vscode.QuickPickItemKind.Separator });
      for (const r of valid) items.push({ label: escapeIcons(name(r.name!, 100)), description: [r.name === currentSpec ? 'current' : '', r.commit && FULL_SHA.test(r.commit) ? short(r.commit) : ''].filter(Boolean).join(' · ') || undefined, spec: r.name! });
    };
    group('Branches', locals);
    group('Remote Branches', remotes);
    group('Tags', tags);
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: '$(git-commit) Commit…', detail: 'A commit id on this branch: "the changes since that commit"', kind2: 'commit' });
    if (hidden) {
      qp.dispose();
      return;
    }
    qp.items = items;
    qp.busy = false;
    const chosen = await chosenP;
    qp.dispose();
    if (!chosen) return;
    let spec: string | undefined;
    if (chosen.kind2 === 'default') spec = undefined;
    else if (chosen.kind2 === 'commit') {
      spec = await this.askCommit(repo);
      if (!spec) return;
    } else spec = chosen.spec;
    await this.setPick(repo, branch, spec);
    await c.refresh(true);
  }

  /** "Commit…": hex only, resolved to a full id that starts with the input, and an ancestor of HEAD. */
  private async askCommit(repo: GitRepo): Promise<string | undefined> {
    const input = await vscode.window.showInputBox({
      title: 'Compare With a Commit',
      prompt: 'A commit id (at least 4 hex digits) in this branch’s history',
      validateInput: (v) => (COMMIT_INPUT.test(v.trim()) ? undefined : 'Enter 4 to 64 hex digits'),
    });
    const v = input?.trim().toLowerCase();
    if (!v || !COMMIT_INPUT.test(v)) return undefined;
    const commit = await repo.getCommit(v).catch(() => undefined);
    if (!commit?.hash || !commit.hash.startsWith(v)) {
      void vscode.window.showWarningMessage(`No commit ${v} in this repository.`);
      return undefined;
    }
    const head = repo.state.HEAD?.commit;
    const mb = head ? await repo.getMergeBase(commit.hash, head).catch(() => undefined) : undefined;
    if (mb !== commit.hash) {
      void vscode.window.showWarningMessage(
        `${short(commit.hash)} isn't in this branch's history any more (rebased?). A "since my last review" that survives rebases is planned.`,
      );
      return undefined;
    }
    return commit.hash;
  }

  private async pickRepository(): Promise<void> {
    const api = this.api;
    if (!api || api.repositories.length < 2) return;
    const pick = await vscode.window.showQuickPick(
      api.repositories.map((r) => ({ label: escapeIcons(name(baseName(r.rootUri.path))), description: escapeIcons(name(vscode.workspace.asRelativePath(r.rootUri), 120)), repo: r })),
      { title: 'Change Repository' },
    );
    if (!pick) return;
    await this.memento.update(KEYS.repo, pick.repo.rootUri.toString());
    this.useRepo(pick.repo);
  }

  /** Fetch, on a click only (§9.9): the base's remote, else the default one, through the git extension. */
  private async fetch(): Promise<void> {
    const repo = this.comparison?.repo;
    if (!repo?.fetch) return;
    try {
      const st = this.comparison?.state;
      // The base's remote when it is a remote branch (or names one), else the default remote.
      const via = st?.kind === 'ready' ? st.snapshot.base.via : st?.kind === 'baseNotFound' ? `refs/remotes/${st.spec}` : '';
      const remote = refReader(repo).remotes().find((r) => via.startsWith(`refs/remotes/${r}/`));
      await vscode.window.withProgress({ location: { viewId: VIEW_ID }, title: 'Fetching…' }, () => repo.fetch!(remote ? { remote } : {}));
    } catch (e) {
      void vscode.window.showErrorMessage(`Fetch failed: ${plainForMessage((e as Error).message ?? String(e))}`);
    }
    await this.comparison?.refresh(true);
  }

  dispose(): void {
    clearTimeout(this.repaintTimer);
    this.coverage.want('view', false);

    this.apiSubs.forEach((d) => d.dispose());
    this.comparisonSubs.forEach((d) => d.dispose());
    this.subscriptions.forEach((d) => d.dispose());
  }
}
