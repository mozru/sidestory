// `check.cjs --coverage` (docs/CHANGES-PLAN.md §13.1): the branch's merge diff, as the Changes view counts it, and
// which of its changes the sidestories that belong to it explain. Git runs only through src/cli/git.ts (§13.2);
// changes, coverage and membership are the shared core (src/core/hunks.ts, coverage.ts, membership.ts), so the
// checker and the extension agree. The checker in CI is authoritative (§4.1).
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative as pathRelative, sep } from 'node:path';
import { coverage as computeCoverage, normLine, usedAnchorIds, type ChangeCoverage, type FileInput, type Target, type Totals } from '../core/coverage.ts';
import { globMatcher } from '../core/glob.ts';
import { outlineHtml } from '../core/html-scan.ts';
import { decodePair, decodeUtf8, decodeLatin1, diffTexts, isBinary, isLfsChange, MAX_COMPARE_BYTES, textLines, tooLargeChange, moveCarriers, moveFiles, moveGroups, moveLabel, type ChangeBlock, type MoveGroup } from '../core/hunks.ts';
import { FULL_SHA, isValidBase, MAX_MANIFEST_BYTES, parseBranchFields, parseManifest, sideOf, type Diagnostic, type LineRange, type Manifest } from '../core/manifest.ts';
import { archiveMoveCandidates, belongs, countedChange, isArchivedManifest, isArchivePath, isCompleteSidestory, isOwnedFileName, isThreadEventBytes, SIDESTORY_FILES, sidestoryFolderOf, threadEventPath } from '../core/membership.ts';
import { pairUnstagedRenames } from '../core/renames.ts';
import { pathProblem } from '../core/repo-path.ts';
import { resolveAnchor } from '../core/resolve.ts';
import { normalizeLines, PreparedText } from '../core/text.ts';
import { resolveBase } from '../extension/changes/base.ts';
import type { Finding, Severity } from './check-widgets.ts';
import { findRepository, Git, GitError, isSafeFsPath, isSafeRepoPath, WorkingTreeRefused, type RawEntry } from './git.ts';

export type FileKind = 'text' | 'rename' | 'binary' | 'lfs' | 'submodule' | 'link' | 'mode' | 'line-endings' | 'sidestory' | 'archive' | 'unsupported' | 'type-change' | 'missing' | 'too-large';

/**
 * Kinds whose lines can't be compared but which still count, each as ONE change that only a trivialFiles match can
 * cover (`tooLargeChange`, §5.1): so nothing a branch changes can slip past the gate by being binary, in Git LFS, a
 * link, a submodule, a type change, a path Sidestory won't read, or under `.sidestory/archive/` (archives are written
 * by the archive job on the default branch, never in a branch). Moves count too: one change per (old folder → new
 * folder) group (`moveGroups`), carried by its first file; a pure move is kind 'rename'. Only mode-only and
 * line-ending-only changes stay "not counted".
 */
export const ONE_CHANGE_KINDS: ReadonlySet<FileKind> = new Set<FileKind>(['too-large', 'binary', 'lfs', 'link', 'submodule', 'type-change', 'unsupported', 'archive']);

export interface CoverageOptions {
  /** Where to look for the repository when no sidestory is given (--repo, else the working directory). */
  repo?: string;
  /** The sidestory folder given on the command line (absolute). */
  sidestory?: string;
  /** --base; else the sidestory's own base. */
  base?: string;
  /** --committed: HEAD instead of the working tree. */
  committed?: boolean;
  /** --head <sha>: that commit instead of the working tree. */
  head?: string;
  /** Tests: which git, and the environment it inherits (before cleaning). */
  gitPath?: string;
  env?: NodeJS.ProcessEnv;
  /** --new-id: a new sidestory replaces one under the same folder name, so its `id` differs on purpose. */
  newId?: boolean;
}

export interface JsonChange {
  key: string;
  old: [number, number] | null;
  new: [number, number] | null;
  added: number;
  removed: number;
  status: ChangeCoverage['state'];
  by: { sidestory: string; anchor: string }[];
  /** Uncovered added lines (new side). */
  uncovered: [number, number][];
  /** Uncovered removed lines (old side). */
  uncoveredOld: [number, number][];
  needsLook?: { sidestory: string; anchor: string; lines: number[] }[];
  stale?: boolean;
  broad?: boolean;
  why?: string[];
  /** A move group's change (§5.1): what moved. */
  move?: { label: string; from: string; to: string; files: { path: string; oldPath: string }[]; more?: number };
  /** A move group's files with neither a step nor their own trivial mark or trivialFiles match. */
  uncoveredFiles?: string[];
}

export interface CoverageJson {
  base: { spec: string; label: string; sha: string } | null;
  mergeBase: string | null;
  /** 'working tree', or the head commit. */
  head: string | null;
  /** Repo-relative folders of the sidestories that belong (§6.1). */
  sidestories: string[];
  files: { path: string; oldPath?: string; status: string; kind: FileKind; changes: JsonChange[] }[];
  totals: Totals & { notCounted: number };
  /** Something stopped coverage from being complete (a cap, a missing object, a page too complex to scan). */
  incomplete: boolean;
}

export interface CoverageResult {
  coverage: CoverageJson;
  findings: Finding[];
  /** The text header: `.sidestory/x: base main (origin/main), merge-base 3f2a1c9, head: working tree`. */
  header: string;
  /** The totals line. */
  summary: string;
  /** Exit 3 unless every change is done (and nothing stopped the count). */
  done: boolean;
  /** Belonging sidestories as absolute folders, for the normal checks. */
  sidestoryDirs: string[];
  /** For --pin and --accept on the given sidestory: its anchors with changed-since-pinned lines, and the merge-base texts. */
  branch?: BranchContext;
}

export interface BranchContext {
  /** Anchors (of the given sidestory) with lines added after they were pinned, and those lines. */
  held: Map<string, number[]>;
  /** The merge-base text of a path relative to the sidestory's root (the folder holding .sidestory/), for base-side pins. */
  baseText(file: string): Promise<string | undefined>;
  /** The id the given sidestory's manifest had at the merge-base or HEAD: --pin puts it back rather than writing a new one. */
  previousId?: string;
}

const ZERO = /^0+$/;
const REGULAR = new Set(['100644', '100755']);

interface Entry extends RawEntry {
  kind: FileKind;
  /** Untracked (working tree mode), or paired as an unstaged rename. */
  untracked?: boolean;
  detected?: boolean;
  diff?: { changes: ChangeBlock[]; newLines: number };
  newText?: string;
  oldText?: string;
}

interface Sidestory {
  /** Repo-relative folder: `.sidestory/x` or `pkg/.sidestory/x`. */
  folder: string;
  /** Repo-relative folder holding `.sidestory/` ('' at the repository root). */
  prefix: string;
  manifestText: string;
  manifest: Manifest;
  diagnostics: Diagnostic[];
  html: string;
  /** The page is over the read cap (MAX_COMPARE_BYTES): a candidate all the same, and coverage is incomplete. */
  htmlTooLarge?: boolean;
  ownMergeBase?: string;
}

/** `<prefix>/.sidestory/<name>/<rest>` for a real sidestory folder (`sidestoryFolderOf`), else undefined. */
function sidestoryOf(path: string): { prefix: string; folder: string; rest: string } | undefined {
  const folder = sidestoryFolderOf(path);
  if (!folder) return undefined;
  const at = folder.lastIndexOf('/.sidestory/');
  return { prefix: at < 0 ? '' : folder.slice(0, at), folder, rest: path.slice(folder.length + 1) };
}

const rel = (prefix: string, file: string) => (prefix ? `${prefix}/${file}` : file);

