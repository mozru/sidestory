// Records each anchor's current text (quote + context) from its range, upgrading the manifest to v2.
// Usage: npm run pin -- <path/to/.explain/name> [anchorId ...]
// Only the pinned anchors' fields change; the rest of the file keeps its formatting.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseManifest } from '../src/core/manifest.ts';
import { pinQuote, trimBlankLines } from '../src/core/pin.ts';
import { splitLines } from '../src/core/text.ts';
import type { AnchorPatch } from '../src/extension/manifest-edit.ts';
import { patchManifest } from '../src/extension/manifest-edit.ts';
import { realPathInside } from '../src/extension/paths.ts';

const [dirArg, ...only] = process.argv.slice(2);
if (!dirArg) {
  console.error('usage: npm run pin -- <path/to/.explain/name> [anchorId ...]');
  process.exit(2);
}
const dir = resolve(dirArg);
const root = dirname(dirname(dir));
const manifestPath = join(dir, 'manifest.json');
const text = readFileSync(manifestPath, 'utf8');
const parsed = parseManifest(text);
if (!parsed.ok) {
  console.error(parsed.error);
  process.exit(1);
}
for (const d of parsed.diagnostics) console.warn(`warning: ${d.anchor ?? ''} ${d.message}`);

const patches = new Map<string, AnchorPatch>();
for (const a of parsed.manifest.anchors.values()) {
  if (only.length && !only.includes(a.id)) continue;
  // Never follow a link out of the repository: the quote would copy that file's text into the manifest.
  const real = await realPathInside(join(root, a.file), root);
  if (!real) {
    console.warn(`skipped ${a.id}: ${a.file} is missing or outside the repository`);
    continue;
  }
  const lines = splitLines(readFileSync(real, 'utf8'));
  // The stored range is the lines actually quoted (without blank edge lines).
  const range = trimBlankLines(lines, a.range);
  const quote = range && pinQuote(lines, range, a.quote?.norm);
  if (!range || !quote) {
    console.warn(`skipped ${a.id}: lines ${a.range.start}-${a.range.end} of ${a.file} are blank or missing`);
    continue;
  }
  patches.set(a.id, { range, quote });
}
if (patches.size) writeFileSync(manifestPath, patchManifest(text, patches));
console.log(`pinned ${patches.size} anchor(s) in ${manifestPath}`);
