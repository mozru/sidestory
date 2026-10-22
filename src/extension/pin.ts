// "Pin Anchors": records each anchor's current code and context in the manifest (upgrading it to v2),
// so anchors can follow the code through later edits. Other manifest fields are kept as written.
import * as vscode from 'vscode';
import type { LineRange } from '../core/manifest.ts';
import { parseManifest } from '../core/manifest.ts';
import { pinQuote } from '../core/pin.ts';
import { splitLines } from '../core/text.ts';
import type { ExplainerRef } from './explainers.ts';
import { manifestUri, MAX_CODE_BYTES, MAX_MANIFEST_BYTES, readInside } from './explainers.ts';

/** `currentRange` gives where an anchor's code is now, if known with confidence (from an open explainer). */
export async function pinAnchors(ref: ExplainerRef, currentRange: (id: string) => LineRange | undefined = () => undefined): Promise<void> {
  const text = await readInside(manifestUri(ref), ref.root, MAX_MANIFEST_BYTES);
  if (text === undefined) {
    void vscode.window.showErrorMessage(`Can't read ${vscode.workspace.asRelativePath(manifestUri(ref))}.`);
    return;
  }
  const parsed = parseManifest(text);
  if (!parsed.ok) {
    void vscode.window.showErrorMessage(parsed.error);
    return;
  }
  const raw = parsed.manifest.raw as { version: number; anchors: Record<string, Record<string, unknown>> };
  const skipped: string[] = [];
  let pinned = 0;
  for (const a of parsed.manifest.anchors.values()) {
    const source = await readInside(vscode.Uri.joinPath(ref.root, a.file), ref.root, MAX_CODE_BYTES);
    const range = currentRange(a.id) ?? a.range;
    const quote = source === undefined ? null : pinQuote(splitLines(source), range, a.quote?.norm);
    if (!quote) {
      skipped.push(a.id);
      continue;
    }
    const entry = raw.anchors[a.id]!;
    entry.quote = quote;
    entry.range = [range.start, range.end];
    delete entry.snippet;
    pinned++;
  }
  raw.version = 2;
  await vscode.workspace.fs.writeFile(manifestUri(ref), new TextEncoder().encode(JSON.stringify(raw, null, 2) + '\n'));
  const note = skipped.length ? ` Skipped (file missing, or lines blank or out of range): ${skipped.join(', ')}.` : '';
  void vscode.window.showInformationMessage(`Pinned ${pinned} anchor${pinned === 1 ? '' : 's'} in ${ref.name}.${note}`);
}