/** Lines as `40–44` or `40`. */
const span = (r: LineRange) => (r.start === r.end ? `${r.start}` : `${r.start}–${r.end}`);
const counts = (c: { added: number; removed: number }) => [c.added ? `+${c.added}` : '', c.removed ? `−${c.removed}` : ''].filter(Boolean).join(' ');

/**
 * Builds the comparison and its coverage. Never throws for repository problems: they become findings (and an
 * incomplete, not-done result).
 */
export async function runCoverage(opts: CoverageOptions): Promise<CoverageResult> {
  const findings: Finding[] = [];
  const empty = (where: string, header: string): CoverageResult => ({
    coverage: { base: null, mergeBase: null, head: null, sidestories: [], files: [], totals: { changes: 0, explained: 0, trivial: 0, left: 0, needsLook: 0, files: 0, notCounted: 0 }, incomplete: true },
    findings,
    header: `${where}: ${header}`,
    summary: 'Coverage not computed.',
    done: false,
    sidestoryDirs: [],
  });
  const add = (severity: Severity, file: string, code: string, message: string, line?: number) => findings.push({ severity, file, code, message, ...(line ? { line } : {}) });

  const start = opts.sidestory ?? opts.repo ?? process.cwd();
  const loc = await findRepository(start);
  if (!loc) {
    add('error', start, 'not-a-repository', 'No git repository here: --coverage compares a branch with its base, so it runs inside a git checkout (the nearest folder with a .git above this one).');
    return empty(start, 'not a git repository');
  }
  const git = new Git(loc, { gitPath: opts.gitPath, env: opts.env });
  try {
    return await compute(git, opts, findings, add, empty);
  } catch (e) {
    if (e instanceof GitError || e instanceof WorkingTreeRefused) {
      add('error', loc.root, e instanceof WorkingTreeRefused ? 'working-tree-refused' : 'git', e.message);
      return empty(loc.root, 'coverage not computed');
    }
    throw e;
  } finally {
    await git.dispose();
  }
}

type Add = (severity: Severity, file: string, code: string, message: string, line?: number) => void;

