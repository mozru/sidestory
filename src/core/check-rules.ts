// The checker's rules, set by the repository (docs/GUIDE.md "Checker rules"): how serious each finding is, and where
// it doesn't apply. Four levels, the narrowest winning:
//
//   global      .sidestory/checks.json        { "rules": { "anchor-stale": "error", "no-fallback": "off" } }
//   sidestory   its manifest.json             { "checks": { "box-unlinked": "off" }, … }
//   step        an anchor in the manifest     "refill": { …, "checks": { "anchor-changed": "off" } }
//   element     the page                      <g data-explain-ignore="box-unlinked: legend, not code">
//
// A level is "error", "warning", "info" or "off". An element's exception only turns rules off, needs a reason, and is
// reported when it no longer silences anything. Safety rules can't be turned down at any level. Pure: no node or
// vscode imports, so the CLI checker and the extension share it.

export type Severity = 'error' | 'warning' | 'info';
export type Level = Severity | 'off';

const LEVELS = new Set<Level>(['error', 'warning', 'info', 'off']);
const RANK: Record<Level, number> = { error: 3, warning: 2, info: 1, off: 0 };

/**
 * Rules that guard the reader or their machine, not the page's quality: a code link to a secret-looking file, code
 * outside the repository, pinning code widgets may read without the reader's go-ahead. No level lowers them.
 */
export const LOCKED_RULES: ReadonlySet<string> = new Set(['code-link-secret', 'secret-file', 'outside-folder', 'pin-needs-consent', 'bad-specifier', 'dynamic-import']);

/**
 * Errors that mean the page or a widget doesn't load (a manifest VS Code rejects, a widget that doesn't compile): a
 * passing check must mean the page works, so these can be raised but not lowered either.
 */
export const LOAD_RULES: ReadonlySet<string> = new Set([
  'manifest', 'not-found', 'unsupported-version', 'too-large', 'no-src', 'nested-widget',
  'syntax', 'unknown-import', 'unknown-export', 'unavailable-import', 'no-default-export', 'bad-extension', 'invalid-json', 'top-level-await', 'too-many-files', 'too-complex', 'internal',
]);

/** The rules' own findings (a bad checks.json, an exception without a reason): no rule changes them. */
export const RULE_FINDINGS: ReadonlySet<string> = new Set(['checks-json', 'ignore-syntax', 'ignore-no-reason', 'rule-locked', 'unused-ignore']);

/** The step-level rules: the findings about a step's code. */
export const STEP_RULES: ReadonlySet<string> = new Set(['anchor-lost', 'anchor-stale', 'anchor-changed', 'anchor-unchecked']);

/** Why a rule can't be turned down, for the message; undefined when it can. */
export function lockedWhy(code: string): string | undefined {
  if (LOCKED_RULES.has(code)) return "guards the reader's safety";
  if (LOAD_RULES.has(code)) return "means the page or a widget doesn't load";
  if (RULE_FINDINGS.has(code)) return 'reports a mistake in the rules themselves';
  return undefined;
}

/** A rule code: lowercase words joined by hyphens (`anchor-stale`). */
const RULE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
/** Rules at one level, by code. */
export type Levels = ReadonlyMap<string, Level>;

/** A `{ "<rule>": "<level>" }` object, checked: bad entries are reported, not applied. */
export function parseLevels(raw: unknown): { levels: Map<string, Level>; problems: string[] } {
  const levels = new Map<string, Level>();
  const problems: string[] = [];
  if (raw === undefined) return { levels, problems };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { levels, problems: ['must be an object of rules, like { "anchor-stale": "error" }'] };
  for (const [code, level] of Object.entries(raw as Record<string, unknown>)) {
    if (!RULE.test(code)) problems.push(`"${code.slice(0, 60)}" isn't a rule name (lowercase words joined by "-", as the checker prints them)`);
    else if (typeof level !== 'string' || !LEVELS.has(level as Level)) problems.push(`"${code}" must be "error", "warning", "info" or "off"`);
    else levels.set(code, level as Level);
  }
  return { levels, problems };
}

