// The parts of code links that need no VS Code API, shared by the extension host and the checker
// (docs/AUTHORING-PLAN.md §8.1):
//   OpenCodeGate        dedupes identical `openCode` requests within 300 ms and allows 10 a second, before any
//                       file is touched
//   checkCodePath       real-path containment, no `.git` segment in the real path, a regular file; and whether
//                       the link's name or the real file's name looks secret
//   matchProviderSymbol a path against a language's document symbols (`RetryClient.send`)
import { realpath, stat } from 'node:fs/promises';
import { basename, relative, sep } from 'node:path';
import type { LineRange } from '../core/manifest.ts';
import { realPathInside } from './paths.ts';
import { isSecretFileName } from './widgets/secret-files.ts';

export type LinkResolution = { ok: true; range: LineRange } | { ok: false; message: string; unavailable?: boolean };

/** `openCode` requests a second, as a backstop: the guarantee is that only the reader's own input posts them. */
export const OPEN_CODE_PER_SECOND = 10;
/** Identical requests closer than this are one (a double click, a key and its click). */
export const OPEN_CODE_DEDUPE_MS = 300;

export class OpenCodeGate {
  private times: number[] = [];
  private last = { key: '', at: -Infinity };

  /** Whether to act on a request with this key now. Cheap: called before any file-system work. */
  allow(key: string, now = Date.now()): boolean {
    if (key === this.last.key && now - this.last.at < OPEN_CODE_DEDUPE_MS) return false;
    this.last = { key, at: now };
    this.times = this.times.filter((t) => now - t < 1000);
    if (this.times.length >= OPEN_CODE_PER_SECOND) return false;
    this.times.push(now);
    return true;
  }
}

/**
 * `direct`: no symlink between the repository root and the file, so the workspace path names the same file (open
 * that, so it's the document the reader and the anchors already use). `size` in bytes.
 */
export type PathCheck = { ok: true; real: string; secret: boolean; direct: boolean; size: number } | { ok: false; why: string };

/**
 * Where a link's path really is: inside `root` once links are followed, with no `.git` segment in the real path
 * relative to the root, and a regular file. `secret` is the widget rule on the requested name and the real name.
 */
export async function checkCodePath(root: string, path: string): Promise<PathCheck> {
  const segments = path.split('/');
  if (segments.some((s) => s.toLowerCase() === '.git')) return { ok: false, why: 'it is inside .git' };
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return { ok: false, why: "the repository can't be read" };
  }
  const real = await realPathInside(`${root}${sep}${segments.join(sep)}`, root);
  if (!real) return { ok: false, why: "it isn't a file inside the repository" };
  const rel = relative(realRoot, real);
  if (rel.split(sep).some((s) => s.toLowerCase() === '.git')) return { ok: false, why: 'it is inside .git' };
  let size: number;
  try {
    const st = await stat(real);
    if (!st.isFile()) return { ok: false, why: "it isn't a file" };
    size = st.size;
  } catch {
    return { ok: false, why: "it can't be read" };
  }
  return { ok: true, real, secret: isSecretFileName(basename(path)) || isSecretFileName(basename(real)), direct: rel === segments.join(sep), size };
}

/** A symbol from a document symbol provider: the chain of names, and its lines. */
export interface ProviderSymbol {
  chain: string[];
  range: LineRange;
}

/** A path matched against provider symbols: the whole chain, else a unique suffix of one (`RetryClient.send`). */
export function matchProviderSymbol(symbols: readonly ProviderSymbol[], path: string): LinkResolution {
  const want = path.split('.');
  const ends = symbols.filter((s) => s.chain.length >= want.length && want.every((w, i) => s.chain[s.chain.length - want.length + i] === w));
  const exact = ends.filter((s) => s.chain.length === want.length);
  const pick = exact.length === 1 ? exact : ends;
  if (pick.length === 1) return { ok: true, range: pick[0]!.range };
  if (pick.length > 1) return { ok: false, message: `\`${path}\` is ambiguous (lines ${pick.slice(0, 5).map((s) => s.range.start).join(', ')}): name its container too` };
  return { ok: false, message: `\`${path}\` not found` };
}