async function compute(git: Git, opts: CoverageOptions, findings: Finding[], add: Add, empty: (where: string, header: string) => CoverageResult): Promise<CoverageResult> {
  const root = git.root;
  const abs = (p: string) => join(root, ...p.split('/'));
  const mode: 'working' | 'committed' | 'head' = opts.head ? 'head' : opts.committed ? 'committed' : 'working';

  // The given sidestory: its folder in the repository, and its manifest from disk (its base, its pins).
  let given: { folder: string; prefix: string; manifest?: Manifest; manifestFile: string } | undefined;
  if (opts.sidestory) {
    // The root is a real path (findRepository): compare real paths, so a folder reached through a link (macOS's
    // /var → /private/var) is still inside.
    const r = relative(root, await realpath(opts.sidestory).catch(() => opts.sidestory!));
    const s = r !== undefined ? sidestoryOf(`${r}/manifest.json`) : undefined;
    const manifestFile = join(opts.sidestory, 'manifest.json');
    if (r === undefined || !s) {
      add('error', opts.sidestory, 'not-in-repository', "This sidestory isn't in a .sidestory/<name>/ folder of the repository, so it can't count toward the branch's coverage.");
      return empty(opts.sidestory, 'not in the repository');
    }
    const bytes = await git.readWorkingFile(`${r}/manifest.json`);
    const parsed = 'bytes' in bytes ? parseManifest(decodeUtf8(bytes.bytes) ?? '') : undefined;
    given = { folder: r, prefix: s.prefix, manifest: parsed?.ok ? parsed.manifest : undefined, manifestFile };
  }
  const where = given?.folder ?? 'Coverage';
  const baseSpec = opts.base ?? given?.manifest?.base;
  const baseFile = opts.base !== undefined || !given ? root : given.manifestFile;
  if (baseSpec === undefined) {
    add('error', given?.manifestFile ?? root, 'base', given ? 'This sidestory has no valid "base", so it has no branch to explain: add "base": "main" (the branch it is compared with), or pass --base.' : '--coverage without a sidestory needs --base <branch>.');
    return empty(where, 'no base');
  }
  if (!isValidBase(baseSpec)) {
    add('error', baseFile, 'base', `base ${JSON.stringify(baseSpec.slice(0, 80))} isn't a branch or tag name (like main or origin/main) or a full commit id.`);
    return empty(where, 'invalid base');
  }

  // The head side.
  let headSha: string | undefined;
  if (opts.head !== undefined) {
    if (!FULL_SHA.test(opts.head)) {
      add('error', root, 'head', `--head needs a full commit id (40 or 64 hex digits), not ${JSON.stringify(opts.head.slice(0, 80))}.`);
      return empty(where, 'invalid head');
    }
    headSha = await git.commit(opts.head);
    if (!headSha) {
      add('error', root, 'head', `--head ${opts.head.slice(0, 12)} isn't a commit in this repository.`);
      return empty(where, 'head not found');
    }
  } else headSha = await git.headCommit();
  if (!headSha) {
    add('error', root, 'no-commits', 'This repository has no commits yet, so there is nothing to compare.');
    return empty(where, 'no commits');
  }

  // The base and the merge-base (§4.3).
  const reader = await git.refReader();
  const resolved = await resolveBase(reader, baseSpec);
  if (!resolved) {
    add('error', baseFile, 'base-not-found', `base "${baseSpec}" isn't a branch, remote branch or tag here${FULL_SHA.test(baseSpec) ? ' (nor a commit)' : ''}. Fetch it (git fetch origin ${baseSpec}), or pass --base.`);
    return empty(where, `base ${baseSpec} not found`);
  }
  let mergeBase: string;
  if (mode === 'head' && FULL_SHA.test(baseSpec)) {
    // A review sidestory: its base is the merge-base itself, once it is an ancestor of the head (§13.1).
    if (!(await git.isAncestor(resolved.sha, headSha))) {
      add('error', baseFile, 'base-not-ancestor', `base ${baseSpec.slice(0, 12)} isn't an ancestor of ${headSha.slice(0, 12)}, so the diff wouldn't be the branch's own changes.`);
      return empty(where, 'base not an ancestor');
    }
    mergeBase = resolved.sha;
  } else {
    const all = await git.mergeBases(resolved.sha, headSha);
    if (!all.length) {
      add('error', baseFile, 'no-merge-base', `${resolved.label} and ${mode === 'head' ? headSha.slice(0, 12) : 'HEAD'} have no common commit (a shallow clone or unrelated histories). Fetch more history (git fetch --unshallow; fetch-depth: 0 in CI).`);
      return empty(where, 'no merge-base');
    }
    if (all.length > 1) add('warning', baseFile, 'several-merge-bases', `${resolved.label} and the head have ${all.length} merge-bases (a criss-cross history); using ${all[0]!.slice(0, 12)}, as git does.`);
    mergeBase = all[0]!;
  }
  const headLabel = mode === 'working' ? 'working tree' : mode === 'committed' ? `HEAD ${headSha.slice(0, 7)}` : headSha.slice(0, 7);
  let header = `${where}: base ${resolved.label}, merge-base ${mergeBase.slice(0, 7)}, head: ${headLabel}`;

  // The file list (§5.1, §13.1).
  let incomplete = false;
  const raw = mode === 'working' ? await git.diffWorkingTree(mergeBase) : await git.diffTree(mergeBase, headSha);
  const entries: Entry[] = raw.map((r) => ({ ...r, kind: 'text' }));
  if (mode === 'working') {
    const tracked = new Set(entries.map((e) => e.path));
    for (const listed of await git.untracked()) {
      // `ls-files -o` lists an untracked nested repository as `dir/`: a submodule-to-be, one change.
      const nested = listed.endsWith('/') && listed.length > 1;
      const p = nested ? listed.slice(0, -1) : listed;
      if (!tracked.has(p)) entries.push({ status: 'A', oldMode: '000000', newMode: nested ? '160000' : '100644', oldId: '0'.repeat(mergeBase.length), newId: '0'.repeat(mergeBase.length), path: p, kind: 'text', untracked: true });
    }
  }
  const sorted = entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // Bytes: blobs by id, working tree files by path.
  // In working tree mode the new side is always the file on disk, as in the extension: git may show a hash for it
  // (the index's, or the file's own when it had to hash a racily clean file) that isn't an object in the clone.
  const blobIds = new Set<string>();
  for (const e of sorted) {
    if (!ZERO.test(e.oldId)) blobIds.add(e.oldId);
    if (!ZERO.test(e.newId) && mode !== 'working') blobIds.add(e.newId);
  }
  const unsafe = (e: Entry) => !isSafeRepoPath(e.path) || (e.oldPath !== undefined && !isSafeRepoPath(e.oldPath));
  // In working tree mode the new side is read from disk: the file system rule (no device names, trailing dots or
  // spaces, ":") applies to it too. Blobs read by id need only the lenient rule.
  const unreadableOnDisk = (e: Entry) => mode === 'working' && e.newMode !== '000000' && !isSafeFsPath(e.path);
  // The files sidestories own (manifest.json and sidestory.html of a folder that is a complete sidestory at the head
  // or at the merge-base) are the only ones left out; every other file under .sidestory/ counts (§5.1).
  const complete = new Set<string>();
  const ownedFolders = new Set<string>();
  for (const e of sorted) {
    for (const p of [e.path, e.oldPath]) {
      const f = p !== undefined && isSafeRepoPath(p) ? sidestoryFolderOf(p) : undefined;
      if (f && isOwnedFileName(p!.slice(f.length + 1))) ownedFolders.add(f);
    }
  }
  for (const f of ownedFolders) {
    const files = SIDESTORY_FILES.map((n) => `${f}/${n}`);
    const regularAt = async (commit: string) => {
      const t = await git.lsTree(commit, files);
      return isCompleteSidestory(SIDESTORY_FILES.filter((_, k) => REGULAR.has(t.get(files[k]!)?.mode ?? '')));
    };
    const atHead = mode === 'working' ? (await Promise.all(files.map((p) => git.isWorkingFile(p)))).every(Boolean) : await regularAt(headSha);
    if (atHead || (await regularAt(mergeBase))) complete.add(f);
  }
  const isComplete = (folder: string) => complete.has(folder);
  const zeros = (id: string) => '0'.repeat(id.length);

  // Archiving into a branch (§12.4, way 2: the skill offers it, and it arrives with an ordinary PR): a file of a
  // sidestory that was complete at the merge-base, moved to `<prefix>/.sidestory/archive/<YYYY-MM-DD>-<name>/` with
  // the same relative path and the same blob (manifest.json only as the archive job rewrites it: `isArchivedManifest`). Such
  // a move, and the deletion it pairs with, are the explanation moving, not code. Anything else under the archive
  // counts as one change.
  const completeAtBase = new Map<string, Promise<boolean>>();
  const archiveMoves = new Set<Entry>();
  for (const { entry: e, from, folder, file } of archiveMoveCandidates(sorted, isSafeRepoPath)) {
    if (ZERO.test(from.oldId)) continue;
    // The new side as committed, or on disk in working tree mode (its id may be missing or stale there).
    const newSide = async () => {
      if (mode === 'working') {
        const disk = await git.readWorkingFile(e.path);
        return 'bytes' in disk ? disk.bytes : undefined;
      }
      return ZERO.test(e.newId) ? undefined : (await git.blobs([e.newId])).bytes.get(e.newId);
    };
    if (file === 'manifest.json') {
      // Only as the archive job rewrites it: the old manifest but for base, head and landed (isArchivedManifest).
      const [old, now] = [(await git.blobs([from.oldId])).bytes.get(from.oldId), await newSide()];
      if (!old || !now || !isArchivedManifest(old, now)) continue;
    } else if (from.oldId !== e.newId) {
      if (mode !== 'working') continue;
      const [now, old] = [await newSide(), (await git.blobs([from.oldId])).bytes.get(from.oldId)];
      if (!now || !old || !sameBytes(now, old)) continue;
    }
    if (!completeAtBase.has(folder)) {
      const files = SIDESTORY_FILES.map((n) => `${folder}/${n}`);
      completeAtBase.set(folder, git.lsTree(mergeBase, files).then((t) => isCompleteSidestory(SIDESTORY_FILES.filter((_, k) => REGULAR.has(t.get(files[k]!)?.mode ?? '')))));
    }
    if (!(await completeAtBase.get(folder))) continue;
    archiveMoves.add(e).add(from);
  }

  // Stable ids (docs/COMMENTS-PLAN.md §3.1): local comment threads key off a sidestory's manifest `id`.
  const previousIds = await checkIds(git, sorted, { mode, mergeBase, headSha, report: !opts.newId, add: (file, code, message, line) => add('error', abs(file), code, message, line) });
  // Shared comment event files are the sidestory's own only when they are one: a regular file holding a valid event
  // (any regular mode, as the extension sees it; links and submodules never are).
  const notEvents = new Set<Entry>();
  const eventFiles = sorted.flatMap((e) => {
    const ids = e.newMode !== '000000' && !unsafe(e) ? threadEventPath(e.path) : undefined;
    return ids ? [{ e, ids }] : [];
  });
  // Committed blobs in one batch (a branch may share many comments); working tree files from disk.
  const eventIds = eventFiles.filter(({ e }) => REGULAR.has(e.newMode) && !ZERO.test(e.newId)).map(({ e }) => e.newId);
  const eventBlobs = mode === 'working' ? undefined : eventIds.length ? (await git.blobs(eventIds)).bytes : new Map<string, Uint8Array>();
  for (const { e, ids } of eventFiles) {
    let bytes: Uint8Array | undefined;
    if (REGULAR.has(e.newMode)) {
      if (eventBlobs) bytes = eventBlobs.get(e.newId);
      else {
        const disk = isSafeFsPath(e.path) ? await git.readWorkingFile(e.path) : undefined;
        bytes = disk && 'bytes' in disk ? disk.bytes : undefined;
      }
    }
    if (!isThreadEventBytes(ids, bytes)) notEvents.add(e);
  }
  let classified = sorted.map((original) => {
    let e = original;
    if (unsafe(e)) {
      e.kind = 'unsupported';
      return e;
    }
    if (archiveMoves.has(e)) {
      e.kind = 'sidestory';
      return e;
    }
    // Anything else under .sidestory/archive/, on either side of a rename: one change (§12.3).
    if (isArchivePath(e.path) || (e.oldPath !== undefined && isArchivePath(e.oldPath))) {
      e.kind = 'archive';
      return e;
    }
    const c = notEvents.has(e) ? { counted: true as const } : countedChange(e, isComplete);
    if (!c.counted) {
      e.kind = 'sidestory';
      return e;
    }
    // A rename between code and a sidestory's own file: the code side alone, as a deletion or an addition.
    if (c.as === 'deletion') {
      const { oldPath, ...rest } = e;
      e = { ...rest, status: 'D', path: oldPath!, newMode: '000000', newId: zeros(e.newId), kind: 'text' };
    } else if (c.as === 'addition') {
      const { oldPath: _old, ...rest } = e;
      e = { ...rest, status: 'A', oldMode: '000000', oldId: zeros(e.oldId), kind: 'text' };
    }
    if (e.status === 'T' || ((e.oldMode === '120000') !== (e.newMode === '120000') || (e.oldMode === '160000') !== (e.newMode === '160000')) && e.oldMode !== '000000' && e.newMode !== '000000') e.kind = 'type-change';
    else if (e.oldMode === '160000' || e.newMode === '160000') e.kind = 'submodule';
    else if (e.oldMode === '120000' || e.newMode === '120000') e.kind = 'link';
    else if (unreadableOnDisk(e)) e.kind = 'unsupported';
    else if (e.status === 'M' && !ZERO.test(e.newId) && e.oldId === e.newId) e.kind = 'mode';
    return e;
  });
  classified.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const wantedIds = [...blobIds].filter((id) => classified.some((e) => (e.kind === 'text' || e.kind === 'sidestory') && (e.oldId === id || e.newId === id)));
  const { bytes: blobs, skipped } = await git.blobs(wantedIds);
  const missing = new Set<string>();
  for (const [id, why] of skipped) {
    if (why === 'missing') missing.add(id);
    if (why === 'budget') incomplete = true;
  }

  const readNew = async (e: Entry): Promise<Uint8Array | 'too-large' | 'missing' | 'link' | 'submodule' | 'unsupported' | undefined> => {
    if (e.newMode === '000000') return undefined;
    if (mode !== 'working') return blobs.get(e.newId) ?? (skipped.get(e.newId) === 'too-large' ? 'too-large' : 'missing');
    const r = await git.readWorkingFile(e.path);
    if ('bytes' in r) return r.bytes;
    switch (r.error) {
      case 'too-large':
        return 'too-large';
      // A link on disk (an untracked symlink, or a folder on the way that is one): the extension's stat sees a link too.
      case 'link':
      case 'outside':
        return 'link';
      case 'directory':
        return 'submodule';
      case 'not-a-file':
      case 'unsupported':
        return 'unsupported';
      case 'budget':
        incomplete = true;
        return 'missing';
      default:
        return 'missing';
    }
  };
  const readOld = (e: Entry): Uint8Array | 'too-large' | 'missing' | undefined => {
    if (e.oldMode === '000000' || ZERO.test(e.oldId)) return undefined;
    return blobs.get(e.oldId) ?? (skipped.get(e.oldId) === 'too-large' ? 'too-large' : 'missing');
  };

  const newBytes = new Map<Entry, Uint8Array | undefined>();
  const oldBytes = new Map<Entry, Uint8Array | undefined>();
  for (const e of classified) {
    if (e.kind !== 'text') continue;
    const [o, n] = [readOld(e), await readNew(e)];
    if (n === 'link' || n === 'submodule' || n === 'unsupported') {
      e.kind = n;
      continue;
    }
    if (o === 'missing' || n === 'missing') {
      e.kind = 'missing';
      continue;
    }
    if (o === 'too-large' || n === 'too-large') {
      e.kind = 'too-large';
      continue;
    }
    // Git LFS (every side a complete pointer, isLfsChange) and binary each count as one change.
    if (isLfsChange(o, n)) e.kind = 'lfs';
    else if (isBinary(o) || isBinary(n)) e.kind = 'binary';
    // The same bytes: mode only or nothing, unless the path changed (a pure rename counts, below).
    else if (o && n && sameBytes(o, n) && (e.oldPath === undefined || e.oldPath === e.path)) e.kind = e.oldMode !== e.newMode ? 'mode' : 'line-endings';
    oldBytes.set(e, o);
    newBytes.set(e, n);
  }

  // Unstaged renames (§4.6): a deleted tracked file and an untracked new one, paired by content.
  if (mode === 'working') {
    const deleted = classified.filter((e) => e.kind === 'text' && e.status === 'D' && !e.untracked);
    const added = classified.filter((e) => e.kind === 'text' && e.untracked);
    const pairs = pairUnstagedRenames(deleted, added, (d) => oldBytes.get(d), (a) => newBytes.get(a));
    const dropped = new Set<Entry>();
    for (const { deleted: d, added: a } of pairs) {
      // The untracked entry becomes the rename; the deletion it replaces goes.
      dropped.add(d);
      a.oldPath = d.path;
      a.oldId = d.oldId;
      a.oldMode = d.oldMode;
      a.status = 'R';
      a.detected = true;
      oldBytes.set(a, oldBytes.get(d));
    }
    if (dropped.size) classified = classified.filter((e) => !dropped.has(e));
  }

  for (const e of classified) {
    if (e.kind !== 'text') continue;
    const d = decodePair(oldBytes.get(e), newBytes.get(e));
    const diff = diffTexts(e.path, d.old, d.new);
    if (diff.lineEndingsOnly || !diff.changes.length) {
      // A pure move still counts, in its folder's move group (§5.1); its text stays readable for the anchors.
      if (e.oldPath !== undefined && e.oldPath !== e.path) {
        e.kind = 'rename';
        e.diff = { changes: [], newLines: diff.newLines };
        e.newText = d.new;
        e.oldText = d.old;
      } else e.kind = 'line-endings';
      continue;
    }
    e.diff = { changes: diff.changes, newLines: diff.newLines };
    e.newText = d.new;
    e.oldText = d.old;
  }
  for (const e of classified) {
    if (e.kind === 'missing') {
      incomplete = true;
      add('warning', abs(e.path), 'blob-missing', `${e.path}: a version of this file isn't in this clone (a partial or shallow clone); the checker never fetches. Fetch it (git fetch) and run again.`);
    }
  }

  // The sidestories that belong (§6.1): their manifests are added in the change (absent at the merge-base, present
  // at the head), plus the given one (a review sidestory lives untracked beside a fixed head).
  const candidates = new Map<string, { prefix: string; fromDisk: boolean }>();
  // From git's own entries (`sorted`), before a rename between code and a manifest was split into its code side.
  for (const e of sorted) {
    const s = sidestoryOf(e.path);
    if (s && s.rest === 'manifest.json' && (e.status === 'A' || e.status === 'R' || e.status === 'C' || e.untracked) && e.newMode !== '000000') {
      candidates.set(e.path.slice(0, -'/manifest.json'.length), { prefix: s.prefix, fromDisk: mode === 'working' });
    }
  }
  if (given && !candidates.has(given.folder)) candidates.set(given.folder, { prefix: given.prefix, fromDisk: mode === 'working' });
  for (const folder of candidates.keys()) if (!isSafeRepoPath(folder)) candidates.delete(folder);
  const ownMergeBases = new Map<string, Promise<string | undefined>>([[baseSpec, Promise.resolve(mergeBase)]]);
  const ownMergeBase = (spec: string) => {
    let p = ownMergeBases.get(spec);
    if (!p) {
      p = (async () => {
        const r = await resolveBase(reader, spec);
        if (!r) return undefined;
        if (mode === 'head' && FULL_SHA.test(spec)) return (await git.isAncestor(r.sha, headSha!)) ? r.sha : undefined;
        return (await git.mergeBases(r.sha, headSha!))[0];
      })();
      ownMergeBases.set(spec, p);
    }
    return p;
  };
  const sidestories: Sidestory[] = [];
  const notBelonging: string[] = [];
  for (const [folder, c] of [...candidates].sort(([a], [b]) => (a < b ? -1 : 1))) {
    // A review sidestory (--head) lives untracked beside the commit it describes; with --committed, a sidestory
    // counts only once it is committed, as in CI.
    const read = await readSidestory(git, folder, c.fromDisk ? undefined : headSha, mode === 'head' && given?.folder === folder);
    if (!read) {
      if (given?.folder === folder) notBelonging.push(mode === 'committed' ? `${folder} (it isn't committed at HEAD: --committed reads sidestories at HEAD, as CI does; commit it, or leave out --committed)` : `${folder} (its manifest.json or sidestory.html can't be read${mode !== 'working' ? ' at the head commit' : ''})`);
      continue;
    }
    const parsed = parseManifest(read.manifestText);
    if (!parsed.ok) {
      add('error', abs(`${folder}/manifest.json`), 'manifest', parsed.error);
      continue;
    }
    const m = parsed.manifest;
    const own = m.base !== undefined ? await ownMergeBase(m.base) : undefined;
    const presentAtMergeBase = (await git.lsTree(mergeBase, [`${folder}/manifest.json`])).size > 0;
    const ok = belongs({ presentAtMergeBase, presentAtHead: true, ownMergeBase: own, comparisonMergeBase: mergeBase, manifestHead: m.head, comparisonHead: mode === 'head' ? headSha : undefined });
    if (!ok) {
      if (given?.folder === folder) {
        const why =
          m.base === undefined ? 'it has no valid "base"'
          : presentAtMergeBase && m.head === undefined ? 'it already exists at the merge-base: it landed earlier, and a follow-up change needs its own sidestory'
          : own === undefined ? `its base "${m.base}" doesn't resolve here`
          : own !== mergeBase ? `its base "${m.base}" gives another merge-base (${own.slice(0, 7)})`
          : m.head !== undefined ? 'its "head" fixes another commit'
          : 'it is not part of this change';
        notBelonging.push(`${folder} (${why})`);
      }
      continue;
    }
    sidestories.push({ folder, prefix: c.prefix, manifestText: read.manifestText, manifest: m, diagnostics: parsed.diagnostics, html: read.html, ...(read.htmlTooLarge ? { htmlTooLarge: true } : {}), ownMergeBase: own });
  }
  for (const n of notBelonging) add('warning', given?.manifestFile ?? root, 'not-belonging', `${n} doesn't count toward this branch's coverage.`);
  header += sidestories.length ? `; counting ${sidestories.map((s) => s.folder).join(', ')}` : '; no sidestory of this branch yet';

  // Counted files, trivialFiles, targets.
  const counted = classified.filter((e) => e.kind === 'text' || e.kind === 'rename' || ONE_CHANGE_KINDS.has(e.kind));
  const matchers = sidestories.map((s) => ({ s, patterns: s.manifest.trivialFiles ?? [], match: globMatcher(s.manifest.trivialFiles ?? []) }));
  const underPrefix = (prefix: string, path: string) => (prefix ? (path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : undefined) : path);
  for (const { s, patterns } of matchers) {
    for (const p of patterns) {
      const one = globMatcher([p]);
      // Binary and LFS files are what such globs are for: they don't make a pattern broad.
      const lined = counted.filter((e) => e.kind !== 'binary' && e.kind !== 'lfs');
      const n = lined.filter((e) => {
        const r = underPrefix(s.prefix, e.path);
        return r !== undefined && one(r);
      }).length;
      if (p === '**' || p === '*' || (lined.length > 1 && n > lined.length / 2)) {
        add('warning', abs(`${s.folder}/manifest.json`), 'trivial-broad', `trivialFiles pattern "${p}" marks ${p === '**' || p === '*' ? 'every file' : `${n} of the ${lined.length} changed files`} as needing no explanation; name the files (package-lock.json, **/__snapshots__/**) so reviewers can trust the mark.`, manifestLineOf(s.manifestText, 'trivialFiles'));
      }
    }
  }
  const isTrivialFile = (path: string) =>
    matchers.some(({ s, match }) => {
      const r = underPrefix(s.prefix, path);
      return r !== undefined && match(r);
    });

  // One entry per path on each side, whatever order git listed them in: a file's own entry (modified, renamed or
  // deleted) wins over a copy made from it, then the first by new path (`counted` is sorted).
  const byNew = new Map<string, Entry>();
  const byOld = new Map<string, Entry>();
  for (const e of counted) if (!byNew.has(e.path)) byNew.set(e.path, e);
  for (const pass of [false, true]) {
    for (const e of counted) {
      if ((e.status === 'C') !== pass || e.oldMode === '000000') continue; // added: no merge-base side
      const k = e.oldPath ?? e.path;
      if (!byOld.has(k)) byOld.set(k, e);
    }
  }
  const targets: Target[] = [];
  const stepTitles = new Map<string, Map<string, string>>();
  for (const s of sidestories) {
    const used = s.htmlTooLarge ? { ids: new Set<string>(), incomplete: true } : usedAnchorIds(s.html);
    if (used.incomplete) {
      incomplete = true;
      add('warning', abs(`${s.folder}/sidestory.html`), 'coverage-incomplete', s.htmlTooLarge ? `The page is over ${MAX_COMPARE_BYTES / (1024 * 1024)} MB, too large to read for the anchors it uses, so coverage can't be complete. Split the page.` : "The page is too large to scan for the anchors it uses, so coverage can't be complete. Split the page.");
    }
    const outline = outlineHtml(s.html);
    const steps = new Set(outline.steps.map((x) => x.id));
    stepTitles.set(s.folder, new Map(outline.steps.map((x) => [x.id, x.title])));
    const manifestFile = abs(`${s.folder}/manifest.json`);
    for (const a of s.manifest.anchors.values()) {
      const line = manifestLineOf(s.manifestText, a.id, true);
      if (a.trivial && a.why === undefined) continue; // reported as trivial-why with the manifest's diagnostics
      if (a.trivial && steps.has(a.id)) add('warning', manifestFile, 'trivial-section', `Anchor "${a.id}" is a trivial mark, but sidestory.html has a section for it: trivial marks aren't steps. Remove the section, or drop "trivial" and explain the change.`, line);
      if (!a.trivial && !used.ids.has(a.id)) {
        if (!used.incomplete) add('warning', manifestFile, 'anchor-unused', `Anchor "${a.id}" isn't used by sidestory.html (no section, data-explain-ref or data-explain-on), so it explains no change. Refer to it from the prose, or remove it.`, line);
        continue;
      }
      const side = sideOf(a);
      const path = rel(s.prefix, a.file);
      const e = side === 'head' ? byNew.get(path) : byOld.get(path);
      if (!e || !e.diff) continue; // a file this branch doesn't change (or can't compare): nothing to cover
      const text = side === 'head' ? e.newText! : e.oldText!;
      const r = resolveAnchor(PreparedText.from(text), a);
      targets.push({
        sidestory: s.folder,
        anchor: a.id,
        path,
        side,
        range: r.range,
        state: r.state,
        ...(a.trivial ? { trivial: true, why: a.why } : {}),
        ...(a.quote && side === 'head' ? { pinned: new Set(normalizeLines(textLines(a.quote.exact), 'ws')) } : {}),
      });
    }
  }

  const inputs: FileInput[] = counted.map((e) => {
    const newLines = e.newText !== undefined ? textLines(e.newText) : [];
    const oldLines = e.oldText !== undefined ? textLines(e.oldText) : [];
    return {
      path: e.path,
      ...(e.oldPath !== undefined ? { oldPath: e.oldPath } : {}),
      changes: e.diff?.changes ?? [tooLargeChange(e.path, 0, 0)],
      newLine: (l) => newLines[l - 1] ?? '',
      oldLine: (l) => oldLines[l - 1] ?? '',
      trivialFile: isTrivialFile(e.path),
      newLines: newLines.length,
    };
  });
  // Moves (§5.1): one change per (old folder → new folder), carried by the group's first file.
  // Archive changes and unsupported paths are counted already, one change each: never in a move group too.
  const inputPaths = new Set(inputs.map((f) => f.path));
  const carried = moveCarriers(moveGroups(counted.filter((e) => e.kind !== 'archive' && e.kind !== 'unsupported')), (p) => inputPaths.has(p));
  for (const f of inputs) {
    const move = carried.get(f.path);
    if (move) f.changes = [move, ...f.changes];
  }
  const result = computeCoverage(inputs, targets);

  // Findings per change, and per target.
  const title = (sidestory: string, anchor: string) => {
    const t = stepTitles.get(sidestory)?.get(anchor);
    return t ? `step "${t}"` : `anchor "${anchor}"`;
  };
  const many = sidestories.length > 1;
  const of = (sidestory: string) => (many ? ` of ${sidestory}` : '');
  // Covered moves: one info line each, or one summary past 5 groups (a big refactor shouldn't flood the report).
  const coveredMoves: { file: string; text: string; label: string }[] = [];
  result.files.forEach((f, fi) => {
    const e = counted[fi]!;
    const file = abs(f.path);
    f.changes.forEach((c, ci) => {
      const block = inputs[fi]!.changes[ci]!;
      const at = block.new ? block.new.start : e.newMode === '000000' ? (block.old?.start ?? 1) : Math.max(1, Math.min(block.newAt, e.diff?.newLines ?? 1));
      const where = block.new ? `lines ${span(block.new)}`.replace(/^lines (\d+)$/, 'line $1') : e.newMode === '000000' ? 'deleted file' : `deleted at line ${at}`;
      if (block.move) {
        // Every move is said with its files, covered or not, so a reviewer sees what moved.
        const g = block.move;
        const what = `${moveLabel(g)}${g.files.length > 1 ? ` (${moveFiles(g, 50)})` : ''}`;
        if (c.state === 'unexplained') {
          const lacking = c.uncoveredFiles ?? [];
          const without = lacking.length && lacking.length < g.files.length ? ` Without cover: ${lacking.slice(0, 10).join(', ')}${lacking.length > 10 ? `, and ${lacking.length - 10} more` : ''}.` : '';
          add('warning', file, 'unexplained', `${what}: a move can switch code off, so it needs a mention. A step anchored in any of these files explains it; a trivial mark or trivialFiles match covers only its own file's move.${without}`, 1);
        } else {
          coveredMoves.push({ file, text: `${what}: ${c.state === 'trivial' ? 'every file marked trivial' : `explained by ${c.by.map((x) => title(x.sidestory, x.anchor) + of(x.sidestory)).join(', ')}`}.`, label: moveLabel(g) });
        }
        return;
      }
      if (ONE_CHANGE_KINDS.has(e.kind)) {
        if (c.state !== 'trivial') {
          const [code, at, what] = oneChangeFinding(e, root, abs);
          add('warning', at, code, `${what}; it counts as one unexplained change. Mark it in trivialFiles if it needs no explanation${e.kind === 'binary' ? ' (a glob such as "**/*.png" for assets)' : ''}.`, at === root ? undefined : 1);
        }
        return;
      }
      if (c.state === 'unexplained') {
        if (block.new) add('warning', file, 'unexplained', `${where} (${counts(block)}) ${block.new.start === block.new.end ? "isn't" : "aren't"} explained by a sidestory of this branch.`, at);
        else {
          const hint = block.removed <= 20 ? 'anchor it with "side": "base", cover the lines around it with a step, or mark it trivial' : 'anchor it with "side": "base" (more than 20 lines need the removed code itself), or mark it trivial';
          add('warning', file, 'unexplained', `${where === 'deleted file' ? 'deleted file' : `deleted before line ${block.newAt}`} (${counts(block)}, old lines ${span(block.old!)}); ${hint}.`, at);
        }
      } else if (c.state === 'partly') {
        const head = c.uncovered.filter((u) => u.side === 'head').map((u) => span(u.range));
        const base = c.uncovered.filter((u) => u.side === 'base').map((u) => span(u.range));
        const parts = [head.length ? head.join(', ') : '', base.length ? `old lines ${base.join(', ')}${block.new ? ' (or cover all new lines with one step)' : ''}` : ''].filter(Boolean).join(' and ');
        add('warning', file, 'partly-explained', `${block.new ? where : `deleted (old lines ${span(block.old!)})`} (${counts(block)}): ${parts} ${head.length + base.length === 1 && !/[–,]/.test(parts) ? "isn't" : "aren't"} covered (${c.coveredLines} of ${c.changedLines} lines are).`, at);
      }
      for (const n of c.needsLook ?? []) {
        const lines = compactLines(n.lines);
        add('warning', file, 'changed-since-pinned', `${n.lines.length === 1 ? `line ${lines} was` : `lines ${lines} were`} added inside ${title(n.sidestory, n.anchor)}${of(n.sidestory)} after it was pinned; update the prose, then --accept ${n.anchor}.`, n.lines[0]);
      }
      if (c.stale && (c.state === 'explained' || c.state === 'trivial')) {
        const names = c.by.map((b) => title(b.sidestory, b.anchor)).join(', ');
        add('warning', file, 'explained-stale', `${where} explained by ${names}, whose code changed a lot since it was pinned: check the prose still fits, then re-pin (--pin).`, at);
      }
    });
  });
  if (coveredMoves.length > 5) add('info', root, 'moved', `${coveredMoves.length} moves, each explained or marked trivial: ${coveredMoves.slice(0, 10).map((m) => m.label).join('; ')}${coveredMoves.length > 10 ? `; and ${coveredMoves.length - 10} more` : ''} (the files of each are in --json).`);
  else for (const m of coveredMoves) add('info', m.file, 'moved', m.text, 1);
  for (const u of result.targets) {
    if (!u.broad) continue;
    const s = sidestories.find((x) => x.folder === u.sidestory)!;
    add('warning', abs(`${s.folder}/manifest.json`), 'anchor-broad', `Anchor "${u.anchor}" spans ${u.lines} lines of ${u.path} but covers only ${u.explains} changed line${u.explains === 1 ? '' : 's'}: narrow it to the code the step is about.`, manifestLineOf(s.manifestText, u.anchor, true));
  }

  // The given sidestory's context for --pin and --accept.
  let branch: BranchContext | undefined;
  if (given) {
    const held = new Map<string, number[]>();
    for (const f of result.files) for (const c of f.changes) for (const n of c.needsLook ?? []) if (n.sidestory === given.folder) held.set(n.anchor, [...(held.get(n.anchor) ?? []), ...n.lines]);
    const prefix = given.prefix;
    const cache = new Map<string, Promise<string | undefined>>();
    const previousId = opts.newId ? undefined : previousIds.get(`${given.folder}/manifest.json`);
    branch = {
      held,
      ...(previousId ? { previousId } : {}),
      baseText: (file) => {
        const path = rel(prefix, file);
        let p = cache.get(path);
        if (!p) {
          p = (async () => {
            const e = byOld.get(path);
            if (e?.oldText !== undefined) return e.oldText;
            const t = await git.lsTree(mergeBase, [path]);
            const id = t.get(path);
            if (!id || !REGULAR.has(id.mode)) return undefined;
            const b = (await git.blobs([id.id])).bytes.get(id.id);
            return b ? (decodeUtf8(b) ?? decodeLatin1(b)) : undefined;
          })();
          cache.set(path, p);
        }
        return p;
      },
    };
  }

  const notCounted = classified.filter((e) => e.kind !== 'text' && e.kind !== 'rename' && !ONE_CHANGE_KINDS.has(e.kind) && e.kind !== 'sidestory' && e.kind !== 'line-endings');
  const totals = { ...result.totals, notCounted: notCounted.length };
  const kinds = [...new Set(notCounted.map((e) => kindLabel(e.kind)))];
  const summary = `${totals.explained} explained · ${totals.trivial} trivial · ${totals.left} left${totals.needsLook ? ` (${totals.needsLook} changed since pinned)` : ''}, in ${totals.files} file${totals.files === 1 ? '' : 's'}.${notCounted.length ? ` ${notCounted.length} file${notCounted.length === 1 ? '' : 's'} not counted (${kinds.join(', ')}).` : ''}${incomplete ? ' Incomplete: see the warnings above.' : ''}`;

  const json: CoverageJson = {
    base: { spec: resolved.spec, label: resolved.label, sha: resolved.sha },
    mergeBase,
    head: mode === 'working' ? 'working tree' : headSha,
    sidestories: sidestories.map((s) => s.folder),
    files: classified
      .filter((e) => e.kind !== 'sidestory')
      .map((e) => {
        const fi = counted.indexOf(e);
        const changes = fi < 0 ? [] : result.files[fi]!.changes.map((c, ci) => toJson(c, inputs[fi]!.changes[ci]!));
        return { path: e.path, ...(e.oldPath !== undefined ? { oldPath: e.oldPath } : {}), status: e.detected ? 'R' : e.untracked ? 'A' : e.status, kind: e.kind, changes };
      }),
    totals,
    incomplete,
  };
  return {
    coverage: json,
    findings,
    header,
    summary,
    done: totals.left === 0 && !incomplete,
    sidestoryDirs: sidestories.map((s) => abs(s.folder)),
    branch,
  };
}