/**
 * `.sidestory/checks.json`: `{ "rules": { … }, "coverage": { "minimum": 90 } }`. `coverageMinimum`: the share of a
 * branch's changes (0–100) that must be explained or marked trivial for coverage to pass.
 */
export function parseChecksFile(text: string): { levels: Map<string, Level>; coverageMinimum?: number; problems: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    return { levels: new Map(), problems: [`isn't valid JSON: ${(e as Error).message}`] };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { levels: new Map(), problems: ['must be an object with "rules"'] };
  const { rules, coverage, ...rest } = raw as Record<string, unknown>;
  const r: { levels: Map<string, Level>; coverageMinimum?: number; problems: string[] } = parseLevels(rules);
  for (const k of Object.keys(rest)) r.problems.push(`"${k.slice(0, 60)}" isn't a known key (only "rules" and "coverage")`);
  if (coverage !== undefined) {
    const { minimum, ...extra } = (coverage && typeof coverage === 'object' && !Array.isArray(coverage) ? coverage : {}) as Record<string, unknown>;
    if (typeof minimum === 'number' && Number.isFinite(minimum) && minimum >= 0 && minimum <= 100) r.coverageMinimum = minimum;
    else r.problems.push('"coverage" must be { "minimum": <a percentage from 0 to 100> }');
    for (const k of Object.keys(extra)) r.problems.push(`"coverage.${k.slice(0, 60)}" isn't a known key (only "minimum")`);
  }
  return r;
}

/** The manifest's own levels and its anchors', from the manifest's text (bad entries reported, not applied). */
export function manifestLevels(text: string): { sidestory: Map<string, Level>; anchors: Map<string, Map<string, Level>>; problems: string[] } {
  const out = { sidestory: new Map<string, Level>(), anchors: new Map<string, Map<string, Level>>(), problems: [] as string[] };
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return out; // the manifest check reports it
  }
  if (!raw || typeof raw !== 'object') return out;
  const m = raw as { checks?: unknown; anchors?: unknown };
  const top = parseLevels(m.checks);
  out.sidestory = top.levels;
  out.problems.push(...top.problems.map((p) => `"checks": ${p}`));
  if (m.anchors && typeof m.anchors === 'object' && !Array.isArray(m.anchors)) {
    for (const [id, a] of Object.entries(m.anchors as Record<string, unknown>)) {
      if (!a || typeof a !== 'object' || !Object.hasOwn(a, 'checks')) continue;
      const r = parseLevels((a as { checks?: unknown }).checks);
      for (const code of [...r.levels.keys()]) {
        if (STEP_RULES.has(code)) continue;
        r.levels.delete(code);
        r.problems.push(`"${code}" can't be set for one step (a step's "checks" takes ${[...STEP_RULES].join(', ')}); set it for the sidestory or in .sidestory/checks.json`);
      }
      out.anchors.set(id, r.levels);
      out.problems.push(...r.problems.map((p) => `anchor "${id.slice(0, 60)}" "checks": ${p}`));
    }
  }
  return out;
}

/** `data-explain-ignore="rule another-rule: why"`: the rules, and the reason after the colon. */
export function parseIgnore(value: string): { codes: string[]; reason: string; bad: string[] } {
  const colon = value.indexOf(':');
  const head = colon < 0 ? value : value.slice(0, colon);
  const reason = colon < 0 ? '' : value.slice(colon + 1).trim().slice(0, 200);
  const words = head.split(/[\s,]+/).filter(Boolean);
  return { codes: words.filter((w) => RULE.test(w)), reason, bad: words.filter((w) => !RULE.test(w)) };
}

/** An element's exception in the page: its rules, its reason, and where it is (lines, and offsets in the page). */
export interface Ignore {
  codes: string[];
  reason: string;
  line: number;
  endLine: number;
  /** The element's start and end in the page's text: findings that know their element are matched by these. */
  start?: number;
  end?: number;
}

export interface RuleFinding {
  severity: Severity;
  file: string;
  line?: number;
  code: string;
  message: string;
  /** The anchor (step) the finding is about, for its step's levels. */
  anchor?: string;
  /** Where in the page the element it is about starts: an exception then covers it only when it is inside. */
  offset?: number;
}

