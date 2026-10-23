// Builds sidestory workspaces on disk for the navigation tests (index, Explained here, drift, pickers).
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface StoryAnchor {
  file: string;
  range: [number, number];
  /** Pin with this exact text (prefix/suffix empty). */
  quote?: string;
}

export interface StoryOptions {
  title?: string;
  summary?: string;
  group?: string;
  top?: boolean;
  anchors?: Record<string, StoryAnchor>;
  /** Detail links, placed in the first step. */
  details?: string[];
  /** Replaces the generated page. */
  html?: string;
  /** Extra top-level manifest fields (padding, say). */
  extra?: Record<string, unknown>;
}

export function tempRoot(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** The manifest JSON for a sidestory. */
export function manifestText(o: StoryOptions): string {
  const anchors: Record<string, unknown> = {};
  for (const [id, a] of Object.entries(o.anchors ?? {})) {
    anchors[id] = { file: a.file, range: a.range, ...(a.quote ? { quote: { exact: a.quote, prefix: '', suffix: '', norm: 'ws' } } : {}) };
  }
  return JSON.stringify({ version: 2, title: o.title ?? '', ...(o.summary ? { summary: o.summary } : {}), ...(o.group ? { group: o.group } : {}), ...(o.top ? { top: true } : {}), ...(o.extra ?? {}), anchors }, null, 2);
}

export function pageText(o: StoryOptions): string {
  if (o.html !== undefined) return o.html;
  const ids = Object.keys(o.anchors ?? {});
  const details = (o.details ?? []).map((d) => `<p data-explain-detail="${d}">see ${d}</p>`).join('');
  return ids.map((id, i) => `<section data-explain-anchor="${id}"><h2>Step ${id}</h2><p>About ${id}.</p>${i === 0 ? details : ''}</section>`).join('\n') || `<p>empty</p>${details}`;
}

/** Writes `<root>/<pkg>/.sidestory/<name>/{manifest.json,sidestory.html}`; returns the folder. */
export function story(root: string, pkg: string, name: string, o: StoryOptions = {}): string {
  const dir = join(root, pkg, '.sidestory', name);
  write(join(dir, 'manifest.json'), manifestText(o));
  write(join(dir, 'sidestory.html'), pageText(o));
  return dir;
}

/** `n` lines of code, `line 1` … `line n`. */
export const code = (n: number, tag = 'line') => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join('\n') + '\n';

export async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
