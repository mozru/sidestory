// `check.cjs --coverage` (docs/CHANGES-PLAN.md §13.1): the branch's merge diff, as the Changes view counts it, and
// which of its changes the sidestories that belong to it explain. Git runs only through src/cli/git.ts (§13.2);
// changes, coverage and membership are the shared core (src/core/hunks.ts, coverage.ts, membership.ts), so the
// checker and the extension agree. The checker in CI is authoritative (§4.1).
import { randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative as pathRelative, sep } from 'node:path';
import { coverage as computeCoverage, normLine, usedAnchorIds, type ChangeCoverage, type FileInput, type Target, type Totals } from '../core/coverage.ts';
import { globMatcher } from '../core/glob.ts';
import { outlineHtml } from '../core/html-scan.ts';
import { decodePair, decodeUtf8, decodeLatin1, diffTexts, textLines, type ChangeBlock } from '../core/hunks.ts';
import { explainerNameSchema, FULL_SHA, isValidBase, parseManifest, sideOf, type Diagnostic, type LineRange, type Manifest } from '../core/manifest.ts';
import { belongs, isArchivePath } from '../core/membership.ts';
import { resolveAnchor } from '../core/resolve.ts';
import { contentSimilarity } from '../core/similarity.ts';
import { normalizeLines, PreparedText } from '../core/text.ts';
import { resolveBase } from '../extension/changes/base.ts';
import type { Finding, Severity } from './check-widgets.ts';
import { findRepository, Git, GitError, isSafeRepoPath, WorkingTreeRefused, type RawEntry } from './git.ts';

export type FileKind = 'text' | 'binary' | 'lfs' | 'submodule' | 'link' | 'mode' | 'line-endings' | 'sidestory' | 'archive' | 'unsupported' | 'type-change' | 'missing' | 'too-large';

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
}

