// "Pin Anchors": records each anchor's current code and context in the manifest (upgrading it to v2),
// so anchors can follow the code through later edits. Only the pinned anchors' fields are edited;
// the rest of the manifest stays as written (see manifest-edit.ts).
//
// Only anchors whose code is found with confidence are pinned outright. An anchor that changed a lot,
// is out of date, lost or ambiguous keeps its old quote: that quote is the only record of what the
// section was about, and silently re-pinning it would hide the problem. Pin then lists those with their
// reasons, and the author picks which to re-pin anyway (an intended change), either where the code is
// now or at the lines its `range` gives (so editing `range` by hand repairs a lost anchor).
// "Re-anchor Section to Selection" points one anchor at whatever code the author selects.
import * as vscode from 'vscode';
import type { Anchor, LineRange, Quote } from '../core/manifest.ts';
import { isSafeRelativePath, parseManifest } from '../core/manifest.ts';
import { pinQuote, trimBlankLines } from '../core/pin.ts';
import type { AnchorState, Resolution } from '../core/resolve.ts';
import { resolveAnchor } from '../core/resolve.ts';
import { PreparedText, splitLines } from '../core/text.ts';
import type { ExplainerRef } from './explainers.ts';
import { manifestUri, MAX_CODE_BYTES, MAX_MANIFEST_BYTES, readInside } from './explainers.ts';
import type { AnchorPatch } from './manifest-edit.ts';
import { minimalReplacement, patchManifest } from './manifest-edit.ts';
import { realPathInside, writeFileAtomic } from './paths.ts';
import type { PinWidgetHooks } from './widgets/host.ts';
import { isSecretPath } from './widgets/secret-files.ts';

/** Why an anchor wasn't pinned outright. */
type Refusal = 'changed' | 'stale' | 'lost' | 'ambiguous' | 'missing' | 'unpinnable' | 'widgets-declined' | 'widgets-secret';

const REASON: Record<Refusal, string> = {
  changed: 'code changed',
  stale: 'out of date',
  lost: 'code not found',
  ambiguous: 'ambiguous',
  missing: 'file missing',
  unpinnable: 'lines blank or too long',
  'widgets-declined': 'widgets would read it; not confirmed',
  'widgets-secret': 'widgets read it, and the file looks like it holds secrets',
};

/** A place an anchor could be re-pinned to, offered to the author. */
interface Candidate {
  anchor: Anchor;
  reason: Refusal;
  range: LineRange;
  /** `found`: where the code resolves now; `range`: the lines the manifest's `range` gives. */
  where: 'found' | 'range';
  /** The lines as offered, to check they're still there when the choice comes back. */
  text: string;
}

interface Snapshot {
  manifestText: string;
  anchors: Anchor[];
  /** Anchored files (relative path → text), read once; undefined if missing or refused. */
  files: Map<string, PreparedText | undefined>;
  /** Anchored files that had unsaved changes in an editor. */
  dirty: Set<string>;
}

/** The quote for these lines and the range it covers (blank edge lines are left out of both), or null. */
function pinAt(lines: readonly string[], range: LineRange, norm: Quote['norm'] | undefined): { range: LineRange; quote: Quote } | null {
  const trimmed = trimBlankLines(lines, range);
  const quote = trimmed && pinQuote(lines, trimmed, norm);
  return trimmed && quote ? { range: trimmed, quote } : null;
}

const rangeText = (r: LineRange) => (r.start === r.end ? `${r.start}` : `${r.start}–${r.end}`);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function snapshot(ref: ExplainerRef): Promise<Snapshot | undefined> {
  const uri = manifestUri(ref);
  const manifestText = await readInside(uri, ref.root, MAX_MANIFEST_BYTES);
  if (manifestText === undefined) {
    void vscode.window.showErrorMessage(`Can't read ${vscode.workspace.asRelativePath(uri)}.`);
    return undefined;
  }
  const parsed = parseManifest(manifestText);
  if (!parsed.ok) {
    void vscode.window.showErrorMessage(parsed.error);
    return undefined;
  }
  const anchors = [...parsed.manifest.anchors.values()];
  const files = new Map<string, PreparedText | undefined>();
  const dirty = new Set<string>();
  for (const a of anchors) {
    if (files.has(a.file)) continue;
    const fileUri = vscode.Uri.joinPath(ref.root, a.file);
    const source = await readInside(fileUri, ref.root, MAX_CODE_BYTES);
    files.set(a.file, source === undefined ? undefined : PreparedText.from(source));
    if (vscode.workspace.textDocuments.some((d) => d.isDirty && d.uri.toString() === fileUri.toString())) dirty.add(a.file);
  }
  return { manifestText, anchors, files, dirty };
}

