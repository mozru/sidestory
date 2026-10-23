// The explainer manifest: which code each section is about.
// Spec: docs/DESIGN.md §4.2 and §12; anchor fields from docs/research/anchors.md §3.
// Manifests are untrusted repo content: everything is validated and size-limited here.
import { z } from 'zod';
import { splitLines } from './text.ts';

export type Norm = 'ws' | 'ws-ci';

/** 1-based, inclusive line range. Anchors are line-granular for now; v2 columns are kept in `raw`. */
export interface LineRange {
  start: number;
  end: number;
}

export interface Quote {
  exact: string;
  prefix: string;
  suffix: string;
  norm: Norm;
}

/** An anchor as written, without its id. Thread code anchors reuse this shape. */
export interface AnchorSpec {
  /** Repo-relative POSIX path, from the directory that holds `.explain/`. */
  file: string;
  /** Where the code was when the anchor was written. A hint, not the truth. */
  range: LineRange;
  /** The full text of the anchored lines, with context. Preferred. */
  quote?: Quote;
  /** v1 only: text near the start of the range. */
  snippet?: string;
  /** Identifiers to mark in the file while the section is active (word characters only). */
  highlight: string[];
  /** A theme color id such as `charts.purple`. */
  color?: string;
}

export interface Anchor extends AnchorSpec {
  id: string;
}

export interface Manifest {
  version: 1 | 2;
  title: string;
  /** A short description, shown when a parent explainer offers this one as a detail ("peek"). */
  summary?: string;
  commit?: string;
  anchors: Map<string, Anchor>;
  /** The parsed JSON as written, so tools can rewrite it without losing fields we don't model. */
  raw: Record<string, unknown>;
}

export interface Diagnostic {
  /** The anchor the problem is in, if any. */
  anchor?: string;
  message: string;
}

export type ParseResult =
  | { ok: true; manifest: Manifest; diagnostics: Diagnostic[] }
  | { ok: false; code: 'invalid' | 'unsupported-version' | 'too-large'; error: string };

export const LIMITS = {
  manifestChars: 1_000_000,
  anchors: 500,
  pathChars: 1024,
  quoteChars: 64_000,
  quoteLines: 2000,
  contextChars: 1000,
  highlights: 50,
  titleChars: 300,
} as const;

const SUPPORTED_VERSIONS = [1, 2] as const;
const RESERVED_SEGMENT = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** True for a canonical repo-relative POSIX path that can't escape the repo on any OS. */
export function isSafeRelativePath(p: string): boolean {
  if (p.length === 0 || p.length > LIMITS.pathChars) return false;
  // Backslashes, drive letters, URLs, control characters, and glob syntax (paths become file watcher patterns).
  if (/[\\:\x00-\x1f\x7f*?[\]{}]/.test(p)) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..' && !/[. ]$/.test(seg) && !RESERVED_SEGMENT.test(seg) && seg.toLowerCase() !== '.git');
}

const line = z.number().int().min(1).max(10_000_000);
const pos = z.tuple([line, z.number().int().min(0)]);

const rangeSchema = z
  .union([z.tuple([line, line]), z.object({ start: pos, end: pos })])
  .transform((r): LineRange => (Array.isArray(r) ? { start: r[0], end: r[1] } : { start: r.start[0], end: r.end[0] }))
  .refine((r) => r.end >= r.start, 'range end is before its start');

/** The anchor object as written in a manifest or a thread. */
export const anchorSpecSchema = z.looseObject({
  file: z.string().refine(isSafeRelativePath, 'file must be a relative path inside the repo, using / separators'),
  range: rangeSchema,
  snippet: z.string().min(1).max(LIMITS.contextChars).optional(),
  quote: z
    .object({
      exact: z
        .string()
        .min(1)
        .max(LIMITS.quoteChars)
        .refine((s) => splitLines(s).length <= LIMITS.quoteLines, `quote is longer than ${LIMITS.quoteLines} lines`),
      prefix: z.string().max(LIMITS.contextChars).default(''),
      suffix: z.string().max(LIMITS.contextChars).default(''),
      norm: z.enum(['ws', 'ws-ci']).default('ws'),
    })
    .optional(),
  highlight: z
    .array(z.string().regex(/^[A-Za-z_$][\w$]{0,99}$/, 'highlight entries are identifiers'))
    .max(LIMITS.highlights)
    .default([]),
  color: z
    .string()
    .max(100)
    .regex(/^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)*$/, 'color must be a theme color id like charts.purple')
    .optional(),
});

