// The Changes view (docs/CHANGES-PLAN.md §9.1–§9.5, §9.7–§9.9, release 1a): the branch's merge diff as a file
// navigator, with no sidestory needed. It owns the comparison for the chosen repository, the tree, the title bar
// (description, message, toggles), the states, and the commands: open a file's merge diff, next/previous changed
// file, Open All Changes, the base picker, the filter. Coverage, sidestory rows and This File arrive with
// release 1b on top of `ChangesView.snapshot` and `ChangesTree`.
import * as vscode from 'vscode';
import { displayText, escapeIcons, plainForMessage } from '../../core/display-text.ts';
import { AVAILABLE_KEY } from '../bootstrap-shared.ts';
import { log } from '../log.ts';
import { COMMIT_INPUT, isValidBase } from './base.ts';
import type { Mode, Snapshot } from './comparison.ts';
import { chooseRepository, Comparison } from './comparison.ts';
import type { ApiState, GitApi, GitRepo } from './git-api.ts';
import { gitApi, relPath } from './git-api.ts';
import { ChangeDecorations, emptyUri, EMPTY_SCHEME, GitFileSystem, gitUri, GIT_SCHEME, parseGitUri, RepoIds } from './git-fs.ts';
import type { ChangeEntry, SortKey } from './model.ts';
import { baseName, commitsLabel, filterEntries, MAX_LISTED, parseFilter, short, SORT_KEYS, step } from './model.ts';
import type { ChangesNode } from './tree.ts';
import { ChangesTree } from './tree.ts';