/** A ULID (docs/COMMENTS-PLAN.md §3.1): 48 bits of time, 80 random bits, Crockford base32. */
export function newUlid(now = Date.now()): string {
  const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = A[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  const r = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += A[r[i]! % 32]!;
  return time + rand;
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
  ownMergeBase?: string;
}

/** `<prefix>.sidestory/<name>/<rest>` for a real sidestory folder name, else undefined. */
function sidestoryOf(path: string): { prefix: string; name: string; rest: string } | undefined {
  const m = /^(?:(.*)\/)?\.sidestory\/([^/]+)\/(.+)$/.exec(path);
  if (!m || m[2] === 'archive' || !explainerNameSchema.safeParse(m[2]).success) return undefined;
  return { prefix: m[1] ?? '', name: m[2]!, rest: m[3]! };
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
    for (const p of await git.untracked()) {
      if (!tracked.has(p)) entries.push({ status: 'A', oldMode: '000000', newMode: '100644', oldId: '0'.repeat(mergeBase.length), newId: '0'.repeat(mergeBase.length), path: p, kind: 'text', untracked: true });
    }
  }
  const sorted = entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // Bytes: blobs by id, working tree files by path.
  const blobIds = new Set<string>();
  for (const e of sorted) {
    if (!ZERO.test(e.oldId)) blobIds.add(e.oldId);
    if (!ZERO.test(e.newId)) blobIds.add(e.newId);
  }
  const unsafe = (e: Entry) => !isSafeRepoPath(e.path) || (e.oldPath !== undefined && !isSafeRepoPath(e.oldPath));
  let classified = sorted.map((e) => {
    if (unsafe(e)) e.kind = 'unsupported';
    else if (isArchivePath(e.path) || (e.oldPath !== undefined && isArchivePath(e.oldPath))) e.kind = 'archive';
    else if (sidestoryOf(e.path)) e.kind = 'sidestory';
    else if (e.status === 'T' || (e.oldMode === '120000') !== (e.newMode === '120000') && e.oldMode !== '000000' && e.newMode !== '000000') e.kind = 'type-change';
    else if (e.oldMode === '160000' || e.newMode === '160000') e.kind = 'submodule';
    else if (e.oldMode === '120000' || e.newMode === '120000') e.kind = 'link';
    else if (e.status === 'M' && !ZERO.test(e.newId) && e.oldId === e.newId) e.kind = 'mode';
    return e;
  });
  const wantedIds = [...blobIds].filter((id) => classified.some((e) => (e.kind === 'text' || e.kind === 'sidestory') && (e.oldId === id || e.newId === id)));
  const { bytes: blobs, skipped } = await git.blobs(wantedIds);
  const missing = new Set<string>();
  for (const [id, why] of skipped) {
    if (why === 'missing') missing.add(id);
    if (why === 'budget') incomplete = true;
  }

  const readNew = async (e: Entry): Promise<Uint8Array | 'too-large' | 'missing' | undefined> => {
    if (e.newMode === '000000') return undefined;
    if (!ZERO.test(e.newId)) return blobs.get(e.newId) ?? (skipped.get(e.newId) === 'too-large' ? 'too-large' : 'missing');
    const r = await git.readWorkingFile(e.path);
    if ('bytes' in r) return r.bytes;
    if (r.error === 'too-large') return 'too-large';
    if (r.error === 'budget') incomplete = true;
    return 'missing';
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
    if (o === 'missing' || n === 'missing') {
      e.kind = 'missing';
      continue;
    }
    if (o === 'too-large' || n === 'too-large') {
      e.kind = 'too-large';
      continue;
    }
    if (isBinary(o) || isBinary(n)) e.kind = 'binary';
    else if (isLfs(o) || isLfs(n)) e.kind = 'lfs';
    else if (o && n && sameBytes(o, n)) e.kind = e.oldMode !== e.newMode ? 'mode' : 'line-endings';
    oldBytes.set(e, o);
    newBytes.set(e, n);
  }

  // Unstaged renames (§4.6): a deleted tracked file and an untracked new one, paired by content.
  if (mode === 'working') {
    const paired = pairUnstagedRenames(classified, oldBytes, newBytes);
    if (paired.size) classified = classified.filter((e) => !paired.has(e));
  }

  for (const e of classified) {
    if (e.kind !== 'text') continue;
    const d = decodePair(oldBytes.get(e), newBytes.get(e));
    const diff = diffTexts(e.path, d.old, d.new);
    if (diff.lineEndingsOnly || !diff.changes.length) {
      e.kind = 'line-endings';
      continue;
    }
    e.diff = { changes: diff.changes, newLines: diff.newLines };
    e.newText = d.new;
    e.oldText = d.old;
  }
  for (const e of classified) {
    if (e.kind === 'unsupported') add('warning', root, 'unsupported-path', `A changed file has a path Sidestory won't read (control characters, "..", ".git" or a leading ":"): ${JSON.stringify((e.oldPath ? `${e.oldPath} → ${e.path}` : e.path).slice(0, 200))}. It isn't counted.`);
    else if (e.kind === 'type-change') add('warning', abs(e.path), 'type-change', `${e.path} changed between a file and a link; it isn't counted (explain it in prose if it matters).`);
    else if (e.kind === 'missing') {
      incomplete = true;
      add('warning', abs(e.path), 'blob-missing', `${e.path}: a version of this file isn't in this clone (a partial or shallow clone); the checker never fetches. Fetch it (git fetch) and run again.`);
    }
  }

  // The sidestories that belong (§6.1): their manifests are added in the change (absent at the merge-base, present
  // at the head), plus the given one (a review sidestory lives untracked beside a fixed head).
  const candidates = new Map<string, { prefix: string; fromDisk: boolean }>();
  for (const e of classified) {
    const s = sidestoryOf(e.path);
    if (s && s.rest === 'manifest.json' && (e.status === 'A' || e.status === 'R' || e.status === 'C' || e.untracked) && e.newMode !== '000000') {
      candidates.set(e.path.slice(0, -'/manifest.json'.length), { prefix: s.prefix, fromDisk: mode === 'working' });
    }
  }
  if (given && !candidates.has(given.folder)) candidates.set(given.folder, { prefix: given.prefix, fromDisk: mode === 'working' });
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
    sidestories.push({ folder, prefix: c.prefix, manifestText: read.manifestText, manifest: m, diagnostics: parsed.diagnostics, html: read.html, ownMergeBase: own });
  }
  for (const n of notBelonging) add('warning', given?.manifestFile ?? root, 'not-belonging', `${n} doesn't count toward this branch's coverage.`);
  header += sidestories.length ? `; counting ${sidestories.map((s) => s.folder).join(', ')}` : '; no sidestory of this branch yet';

  // Counted files, trivialFiles, targets.
  const counted = classified.filter((e) => e.kind === 'text' || e.kind === 'too-large');
  const matchers = sidestories.map((s) => ({ s, patterns: s.manifest.trivialFiles ?? [], match: globMatcher(s.manifest.trivialFiles ?? []) }));
  const underPrefix = (prefix: string, path: string) => (prefix ? (path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : undefined) : path);
  for (const { s, patterns } of matchers) {
    for (const p of patterns) {
      const one = globMatcher([p]);
      const n = counted.filter((e) => {
        const r = underPrefix(s.prefix, e.path);
        return r !== undefined && one(r);
      }).length;
      if (p === '**' || p === '*' || (counted.length > 1 && n > counted.length / 2)) {
        add('warning', abs(`${s.folder}/manifest.json`), 'trivial-broad', `trivialFiles pattern "${p}" marks ${p === '**' || p === '*' ? 'every file' : `${n} of the ${counted.length} changed files`} as needing no explanation; name the files (package-lock.json, **/__snapshots__/**) so reviewers can trust the mark.`, manifestLineOf(s.manifestText, 'trivialFiles'));
      }
    }
  }
  const isTrivialFile = (path: string) =>
    matchers.some(({ s, match }) => {
      const r = underPrefix(s.prefix, path);
      return r !== undefined && match(r);
    });

  const byNew = new Map(counted.map((e) => [e.path, e]));
  const byOld = new Map(counted.map((e) => [e.oldPath ?? e.path, e]));
  const targets: Target[] = [];
  const stepTitles = new Map<string, Map<string, string>>();
  for (const s of sidestories) {
    const used = usedAnchorIds(s.html);
    if (used.incomplete) {
      incomplete = true;
      add('warning', abs(`${s.folder}/sidestory.html`), 'coverage-incomplete', "The page is too large to scan for the anchors it uses, so coverage can't be complete. Split the page.");
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
      changes: e.diff?.changes ?? [tooLargeChange(e.path)],
      newLine: (l) => newLines[l - 1] ?? '',
      oldLine: (l) => oldLines[l - 1] ?? '',
      trivialFile: isTrivialFile(e.path),
      newLines: newLines.length,
    };
  });
  const result = computeCoverage(inputs, targets);

  // Findings per change, and per target.
  const title = (sidestory: string, anchor: string) => {
    const t = stepTitles.get(sidestory)?.get(anchor);
    return t ? `step "${t}"` : `anchor "${anchor}"`;
  };
  const many = sidestories.length > 1;
  const of = (sidestory: string) => (many ? ` of ${sidestory}` : '');
  result.files.forEach((f, fi) => {
    const e = counted[fi]!;
    const file = abs(f.path);
    f.changes.forEach((c, ci) => {
      const block = inputs[fi]!.changes[ci]!;
      const at = block.new ? block.new.start : e.newMode === '000000' ? (block.old?.start ?? 1) : Math.max(1, Math.min(block.newAt, e.diff?.newLines ?? 1));
      const where = block.new ? `lines ${span(block.new)}`.replace(/^lines (\d+)$/, 'line $1') : e.newMode === '000000' ? 'deleted file' : `deleted at line ${at}`;
      if (e.kind === 'too-large') {
        if (c.state !== 'trivial') add('warning', file, 'unexplained', `${f.path} is too large to compare (over 10 MB); it counts as one unexplained change. Mark it in trivialFiles if it needs no explanation.`, 1);
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
    branch = {
      held,
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

  const notCounted = classified.filter((e) => e.kind !== 'text' && e.kind !== 'too-large' && e.kind !== 'sidestory' && e.kind !== 'archive' && e.kind !== 'line-endings');
  const totals = { ...result.totals, notCounted: notCounted.length };
  const kinds = [...new Set(notCounted.map((e) => kindLabel(e.kind)))];
  const summary = `${totals.explained} explained · ${totals.trivial} trivial · ${totals.left} left${totals.needsLook ? ` (${totals.needsLook} changed since pinned)` : ''}, in ${totals.files} file${totals.files === 1 ? '' : 's'}.${notCounted.length ? ` ${notCounted.length} file${notCounted.length === 1 ? '' : 's'} not counted (${kinds.join(', ')}).` : ''}${incomplete ? ' Incomplete: see the warnings above.' : ''}`;

  const json: CoverageJson = {
    base: { spec: resolved.spec, label: resolved.label, sha: resolved.sha },
    mergeBase,
    head: mode === 'working' ? 'working tree' : headSha,
    sidestories: sidestories.map((s) => s.folder),
    files: classified
      .filter((e) => e.kind !== 'sidestory' && e.kind !== 'archive')
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
  };
}

function kindLabel(k: FileKind): string {
  return { binary: 'binary', lfs: 'LFS', submodule: 'submodule', link: 'link', mode: 'mode only', unsupported: 'unsupported path', 'type-change': 'type change', missing: 'missing object', text: 'text', 'line-endings': 'line endings only', sidestory: 'sidestory', archive: 'archive', 'too-large': 'too large' }[k];
}

function tooLargeChange(path: string): ChangeBlock {
  return { key: `large-${path.length}-${[...path].reduce((h, ch) => Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0, 2166136261).toString(16)}`, old: null, new: null, removedRuns: [], addedRuns: [], added: 0, removed: 0, oldAt: 1, newAt: 1, oldLen: 0, newLen: 0 };
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

/** A sidestory's manifest and page: from the working tree, or from the head commit (falling back to disk when `diskToo`). */
async function readSidestory(git: Git, folder: string, atCommit: string | undefined, diskToo: boolean): Promise<{ manifestText: string; html: string } | undefined> {
  const files = [`${folder}/manifest.json`, `${folder}/sidestory.html`];
  const decode = (b: Uint8Array) => decodeUtf8(b) ?? decodeLatin1(b);
  if (atCommit) {
    const t = await git.lsTree(atCommit, files);
    const ids = files.map((f) => t.get(f));
    if (ids.every((i) => i && REGULAR.has(i.mode))) {
      const b = await git.blobs(ids.map((i) => i!.id));
      const [m, h] = ids.map((i) => b.bytes.get(i!.id));
      if (m && h) return { manifestText: decode(m), html: decode(h) };
    }
    if (!diskToo) return undefined;
  }
  const [m, h] = await Promise.all(files.map((f) => git.readWorkingFile(f)));
  if (!('bytes' in m!) || !('bytes' in h!)) return undefined;
  return { manifestText: decode(m.bytes), html: decode(h.bytes) };
}

/**
 * Pairs deleted tracked files with untracked new ones by content (§4.6): at most 50 × 50, each at most 1 MB,
 * similarity ≥ 0.5, best pairs first. The untracked entry becomes the rename; returns the deletions it replaces.
 */
function pairUnstagedRenames(entries: Entry[], oldBytes: Map<Entry, Uint8Array | undefined>, newBytes: Map<Entry, Uint8Array | undefined>): Set<Entry> {
  const used = new Set<Entry>();
  const dropped = new Set<Entry>();
  const deleted = entries.filter((e) => e.kind === 'text' && e.status === 'D' && !e.untracked);
  const added = entries.filter((e) => e.kind === 'text' && e.untracked);
  if (!deleted.length || !added.length || deleted.length > 50 || added.length > 50) return dropped;
  const MB = 1024 * 1024;
  const lines = (b: Uint8Array | undefined) => (b && b.length <= MB ? normalizeLines(textLines(decodeUtf8(b) ?? decodeLatin1(b))) : undefined);
  const pairs: { d: Entry; a: Entry; score: number }[] = [];
  for (const d of deleted) {
    const dl = lines(oldBytes.get(d));
    if (!dl?.length) continue;
    for (const a of added) {
      const al = lines(newBytes.get(a));
      if (!al?.length) continue;
      const score = contentSimilarity(dl, al);
      if (score >= 0.5) pairs.push({ d, a, score });
    }
  }
  pairs.sort((x, y) => y.score - x.score || (x.a.path < y.a.path ? -1 : x.a.path > y.a.path ? 1 : x.d.path < y.d.path ? -1 : 1));
  for (const p of pairs) {
    if (used.has(p.d) || used.has(p.a)) continue;
    used.add(p.d).add(p.a);
    dropped.add(p.d);
    p.a.oldPath = p.d.path;
    p.a.oldId = p.d.oldId;
    p.a.oldMode = p.d.oldMode;
    p.a.status = 'R';
    p.a.detected = true;
    oldBytes.set(p.a, oldBytes.get(p.d));
  }
  return dropped;
}

function isBinary(b: Uint8Array | undefined): boolean {
  if (!b) return false;
  const n = Math.min(b.length, 8000);
  for (let i = 0; i < n; i++) if (b[i] === 0) return true;
  return false;
}

function isLfs(b: Uint8Array | undefined): boolean {
  if (!b || b.length > 1024) return false;
  const head = 'version https://git-lfs.github.com/spec/v1';
  for (let i = 0; i < head.length; i++) if (b[i] !== head.charCodeAt(i)) return false;
  return true;
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
