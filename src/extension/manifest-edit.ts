// Rewrites only the anchors that pinning changed, keeping the rest of manifest.json as written:
// key order, spacing, a compact one-line-per-anchor layout, fields we don't model.
// No VS Code API here, so scripts/pin.ts and the unit tests can use it too.
import type { Node } from 'jsonc-parser';
import { getNodeValue, parseTree } from 'jsonc-parser';
import type { LineRange, Quote, Side } from '../core/manifest.ts';
import { requiredVersion } from '../core/manifest.ts';

export interface AnchorPatch {
  /** A new file for the anchor (re-anchoring to code in another file); omitted keeps the old one. */
  file?: string;
  range: LineRange;
  quote: Quote;
  /**
   * The side the code is on (docs/CHANGES-PLAN.md §3.2): `'base'` writes `"side": "base"`, `'head'` removes a
   * `side` (head is the default); omitted keeps what is written.
   */
  side?: Side;
}

export interface ManifestPatchOptions {
  /** A top-level `id` (a ULID, docs/COMMENTS-PLAN.md §3.1) to add, as the last field, when the manifest has none; an existing one is kept. */
  id?: string;
}

interface TextEdit {
  offset: number;
  length: number;
  content: string;
}

/**
 * The manifest with each patched anchor's `range` and `quote` (and `file`, `side`) set, its v1 `snippet` removed,
 * and `version` set by the writer rule `max(current, required, 2)` (docs/AUTHORING-PLAN.md §1.2; a base-side anchor
 * requires 3, docs/CHANGES-PLAN.md §3.5), so a v3 manifest is never downgraded. Edits are made in place; if the
 * result doesn't parse back to exactly what was asked for (an odd layout we didn't foresee), the whole file is
 * rewritten instead.
 */
export function patchManifest(text: string, patches: ReadonlyMap<string, AnchorPatch>, options: ManifestPatchOptions = {}): string {
  const expected = JSON.parse(text.replace(/^\uFEFF/, '')) as { version: number; id?: unknown; anchors: Record<string, Record<string, unknown>> };
  for (const [id, p] of patches) {
    const entry = expected.anchors[id];
    if (!entry) throw new Error(`no anchor "${id}" in manifest.json`);
    if (p.file !== undefined) entry.file = p.file;
    entry.range = [p.range.start, p.range.end];
    entry.quote = p.quote;
    if (p.side === 'base') entry.side = 'base';
    else if (p.side === 'head') delete entry.side;
    delete entry.snippet;
  }
  const current = typeof expected.version === 'number' && Number.isFinite(expected.version) ? expected.version : 2;
  const version = Math.max(current, requiredVersion(expected), 2);
  expected.version = version;
  const addId = options.id !== undefined && expected.id === undefined ? options.id : undefined;
  // Added last, so the lines a person wrote (and reads first) stay where they were.
  if (addId !== undefined) expected.id = addId;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  try {
    const edited = applyEdits(text, editsFor(text, patches, eol, version, addId));
    if (canonical(JSON.parse(edited.replace(/^\uFEFF/, ''))) === canonical(expected)) return edited;
  } catch {
    // fall through to a full rewrite
  }
  return JSON.stringify(expected, null, 2).replace(/\n/g, eol) + eol;
}