export const VIEW_ID = 'sidestory.changes';
const KEYS = {
  listMode: 'sidestory.changes.listMode',
  sort: 'sidestory.changes.sort',
  filter: (mode: Mode) => `sidestory.changes.filter.${mode}`,
  uncommitted: 'sidestory.changes.includeUncommitted',
  picks: 'sidestory.changes.picks',
  recent: 'sidestory.changes.recentBases',
  repo: 'sidestory.changes.repository',
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
  private comparison: Comparison | undefined;
  private comparisonSubs: vscode.Disposable[] = [];
  private apiSubs: vscode.Disposable[] = [];
  private stateKey: State | undefined;
  private shownPaths = new Set<string>();
  private filterText = '';
  /** Our own reveals change the selection: those never open a diff (openOnSelect). */
  private revealing = false;
  private lastOpened: { path: string; at: number } | undefined;
  private countEpoch = -1;
  private repaintTimer: ReturnType<typeof setTimeout> | undefined;
  /** For tests and the perf smoke: how long the last render took. */
  readonly stats = { renders: 0, lastRenderMs: 0, files: 0 };

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.memento = context.workspaceState;
    this.ids = new RepoIds(context.globalState);
    this.view = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: this.tree, canSelectMany: false });
    this.subscriptions.push(
      this.tree,
      this.view,
      GitFileSystem.register(this.ids),
      vscode.window.registerFileDecorationProvider(new ChangeDecorations()),
      this.view.onDidChangeVisibility(() => this.updateActive()),
      this.view.onDidChangeSelection((e) => this.onSelect(e.selection)),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateActiveFile()),
      vscode.window.tabGroups.onDidChangeTabs(() => this.updateActiveFile()),
      vscode.workspace.onDidGrantWorkspaceTrust(() => void this.init()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('sidestory.changes.defaultBase')) void this.comparison?.refresh(true);
      }),
    );
    this.filterText = this.memento.get<string>(KEYS.filter(this.mode()), '') ?? '';
    this.syncToggles();
    this.setState('loading');
    void this.init();
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
    if (!repo) {
      this.tree.set(undefined);
      this.updateTitle();
      return;
    }
    const c = new Comparison(repo, {
      pick: (branch) => this.picks().find(([k]) => k === this.pickKey(repo, branch))?.[1],
      mode: () => this.mode(),
      setting: () => vscode.workspace.getConfiguration('sidestory.changes').get<string>('defaultBase')?.trim() || undefined,
    });
    this.comparison = c;
    this.comparisonSubs.push(c, c.onDidChange(() => this.render()));
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
      this.setState(st.kind === 'error' ? 'error' : st.kind);
      if (st.kind === 'error') log.warn(`Changes: ${st.message}`);
      this.updateTitle();
      this.updateActiveFile();
      return;
    }
    const snap = st.snapshot;
    const filter = parseFilter(this.filterText);
    const entries = filterEntries(snap.entries, filter);
    const multi = (this.api?.repositories.length ?? 0) > 1;
    this.tree.set({
      entries,
      listMode: this.listMode(),
      sort: this.sort(),
      onDisk: snap.mode === 'workingTree',
      repoLabel: multi ? baseName(snap.repo.rootUri.path) : undefined,
    });
    this.shownPaths = new Set(snap.entries.map((e) => e.path));
    this.setState(snap.entries.length ? (entries.length ? 'ready' : 'filteredOut') : snap.onBase ? 'onBase' : 'noChanges');
    setContext('sidestory.changes.active', snap.entries.length > 0);
    if (snap.entries.length && this.memento.get(AVAILABLE_KEY) === undefined) {
      // The navigator is useful on any branch with changes: keep the container (§9.1).
      void this.memento.update(AVAILABLE_KEY, 'shown');
      setContext('sidestory.available', true);
    }
    this.updateTitle();
    this.updateActiveFile();
    this.countLater(snap, c.epoch);
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
            ? `${name(st.base.label)} and this branch share no history here (a shallow clone? run git fetch --unshallow), or pick another base.`
            : st?.kind === 'error'
              ? `Couldn't compare: ${displayText(st.message, 200)}`
              : undefined;
      return;
    }
    const s = st.snapshot;
    const parts: string[] = [];
    if (!s.head.name) parts.push(`detached ${short(s.head.sha)}`);
    parts.push(`vs ${name(s.base.label, 48)} @ ${short(s.mergeBase)}`);
    if (s.commits) parts.push(commitsLabel(s.commits.count, s.commits.capped));
    if (s.mode === 'workingTree') parts.push('uncommitted');
    view.description = parts.join(' · ');
    const msg: string[] = [];
    if (c.busy) msg.push('Rebase or merge in progress: showing the last state.');
    if (s.onBase && s.entries.length && s.mode === 'workingTree') msg.push(`Uncommitted changes on ${name(s.base.branch ?? s.base.label)}.`);
    if (s.head.name && s.head.upstream && (s.head.ahead ?? 0) > 0 && (s.head.behind ?? 0) > 0) {
      msg.push(`${name(s.head.name)} and ${name(s.head.upstream)} have diverged (${s.head.ahead} ahead, ${s.head.behind} behind): showing your local branch.`);
    }
    if (s.total > s.entries.length) msg.push(`Showing ${MAX_LISTED.toLocaleString('en-US')} of ${s.total.toLocaleString('en-US')} changed files.`);
    if (s.unsafe) msg.push(`${s.unsafe} changed ${s.unsafe === 1 ? 'file has a path' : 'files have paths'} with control characters, “..” or “.git” in it: not listed.`);
    if (s.partialClone) msg.push('Partial clone: line counts are off, since computing them could download every file.');
    if (this.filterText) {
      const shown = this.tree.order.length;
      msg.push(`Filtered by “${displayText(this.filterText, 60)}”: ${shown.toLocaleString('en-US')} of ${s.entries.length.toLocaleString('en-US')} files`);
    }
    view.message = msg.length ? msg.join(' ') : undefined;
  }

  /** Counts lines the list didn't come with, a few files at a time and in view order, then repaints. */
  private countLater(snap: Snapshot, epoch: number): void {
    if (this.countEpoch === epoch || snap.partialClone) return;
    this.countEpoch = epoch;
    // Renames and copies: a one-path patch can't pair the two sides, so they stay uncounted here.
    // What the view shows first, then files the filter hides.
    const todo = [...new Set([...this.tree.order, ...snap.entries])]
      .filter((e) => e.added === undefined && !e.noText && (e.untracked || e.status === 'A' || e.status === 'M' || e.status === 'D'))
      .slice(0, COUNT_LATER.files);
    if (!todo.length) return;
    const repo = snap.repo;
    let next = 0;
    const work = async () => {
      while (next < todo.length && this.comparison?.epoch === epoch) {
        const e = todo[next++]!;
        try {
          const uri = vscode.Uri.joinPath(repo.rootUri, ...e.path.split('/'));
          if (e.untracked) {
            const st = await vscode.workspace.fs.stat(uri);
            if (st.type !== vscode.FileType.File || st.size > COUNT_LATER.bytes) continue;
            const bytes = await vscode.workspace.fs.readFile(uri);
            if (bytes.subarray(0, 8000).includes(0)) e.noText = true;
            else e.added = countLines(bytes);
            e.removed = 0;
          } else {
            const patch = snap.mode === 'workingTree' ? await repo.diffWith(snap.mergeBase, uri.fsPath) : await repo.diffBetween(snap.mergeBase, snap.head.sha, uri.fsPath);
            if (this.comparison?.epoch !== epoch) return;
            Object.assign(e, patchCounts(patch));
          }
          this.scheduleRepaint();
        } catch {
          // gone or unreadable: no count
        }
      }
    };
    for (let i = 0; i < COUNT_LATER.parallel; i++) void work();
  }

  private scheduleRepaint(): void {
    this.repaintTimer ??= setTimeout(() => {
      this.repaintTimer = undefined;
      this.tree.repaint();
    }, 250);
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
      return s.entries.find((e) => e.oldPath === g.path)?.path ?? g.path;
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
    if (r.wrapped) vscode.window.setStatusBarMessage(dir === 1 ? 'Back to the first changed file' : 'Back to the last changed file', 3000);
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
      for (const i of items) if (i.key === current) i.label = `$(check) ${i.label}`;
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
    box.placeholder = 'Part of a path, a glob (src/**/*.ts, *.md), or !text to exclude';
    box.value = before;
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
    const files = this.tree.order.filter((e) => !e.noText);
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
    qp.title = 'Compare with';
    qp.placeholder = 'The diff is always merge-base(base, this branch) → this branch';
    qp.busy = true;
    qp.matchOnDescription = true;
    qp.show();
    const items: Item[] = [];
    const def = await c.defaultBase().catch(() => undefined);
    const mb = def && head?.commit ? await repo.getMergeBase(def.sha, head.commit).catch(() => undefined) : undefined;
    items.push({
      label: `$(git-compare) Merge-base with ${escapeIcons(name(def?.label ?? 'main'))}`,
      description: mb ? short(mb) : def ? '' : 'not found',
      detail: def ? 'The default base' : 'No default base here: pick one below',
      kind2: 'default',
    });
    const recent = (this.memento.get<string[]>(KEYS.recent) ?? []).filter((x) => typeof x === 'string' && isValidBase(x));
    if (recent.length) {
      items.push({ label: 'Recent', kind: vscode.QuickPickItemKind.Separator });
      for (const r of recent) items.push({ label: escapeIcons(name(r, 100)), spec: r });
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
      for (const r of valid) items.push({ label: escapeIcons(name(r.name!, 100)), description: r.commit ? short(r.commit) : undefined, spec: r.name! });
    };
    group('Branches', locals);
    group('Remote Branches', remotes);
    group('Tags', tags);
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: '$(git-commit) Commit…', detail: 'A commit id on this branch: "the changes since that commit"', kind2: 'commit' });
    qp.items = items;
    qp.busy = false;
    const chosen = await new Promise<Item | undefined>((resolve) => {
      qp.onDidAccept(() => resolve(qp.selectedItems[0]));
      qp.onDidHide(() => resolve(undefined));
    });
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
      title: 'Compare with a commit',
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
      { title: 'Compare which repository?' },
    );
    if (!pick) return;
    await this.memento.update(KEYS.repo, pick.repo.rootUri.toString());
    this.useRepo(pick.repo);
  }

  /** Fetch, on a click only (§9.9): the default remote, through the git extension. */
  private async fetch(): Promise<void> {
    const repo = this.comparison?.repo;
    if (!repo?.fetch) return;
    try {
      await vscode.window.withProgress({ location: { viewId: VIEW_ID }, title: 'Fetching…' }, () => repo.fetch!({}));
    } catch (e) {
      void vscode.window.showErrorMessage(`Fetch failed: ${plainForMessage((e as Error).message ?? String(e))}`);
    }
    await this.comparison?.refresh(true);
  }

  dispose(): void {
    clearTimeout(this.repaintTimer);
    this.apiSubs.forEach((d) => d.dispose());
    this.comparisonSubs.forEach((d) => d.dispose());
    this.subscriptions.forEach((d) => d.dispose());
  }
}

/** Lines added and removed in one file's unified diff; a binary file has none. */
export function patchCounts(patch: string): { added: number; removed: number; noText?: true } {
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) inHunk = true;
    else if (line.startsWith('diff --git ')) inHunk = false;
    else if (!inHunk) {
      if (/^Binary files .* differ$/.test(line) || line.startsWith('GIT binary patch')) return { added: 0, removed: 0, noText: true };
    } else if (line[0] === '+') added++;
    else if (line[0] === '-') removed++;
  }
  return added || removed ? { added, removed } : { added, removed, noText: true };
}

/** Lines in a text file's bytes (a final line without a newline counts). */
export function countLines(bytes: Uint8Array): number {
  if (!bytes.length) return 0;
  let n = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) n++;
  return bytes[bytes.length - 1] === 10 ? n : n + 1;
}