function toJson(c: ChangeCoverage, b: ChangeBlock): JsonChange {
  const pair = (r: LineRange | null): [number, number] | null => (r ? [r.start, r.end] : null);
  return {
    key: c.key,
    old: pair(b.old),
    new: pair(b.new),
    added: b.added,
    removed: b.removed,
    status: c.state,
    by: c.by,
    uncovered: c.uncovered.filter((u) => u.side === 'head').map((u) => [u.range.start, u.range.end]),
    uncoveredOld: c.uncovered.filter((u) => u.side === 'base').map((u) => [u.range.start, u.range.end]),
    ...(c.needsLook ? { needsLook: c.needsLook } : {}),
    ...(c.stale ? { stale: true } : {}),
    ...(c.broad ? { broad: true } : {}),
    ...(c.why ? { why: c.why } : {}),
    ...(b.move ? { move: moveJson(b.move) } : {}),
    ...(c.uncoveredFiles ? { uncoveredFiles: c.uncoveredFiles } : {}),
  };
}

/** A move group in --json: its label, prefixes and files (at most 200, `more` past that). */
function moveJson(g: MoveGroup): NonNullable<JsonChange['move']> {
  return { label: moveLabel(g), from: g.from, to: g.to, files: g.files.slice(0, 200).map((f) => ({ path: f.path, oldPath: f.oldPath })), ...(g.files.length > 200 ? { more: g.files.length - 200 } : {}) };
}

