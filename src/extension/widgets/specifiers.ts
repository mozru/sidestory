// Which widget file paths and relative import specifiers are acceptable, and what they name.
// Everything here is lexical; compile-worker.ts then opens the result via realpath inside the folder.
import { posix } from 'node:path';
import { WIDGET_DATA_EXTENSIONS, WIDGET_IMAGE_EXTENSIONS, WIDGET_SOURCE_EXTENSIONS } from '../../shared/widget-imports.ts';

export type FileKind = 'source' | 'json' | 'image';
export type SpecResult = { ok: true; key: string } | { ok: false; code: string; message: string };

const RESERVED_SEGMENT = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export const isRelativeSpecifier = (spec: string) => spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../');

export function extensionOf(key: string): string {
  const base = key.slice(key.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

export function kindOf(key: string): FileKind | undefined {
  const ext = extensionOf(key);
  if ((WIDGET_SOURCE_EXTENSIONS as readonly string[]).includes(ext)) return 'source';
  if ((WIDGET_DATA_EXTENSIONS as readonly string[]).includes(ext)) return 'json';
  if ((WIDGET_IMAGE_EXTENSIONS as readonly string[]).includes(ext)) return 'image';
  return undefined;
}

export const ALLOWED_EXTENSIONS = [...WIDGET_SOURCE_EXTENSIONS, ...WIDGET_DATA_EXTENSIONS, ...WIDGET_IMAGE_EXTENSIONS];

/** Problems any path or specifier can have, before it is resolved. */
export function lexicalProblem(spec: string): { code: string; message: string } | undefined {
  if (spec.length === 0) return { code: 'bad-specifier', message: 'an empty path' };
  if (spec.length > 1024) return { code: 'bad-specifier', message: 'a path longer than 1024 characters' };
  if (/[\x00-\x1f\x7f]/.test(spec)) return { code: 'bad-specifier', message: 'paths may not contain control characters' };
  if (spec.includes('\\')) return { code: 'bad-specifier', message: 'use / in paths, not \\' };
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(spec) || spec.includes(':')) return { code: 'bad-specifier', message: 'URLs (file:, http:, data:) are not allowed; use a path inside the explainer folder' };
  if (spec.includes('?') || spec.includes('#')) return { code: 'bad-specifier', message: 'query strings and fragments (? and #) are not allowed in paths' };
  if (spec.startsWith('/')) return { code: 'bad-specifier', message: 'absolute paths are not allowed; use a path relative to the explainer folder' };
  return undefined;
}

/** Checks a normalized, folder-relative key: inside the folder, and segments safe on every OS. */
function checkKey(key: string, trailingSlash: boolean): SpecResult {
  if (key === '..' || key.startsWith('../')) return { ok: false, code: 'outside-folder', message: 'the path leads outside the explainer folder' };
  if (key === '.' || key === '') return { ok: false, code: 'bad-specifier', message: 'the path names the explainer folder itself' };
  for (const seg of key.split('/')) {
    if (seg.toLowerCase() === '.git' || /[. ]$/.test(seg) || RESERVED_SEGMENT.test(seg)) {
      return { ok: false, code: 'bad-specifier', message: `'${seg}' is not allowed as a path segment` };
    }
  }
  return { ok: true, key: trailingSlash ? `${key}/` : key };
}

/** The entry module's key from a widget's `src` (relative to the explainer folder). */
export function normalizeEntry(src: string): SpecResult {
  const p = lexicalProblem(src);
  if (p) return { ok: false, ...p };
  const key = posix.normalize(src);
  const r = checkKey(key, false);
  if (!r.ok) return r;
  if (kindOf(r.key) !== 'source') {
    return { ok: false, code: 'bad-extension', message: `a widget's src must be a ${WIDGET_SOURCE_EXTENSIONS.join(', ')} file` };
  }
  return r;
}

/**
 * The key a relative specifier names, from the module `fromKey`. May lack an extension (resolution then
 * tries source extensions and index files) and may end in `/` (index files only).
 */
export function resolveRelative(fromKey: string, spec: string): SpecResult {
  const p = lexicalProblem(spec);
  if (p) return { ok: false, ...p };
  const trailingSlash = spec.endsWith('/') || spec === '.' || spec === '..' || spec.endsWith('/.') || spec.endsWith('/..');
  const key = posix.normalize(posix.join(posix.dirname(fromKey), spec)).replace(/\/$/, '');
  return checkKey(key, trailingSlash);
}

/** Keys to try, in order, for a resolved key: as written (if its extension is allowed), with each source extension, then index files. */
export function candidatesFor(key: string): string[] {
  if (key.endsWith('/')) return WIDGET_SOURCE_EXTENSIONS.map((e) => `${key}index${e}`);
  const out: string[] = [];
  if (kindOf(key)) out.push(key);
  for (const e of WIDGET_SOURCE_EXTENSIONS) out.push(key + e);
  for (const e of WIDGET_SOURCE_EXTENSIONS) out.push(`${key}/index${e}`);
  return out;
}
