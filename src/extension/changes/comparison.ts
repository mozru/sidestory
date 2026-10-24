// One comparison (docs/CHANGES-PLAN.md §1, §4.3–§4.4, §4.6): a repository, a base and a head, with its merge-base and
// changed files. Everything is read through the vscode.git API; nothing here runs git. Recomputes are coalesced
// (300 ms, extended to 2 s while events keep arriving), the merge-base and commit count are recomputed only when
// HEAD or the base moved, and every result carries an epoch so a late answer never overwrites a newer one.
import * as vscode from 'vscode';
import type { BaseSource, DefaultBaseInputs, ResolvedBase } from './base.ts';
import { FULL_SHA, isValidBase, remoteDefault, resolveBase, resolveDefaultBase } from './base.ts';
import type { GitApi, GitChange, GitDiffChange, GitRepo } from './git-api.ts';
import { configValue, refReader, relPath } from './git-api.ts';
import type { ChangeEntry } from './model.ts';
import { comparePaths, MAX_LISTED, statusLetter } from './model.ts';

export type Mode = 'workingTree' | 'committed';

export interface Snapshot {
  readonly repo: GitRepo;
  readonly base: ResolvedBase & { source: BaseSource };
  readonly mergeBase: string;
  readonly head: { readonly sha: string; readonly name?: string; readonly upstream?: string; readonly ahead?: number; readonly behind?: number };
  readonly mode: Mode;
  /** At most MAX_LISTED, sorted by path. */
  readonly entries: ChangeEntry[];
  /** Changed files before the cap. */
  readonly total: number;
  readonly commits?: { readonly count: number; readonly capped: boolean };
  /** Line counts came with the list (numstat); otherwise only untracked files get counted. */
  readonly countsKnown: boolean;
  readonly partialClone: boolean;
  /** HEAD is the base branch (or its commit). */
  readonly onBase: boolean;
  /** Working tree mode, and there are uncommitted edits (staged, unstaged, untracked or unsaved). */
  readonly uncommitted: boolean;
  /** Changed files whose paths are unsafe to show or read (control characters, `..`, `.git`): not listed. */
  readonly unsafe: number;
}

export type ComparisonState =
  | { kind: 'loading' }
  | { kind: 'noCommits' }
  | { kind: 'noBase' }
  | { kind: 'baseNotFound'; spec: string }
  | { kind: 'noMergeBase'; base: ResolvedBase }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; snapshot: Snapshot };

/**
 * Paths the view refuses to read or open (§4.5): control characters, `..`, `.git`, backslashes, and a leading `:`
 * (git reads `:(literal)x` and `:/x` as pathspec magic).
 */
export function isSafeRepoPath(p: string): boolean {
  if (!p || p.length > 4096 || p.startsWith(':') || /[\x00-\x1f\x7f\\]/.test(p)) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..' && s.toLowerCase() !== '.git');
}

/** The git API's changes as entries; `untracked` marks them all as untracked. Unsafe paths are dropped. */
export function toEntries(repo: GitRepo, changes: readonly (GitChange | GitDiffChange)[], untracked = false): { entries: ChangeEntry[]; unsafe: number } {
  const entries: ChangeEntry[] = [];
  let unsafe = 0;
  for (const c of changes) {
    // Read each property once: the API's changes can be class instances with getters (never spread them).
    const status = untracked ? 'A' : statusLetter(c.status);
    if (!status) continue;
    const newPath = relPath(repo, c.renameUri ?? c.uri);
    const oldPath = relPath(repo, c.originalUri);
    const path = status === 'D' ? (oldPath ?? newPath) : newPath;
    if (!path || !isSafeRepoPath(path) || ((status === 'R' || status === 'C') && (!oldPath || !isSafeRepoPath(oldPath)))) {
      unsafe++;
      continue;
    }
    const e: ChangeEntry = { path, status, ...((status === 'R' || status === 'C') && oldPath !== path ? { oldPath } : {}), ...(untracked ? { untracked: true } : {}) };
    if ('insertions' in c && typeof c.insertions === 'number') {
      e.added = c.insertions;
      e.removed = c.deletions;
      if (!c.insertions && !c.deletions) e.noText = true;
    }
    entries.push(e);
  }
  return { entries, unsafe };
}