/** The finding for a file that counts as one change: its code, the file it names, and what it is. */
function oneChangeFinding(e: Entry, root: string, abs: (p: string) => string): [string, string, string] {
  const shown = e.oldPath !== undefined && e.oldPath !== e.path ? `${e.oldPath} → ${e.path}` : e.path;
  switch (e.kind) {
    case 'unsupported': {
      const why = [e.oldPath, e.path].map((p) => (p === undefined ? undefined : (pathProblem(p) ?? pathProblem(p, true)))).find((x) => x !== undefined) ?? 'a path Sidestory refuses';
      return ['unsupported-path', root, `A changed file has a path Sidestory won't read (${why}): ${JSON.stringify(shown.slice(0, 200))}`];
    }
    case 'binary':
      return ['unexplained', abs(e.path), `${shown} is a binary file`];
    case 'link':
      return ['unexplained', abs(e.path), `${shown} is a symbolic link`];
    case 'submodule':
      return ['unexplained', abs(e.path), `${shown} is a submodule whose commit changed`];
    case 'type-change':
      return ['type-change', abs(e.path), `${shown} changed type (a file, a link or a submodule)`];
    case 'lfs':
      return ['unexplained', abs(e.path), `${shown} is stored in Git LFS (its pointer changed), so its contents can't be compared`];
    case 'archive':
      return ['archive-changed', abs(e.path), `${shown} is under .sidestory/archive/, which only the archive job writes on the default branch, never a branch`];
    default:
      return ['unexplained', abs(e.path), `${shown} is too large to compare (over ${MAX_COMPARE_BYTES / (1024 * 1024)} MB)`];
  }
}