/** An explainer's folder name under `.explain/`, as used in `data-explain-detail`. */
export const explainerNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'explainer names use letters, digits, ".", "-" and "_"');

export const anchorIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/, 'anchor ids start with a letter and use letters, digits, - and _');

const manifestSchema = z.looseObject({
  version: z.number(),
  title: z.string().max(LIMITS.titleChars),
  summary: z.string().max(1000).optional(),
  commit: z
    .string()
    .regex(/^[0-9a-fA-F]{7,64}$/, 'commit must be a hex commit id')
    .optional(),
  anchors: z.custom<Record<string, unknown>>((v) => typeof v === 'object' && v !== null && !Array.isArray(v), 'anchors must be an object'),
});

export function parseAnchorSpec(raw: unknown): { ok: true; spec: AnchorSpec } | { ok: false; error: string } {
  const r = anchorSpecSchema.safeParse(raw);
  if (!r.success) return { ok: false, error: describe(r.error) };
  const a = r.data;
  return { ok: true, spec: { file: a.file, range: a.range, quote: a.quote, snippet: a.snippet, highlight: a.highlight, color: a.color } };
}

/**
 * Parses a manifest. A broken anchor becomes a diagnostic and the rest still load;
 * only a broken top level (or an unknown future version) fails the whole manifest.
 */
export function parseManifest(json: string): ParseResult {
  if (json.length > LIMITS.manifestChars) return { ok: false, code: 'too-large', error: `manifest.json is longer than ${LIMITS.manifestChars} characters` };
  let raw: unknown;
  try {
    raw = JSON.parse(json.replace(/^﻿/, ''));
  } catch (e) {
    return { ok: false, code: 'invalid', error: `manifest.json is not valid JSON: ${(e as Error).message}` };
  }
  const top = manifestSchema.safeParse(raw);
  if (!top.success) return { ok: false, code: 'invalid', error: `manifest.json: ${describe(top.error)}` };
  const version = top.data.version;
  if (!(SUPPORTED_VERSIONS as readonly number[]).includes(version)) {
    return { ok: false, code: 'unsupported-version', error: `manifest.json has version ${version}; this version of Sidestory reads versions ${SUPPORTED_VERSIONS.join(' and ')}` };
  }

  const diagnostics: Diagnostic[] = [];
  const anchors = new Map<string, Anchor>();
  // Read the raw object (not a zod record) so odd keys like "__proto__" are reported, not silently dropped.
  const entries = Object.entries((raw as { anchors: Record<string, unknown> }).anchors);
  if (entries.length > LIMITS.anchors) diagnostics.push({ message: `only the first ${LIMITS.anchors} of ${entries.length} anchors are used` });
  for (const [id, value] of entries.slice(0, LIMITS.anchors)) {
    const idOk = anchorIdSchema.safeParse(id);
    if (!idOk.success) {
      diagnostics.push({ anchor: id.slice(0, 64), message: describe(idOk.error) });
      continue;
    }
    const spec = parseAnchorSpec(value);
    if (spec.ok) anchors.set(id, { id, ...spec.spec });
    else diagnostics.push({ anchor: id, message: spec.error });
  }
  return {
    ok: true,
    diagnostics,
    manifest: { version: version as 1 | 2, title: top.data.title, summary: top.data.summary, commit: top.data.commit, anchors, raw: raw as Record<string, unknown> },
  };
}

function describe(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid';
  const where = issue.path.map(String).join(' › ');
  return where ? `${where}: ${issue.message}` : issue.message;
}
