// The explainer manifest: which code each section is about.
// Spec: docs/DESIGN.md §4.2 and §12; anchor fields from docs/research/anchors.md §3.
// Manifests are untrusted repo content: everything is validated and size-limited here.
import { z } from 'zod';
import { splitLines } from './text.ts';

/** Which side of a branch's merge diff an anchor's code is on (docs/CHANGES-PLAN.md §3.2). */
export type Side = 'head' | 'base';

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
  /** Repo-relative POSIX path, from the directory that holds `.sidestory/`. */
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
  /**
   * `'base'`: the code at the merge-base of the sidestory's `base` (the left of a diff), read at `file` there (the
   * old path of a renamed file). Absent means `'head'`, the code as it is now (docs/CHANGES-PLAN.md §3.2).
   */
  side?: Side;
  /** Marks the anchored change as not needing an explanation (§3.3). Covers nothing without `why`. */
  trivial?: boolean;
  /** Why a trivial change needs no explanation (1–200 characters, shown to reviewers). Required with `trivial`. */
  why?: string;
}

/**
 * One place in the code an anchor points at (docs/AUTHORING-PLAN.md §1.1). Release 1 has the type only: every
 * anchor is single-part, normalized to one part equal to its own fields. Multi-part anchors (`parts` in the
 * manifest, version 3) come later, and the workspace index stores parts from the start (§10.1, step 3).
 */
export interface AnchorPart {
  /** Addresses the part (`anchor:label`); the anchor-id grammar, up to 24 characters. */
  label?: string;
  file: string;
  range: LineRange;
  quote?: Quote;
  snippet?: string;
  highlight: string[];
  /** As on the anchor; a part field from the start, so multi-part anchors need no migration (§3.2). */
  side?: Side;
}

export interface Anchor extends AnchorSpec {
  id: string;
  /**
   * The anchor's parts, part 1 first. `parseManifest` always sets it (one part, today); anchors built elsewhere may
   * leave it out, so read it through `anchorParts`.
   */
  parts?: readonly [AnchorPart, ...AnchorPart[]];
}

/** An anchor's parts: `parts`, or the anchor itself as its only part. */
export function anchorParts(a: Anchor): readonly [AnchorPart, ...AnchorPart[]] {
  return a.parts ?? [{ file: a.file, range: a.range, quote: a.quote, snippet: a.snippet, highlight: a.highlight, ...(a.side ? { side: a.side } : {}) }];
}

/** The side an anchor's code is on: `'head'` unless it says `'base'`. */
export function sideOf(a: { side?: Side }): Side {
  return a.side === 'base' ? 'base' : 'head';
}

/**
 * The key for state kept per code target (resolutions, hints, orphan flags, confirmed widget anchors). Part 1's
 * key is the anchor id itself, so state keyed by id today stays valid; later parts are `id:2`, `id:3` …, which no
 * anchor id can be (ids can't contain `:`). `part` is 0-based.
 */
export function partKey(id: string, part = 0): string {
  return part === 0 ? id : `${id}:${part + 1}`;
}

export interface Manifest {
  version: 1 | 2 | 3;
  /**
   * A stable id for the sidestory, a ULID (docs/COMMENTS-PLAN.md §3.1): written once when the sidestory is created
   * and kept through edits and archiving. A convenience for matching, not provenance.
   */
  id?: string;
  /**
   * What the sidestory's branch is compared with: a ref name or a full commit id (docs/CHANGES-PLAN.md §3.1). With
   * it, steps open the branch's merge diff and the sidestory counts toward that branch's coverage.
   */
  base?: string;
  /** With `base`: fixes the head side at this full commit id (archived and review sidestories). */
  head?: string;
  /** With `base`: globs of repo-relative files whose changes need no explanation (§3.1, §3.3). */
  trivialFiles?: string[];
  title: string;
  /** A short description, shown when a parent explainer offers this one as a detail ("peek"). */
  summary?: string;
  commit?: string;
  /**
   * Files the sidestory under this group in the sidebar, and makes it a top even when another sidestory links
   * to it as a detail (docs/NAVIGATION-PLAN.md §4.2, §5.2). Trimmed, 1–60 characters.
   */
  group?: string;
  /** Keeps a cross-linked sidestory at the top level without inventing a group (docs/NAVIGATION-PLAN.md §13, Q3). */
  top?: boolean;
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
  groupChars: 60,
  whyChars: 200,
  trivialFiles: 100,
  trivialFileChars: 200,
} as const;