function kindLabel(k: FileKind): string {
  return { rename: 'renamed', binary: 'binary', lfs: 'LFS', submodule: 'submodule', link: 'link', mode: 'mode only', unsupported: 'unsupported path', 'type-change': 'type change', missing: 'missing object', text: 'text', 'line-endings': 'line endings only', sidestory: 'sidestory', archive: 'archive', 'too-large': 'too large' }[k];
}

const compactLines = (lines: number[]) => {
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    let j = i;
    while (j + 1 < lines.length && lines[j + 1] === lines[j]! + 1) j++;
    out.push(i === j ? `${lines[i]}` : `${lines[i]}–${lines[j]}`);
    i = j + 1;
  }
  return out.join(', ');
};

/**
 * `id-changed` and `id-removed` (docs/COMMENTS-PLAN.md §3.1): a manifest's `id` now against the one it had before.
 * Nothing when it had none, or when that id now lives under `.sidestory/archive/` (the sidestory was archived, and a
 * new one under its old name has an id of its own).
 */
export function idProblem(before: string | undefined, now: string | undefined, archived: ReadonlySet<string>): 'id-changed' | 'id-removed' | undefined {
  if (before === undefined || before === now || archived.has(before)) return undefined;
  return now === undefined ? 'id-removed' : 'id-changed';
}