/**
 * `liveHint` gives where an open explainer last saw an anchor's code (live-tracked through edits). With
 * `widgets`, anchors that widgets read are pinned only after the user confirms what widgets could then read
 * (docs/WIDGETS-PLAN.md §5.2), and never in secret-looking files.
 */
export async function pinAnchors(ref: ExplainerRef, liveHint: (id: string) => LineRange | undefined = () => undefined, widgets?: PinWidgetHooks): Promise<void> {
  const snap = await snapshot(ref);
  if (!snap) return;
  const patches = new Map<string, AnchorPatch>();
  const slightlyChanged: string[] = [];
  const refused: { anchor: Anchor; reason: Refusal }[] = [];
  const candidates: Candidate[] = [];
  for (const a of snap.anchors) {
    const doc = snap.files.get(a.file);
    if (!doc) {
      refused.push({ anchor: a, reason: 'missing' });
      continue;
    }
    const r = resolveAnchor(doc, a, { hint: liveHint(a.id) });
    const confident = !!r.range && !r.ambiguous && (r.state === 'exact' || r.state === 'moved' || (r.state === 'changed' && r.similarity >= 0.9));
    const pin = confident ? pinAt(doc.lines, r.range!, a.quote?.norm) : null;
    if (pin) {
      patches.set(a.id, pin);
      if (r.state === 'changed') slightlyChanged.push(a.id);
      continue;
    }
    const reason = refusal(r, confident);
    refused.push({ anchor: a, reason });
    candidates.push(...candidatesFor(a, reason, r, doc));
  }

  const confirmed: { file: string; quote: Quote; range: LineRange }[] = [];
  const read = widgets && patches.size ? await widgets.readAnchors() : undefined;
  if (widgets && read) {
    const byWidgets = snap.anchors.filter((a) => patches.has(a.id) && (read === 'all' || read.has(a.id)));
    for (const a of byWidgets.filter((x) => isSecretPath(x.file))) {
      patches.delete(a.id);
      refused.push({ anchor: a, reason: 'widgets-secret' });
    }
    // Quotes that stay as they were and were confirmed before, or are committed at HEAD (widgets read them
    // already), need no second confirmation.
    const ask: Anchor[] = [];
    for (const a of byWidgets) {
      const p = patches.get(a.id);
      if (!p || widgets.isConfirmed(a.file, p.quote, p.range)) continue;
      const same = !!a.quote && a.quote.exact === p.quote.exact && a.quote.norm === p.quote.norm;
      if (same && (await widgets.isCommitted(a))) continue;
      ask.push(a);
    }
    if (ask.length) {
      const ok = await widgets.confirm(ask.map((a) => ({ id: a.id, file: a.file, range: patches.get(a.id)!.range })));
      for (const a of ask) {
        const p = patches.get(a.id)!;
        if (ok) confirmed.push({ file: a.file, quote: p.quote, range: p.range });
        else {
          patches.delete(a.id);
          refused.push({ anchor: a, reason: 'widgets-declined' });
        }
      }
    }
  }

  if (patches.size) await writeManifest(ref, snap.manifestText, patchManifest(snap.manifestText, patches));
  if (confirmed.length) widgets?.record(confirmed);
  const parts: string[] = [];
  parts.push(patches.size ? `Pinned ${plural(patches.size, 'anchor')} in ${ref.name}.` : `Nothing pinned in ${ref.name}: no anchor's code was found with confidence.`);
  if (slightlyChanged.length) parts.push(`Accepted small changes in: ${slightlyChanged.join(', ')}.`);
  if (refused.length) parts.push(`Not pinned: ${refused.map((x) => `${x.anchor.id} (${REASON[x.reason]})`).join(', ')}.`);
  const dirty = [...snap.dirty].filter((f) => snap.anchors.some((a) => a.file === f && patches.has(a.id)));
  if (dirty.length) parts.push(`Pinned from unsaved changes in ${dirty.join(', ')}.`);
  const message = parts.join(' ');
  if (patches.size) void vscode.window.showInformationMessage(message);
  else void vscode.window.showWarningMessage(message);

  if (candidates.length) await offerRepin(ref, candidates);
}

function refusal(r: Resolution, confident: boolean): Refusal {
  if (confident) return 'unpinnable';
  if (!r.range) return 'lost';
  if (r.ambiguous) return 'ambiguous';
  return r.state === 'changed' ? 'changed' : r.state === 'stale' ? 'stale' : 'lost';
}

/** Where an anchor that wasn't pinned could go: where it resolves now, and the lines its `range` gives. */
function candidatesFor(anchor: Anchor, reason: Refusal, r: Resolution, doc: PreparedText): Candidate[] {
  const out: Candidate[] = [];
  const add = (wanted: LineRange, where: Candidate['where']) => {
    const range = pinAt(doc.lines, wanted, anchor.quote?.norm)?.range;
    if (!range || out.some((c) => c.range.start === range.start && c.range.end === range.end)) return;
    out.push({ anchor, reason, range, where, text: doc.lines.slice(range.start - 1, range.end).join('\n') });
  };
  if (r.range) add(r.range, 'found');
  if (!r.range || r.range.start !== anchor.range.start || r.range.end !== anchor.range.end) add(anchor.range, 'range');
  return out;
}