const SUPPORTED_VERSIONS = [1, 2, 3] as const;
/** The newest version this release reads and writes. */
export const MANIFEST_VERSION = 3;

/** Full commit ids: SHA-1 or SHA-256, lowercase. */
export const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** A ULID: 26 characters of Crockford base32 (docs/COMMENTS-PLAN.md §3.1). */
export const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * §3.1's grammar for a base written by a person or a manifest: a full commit id, or a ref name of 1–200 characters
 * from `[A-Za-z0-9._/-]` that doesn't start with `-` or `/`, doesn't end with `/`, `.` or `.lock`, has no `..`,
 * `//` or `@{`, and isn't a pseudo-ref (`HEAD`, `FETCH_HEAD`, any all-caps name ending in `HEAD`). A short hex
 * name is read as a ref name, never as an abbreviated commit id.
 */
export function isValidBase(spec: string): boolean {
  if (FULL_SHA.test(spec)) return true;
  if (spec.length < 1 || spec.length > 200) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(spec)) return false;
  if (/^[-/]/.test(spec) || /(\/|\.|\.lock)$/.test(spec)) return false;
  if (spec.includes('..') || spec.includes('//') || spec.includes('@{')) return false;
  if (/^[A-Z_]*HEAD$/.test(spec)) return false;
  // Each segment must be a valid ref component too: none may start with "." (refs can't).
  return spec.split('/').every((s) => s !== '' && !s.startsWith('.'));
}

/**
 * A `trivialFiles` pattern (§3.4): `*`, `**` and `?` only (no braces, character classes or `!`), repo-relative, no
 * `.` or `..` segment, no leading `/`, no backslashes or control characters, at most 200 characters.
 */
export function isValidTrivialGlob(p: string): boolean {
  if (p.length < 1 || p.length > LIMITS.trivialFileChars) return false;
  if (/[\\\x00-\x1f\x7f[\]{}!]/.test(p) || p.startsWith('/')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/**
 * A `trivialFiles` glob that matches exactly one path's shape, for a path that isn't a valid glob itself (an
 * unsupported path: control characters, a backslash, `[`, `{`): each character a glob refuses becomes `?`, which
 * matches any one character in a segment, and a `.` or `..` segment becomes `?` or `??`. Undefined when no valid glob
 * can match it (an empty segment, a leading `/`, over the length cap).
 */
export function trivialGlobFor(path: string): string | undefined {
  if (path.startsWith('/')) return undefined;
  const glob = path
    .split('/')
    .map((seg) => (seg === '.' ? '?' : seg === '..' ? '??' : seg.replace(/[\\\x00-\x1f\x7f[\]{}!]/g, '?')))
    .join('/');
  return isValidTrivialGlob(glob) ? glob : undefined;
}

/**
 * The version a manifest's contents need (§3.5): 3 once any anchor (or part) is on the base side, else 2. Writers
 * set `version = max(current, required)`.
 */
export function requiredVersion(raw: { anchors?: unknown }): 2 | 3 {
  const anchors = raw.anchors;
  if (!anchors || typeof anchors !== 'object') return 2;
  for (const a of Object.values(anchors as Record<string, unknown>)) {
    if (!a || typeof a !== 'object') continue;
    if ((a as { side?: unknown }).side === 'base') return 3;
    const parts = (a as { parts?: unknown }).parts;
    if (Array.isArray(parts) && parts.some((p) => !!p && typeof p === 'object' && (p as { side?: unknown }).side === 'base')) return 3;
  }
  return 2;
}
/** Windows device names, which no path segment may be (with or without an extension). */
export const RESERVED_SEGMENT = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

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
  side: z.enum(['head', 'base'], 'side must be "head" or "base"').optional(),
  trivial: z.boolean('trivial must be true or false').optional(),
  // `why` is read leniently in parseAnchorSpec: a bad one leaves a trivial anchor covering nothing (§3.4).
});

/** An explainer's folder name under `.sidestory/`, as used in `data-explain-detail`. */
export const explainerNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'sidestory names use letters, digits, ".", "-" and "_"');

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