export interface RuleContext {
  global: Levels;
  sidestory: Levels;
  anchors: ReadonlyMap<string, Levels>;
  ignores: readonly Ignore[];
  /** The page's file, where element exceptions apply. */
  htmlFile: string;
}

/** What applying the rules did: the findings left, those turned off (with why), and the exceptions that did nothing. */
export interface Applied<F extends RuleFinding> {
  findings: F[];
  off: { code: string; reason: string }[];
  unusedIgnores: Ignore[];
  /** Rules a level tried to lower that can't be lowered. */
  locked: { code: string; where: string }[];
}

/** The level for a finding, the narrowest set level winning, and which level set it (undefined: the checker's own). */
function levelFor<F extends RuleFinding>(f: F, ctx: RuleContext): { level: Level; where: string } | undefined {
  const step = f.anchor !== undefined ? ctx.anchors.get(f.anchor)?.get(f.code) : undefined;
  if (step) return { level: step, where: `anchor "${f.anchor}"` };
  const s = ctx.sidestory.get(f.code);
  if (s) return { level: s, where: 'manifest.json' };
  const g = ctx.global.get(f.code);
  if (g) return { level: g, where: '.sidestory/checks.json' };
  return undefined;
}

/** Levels that try to turn a locked rule off, wherever they are, so the mistake shows even when nothing fires. */
export function lockedLevels(levels: Levels): { code: string; why: string }[] {
  const out: { code: string; why: string }[] = [];
  for (const [code, level] of levels) {
    const why = lockedWhy(code);
    if (why && (level === 'off' || (LOAD_RULES.has(code) && level !== 'error'))) out.push({ code, why });
  }
  return out;
}

/** The severity a finding shows with under the repository's and the sidestory's levels (for VS Code's Problems panel); undefined: off. */
export function severityFor(code: string, severity: Severity, levels: { global: Levels; sidestory: Levels }): Severity | undefined {
  const set = levels.sidestory.get(code) ?? levels.global.get(code);
  if (!set) return severity;
  if (lockedWhy(code) && RANK[set] < RANK[severity]) return severity;
  return set === 'off' ? undefined : set;
}

/** Applies the levels and the page's exceptions to a check's findings. */
export function applyRules<F extends RuleFinding>(findings: readonly F[], ctx: RuleContext): Applied<F> {
  const out: Applied<F> = { findings: [], off: [], unusedIgnores: [], locked: [] };
  const used = new Set<Ignore>();
  for (const f of findings) {
    const locked = lockedWhy(f.code) !== undefined;
    if (RULE_FINDINGS.has(f.code)) {
      out.findings.push(f);
      continue;
    }
    // By element when the finding knows its element (a page may put a whole diagram on one line), else by line.
    const inside = (i: Ignore) => (f.offset !== undefined && i.start !== undefined && i.end !== undefined ? f.offset >= i.start && f.offset < i.end : f.line! >= i.line && f.line! <= i.endLine);
    const around = f.file === ctx.htmlFile && f.line !== undefined ? ctx.ignores.filter((i) => i.codes.includes(f.code) && inside(i)) : [];
    for (const i of around) used.add(i);
    const ignore = around[0];
    if (ignore) {
      if (locked) out.locked.push({ code: f.code, where: `data-explain-ignore at line ${ignore.line}` });
      else {
        out.off.push({ code: f.code, reason: ignore.reason || 'no reason given' });
        continue;
      }
    }
    const set = levelFor(f, ctx);
    if (!set) {
      out.findings.push(f);
      continue;
    }
    if (locked && RANK[set.level] < RANK[f.severity]) {
      out.locked.push({ code: f.code, where: set.where });
      out.findings.push(f);
      continue;
    }
    if (set.level === 'off') {
      out.off.push({ code: f.code, reason: `off in ${set.where}` });
      continue;
    }
    out.findings.push(set.level === f.severity ? f : { ...f, severity: set.level });
  }
  out.unusedIgnores = ctx.ignores.filter((i) => !used.has(i));
  return out;
}
