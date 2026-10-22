// "Pin Anchors": records each anchor's current code and context in the manifest (upgrading it to v2),
// so anchors can follow the code through later edits. Other manifest fields are kept as written.
//
// Only anchors whose code is found with confidence are pinned. An anchor that is out of date, lost
// or ambiguous keeps its old quote: that quote is the only record of what the section was about,
// and re-pinning it to whatever now sits at the old lines would hide the problem.
import { rename, writeFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import type { LineRange } from '../core/manifest.ts';
import { parseManifest } from '../core/manifest.ts';
import { pinQuote } from '../core/pin.ts';
import { resolveAnchor } from '../core/resolve.ts';
import { PreparedText } from '../core/text.ts';
import type { ExplainerRef } from './explainers.ts';
import { manifestUri, MAX_CODE_BYTES, MAX_MANIFEST_BYTES, readInside } from './explainers.ts';
import { realPathInside } from './paths.ts';

/** `liveHint` gives where an open explainer last saw an anchor's code (live-tracked through edits). */
export async function pinAnchors(ref: ExplainerRef, liveHint: (id: string) => LineRange | undefined = () => undefined): Promise<void> {
  const uri = manifestUri(ref);
  const text = await readInside(uri, ref.root, MAX_MANIFEST_BYTES);
  if (text === undefined) {
    void vscode.window.showErrorMessage(`Can't read ${vscode.workspace.asRelativePath(uri)}.`);
    return;
  }
  const parsed = parseManifest(text);
  if (!parsed.ok) {
    void vscode.window.showErrorMessage(parsed.error);
    return;
  }
  const raw = parsed.manifest.raw as { version: number; anchors: Record<string, Record<string, unknown>> };
  const files = new Map<string, PreparedText | undefined>();
  const notPinned: string[] = [];
  let pinned = 0;
  for (const a of parsed.manifest.anchors.values()) {
    if (!files.has(a.file)) {
      const source = await readInside(vscode.Uri.joinPath(ref.root, a.file), ref.root, MAX_CODE_BYTES);
      files.set(a.file, source === undefined ? undefined : PreparedText.from(source));
    }
    const doc = files.get(a.file);
    const r = doc ? resolveAnchor(doc, a, { hint: liveHint(a.id) }) : undefined;
    const confident = r?.range && !r.ambiguous && (r.state === 'exact' || r.state === 'moved' || (r.state === 'changed' && r.similarity >= 0.9));
    const quote = confident && doc ? pinQuote(doc.lines, r.range!, a.quote?.norm) : null;
    if (!quote) {
      notPinned.push(a.id);
      continue;
    }
    const entry = raw.anchors[a.id]!;
    entry.quote = quote;
    entry.range = [r!.range!.start, r!.range!.end];
    delete entry.snippet;
    pinned++;
  }
  if (pinned === 0) {
    void vscode.window.showWarningMessage(`Nothing to pin in ${ref.name}: no anchor's code was found with confidence.`);
    return;
  }
  raw.version = 2;
  await writeManifest(ref, JSON.stringify(raw, null, 2) + '\n');
  const note = notPinned.length ? ` Left as they were (out of date, not found or ambiguous): ${notPinned.join(', ')}.` : '';
  void vscode.window.showInformationMessage(`Pinned ${pinned} anchor${pinned === 1 ? '' : 's'} in ${ref.name}.${note}`);
}

/** Into the open editor if there is one (the user saves it), else atomically to the real file. */
async function writeManifest(ref: ExplainerRef, text: string): Promise<void> {
  const uri = manifestUri(ref);
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(0, 0, open.lineCount, 0), text);
    await vscode.workspace.applyEdit(edit);
    return;
  }
  if (uri.scheme !== 'file') {
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
    return;
  }
  const real = await realPathInside(uri.fsPath, ref.root.fsPath);
  if (!real) throw new Error('manifest.json is not inside the repository');
  const tmp = `${real}.${process.pid}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, real);
}
