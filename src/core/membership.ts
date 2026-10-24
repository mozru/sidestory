// Which sidestories count toward a comparison's coverage (docs/CHANGES-PLAN.md §6.1). Pure: the extension and the
// checker look the facts up their own way (the git API, hardened git) and apply this same test.
import { decodeUtf8 } from './hunks.ts';
import { explainerNameSchema, FULL_SHA, isValidBase, MAX_MANIFEST_BYTES, parseManifest } from './manifest.ts';

/**
 * Does a sidestory belong to a comparison (merge-base M → head)?
 *
 * 1. Its manifest is absent at M and present at the head: it was added in the change. A sidestory that already
 *    landed exists at every later merge-base, so it never belongs to a later branch, whatever that branch does to it.
 * 2. Its own `base` resolves (against the comparison's head) to the same merge-base M.
 *
 * A `head`-pinned sidestory never belongs to a live comparison, with one exception (the review rule): when the
 * comparison's head is a fixed commit (review mode, `--head <sha>`), a sidestory whose base gives M and whose
 * `head` is that commit belongs too (it lives untracked in the reader's working tree, so presence isn't asked).
 */
export function belongs(i: {
  presentAtMergeBase: boolean;
  presentAtHead: boolean;
  ownMergeBase: string | undefined;
  comparisonMergeBase: string;
  manifestHead?: string;
  /** The fixed head commit (review mode, `--head`); undefined for the working tree or a branch's moving tip. */
  comparisonHead?: string;
}): boolean {
  if (i.ownMergeBase === undefined || i.ownMergeBase !== i.comparisonMergeBase) return false;
  // A review sidestory is read from the reader's working tree (untracked), never from the commit it describes.
  if (i.manifestHead !== undefined) return i.comparisonHead !== undefined && i.manifestHead === i.comparisonHead;
  return !i.presentAtMergeBase && i.presentAtHead;
}

/** Under a `.sidestory/archive/` folder (at any package root): archives are never members (§12.3). */
export function isArchivePath(p: string): boolean {
  return p.startsWith('.sidestory/archive/') || p.includes('/.sidestory/archive/') || p === '.sidestory/archive' || p.endsWith('/.sidestory/archive');
}

const SIDESTORY_PATH = /^(?:(.*)\/)?\.sidestory\/([^/]+)\/.+$/;

/**
 * The repo-relative folder of the sidestory a path lies in (`.sidestory/x`, `pkg/.sidestory/x`), or undefined when
 * it isn't inside a real sidestory folder: `<prefix>/.sidestory/<name>/…` where `<name>` is a valid sidestory name
 * and not `archive`. A file directly in `.sidestory/` (a README) or under a folder with an invalid name is ordinary
 * code. The checker and the extension both use this, so they agree on which files a branch's totals leave out.
 */
export function sidestoryFolderOf(path: string): string | undefined {
  const m = SIDESTORY_PATH.exec(path);
  if (!m || m[2] === 'archive' || !explainerNameSchema.safeParse(m[2]).success) return undefined;
  return m[1] ? `${m[1]}/.sidestory/${m[2]}` : `.sidestory/${m[2]}`;
}

/**
 * A file a sidestory owns, left out of a branch's coverage because it is the explanation (§5.1): `manifest.json` or
 * `sidestory.html` directly in a real sidestory folder (`sidestoryFolderOf`) that is a complete sidestory
 * (`isComplete(folder)`: both files present, at the head or at the merge-base; assumed when not given). Nothing else
 * is owned: widget code, assets, helper scripts and any other file under `.sidestory/<name>/` count like code
 * elsewhere (a branch could otherwise keep code there and require it from src/), and archives count as one change.
 */
export function ownedBySidestory(path: string, isComplete?: (folder: string) => boolean): boolean {
  if (isArchivePath(path)) return false;
  const folder = sidestoryFolderOf(path);
  if (!folder) return false;
  const rest = path.slice(folder.length + 1);
  if (!(SIDESTORY_FILES as readonly string[]).includes(rest)) return false;
  return isComplete ? isComplete(folder) : true;
}