/** A manifest's `id` as the manifest parser reads it (a bad one counts as none); undefined when it isn't a JSON object. */
function readManifestId(bytes: Uint8Array | undefined): { id?: string; text: string } | undefined {
  if (!bytes) return undefined;
  const text = decodeUtf8(bytes) ?? decodeLatin1(bytes);
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const id = parseBranchFields(raw as Record<string, unknown>).id;
  return id !== undefined ? { id, text } : { text };
}

/**
 * The ids of the sidestories this change edits, against the merge-base and, comparing the working tree, against HEAD
 * too (a sidestory added on the branch has no merge-base version, and an agent rewriting its manifest whole may drop
 * the id). Every manifest in the diff counts, not only the sidestories that belong: comments attach to landed ones too.
 * A manifest renamed into a folder of another name isn't compared (local threads go by folder name, and git may pair
 * two different small manifests as a rename). Returns each manifest's earlier id, so --pin can put back a dropped one.
 */
async function checkIds(git: Git, entries: readonly Entry[], o: { mode: 'working' | 'committed' | 'head'; mergeBase: string; headSha: string; report: boolean; add: (file: string, code: string, message: string, line?: number) => void }): Promise<Map<string, string>> {
  const previous = new Map<string, string>();
  const isManifest = (p: string | undefined) => p !== undefined && isSafeRepoPath(p) && p.endsWith('/manifest.json');
  // As much as the extension reads (MAX_MANIFEST_BYTES): a bigger manifest has no id there either.
  const capped = (b: Uint8Array | undefined) => (b && b.byteLength <= MAX_MANIFEST_BYTES ? b : undefined);
  const blob = async (id: string) => (ZERO.test(id) ? undefined : capped((await git.blobs([id])).bytes.get(id)));
  const newSide = async (e: Entry) => {
    if (o.mode !== 'working') return blob(e.newId);
    const disk = isSafeFsPath(e.path) ? await git.readWorkingFile(e.path) : undefined;
    return disk && 'bytes' in disk ? capped(disk.bytes) : undefined;
  };
  const name = (p: string) => sidestoryOf(p)?.folder.split('/').pop();
  // Ids that moved into the archive in this change (added or renamed there, not edits to older archives).
  const archived = new Set<string>();
  for (const e of entries) {
    if (e.newMode === '000000' || (e.status !== 'A' && e.status !== 'R') || !isManifest(e.path) || !isArchivePath(e.path)) continue;
    const id = readManifestId(await newSide(e))?.id;
    if (id) archived.add(id);
  }
  for (const e of entries) {
    if (e.newMode === '000000' || !isManifest(e.path) || sidestoryOf(e.path)?.rest !== 'manifest.json') continue;
    if (e.status === 'R' && (!isManifest(e.oldPath) || name(e.oldPath!) !== name(e.path))) continue;
    const now = readManifestId(await newSide(e));
    if (!now) continue;
    // What it was: at HEAD (the working tree's own edits: the newest id), then at the merge-base (edited or renamed there).
    const refs: { label: string; id: () => Promise<string | undefined> }[] = [];
    if (o.mode === 'working' && !e.untracked && o.headSha !== o.mergeBase) {
      refs.push({ label: `HEAD (${o.headSha.slice(0, 7)})`, id: async () => {
        const t = (await git.lsTree(o.headSha, [e.path])).get(e.path);
        return t && REGULAR.has(t.mode) && t.id !== e.oldId ? readManifestId(await blob(t.id))?.id : undefined;
      } });
    }
    if (e.status === 'M' || e.status === 'R') refs.push({ label: `the merge-base (${o.mergeBase.slice(0, 7)})`, id: async () => readManifestId(await blob(e.oldId))?.id });
    for (const ref of refs) {
      const before = await ref.id();
      // HEAD's id wins over the merge-base's; an archived sidestory's id is never reused.
      if (before !== undefined && !archived.has(before) && !previous.has(e.path)) previous.set(e.path, before);
      const problem = idProblem(before, now.id, archived);
      if (!problem) continue;
      if (!o.report) continue;
      const why = 'local comment threads find their sidestory by it, and would otherwise move to "Elsewhere" in its panel';
      o.add(
        e.path,
        problem,
        problem === 'id-changed'
          ? `"id" is "${now.id}", but it was "${before}" at ${ref.label}: ${why}. Put back "id": "${before}". (Only if the user says this is a new sidestory replacing a deleted one under the same folder name, run again with --new-id.)`
          : `"id" is missing or not a valid id, but it was "${before}" at ${ref.label}: ${why}. Put back "id": "${before}"; --pin does so too, from this comparison.`,
        manifestLineOf(now.text, 'id'),
      );
      break;
    }
  }
  return previous;
}