/** Lets the author pick refused anchors to re-pin anyway, then pins those. */
async function offerRepin(ref: ExplainerRef, candidates: Candidate[]): Promise<void> {
  const items = candidates.map((c) => {
    const first = c.text.split('\n').find((l) => l.trim())?.trim() ?? '';
    return {
      label: c.anchor.id,
      description: `${REASON[c.reason]} · ${c.anchor.file}:${rangeText(c.range)} (${c.where === 'found' ? 'where it is now' : 'its "range"'})`,
      detail: first.length > 100 ? `${first.slice(0, 100)}…` : first,
      candidate: c,
    };
  });
  const picks = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: `Re-pin anchors in ${ref.name}`,
    placeHolder: 'These weren\'t pinned. Pick the ones whose code changed on purpose, to pin them to these lines.',
    ignoreFocusOut: true,
  });
  if (!picks?.length) return;
  const byAnchor = new Map<string, Candidate[]>();
  for (const p of picks) byAnchor.set(p.candidate.anchor.id, [...(byAnchor.get(p.candidate.anchor.id) ?? []), p.candidate]);

  const snap = await snapshot(ref);
  if (!snap) return;
  const patches = new Map<string, AnchorPatch>();
  const skipped: string[] = [];
  for (const [id, chosen] of byAnchor) {
    const c = chosen[0]!;
    const anchor = snap.anchors.find((a) => a.id === id);
    const doc = snap.files.get(c.anchor.file);
    const now = doc?.lines.slice(c.range.start - 1, c.range.end).join('\n');
    // Two places picked for one anchor, or the code moved on while the list was open.
    const pin = chosen.length === 1 && anchor?.file === c.anchor.file && doc && now === c.text ? pinAt(doc.lines, c.range, anchor.quote?.norm) : null;
    if (!pin) {
      skipped.push(chosen.length > 1 ? `${id} (two places picked)` : `${id} (its code changed meanwhile)`);
      continue;
    }
    patches.set(id, pin);
  }
  if (patches.size) await writeManifest(ref, snap.manifestText, patchManifest(snap.manifestText, patches));
  const note = skipped.length ? ` Left as they were: ${skipped.join(', ')}.` : '';
  void vscode.window.showInformationMessage(`Re-pinned ${plural(patches.size, 'anchor')} in ${ref.name}.${note}`);
}

/** Anchor states as an open panel shows them, for ordering the anchor picker. */
export interface AnchorStates {
  states: ReadonlyMap<string, AnchorState | 'pending'>;
  active: string | undefined;
}

const NEEDS_LOOK: Record<string, number> = { lost: 0, stale: 1, changed: 2 };

/** Picks an anchor of the explainer: lost and out-of-date ones first, the active section preselected. */
export async function pickAnchor(ref: ExplainerRef, view?: AnchorStates): Promise<string | undefined> {
  const snap = await readManifestAnchors(ref);
  if (!snap) return undefined;
  const state = (id: string) => view?.states.get(id);
  const rank = (id: string) => NEEDS_LOOK[state(id) ?? ''] ?? 3;
  const anchors = [...snap].sort((a, b) => rank(a.id) - rank(b.id));
  if (anchors.length === 0) {
    void vscode.window.showInformationMessage(`${ref.name} has no anchors.`);
    return undefined;
  }
  const label: Partial<Record<string, string>> = { lost: 'code not found', stale: 'out of date', changed: 'code changed' };
  const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { id: string }>();
  qp.title = `Re-anchor a section of ${ref.name} to the selected code`;
  qp.placeholder = 'Which section?';
  qp.items = anchors.map((a) => ({
    id: a.id,
    label: a.id,
    description: [label[state(a.id) ?? ''], a.id === view?.active ? 'current section' : undefined].filter(Boolean).join(' · '),
    detail: `${a.file}:${rangeText(a.range)}`,
  }));
  const active = qp.items.find((i) => i.id === view?.active);
  if (active) qp.activeItems = [active];
  return new Promise((resolve) => {
    let picked: string | undefined;
    qp.onDidAccept(() => {
      picked = qp.selectedItems[0]?.id ?? qp.activeItems[0]?.id;
      qp.hide();
    });
    qp.onDidHide(() => {
      qp.dispose();
      resolve(picked);
    });
    qp.show();
  });
}

