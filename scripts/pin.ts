// Records each anchor's current text (quote + context) from its range, upgrading the manifest to v2.
// Usage: npm run pin -- <path/to/.explain/name> [anchorId ...]
// Other manifest fields are kept as written.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseManifest } from '../src/core/manifest.ts';
import { pinQuote } from '../src/core/pin.ts';
import { splitLines } from '../src/core/text.ts';
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

const raw = parsed.manifest.raw as { version: number; anchors: Record<string, Record<string, unknown>> };
let pinned = 0;
for (const a of parsed.manifest.anchors.values()) {
  if (only.length && !only.includes(a.id)) continue;
  // Never follow a link out of the repository: the quote would copy that file's text into the manifest.
  const real = await realPathInside(join(root, a.file), root);
  if (!real) {
    console.warn(`skipped ${a.id}: ${a.file} is missing or outside the repository`);
    continue;
  }
  const lines = splitLines(readFileSync(real, 'utf8'));
  const quote = pinQuote(lines, a.range, a.quote?.norm);
  if (!quote) {
    console.warn(`skipped ${a.id}: lines ${a.range.start}-${a.range.end} of ${a.file} are blank or missing`);
    continue;
  }
  const entry = raw.anchors[a.id]!;
  entry.quote = quote;
  delete entry.snippet;
  pinned++;
}
raw.version = 2;
writeFileSync(manifestPath, JSON.stringify(raw, null, 2) + '\n');
console.log(`pinned ${pinned} anchor(s) in ${manifestPath}`);