/**
 * Does a changed path count toward a branch's coverage (§6.3)? Every path does except the files a sidestory owns
 * (`ownedBySidestory`). Archive paths count (as one change: `isArchivePath`, §12.3). For a rename or copy, use
 * `countedChange`, which looks at both paths.
 */
export function countedPath(path: string, isComplete?: (folder: string) => boolean): boolean {
  return !ownedBySidestory(path, isComplete);
}

/**
 * How a changed entry counts (§5.1): `counted` false when it touches only files sidestories own. A rename or copy
 * counts when EITHER path counts. Renamed from code into a sidestory's own file, the old side is a deletion
 * (`as: 'deletion'` of `oldPath`); a copy that way leaves the code where it was, so it isn't counted. Renamed or
 * copied from a sidestory's own file into code, the new side is an addition (`as: 'addition'` of `path`).
 */
export function countedChange(
  e: { readonly status: string; readonly path: string; readonly oldPath?: string },
  isComplete?: (folder: string) => boolean,
): { counted: boolean; as?: 'deletion' | 'addition' } {
  const newCounts = countedPath(e.path, isComplete);
  if (e.oldPath === undefined || e.oldPath === e.path) return { counted: newCounts };
  const oldCounts = countedPath(e.oldPath, isComplete);
  if (newCounts && oldCounts) return { counted: true };
  if (!newCounts && !oldCounts) return { counted: false };
  if (oldCounts) return e.status === 'C' ? { counted: false } : { counted: true, as: 'deletion' };
  return { counted: true, as: 'addition' };
}

/** An archived sidestory file: `<prefix>/.sidestory/archive/<YYYY-MM-DD>-<name>/<file>` (prefix, name, file). */
export const ARCHIVED_PATH = /^(?:(.*)\/)?\.sidestory\/archive\/\d{4}-\d{2}-\d{2}-([^/]+)\/(.+)$/;

/**
 * Archiving in a branch (§12.4): an added or renamed file under `<prefix>/.sidestory/archive/<YYYY-MM-DD>-<name>/`
 * whose live path `<prefix>/.sidestory/<name>/<file>` is a real sidestory folder's, with the entry it moved from (the
 * rename itself, or the deletion of the live path). Candidates only: the caller confirms the same bytes (any file
 * but `manifest.json`, which the archive may rewrite) and that the folder was a complete sidestory at the
 * merge-base. A confirmed move and its deletion are the explanation moving, not code: neither counts. Shared by
 * the checker and the extension.
 */
export function archiveMoveCandidates<E extends { readonly status: string; readonly path: string; readonly oldPath?: string }>(
  entries: readonly E[],
  isSafe: (path: string) => boolean,
): { entry: E; from: E; folder: string; file: string }[] {
  const deletedAt = new Map(entries.filter((e) => e.status === 'D').map((e) => [e.path, e]));
  const out: { entry: E; from: E; folder: string; file: string }[] = [];
  for (const e of entries) {
    const m = (e.status === 'R' || e.status === 'A') && isSafe(e.path) ? ARCHIVED_PATH.exec(e.path) : null;
    if (!m) continue;
    const live = `${m[1] ? `${m[1]}/` : ''}.sidestory/${m[2]}/${m[3]}`;
    const folder = sidestoryFolderOf(live);
    if (!folder) continue;
    const from = e.status === 'R' ? (e.oldPath === live ? e : undefined) : deletedAt.get(live);
    if (from) out.push({ entry: e, from, folder, file: m[3]! });
  }
  return out;
}

/** The fields the archive job writes into an archived manifest (§12.3): everything else stays as it was. */
export const ARCHIVE_FIELDS = ['base', 'head', 'landed'] as const;