async function readManifestAnchors(ref: ExplainerRef): Promise<Anchor[] | undefined> {
  const uri = manifestUri(ref);
  const text = await readInside(uri, ref.root, MAX_MANIFEST_BYTES);
  const parsed = text === undefined ? undefined : parseManifest(text);
  if (!parsed?.ok) {
    void vscode.window.showErrorMessage(parsed?.error ?? `Can't read ${vscode.workspace.asRelativePath(uri)}.`);
    return undefined;
  }
  return [...parsed.manifest.anchors.values()];
}

/**
 * Pins one anchor to the lines selected in `editor` (file and lines; the file must be inside the
 * explainer's repository). `confirm` asks first: needed when the request came from the panel, whose
 * content is untrusted.
 */
export async function reanchorToSelection(ref: ExplainerRef, anchorId: string, editor: vscode.TextEditor | undefined, confirm: boolean): Promise<void> {
  const sel = editor?.selection;
  if (!editor || !sel || sel.isEmpty || editor.document.getText(sel).trim() === '') {
    void vscode.window.showInformationMessage(`To re-anchor “${anchorId}”, first select its code in an editor, then try again.`);
    return;
  }
  const doc = editor.document;
  const file = await relativeInside(doc.uri, ref.root);
  if (!file) {
    void vscode.window.showWarningMessage(`Can't anchor to ${vscode.workspace.asRelativePath(doc.uri)}: it isn't inside the repository that holds ${ref.name}.`);
    return;
  }
  // A selection ending at the start of a line doesn't take that line in.
  const endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
  const pin = pinAt(splitLines(doc.getText()), { start: sel.start.line + 1, end: endLine }, undefined);
  if (!pin) {
    void vscode.window.showWarningMessage(`Can't anchor “${anchorId}” there: the selection is blank or too long.`);
    return;
  }
  const where = `${file}:${rangeText(pin.range)}`;
  if (confirm) {
    const ok = 'Re-anchor';
    const choice = await vscode.window.showInformationMessage(`Re-anchor “${anchorId}” to ${where}?`, { modal: true, detail: 'This updates its entry in manifest.json.' }, ok);
    if (choice !== ok) return;
  }
  const uri = manifestUri(ref);
  const manifestText = await readInside(uri, ref.root, MAX_MANIFEST_BYTES);
  const parsed = manifestText === undefined ? undefined : parseManifest(manifestText);
  if (manifestText === undefined || !parsed?.ok) {
    void vscode.window.showErrorMessage(parsed && !parsed.ok ? parsed.error : `Can't read ${vscode.workspace.asRelativePath(uri)}.`);
    return;
  }
  const anchor = parsed.manifest.anchors.get(anchorId);
  if (!anchor) {
    void vscode.window.showWarningMessage(`${ref.name} has no anchor “${anchorId}”.`);
    return;
  }
  const quote = pinQuote(splitLines(doc.getText()), pin.range, anchor.quote?.norm);
  if (!quote) return;
  await writeManifest(ref, manifestText, patchManifest(manifestText, new Map([[anchorId, { file: file === anchor.file ? undefined : file, range: pin.range, quote }]])));
  const unsaved = doc.isDirty ? ' (from unsaved changes)' : '';
  vscode.window.setStatusBarMessage(`Re-anchored “${anchorId}” to ${where}${unsaved}.`, 5000);
}

/** The file's path relative to `root`, if it lies inside it (links followed) and is a valid anchor path. */
async function relativeInside(uri: vscode.Uri, root: vscode.Uri): Promise<string | undefined> {
  if (uri.scheme !== root.scheme || uri.authority !== root.authority) return undefined;
  const prefix = root.path.replace(/\/?$/, '/');
  if (!uri.path.startsWith(prefix)) return undefined;
  const rel = uri.path.slice(prefix.length);
  if (!isSafeRelativePath(rel)) return undefined;
  if (uri.scheme === 'file' && !(await realPathInside(uri.fsPath, root.fsPath))) return undefined;
  return rel;
}

/**
 * Into the open editor if there is one (the user saves it), else atomically to the real file.
 * `before` is the text the edit was computed from: if the manifest changed since, nothing is written.
 */
async function writeManifest(ref: ExplainerRef, before: string, after: string): Promise<void> {
  const uri = manifestUri(ref);
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) {
    if (open.getText() !== before) throw new Error('manifest.json changed while pinning; try again');
    const r = minimalReplacement(before, after);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(open.positionAt(r.offset), open.positionAt(r.offset + r.length)), r.content);
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error("couldn't edit manifest.json");
    return;
  }
  if (uri.scheme !== 'file') {
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(after));
    return;
  }
  const real = await realPathInside(uri.fsPath, ref.root.fsPath);
  if (!real) throw new Error('manifest.json is not inside the repository');
  if ((await readInside(uri, ref.root, MAX_MANIFEST_BYTES)) !== before) throw new Error('manifest.json changed while pinning; try again');
  await writeFileAtomic(real, after);
}