/** Commits merge-base → head, "1000+" past the cap (§9.2). `log`'s maxEntries is ignored with a range (1.95 and newer). */
export async function countCommits(repo: GitRepo, mergeBase: string, head: string, cap = 1000): Promise<{ count: number; capped: boolean } | undefined> {
  if (mergeBase === head) return { count: 0, capped: false };
  try {
    // Bounded first: the merge-base among HEAD's latest commits means the range is small.
    const recent = await repo.log({ maxEntries: cap + 1 });
    if (!recent.some((c) => c.hash === mergeBase)) return { count: cap, capped: true };
    const range = await repo.log({ range: `${mergeBase}..${head}` });
    return range.length > cap ? { count: cap, capped: true } : { count: range.length, capped: false };
  } catch {
    return undefined;
  }
}

export interface ComparisonOptions {
  /** The base the user picked for this branch, if any. */
  pick(branch: string): string | undefined;
  mode(): Mode;
  /** The `sidestory.changes.defaultBase` setting. */
  setting(): string | undefined;
  /** Throttle for re-reading the base's commit on status refreshes. */
  baseTtlMs?: number;
}

const DEBOUNCE_MS = 300;
const MAX_DEBOUNCE_MS = 2000;
/** Working tree mode lists the whole branch on each recompute: at most one a second. */
const MIN_GAP_MS = 1000;

export class Comparison implements vscode.Disposable {
  readonly repo: GitRepo;
  private readonly opts: ComparisonOptions;
  private current: ComparisonState = { kind: 'loading' };
  /** Bumped on every recompute; async work drops its result when it moved. */
  epoch = 0;
  /** Set while git is rebasing or merging: the last result stays, marked. */
  busy = false;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly subscriptions: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private firstEventAt = 0;
  private base: { key: string; at: number; value: (ResolvedBase & { source: BaseSource }) | undefined } | undefined;
  private mergeBase: { key: string; value: string | undefined } | undefined;
  private commits: { key: string; value: Promise<{ count: number; capped: boolean } | undefined> } | undefined;
  private partial: Promise<boolean> | undefined;
  private running: Promise<void> | undefined;
  private again = false;
  /** Only an active comparison (a visible view, or a command that needs it) recomputes; others note they're stale. */
  private activeNow = false;
  private stale = true;
  /** Dirty documents of this repository (working tree mode): a change of the set recomputes, typing doesn't. */
  private readonly dirty = new Set<string>();
  /** Bumped by Refresh: a run that started before it doesn't write its caches back. */
  private generation = 0;
  private lastRunAt = 0;
  /** Counts found later (per-file patches, untracked files), kept across recomputes of the same merge-base and head. */
  private readonly counts = new Map<string, { added?: number; removed?: number; noText?: boolean }>();
  private countsKey = '';
  /** The committed list, per merge-base and head (§4.4: re-read only when either moved). */
  private committedList: { key: string; list: (GitChange | GitDiffChange)[]; countsKnown: boolean } | undefined;

  constructor(repo: GitRepo, opts: ComparisonOptions) {
    this.repo = repo;
    this.opts = opts;
    this.subscriptions.push(
      this.emitter,
      repo.state.onDidChange(() => this.schedule()),
      vscode.workspace.onDidChangeTextDocument((e) => this.noteDocument(e.document)),
      vscode.workspace.onDidSaveTextDocument((d) => this.noteDocument(d)),
      vscode.workspace.onDidCloseTextDocument((d) => this.noteDocument(d, true)),
    );
  }

  /** A document became dirty or clean (or closed): only then does the list change, and only in working tree mode. */
  private noteDocument(d: vscode.TextDocument, closed = false): void {
    if (d.uri.scheme !== 'file' || this.opts.mode() !== 'workingTree') return;
    const key = d.uri.toString();
    const dirty = !closed && d.isDirty;
    if (dirty === this.dirty.has(key)) return;
    if (relPath(this.repo, d.uri) === undefined) return;
    if (dirty) this.dirty.add(key);
    else this.dirty.delete(key);
    this.schedule();
  }