/**
 * Whether an archived `manifest.json` is the merge-base's manifest as the archive job rewrites it (§12.3): at most
 * MAX_MANIFEST_BYTES, a valid manifest, and equal to the old one but for `base`, `head` and `landed`. Anything else
 * (a payload field, other anchors, not JSON) is not an archive move, and counts as one change.
 */
export function isArchivedManifest(oldBytes: Uint8Array, newBytes: Uint8Array): boolean {
  if (newBytes.byteLength > MAX_MANIFEST_BYTES || oldBytes.byteLength > MAX_MANIFEST_BYTES) return false;
  const [oldText, newText] = [decodeUtf8(oldBytes), decodeUtf8(newBytes)];
  if (oldText === undefined || newText === undefined || !parseManifest(newText).ok) return false;
  const object = (text: string): Record<string, unknown> | undefined => {
    try {
      const v: unknown = JSON.parse(text.replace(/^\ufeff/, ''));
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };
  const [was, now] = [object(oldText), object(newText)];
  if (!was || !now) return false;
  const rest = (o: Record<string, unknown>) => {
    const r = { ...o };
    for (const k of ARCHIVE_FIELDS) delete r[k];
    return canonical(r);
  };
  return rest(was) === rest(now) && archiveFieldsValid(was, now);
}

/**
 * The archive job's small schema for `landed` (§12.3): the branch, the ISO date, the PR's https URL, and the landing
 * commits (`base`, `head`) as full ids when it records them there.
 */
const LANDED_KEYS = new Set(['branch', 'at', 'pr', 'base', 'head']);
const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const PR_URL = /^https:\/\/[A-Za-z0-9.-]{1,100}\/[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}\/pull\/[1-9]\d{0,8}$/;

/**
 * `base`, `head` and `landed` as the archive job writes them, and nothing riding in them: `base` is the old base or a
 * full commit id, `head` a full commit id, `landed` at most `{ branch, at, pr, base, head }` with a branch name, an
 * ISO date, a pull request URL and full commit ids, under 512 bytes.
 */
function archiveFieldsValid(was: Record<string, unknown>, now: Record<string, unknown>): boolean {
  const base = now.base;
  if (base === undefined ? was.base !== undefined : typeof base !== 'string' || !(FULL_SHA.test(base) || (isValidBase(base) && base === was.base))) return false;
  if (now.head !== undefined && (typeof now.head !== 'string' || !FULL_SHA.test(now.head))) return false;
  const landed = now.landed;
  if (landed === undefined) return true;
  if (!landed || typeof landed !== 'object' || Array.isArray(landed) || JSON.stringify(landed).length > 512) return false;
  const l = landed as Record<string, unknown>;
  if (!Object.keys(l).every((k) => LANDED_KEYS.has(k))) return false;
  if (l.branch !== undefined && (typeof l.branch !== 'string' || !isValidBase(l.branch) || FULL_SHA.test(l.branch))) return false;
  if (l.at !== undefined && (typeof l.at !== 'string' || !ISO_DATE.test(l.at))) return false;
  if (l.pr !== undefined && (typeof l.pr !== 'string' || !PR_URL.test(l.pr))) return false;
  for (const k of ['base', 'head'] as const) if (l[k] !== undefined && (typeof l[k] !== 'string' || !FULL_SHA.test(l[k]))) return false;
  return true;
}

/** JSON with object keys sorted, so layout and key order don't matter. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/** The files a sidestory folder must hold to be one (relative to the folder). */
export const SIDESTORY_FILES = ['manifest.json', 'sidestory.html'] as const;

/**
 * A sidestory belongs to a comparison only when it is complete: its folder holds both `manifest.json` and
 * `sidestory.html` (at the head, or on disk for the working tree). A folder with only a manifest (an agent still
 * writing the page) counts nothing yet, in the checker and in the extension alike. `files` are the folder's file
 * names, relative to the folder.
 */
export function isCompleteSidestory(files: Iterable<string>): boolean {
  const have = new Set(files);
  return SIDESTORY_FILES.every((f) => have.has(f));
}