export function parseAnchorSpec(raw: unknown): { ok: true; spec: AnchorSpec; warning?: string } | { ok: false; error: string } {
  const r = anchorSpecSchema.safeParse(raw);
  if (!r.success) return { ok: false, error: describe(r.error) };
  const a = r.data;
  const why = parseWhy((raw as { why?: unknown }).why);
  const spec: AnchorSpec = {
    file: a.file,
    range: a.range,
    quote: a.quote,
    snippet: a.snippet,
    highlight: a.highlight,
    color: a.color,
    ...(a.side === 'base' ? { side: 'base' as const } : {}),
    ...(a.trivial ? { trivial: true } : {}),
    ...(why.value !== undefined ? { why: why.value } : {}),
  };
  const warning = why.error ? `why: ${why.error}; ignored` : a.trivial && why.value === undefined ? 'trivial needs a "why" (1–200 characters) saying why the change needs no explanation; until then it marks nothing' : undefined;
  return { ok: true, spec, ...(warning ? { warning } : {}) };
}

/** An anchor's `why`: a string, trimmed, 1–200 characters, no control characters. */
export function parseWhy(v: unknown): { value?: string; error?: string } {
  if (v === undefined) return {};
  if (typeof v !== 'string') return { error: 'must be a string' };
  const value = v.trim();
  if (!value) return { error: 'is empty' };
  if (value.length > LIMITS.whyChars) return { error: `is longer than ${LIMITS.whyChars} characters` };
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) return { error: 'contains control characters' };
  // Reviewers read the why to trust a trivial mark: nothing that hides or reorders text (bidi controls, zero-width
  // and tag characters, lone surrogates; the set displayText removes).
  if (/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u00ad\u200b-\u200d\u2060-\u2064\ufeff]|\udb40[\udc00-\udc7f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value)) {
    return { error: 'contains invisible or direction-changing characters' };
  }
  return { value };
}

/** The most bytes a manifest is read with (the extension and the checker). */
export const MAX_MANIFEST_BYTES = 1_000_000;

/**
 * Parses a manifest. A broken anchor becomes a diagnostic and the rest still load;
 * only a broken top level (or an unknown future version) fails the whole manifest.
 */