  /** Remembers a count found later for this merge-base and head (the view's per-file counting). */
  remember(path: string, c: { added?: number; removed?: number; noText?: boolean }): void {
    this.counts.set(path, c);
  }

  get state(): ComparisonState {
    return this.current;
  }

  get snapshot(): Snapshot | undefined {
    return this.current.kind === 'ready' ? this.current.snapshot : undefined;
  }

  /** Starts (or stops) recomputing on events; becoming active recomputes when something changed meanwhile. */
  set active(on: boolean) {
    const was = this.activeNow;
    this.activeNow = on;
    if (on && !was && this.stale) this.schedule(0);
  }

  /** Recomputes now; `full` also drops the cached base, merge-base and commit count (Refresh). */
  refresh(full = false): Promise<void> {
    if (full) {
      this.base = this.mergeBase = this.commits = this.committedList = undefined;
      this.partial = undefined;
      this.counts.clear();
      this.generation++;
    }
    clearTimeout(this.timer);
    this.timer = undefined;
    return this.run();
  }

  /** The result once any recompute in flight is done (for commands run right after a change). */
  async settled(): Promise<ComparisonState> {
    clearTimeout(this.timer);
    this.timer = undefined;
    for (let i = 0; i < 3 && (this.running || this.stale); i++) {
      if (this.running) await this.running;
      else await this.run();
    }
    return this.current;
  }

