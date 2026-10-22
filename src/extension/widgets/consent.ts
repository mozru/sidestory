// Consent to run widgets (docs/WIDGETS-PLAN.md §5.1), the part that needs no VS Code API: what is stored
// per workspace, and when the reader must be asked again. Consent covers code: each file of a widget's
// import closure is acknowledged by its hash (consented to, or observed as the user's own edit). Changed
// bytes ask again only when the change arrived through git (HEAD moved and the bytes are HEAD's), or when
// git can't be asked about a repository that is there.
import { createHash } from 'node:crypto';

export interface ConsentRecord {
  /** The reader agreed to run widgets in this workspace (at least once). */
  granted: boolean;
  /** Workspace-relative path → acknowledged bytes (sha256 hex) and the HEAD commit they were seen at. */
  files: Record<string, { hash: string; head: string | null }>;
}

export const EMPTY_CONSENT: ConsentRecord = { granted: false, files: {} };
/** Acknowledged files kept per workspace; the oldest are dropped past this. */
export const MAX_CONSENT_FILES = 5000;

/** Git's view of one widget file. */
export type FileGit =
  /** No `.git` at or above the explainer: consent is per workspace. */
  | { kind: 'none' }
  /** A `.git` exists, but the git extension has no repository for it: changed code always asks. */
  | { kind: 'unknown' }
  /** `head`: the current commit; `headHash`: sha256 of the file at HEAD (null: not in HEAD). */
  | { kind: 'repo'; head: string | null; headHash: string | null };

export interface WidgetFile {
  /** Workspace-relative path. */
  path: string;
  /** sha256 hex of the bytes now. */
  hash: string;
  git: FileGit;
}

export interface ConsentDecision {
  /** Ask the reader (in the modal) before running. */
  ask: boolean;
  /** Files whose new bytes need consent (named in the modal). */
  changed: string[];
  /** Files whose new bytes count as the user's own edits: record them as acknowledged. */
  observed: WidgetFile[];
}

/** Hash of file bytes as consent compares them: line endings normalized, so a CRLF checkout is the same code. */
export function contentHash(bytes: Uint8Array | string): string {
  const text = typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('latin1');
  return createHash('sha256').update(text.replace(/\r\n/g, '\n'), typeof bytes === 'string' ? 'utf8' : 'latin1').digest('hex');
}

/** Decides for one explainer's widget files (the union of its widgets' import closures). */
export function decideConsent(record: ConsentRecord, files: readonly WidgetFile[]): ConsentDecision {
  if (!record.granted) return { ask: true, changed: [], observed: [] };
  const changed: string[] = [];
  const observed: WidgetFile[] = [];
  for (const f of files) {
    const known = record.files[f.path];
    if (known?.hash === f.hash) continue;
    const g = f.git;
    if (g.kind === 'none') observed.push(f);
    else if (g.kind === 'unknown') changed.push(f.path);
    else {
      // Arrived through git: these are HEAD's bytes, and HEAD moved since the file was last acknowledged
      // (checkout, pull, merge, rebase; or never seen, as after a clone).
      const headMoved = !known || known.head !== g.head;
      if (g.headHash !== null && g.headHash === f.hash && headMoved) changed.push(f.path);
      else observed.push(f);
    }
  }
  return { ask: changed.length > 0, changed, observed };
}

/** The record after the reader agreed (to these files) or edits were observed. */
export function acknowledge(record: ConsentRecord, files: readonly WidgetFile[], grant: boolean): ConsentRecord {
  const next: ConsentRecord['files'] = { ...record.files };
  for (const f of files) {
    delete next[f.path]; // re-inserted last: the most recent are kept longest
    next[f.path] = { hash: f.hash, head: f.git.kind === 'repo' ? f.git.head : null };
  }
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_CONSENT_FILES))) delete next[k];
  return { granted: record.granted || grant, files: next };
}
