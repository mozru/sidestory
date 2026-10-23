// Consent to run widgets (docs/WIDGETS-PLAN.md §5.1), the part that needs no VS Code API: what is stored
// per workspace, and when the reader must be asked again. Consent covers code: each file of a widget's
// import closure is acknowledged by its content (consented to, or observed as the user's own edit) together
// with the blob git had for it at HEAD then. Changed bytes ask again when git's own version of the file
// changed since (checkout, pull, merge, rebase), or when git can't be asked about a repository that is there.
// Git's blob ids are compared, never working-tree bytes with git's: line-ending conversion, checkout filters
// (`ident`, LFS, smudge), symlinks and encodings make those differ for code that did arrive through git.
import { createHash } from 'node:crypto';

export interface ConsentRecord {
  /** The reader agreed to run widgets in this workspace (at least once). */
  granted: boolean;
  /**
   * Workspace-relative path → acknowledged content (contentHash) and git's blob for the file at HEAD when it
   * was acknowledged (null: not in HEAD, or no repository); `seen`: earlier acknowledged versions, as
   * [contentHash, headBlob] pairs, newest last (switching back to a branch already agreed to doesn't ask).
   */
  files: Record<string, { hash: string; headBlob?: string | null; seen?: [string, string | null][] }>;
}

export const EMPTY_CONSENT: ConsentRecord = { granted: false, files: {} };
/** Acknowledged files kept per workspace; the oldest are dropped past this. */
export const MAX_CONSENT_FILES = 5000;
/** Earlier versions remembered per file. */
export const MAX_SEEN_VERSIONS = 16;

/** Git's view of one widget file. */
export type FileGit =
  /** No `.git` at or above the explainer: consent is per workspace. */
  | { kind: 'none' }
  /**
   * A `.git` exists, but the git extension has no repository for it, the repository didn't settle, or the
   * file is a symlink: changed code always asks.
   */
  | { kind: 'unknown' }
  /** `headBlob`: git's blob id at HEAD (null: not in HEAD); `headHash`: contentHash of HEAD's text, if read. */
  | { kind: 'repo'; headBlob: string | null; headHash: string | null };

export interface WidgetFile {
  /** Workspace-relative path. */
  path: string;
  /** contentHash of the bytes now. */
  hash: string;
  git: FileGit;
}

export interface ConsentDecision {
  /** Ask the reader (in the modal) before running. */
  ask: boolean;
  /** None of the explainer's widget files was ever acknowledged: its widgets haven't run in this workspace. */
  first: boolean;
  /** Files acknowledged before whose new bytes need consent (named in the modal). */
  changed: string[];
  /** Files never acknowledged that arrived through git (named in the modal). */
  added: string[];
  /** Files whose new bytes count as the user's own edits (or whose record is refreshed): record them. */
  observed: WidgetFile[];
}

/** Hash of file bytes as consent compares them: line endings normalized, so a CRLF checkout is the same code. */
export function contentHash(bytes: Uint8Array | string): string {
  const text = typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('latin1');
  return createHash('sha256').update(text.replace(/\r\n/g, '\n'), typeof bytes === 'string' ? 'utf8' : 'latin1').digest('hex');
}

/**
 * Decides for one explainer's widget files (the union of its widgets' import closures). An explainer none of
 * whose files was ever acknowledged asks the first time, with or without git: a copied-in or unzipped
 * explainer doesn't run on the strength of another one's consent. `seen` versions (earlier acknowledged
 * bytes under the same git blob) count as acknowledged.
 */
export function decideConsent(record: ConsentRecord, files: readonly WidgetFile[]): ConsentDecision {
  if (!record.granted) return { ask: true, first: true, changed: [], added: [], observed: [] };
  const changed: string[] = [];
  const added: string[] = [];
  const observed: WidgetFile[] = [];
  const first = files.length > 0 && !files.some((f) => Object.hasOwn(record.files, f.path));
  for (const f of files) {
    const known = Object.hasOwn(record.files, f.path) ? record.files[f.path] : undefined;
    const g = f.git;
    // A version agreed to (or observed) before, under the same git state: a branch switched back to.
    if (known && known.hash !== f.hash && known.seen?.some(([h, b]) => h === f.hash && (g.kind !== 'repo' || b === g.headBlob))) {
      observed.push(f);
      continue;
    }
    // What git had when the file was acknowledged: null (not in HEAD) is a value; undefined only in records
    // from before blobs were kept.
    const recorded = known && 'headBlob' in known ? known.headBlob : undefined;
    if (known?.hash === f.hash) {
      // The acknowledged code. Git's version moved meanwhile: if it is this very code (the user committed
      // it), remember the new blob so later edits are compared with it; otherwise git changed under bytes
      // that may not be settled yet (a pull mid-way): ask.
      if (g.kind === 'repo' && recorded !== g.headBlob) {
        if (g.headHash === f.hash) observed.push(f);
        else changed.push(f.path);
      }
      continue;
    }
    if (g.kind === 'none') observed.push(f);
    else if (g.kind === 'unknown') (known ? changed : added).push(f.path);
    else if (!known) {
      // Never seen: git's (a pull brought a new widget, or a clone) unless git doesn't have it.
      if (g.headBlob !== null) added.push(f.path);
      else observed.push(f);
    } else {
      // Git's version of the file changed since it was acknowledged, and not to the acknowledged code itself
      // (the user committing their own edit): the new bytes may have come with it.
      const gitMoved = g.headBlob !== recorded && (g.headHash === null || g.headHash !== known.hash);
      if (gitMoved) changed.push(f.path);
      else observed.push(f);
    }
  }
  // The first time, nothing is the user's own yet: recording these files would let the next look run them
  // without the reader having agreed.
  return { ask: first || changed.length + added.length > 0, first, changed, added, observed: first ? [] : observed };
}

/** The record after the reader agreed (to these files) or edits were observed. */
export function acknowledge(record: ConsentRecord, files: readonly WidgetFile[], grant: boolean): ConsentRecord {
  const next: ConsentRecord['files'] = { ...record.files };
  for (const f of files) {
    const old = Object.hasOwn(next, f.path) ? next[f.path] : undefined;
    const headBlob = f.git.kind === 'repo' ? f.git.headBlob : null;
    // The version this one replaces joins the earlier ones (without duplicates, the newest last).
    let seen = (old?.seen ?? []).filter(([h, b]) => !(h === f.hash && b === headBlob));
    if (old && !(old.hash === f.hash && (old.headBlob ?? null) === headBlob)) seen = [...seen.filter(([h, b]) => !(h === old.hash && b === (old.headBlob ?? null))), [old.hash, old.headBlob ?? null]];
    delete next[f.path]; // re-inserted last: the most recent are kept longest
    next[f.path] = { hash: f.hash, headBlob, ...(seen.length ? { seen: seen.slice(-MAX_SEEN_VERSIONS) } : {}) };
  }
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_CONSENT_FILES))) delete next[k];
  return { granted: record.granted || grant, files: next };
}

/** How many lines these ranges cover together (overlapping and nested anchors counted once), for the consent bar. */
export function linesCovered(ranges: readonly { start: number; end: number }[]): number {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let total = 0;
  let end = -Infinity;
  for (const r of sorted) {
    const start = Math.max(r.start, end + 1);
    if (r.end >= start) total += r.end - start + 1;
    end = Math.max(end, r.end);
  }
  return total;
}