export function parseManifest(json: string): ParseResult {
  if (json.length > LIMITS.manifestChars) return { ok: false, code: 'too-large', error: `manifest.json is longer than ${LIMITS.manifestChars} characters` };
  let raw: unknown;
  try {
    raw = JSON.parse(json.replace(/^\ufeff/, ''));
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
  // Read leniently, outside the zod top level: a bad value is ignored with a diagnostic, and the manifest still loads.
  const rawTop = raw as Record<string, unknown>;
  const group = parseGroup(rawTop.group);
  if (group.error) diagnostics.push({ message: `group: ${group.error}; ignored` });
  let isTop: boolean | undefined;
  if (rawTop.top !== undefined) {
    if (typeof rawTop.top === 'boolean') isTop = rawTop.top;
    else diagnostics.push({ message: 'top: must be true or false; ignored' });
  }
  // The branch fields (docs/CHANGES-PLAN.md §3.1, §3.4) and the stable id (docs/COMMENTS-PLAN.md §3.1).
  const branch = parseBranchFields(rawTop);
  for (const message of branch.diagnostics) diagnostics.push({ message });
  const anchors = new Map<string, Anchor>();
  // Read the raw object (not a zod record) so odd keys like "__proto__" are reported, not silently dropped.
  const entries = Object.entries((raw as { anchors: Record<string, unknown> }).anchors);
  if (entries.length > LIMITS.anchors) diagnostics.push({ message: `only the first ${LIMITS.anchors} of ${entries.length} anchors are used` });
  let baseSideOld = false;
  for (const [id, value] of entries.slice(0, LIMITS.anchors)) {
    const idOk = anchorIdSchema.safeParse(id);
    if (!idOk.success) {
      diagnostics.push({ anchor: id.slice(0, 64), message: describe(idOk.error) });
      continue;
    }
    const spec = parseAnchorSpec(value);
    if (!spec.ok) {
      diagnostics.push({ anchor: id, message: spec.error });
      continue;
    }
    if (spec.spec.side === 'base' && branch.base === undefined) {
      // The old side of what? Without a base there is no merge-base to read it at (§3.4).
      diagnostics.push({ anchor: id, message: 'side "base" needs a valid top-level "base" (the branch the change is compared with); anchor skipped' });
      continue;
    }
    if (spec.spec.side === 'base' && version < 3) baseSideOld = true;
    if (spec.warning) diagnostics.push({ anchor: id, message: spec.warning });
    const { file, range, quote, snippet, highlight, side } = spec.spec;
    anchors.set(id, { id, ...spec.spec, parts: [{ file, range, quote, snippet, highlight, ...(side ? { side } : {}) }] });
  }
  // Older releases would read base-side code from the working tree: such manifests must say version 3 (§3.5).
  if (baseSideOld) diagnostics.push({ message: `anchors with side "base" need "version": 3 (this manifest says ${version}); older releases would show them at the wrong place` });
  return {
    ok: true,
    diagnostics,
    manifest: {
      version: version as 1 | 2 | 3,
      title: top.data.title,
      summary: top.data.summary,
      commit: top.data.commit,
      ...(branch.id !== undefined ? { id: branch.id } : {}),
      ...(branch.base !== undefined ? { base: branch.base } : {}),
      ...(branch.head !== undefined ? { head: branch.head } : {}),
      ...(branch.trivialFiles !== undefined ? { trivialFiles: branch.trivialFiles } : {}),
      ...(group.value !== undefined ? { group: group.value } : {}),
      ...(isTop !== undefined ? { top: isTop } : {}),
      anchors,
      raw: raw as Record<string, unknown>,
    },
  };
}

/**
 * `id`, `base`, `head` and `trivialFiles`, each read leniently (§3.4): a bad value is dropped with a diagnostic and
 * the sidestory still loads (a bad `base` makes it a plain file story). `head` and `trivialFiles` need `base`.
 */
export function parseBranchFields(raw: Record<string, unknown>): { id?: string; base?: string; head?: string; trivialFiles?: string[]; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const out: { id?: string; base?: string; head?: string; trivialFiles?: string[]; diagnostics: string[] } = { diagnostics };
  if (raw.id !== undefined) {
    if (typeof raw.id === 'string' && ULID.test(raw.id)) out.id = raw.id;
    else diagnostics.push('id: must be a ULID (26 characters, digits and capital letters); ignored');
  }
  if (raw.base !== undefined) {
    if (typeof raw.base === 'string' && isValidBase(raw.base)) out.base = raw.base;
    else diagnostics.push('base: must be a branch or tag name (like main or origin/main) or a full commit id; ignored, so this is a plain file story');
  }
  if (raw.head !== undefined) {
    if (typeof raw.head !== 'string' || !FULL_SHA.test(raw.head)) diagnostics.push('head: must be a full commit id (40 or 64 lowercase hex digits); ignored');
    else if (out.base === undefined) diagnostics.push('head: needs a valid "base"; ignored');
    else out.head = raw.head;
  }
  if (raw.trivialFiles !== undefined) {
    if (!Array.isArray(raw.trivialFiles)) diagnostics.push('trivialFiles: must be a list of file patterns; ignored');
    else if (out.base === undefined) diagnostics.push('trivialFiles: needs a valid "base"; ignored');
    else {
      const list: string[] = [];
      for (const [i, p] of raw.trivialFiles.entries()) {
        if (i >= LIMITS.trivialFiles) {
          diagnostics.push(`trivialFiles: only the first ${LIMITS.trivialFiles} patterns are used`);
          break;
        }
        if (typeof p === 'string' && isValidTrivialGlob(p)) list.push(p);
        else diagnostics.push(`trivialFiles: pattern ${i + 1} isn't a repo-relative glob (*, ** and ? only, no ".." or leading "/", at most ${LIMITS.trivialFileChars} characters); dropped`);
      }
      out.trivialFiles = list;
    }
  }
  return out;
}

/** A manifest's `group`: a string, trimmed, 1–60 characters, no control characters. */
export function parseGroup(v: unknown): { value?: string; error?: string } {
  if (v === undefined) return {};
  if (typeof v !== 'string') return { error: 'must be a string' };
  const value = v.trim();
  if (!value) return { error: 'is empty' };
  if (value.length > LIMITS.groupChars) return { error: `is longer than ${LIMITS.groupChars} characters` };
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) return { error: 'contains control characters' };
  return { value };
}

function describe(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid';
  const where = issue.path.map(String).join(' › ');
  return where ? `${where}: ${issue.message}` : issue.message;
}