/** A sidestory's manifest and page: from the working tree, or from the head commit (falling back to disk when `diskToo`). */
async function readSidestory(git: Git, folder: string, atCommit: string | undefined, diskToo: boolean): Promise<{ manifestText: string; html: string; htmlTooLarge?: boolean } | undefined> {
  // Both files or neither (isCompleteSidestory): a manifest without its page counts nothing yet. A page over the
  // read cap still makes it a sidestory (its anchors can't be read, so coverage is incomplete), as in the extension.
  const files = SIDESTORY_FILES.map((f) => `${folder}/${f}`);
  const htmlAt = SIDESTORY_FILES.indexOf('sidestory.html');
  const decode = (b: Uint8Array) => decodeUtf8(b) ?? decodeLatin1(b);
  const done = (manifest: Uint8Array, html: Uint8Array | 'too-large') => ({ manifestText: decode(manifest), html: html === 'too-large' ? '' : decode(html), ...(html === 'too-large' ? { htmlTooLarge: true } : {}) });
  if (atCommit) {
    const t = await git.lsTree(atCommit, files);
    const ids = files.map((f) => t.get(f));
    if (isCompleteSidestory(SIDESTORY_FILES.filter((_, k) => ids[k] && REGULAR.has(ids[k].mode)))) {
      const b = await git.blobs(ids.map((i) => i!.id));
      const got = ids.map((i, k) => b.bytes.get(i!.id) ?? (k === htmlAt && b.skipped.get(i!.id) === 'too-large' ? ('too-large' as const) : undefined));
      const m = got[1 - htmlAt];
      const h = got[htmlAt];
      if (m instanceof Uint8Array && h) return done(m, h);
    }
    if (!diskToo) return undefined;
  }
  const read = await Promise.all(files.map((f) => git.readWorkingFile(f)));
  const m = read[1 - htmlAt]!;
  const h = read[htmlAt]!;
  if (!('bytes' in m)) return undefined;
  if ('bytes' in h) return done(m.bytes, h.bytes);
  return h.error === 'too-large' ? done(m.bytes, 'too-large') : undefined;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** `p` relative to `root` with / separators ('' for the root itself), or undefined when outside it. */
function relative(root: string, p: string): string | undefined {
  const r = pathRelative(root, p);
  if (r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r)) return undefined;
  return r.split(sep).join('/');
}

/** The line of `"key":` in a manifest's text (an anchor's key when `anchor`), for findings. */
export function manifestLineOf(text: string, key: string, anchor = false): number | undefined {
  const k = `"${key}"`;
  for (let at = text.indexOf(k); at >= 0; at = text.indexOf(k, at + 1)) {
    if (/^\s*:/.test(text.slice(at + k.length, at + k.length + 20)) && (!anchor || /^\s*:\s*\{/.test(text.slice(at + k.length, at + k.length + 20)))) {
      return text.slice(0, at).split(/\r\n|\r|\n/).length;
    }
  }
  return undefined;
}

/**
 * The manifest's diagnostics for the branch fields (§3.4) and the id, as findings: a bad `base` and base-side
 * anchors without one are errors (they would show the sidestory, or its removed code, at the wrong place), as is
 * a base-side anchor in a manifest older than version 3 (§3.5) and a trivial mark without a `why`.
 */
export function manifestDiagnosticFindings(manifestFile: string, manifestText: string, diagnostics: readonly Diagnostic[]): Finding[] {
  const out: Finding[] = [];
  for (const d of diagnostics) {
    const m = d.message;
    let code: string | undefined;
    let severity: Severity = 'warning';
    if (d.anchor === undefined && m.startsWith('base:')) [code, severity] = ['base', 'error'];
    else if (d.anchor === undefined && m.startsWith('head:')) code = 'head';
    else if (d.anchor === undefined && m.startsWith('trivialFiles:')) code = 'trivial-files';
    else if (d.anchor === undefined && m.startsWith('id:')) code = 'id';
    else if (d.anchor === undefined && m.includes('side "base" need "version": 3')) [code, severity] = ['version', 'error'];
    else if (d.anchor !== undefined && m.startsWith('side "base" needs')) [code, severity] = ['side-without-base', 'error'];
    else if (d.anchor !== undefined && m.startsWith('trivial needs a "why"')) [code, severity] = ['trivial-why', 'error'];
    else if (d.anchor !== undefined && m.startsWith('why:')) [code, severity] = ['trivial-why', 'error'];
    else if (d.anchor !== undefined && m.startsWith('side:')) [code, severity] = ['side', 'error'];
    if (!code) continue;
    const key = code === 'version' ? 'version' : code === 'trivial-files' ? 'trivialFiles' : code;
    const line = d.anchor !== undefined ? manifestLineOf(manifestText, d.anchor, true) : manifestLineOf(manifestText, key);
    out.push({ severity, file: manifestFile, code, message: d.anchor !== undefined ? `Anchor "${d.anchor}": ${m}.` : `${m}.`, ...(line ? { line } : {}) });
  }
  return out;
}