  private schedule(delay = DEBOUNCE_MS): void {
    this.stale = true;
    if (!this.activeNow) return;
    const now = Date.now();
    if (!this.timer) this.firstEventAt = now;
    clearTimeout(this.timer);
    // A burst (a rebase, a checkout) extends the wait up to 2 s from its first event, then runs once.
    let wait = Math.max(0, Math.min(delay, this.firstEventAt + MAX_DEBOUNCE_MS - now));
    if (this.opts.mode() === 'workingTree') wait = Math.max(wait, this.lastRunAt + MIN_GAP_MS - now);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run();
    }, wait);
  }

  /** Drops the caches and marks the comparison stale without running (a setting changed while the view is hidden). */
  invalidate(): void {
    this.base = this.mergeBase = this.commits = this.committedList = undefined;
    this.partial = undefined;
    this.counts.clear();
    this.generation++;
    this.schedule();
  }

  private run(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.stale = false;
    this.running = this.compute()
      .catch((e: unknown) => this.set({ kind: 'error', message: e instanceof Error ? e.message : String(e) }))
      .finally(() => {
        this.running = undefined;
        if (this.again) {
          this.again = false;
          void this.run();
        }
      });
    return this.running;
  }

  private set(state: ComparisonState): void {
    this.current = state;
    this.emitter.fire();
  }

  /** §4.3's default-base inputs other than the user's pick: git config, the setting, the remote's default branch. */
  private async inputs(branch: string | undefined): Promise<DefaultBaseInputs> {
    const repo = this.repo;
    const reader = refReader(repo);
    const gitConfig = branch ? await configValue(repo, `branch.${branch}.vscode-merge-base`) : undefined;
    const remote = reader.remotes()[0];
    const remoteDef = remote
      ? await remoteDefault(reader, remote, async () =>
          ((await repo.getRefs?.({ pattern: `refs/remotes/${remote}/`, count: 200, sort: 'alphabetically' }).catch(() => [])) ?? [])
            .filter((r) => r.type === 1 && r.name?.startsWith(`${remote}/`))
            .map((r) => ({ name: r.name!.slice(remote.length + 1), commit: r.commit })),
        )
      : undefined;
    return { gitConfig, setting: this.opts.setting(), remoteDefault: remoteDef };
  }

  /** The base this branch gets without a pick (the base picker's first item). */
  async defaultBase(): Promise<(ResolvedBase & { source: BaseSource }) | undefined> {
    const name = this.repo.state.HEAD?.name;
    const branch = name && isValidBase(name) ? name : undefined;
    return resolveDefaultBase(refReader(this.repo), await this.inputs(branch));
  }

  private async compute(): Promise<void> {
    this.lastRunAt = Date.now();
    const repo = this.repo;
    const s = repo.state;
    const wasBusy = this.busy;
    this.busy = s.rebaseCommit !== undefined || s.mergeChanges.length > 0;
    if (this.busy) {
      // Keep the last result; the next status refresh after git settles recomputes.
      if (!wasBusy) this.emitter.fire();
      if (this.current.kind !== 'loading') return;
    } else if (wasBusy) this.emitter.fire();
    const epoch = ++this.epoch;
    const generation = this.generation;
    const head = s.HEAD;
    const headSha = head?.commit;
    if (!headSha || !FULL_SHA.test(headSha)) return this.set({ kind: 'noCommits' });
    const reader = refReader(repo);
    const branch = head.name && isValidBase(head.name) ? head.name : undefined;

    // The base: re-read at most every few seconds on status refreshes (§4.4), at once when the inputs changed.
    const pick = this.opts.pick(branch ?? 'HEAD');
    const setting = this.opts.setting();
    const baseKey = `${pick}\n${setting}\n${branch}`;
    const ttl = this.opts.baseTtlMs ?? 5000;
    let baseEntry = this.base;
    if (!baseEntry || baseEntry.key !== baseKey || Date.now() - baseEntry.at > ttl) {
      // An explicit pick that no longer resolves is said, not silently replaced by a default.
      const picked = pick ? await resolveBase(reader, pick) : undefined;
      const value = pick ? (picked && { ...picked, source: 'pick' as const }) : await resolveDefaultBase(reader, await this.inputs(branch));
      if (epoch !== this.epoch) return;
      if (pick && !value) {
        this.base = undefined;
        return this.set({ kind: 'baseNotFound', spec: pick });
      }
      baseEntry = { key: baseKey, at: Date.now(), value };
      if (generation === this.generation) this.base = baseEntry;
    }
    const base = baseEntry.value;
    if (!base) return this.set({ kind: 'noBase' });

    const mbKey = `${base.sha}\n${headSha}`;
    let mergeBase = this.mergeBase?.key === mbKey ? this.mergeBase.value : undefined;
    if (!mergeBase) {
      mergeBase = await reader.mergeBase(base.sha, headSha);
      // Only an answer is cached: a failure (a shallow clone being deepened, git busy) is asked again.
      if (mergeBase && generation === this.generation) this.mergeBase = { key: mbKey, value: mergeBase };
    }
    if (epoch !== this.epoch) return;
    if (!mergeBase) return this.set({ kind: 'noMergeBase', base });

    this.partial ??= Promise.all([configValue(repo, 'extensions.partialClone'), ...s.remotes.slice(0, 20).map((r) => configValue(repo, `remote.${r.name}.promisor`))]).then((v) =>
      v.some((x) => x !== undefined && x !== 'false'),
    );
    const partialClone = await this.partial;
    const mode = this.opts.mode();
    let list: (GitChange | GitDiffChange)[] = [];
    let countsKnown = false;
    // In a partial clone numstat reads (and so downloads) every blob: names only (§4.5).
    const listKey = `${mergeBase}\n${headSha}\n${partialClone}`;
    if (this.countsKey !== `${listKey}\n${mode}`) {
      this.counts.clear();
      this.countsKey = `${listKey}\n${mode}`;
    }
    if (mode === 'committed') {
      if (this.committedList?.key === listKey) ({ list, countsKnown } = this.committedList);
      else {
        if (mergeBase !== headSha) {
          if (repo.diffBetweenWithStats && !partialClone) {
            list = await repo.diffBetweenWithStats(mergeBase, headSha);
            countsKnown = true;
          } else list = await repo.diffBetween(mergeBase, headSha);
        } else countsKnown = true;
        if (generation === this.generation) this.committedList = { key: listKey, list, countsKnown };
      }
    } else if (repo.diffBetweenWithStats2 && !partialClone) {
      list = await repo.diffBetweenWithStats2(mergeBase);
      countsKnown = true;
    } else list = await repo.diffWith(mergeBase);
    if (epoch !== this.epoch) return;

    const listed = toEntries(repo, list);
    const entries = listed.entries;
    let unsafe = listed.unsafe;
    if (mode === 'workingTree') {
      const seen = new Set(entries.map((e) => e.path));
      const untracked = [...(s.untrackedChanges ?? []), ...s.workingTreeChanges.filter((c) => c.status === 7)];
      const extra = toEntries(repo, untracked, true);
      unsafe += extra.unsafe;
      for (const e of extra.entries) {
        if (!seen.has(e.path)) {
          seen.add(e.path);
          entries.push(e);
        }
      }
      // Unsaved edits are part of "uncommitted" (§4.4): a dirty document of a file at the merge-base.
      this.dirty.clear();
      for (const d of vscode.workspace.textDocuments) if (d.isDirty && d.uri.scheme === 'file' && relPath(repo, d.uri) !== undefined) this.dirty.add(d.uri.toString());
      for (const d of vscode.workspace.textDocuments) {
        if (!d.isDirty || d.uri.scheme !== 'file') continue;
        const p = relPath(repo, d.uri);
        if (!p || !isSafeRepoPath(p)) continue;
        const listed = entries.find((e) => e.path === p);
        if (listed) listed.unsaved = true;
        else if (seen.size < MAX_LISTED && (await repo.getObjectDetails(mergeBase, d.uri.fsPath).then(() => true, () => false))) {
          seen.add(p);
          entries.push({ path: p, status: 'M', unsaved: true });
        }
      }
      if (epoch !== this.epoch) return;
    }
    const touched = new Set<string>();
    if (mode === 'workingTree') {
      for (const c of [...s.workingTreeChanges, ...s.indexChanges, ...(s.untrackedChanges ?? [])]) {
        const r = relPath(repo, c.uri);
        if (r) touched.add(r);
      }
      for (const e of entries) if (e.unsaved) touched.add(e.path);
    }
    // A file that is changing now may differ from what was counted (and after a revert or stash it stops being
    // "touched" with an old count): forget those; the view re-counts them, keyed by the file's size and time.
    for (const t of touched) this.counts.delete(t);
    for (const e of entries) {
      if (e.added !== undefined || e.noText) continue;
      const c = this.counts.get(e.path);
      if (c) Object.assign(e, c);
    }
    entries.sort((a, b) => comparePaths(a.path, b.path));
    const total = entries.length;
    if (entries.length > MAX_LISTED) entries.length = MAX_LISTED;

    const cKey = `${mergeBase}\n${headSha}`;
    if (this.commits?.key !== cKey) this.commits = { key: cKey, value: countCommits(repo, mergeBase, headSha) };
    const commits = await this.commits.value;
    if (epoch !== this.epoch) return;
    const upstream = head.upstream ? `${head.upstream.remote}/${head.upstream.name}` : undefined;
    this.set({
      kind: 'ready',
      snapshot: {
        repo,
        base,
        mergeBase,
        head: { sha: headSha, name: head.name, upstream, ahead: head.ahead, behind: head.behind },
        mode,
        entries,
        total,
        commits,
        countsKnown,
        partialClone,
        // HEAD is the base branch itself; a new branch at main's commit is a branch with no changes yet.
        onBase: !!base.branch && base.branch === head.name,
        uncommitted: mode === 'workingTree' && (s.workingTreeChanges.length > 0 || s.indexChanges.length > 0 || (s.untrackedChanges?.length ?? 0) > 0 || this.dirty.size > 0),
        unsafe,
      },
    });
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.subscriptions.forEach((d) => d.dispose());
  }
}

/** The repository the view shows: the remembered one, else the active editor's, else the first. */
export function chooseRepository(api: GitApi, rememberedRoot: string | undefined): GitRepo | undefined {
  const repos = api.repositories;
  if (!repos.length) return undefined;
  const byRoot = rememberedRoot ? repos.find((r) => r.rootUri.toString() === rememberedRoot) : undefined;
  if (byRoot) return byRoot;
  const active = vscode.window.activeTextEditor?.document.uri;
  const own = active ? api.getRepository(active) : null;
  return own ?? [...repos].sort((a, b) => a.rootUri.path.length - b.rootUri.path.length)[0];
}