function editsFor(text: string, patches: ReadonlyMap<string, AnchorPatch>, eol: string, toVersion: number, addId: string | undefined): TextEdit[] {
  const root = parseTree(text);
  if (root?.type !== 'object') throw new Error('not an object');
  const edits: TextEdit[] = [];
  const version = property(root, 'version');
  if (version?.children?.[1] && version.children[1].value !== toVersion) edits.push(replace(version.children[1], String(toVersion)));
  if (addId !== undefined) {
    const last = root.children?.at(-1);
    if (!last) throw new Error('empty manifest');
    const compact = !/[\r\n]/.test(text.slice(root.offset, root.offset + root.length));
    const sep = compact ? ' ' : eol + lineIndent(text, last.offset);
    edits.push({ offset: last.offset + last.length, length: 0, content: `,${sep}"id": ${JSON.stringify(addId)}` });
  }
  const anchors = property(root, 'anchors')?.children?.[1];
  if (anchors?.type !== 'object') throw new Error('no anchors object');
  for (const [id, p] of patches) {
    const obj = property(anchors, id)?.children?.[1];
    if (obj?.type !== 'object' || !obj.children?.length) throw new Error(`anchor ${id} is not an object`);
    const compact = !/[\r\n]/.test(text.slice(obj.offset, obj.offset + obj.length));
    const indent = compact ? '' : lineIndent(text, obj.children[0]!.offset);
    const unit = compact ? '' : indent.slice(lineIndent(text, obj.offset).length) || '  ';
    const quoteText = compact ? JSON.stringify(p.quote) : JSON.stringify(p.quote, null, unit).replace(/\n/g, eol + indent);
    const set = (key: string, value: string, insertAfter: Node[]) => {
      const existing = property(obj, key)?.children?.[1];
      if (existing) {
        // Unchanged values are left exactly as written.
        if (canonical(getNodeValue(existing)) !== canonical(JSON.parse(value))) edits.push(replace(existing, value));
        return;
      }
      const last = insertAfter.at(-1)!;
      edits.push({ offset: last.offset + last.length, length: 0, content: `,${compact ? ' ' : eol + indent}${JSON.stringify(key)}: ${value}` });
    };
    const snippet = property(obj, 'snippet');
    const side = property(obj, 'side');
    const dropSide = p.side === 'head' && side ? side : undefined;
    // Insert new properties after the last one that stays (never next to a removed snippet or side).
    const kept = obj.children.filter((c) => c !== snippet && c !== dropSide);
    if (!kept.length) throw new Error('nothing to insert after');
    if (p.file !== undefined) set('file', JSON.stringify(p.file), kept);
    if (p.side === 'base') set('side', '"base"', kept);
    if (dropSide) edits.push(removal(obj, dropSide));
    const range = property(obj, 'range')?.children?.[1];
    if (range?.type === 'array' && range.children?.length === 2 && range.children.every((c) => c.type === 'number')) {
      // Keep the array's own layout: just the numbers change.
      [p.range.start, p.range.end].forEach((n, i) => {
        if (range.children![i]!.value !== n) edits.push(replace(range.children![i]!, String(n)));
      });
    } else {
      set('range', `[${p.range.start}, ${p.range.end}]`, kept);
    }
    if (snippet && !property(obj, 'quote')) {
      // A v1 anchor: the quote takes the snippet's place.
      edits.push({ offset: snippet.offset, length: snippet.length, content: `"quote": ${quoteText}` });
    } else {
      set('quote', quoteText, kept);
      if (snippet) edits.push(removal(obj, snippet));
    }
  }
  return edits;
}

/** JSON with object keys sorted, to compare values whatever order their keys were written in. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  );
}

/** The last property named `key` (JSON.parse keeps the last of duplicates). */
function property(obj: Node, key: string): Node | undefined {
  return obj.children?.filter((c) => c.type === 'property' && c.children?.[0]?.value === key).at(-1);
}

function replace(node: Node, content: string): TextEdit {
  return { offset: node.offset, length: node.length, content };
}

/** Removes a property with the comma that separates it from its neighbour. */
function removal(obj: Node, prop: Node): TextEdit {
  const siblings = obj.children!;
  const i = siblings.indexOf(prop);
  if (i > 0) {
    const prev = siblings[i - 1]!;
    const from = prev.offset + prev.length;
    return { offset: from, length: prop.offset + prop.length - from, content: '' };
  }
  const next = siblings[1];
  return { offset: prop.offset, length: (next ? next.offset : prop.offset + prop.length) - prop.offset, content: '' };
}

function lineIndent(text: string, offset: number): string {
  const lineStart = Math.max(text.lastIndexOf('\n', offset - 1), text.lastIndexOf('\r', offset - 1)) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart, offset))![0];
}

function applyEdits(text: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.offset - a.offset);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.offset + sorted[i]!.length > sorted[i - 1]!.offset) throw new Error('overlapping edits');
  }
  let out = text;
  for (const e of sorted) out = out.slice(0, e.offset) + e.content + out.slice(e.offset + e.length);
  return out;
}

/** The smallest single replacement turning `before` into `after`, for an edit to an open document. */
export function minimalReplacement(before: string, after: string): TextEdit {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  return { offset: start, length: before.length - start - end, content: after.slice(start, after.length - end) };
}
