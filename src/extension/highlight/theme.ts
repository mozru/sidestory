// The reader's color theme, as token colors for the highlighter (docs/HIGHLIGHT-PLAN.md §3). Pure: files
// are read through an injected reader, so this is unit-tested without VS Code.
import { createHash } from 'node:crypto';
import { parse, type ParseError } from 'jsonc-parser';
import { HEX_COLOR } from '../../shared/highlight-languages.ts';

export type ThemeKind = 'dark' | 'light' | 'hc-dark' | 'hc-light';

/** A TextMate theme rule, validated: scopes are strings, colors hex, font style known words. */
export interface ThemeRule {
  scope?: string | string[];
  settings: { foreground?: string; fontStyle?: string };
}

/** What the worker needs: the rules in order, the default foreground, and a key that changes with any of it. */
export interface HighlightTheme {
  key: string;
  /** For logs only. */
  name: string;
  type: 'dark' | 'light';
  fg: string;
  bg: string;
  rules: ThemeRule[];
}

export const MAX_THEME_FILE = 2 * 1024 * 1024;
export const MAX_THEME_CHAIN = 4 * 1024 * 1024;
export const MAX_INCLUDE_DEPTH = 8;
export const MAX_CUSTOM_RULES = 1_000;
const MAX_SCOPE = 1_000;
const MAX_RULES = 5_000;

/**
 * Reads files of one theme extension. `read` returns the text of a URI (a string; `file:` and other schemes) or
 * undefined; `inside` says whether a URI's real file is inside the extension folder (symlinks followed).
 */
export interface ThemeReader {
  read(uri: string): Promise<string | undefined>;
  inside(uri: string, root: string): Promise<boolean>;
}

interface RawTheme {
  type?: string;
  colors: Record<string, unknown>;
  tokenColors: unknown[];
}

/** `uri` joined to `rel`, if the result stays inside `root` (lexically; the reader checks real paths). */
export function resolveInside(rel: string, base: string, root: string): string | undefined {
  if (typeof rel !== 'string' || rel === '' || /^[a-z][a-z0-9+.-]*:/i.test(rel) || rel.startsWith('/') || rel.startsWith('\\') || rel.includes('\\') || rel.includes('\0') || rel.includes('%')) return undefined;
  let url: URL;
  try {
    url = new URL(rel, base);
  } catch {
    return undefined;
  }
  const r = root.endsWith('/') ? root : `${root}/`;
  return url.href.startsWith(r) && !url.search && !url.hash ? url.href : undefined;
}

/**
 * Loads a theme file and everything it includes (included rules first, the including file's colors win), within
 * the extension folder `root`. Undefined when anything is missing, unreadable, too large, cyclic or outside.
 */
export async function loadThemeChain(uri: string, root: string, reader: ThemeReader): Promise<RawTheme | undefined> {
  let total = 0;
  const seen = new Set<string>();
  const readJson = async (u: string): Promise<unknown> => {
    if (seen.has(u) || seen.size > MAX_INCLUDE_DEPTH) return undefined;
    seen.add(u);
    if (!u.toLowerCase().endsWith('.json') || !(await reader.inside(u, root))) return undefined;
    const text = await reader.read(u);
    if (text === undefined || text.length > MAX_THEME_FILE) return undefined;
    total += text.length;
    if (total > MAX_THEME_CHAIN) return undefined;
    const errors: ParseError[] = [];
    const json: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
    return errors.length || !json || typeof json !== 'object' || Array.isArray(json) ? undefined : json;
  };
  const load = async (u: string, depth: number): Promise<RawTheme | undefined> => {
    if (depth > MAX_INCLUDE_DEPTH) return undefined;
    const json = (await readJson(u)) as Record<string, unknown> | undefined;
    if (!json) return undefined;
    let out: RawTheme = { colors: {}, tokenColors: [] };
    if (json.include !== undefined) {
      const inc = typeof json.include === 'string' ? resolveInside(json.include, u, root) : undefined;
      const base = inc ? await load(inc, depth + 1) : undefined;
      if (!base) return undefined;
      out = base;
    }
    if (typeof json.type === 'string') out.type = json.type;
    if (json.colors && typeof json.colors === 'object' && !Array.isArray(json.colors)) out.colors = { ...out.colors, ...(json.colors as Record<string, unknown>) };
    // `settings` is the old name of tokenColors (tmTheme-style JSON), where a rule without a scope sets the editor's
    // foreground (as VS Code converts it).
    if (Array.isArray(json.settings) && json.tokenColors === undefined) {
      const global = (json.settings as { scope?: unknown; settings?: { foreground?: unknown } }[]).find((r) => r && r.scope === undefined && r.settings?.foreground);
      if (global && out.colors['editor.foreground'] === undefined) out.colors = { ...out.colors, 'editor.foreground': global.settings!.foreground };
    }
    let tc = json.tokenColors ?? json.settings;
    if (typeof tc === 'string') {
      const target = resolveInside(tc, u, root);
      const file = target ? ((await readJson(target)) as Record<string, unknown> | undefined) : undefined;
      tc = file?.tokenColors ?? file?.settings;
      if (!Array.isArray(tc)) return undefined; // a .tmTheme (plist) file, or nothing usable
    }
    if (tc !== undefined) {
      if (!Array.isArray(tc)) return undefined;
      out.tokenColors = [...out.tokenColors, ...tc];
    }
    return out;
  };
  return load(uri, 0);
}

const FONT_WORDS = new Set(['italic', 'bold', 'underline', 'strikethrough']);

/** A color VS Code accepts in a theme, as lower-case hex; anything else is dropped. */
function hex(v: unknown): string | undefined {
  return typeof v === 'string' && HEX_COLOR.test(v.trim()) ? v.trim().toLowerCase() : undefined;
}

function fontStyle(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  // Any string sets the style: the words known, and none for the rest ("normal", "" reset inherited styles).
  return v.trim().split(/\s+/).filter((w) => FONT_WORDS.has(w)).join(' ');
}

function scopes(v: unknown): string | string[] | undefined | null {
  if (v === undefined) return undefined;
  if (typeof v === 'string') return v.length <= MAX_SCOPE ? v : null;
  if (Array.isArray(v) && v.length <= 200 && v.every((s) => typeof s === 'string' && s.length <= MAX_SCOPE)) return v as string[];
  return null;
}

/** One validated rule, or undefined. */
export function rule(v: unknown): ThemeRule | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as { scope?: unknown; settings?: unknown };
  const scope = scopes(r.scope);
  // Rules without a scope are ignored, as VS Code does (the default color is editor.foreground).
  if (scope === null || scope === undefined || !r.settings || typeof r.settings !== 'object') return undefined;
  const s = r.settings as { foreground?: unknown; fontStyle?: unknown };
  const settings: ThemeRule['settings'] = {};
  const fg = hex(s.foreground);
  if (fg) settings.foreground = fg;
  const fs = fontStyle(s.fontStyle);
  if (fs !== undefined) settings.fontStyle = fs;
  if (settings.foreground === undefined && settings.fontStyle === undefined) return undefined;
  return { scope, settings };
}

/** VS Code's scopes for the simple keys of `editor.tokenColorCustomizations`. */
const TOKEN_GROUPS: Record<string, string[]> = {
  comments: ['comment', 'punctuation.definition.comment'],
  strings: ['string', 'meta.embedded.assembly'],
  keywords: ['keyword - keyword.operator', 'keyword.control', 'storage', 'storage.type'],
  numbers: ['constant.numeric'],
  types: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'],
  functions: ['entity.name.function', 'support.function'],
  variables: ['variable', 'entity.name.variable'],
};

/**
 * Whether a `[A][B]` key of a theme-specific setting names this theme, as VS Code matches it: a name may start
 * and/or end with `*` (a prefix, suffix or substring match); otherwise it must equal the settings id. Linear work:
 * the key can come from a repository's settings.
 */
export function themeKeyMatches(key: string, settingsId: string): boolean {
  if (key.length > 256 || !/^\s*(?:\[[^\]]+\]\s*)+$/.test(key)) return false;
  return [...key.matchAll(/\[([^\]]+)\]/g)].some(([, n]) => {
    const name = n!;
    const head = name.startsWith('*');
    const tail = name.length > 1 && name.endsWith('*');
    const core = name.slice(head ? 1 : 0, tail ? -1 : undefined);
    if (head && tail) return settingsId.includes(core);
    if (head) return settingsId.endsWith(core);
    if (tail) return settingsId.startsWith(core);
    return name === settingsId;
  });
}

/** Rules from one level of `editor.tokenColorCustomizations` (global or one theme's). */
function customRules(v: unknown): ThemeRule[] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return [];
  const o = v as Record<string, unknown>;
  const out: ThemeRule[] = [];
  for (const [k, scopesForKey] of Object.entries(TOKEN_GROUPS)) {
    const val = o[k];
    const settings = typeof val === 'string' ? { foreground: val } : val && typeof val === 'object' ? val : undefined;
    const r = settings ? rule({ scope: scopesForKey, settings }) : undefined;
    if (r) out.push(r);
  }
  if (Array.isArray(o.textMateRules)) {
    for (const t of o.textMateRules.slice(0, MAX_CUSTOM_RULES)) {
      const r = rule(t);
      if (r) out.push(r);
    }
  }
  return out;
}

/** The user's `editor.tokenColorCustomizations` for this theme: global rules, then the theme-specific ones. */
export function customizationRules(setting: unknown, settingsId: string): ThemeRule[] {
  if (!setting || typeof setting !== 'object' || Array.isArray(setting)) return [];
  const out = customRules(setting);
  for (const [k, v] of Object.entries(setting as Record<string, unknown>)) {
    if (k.startsWith('[') && themeKeyMatches(k, settingsId)) out.push(...customRules(v));
  }
  return out.slice(0, MAX_CUSTOM_RULES * 2);
}

/** VS Code's own default editor foreground and background by kind, when a theme doesn't set them. */
const DEFAULTS: Record<ThemeKind, { fg: string; bg: string }> = {
  dark: { fg: '#bbbbbb', bg: '#1e1e1e' },
  light: { fg: '#333333', bg: '#fffffe' },
  'hc-dark': { fg: '#ffffff', bg: '#000000' },
  'hc-light': { fg: '#292929', bg: '#ffffff' },
};

/** The validated theme the worker gets, keyed by a hash of its content. */
export function normalizeTheme(raw: RawTheme, kind: ThemeKind, name: string, extraRules: ThemeRule[] = []): HighlightTheme {
  const rules: ThemeRule[] = [];
  for (const t of raw.tokenColors) {
    if (rules.length >= MAX_RULES) break;
    const r = rule(t);
    if (r) rules.push(r);
  }
  rules.push(...extraRules);
  const fg = hex(raw.colors['editor.foreground']) ?? DEFAULTS[kind].fg;
  const bg = hex(raw.colors['editor.background']) ?? DEFAULTS[kind].bg;
  const type = kind === 'light' || kind === 'hc-light' ? 'light' : 'dark';
  const body = { type, fg, bg, rules } as const;
  const key = createHash('sha256').update(JSON.stringify(body)).digest('base64url').slice(0, 16);
  return { key, name, ...body };
}

/** The `uiTheme` a contribution must have to be the active theme of this kind. */
export const UI_THEME: Record<ThemeKind, string> = { dark: 'vs-dark', light: 'vs', 'hc-dark': 'hc-black', 'hc-light': 'hc-light' };

/** Old setting values VS Code still accepts (its own migration); `default` means the kind's default theme. */
const MIGRATED: Record<string, string> = {
  'Default Dark Modern': 'Dark Modern',
  'Default Light Modern': 'Light Modern',
  'Default Dark+': 'Dark+',
  'Default Light+': 'Light+',
  'Experimental Dark': 'default',
  'VS Code Dark': 'default',
  'Experimental Light': 'default',
  'VS Code Light': 'default',
};

export interface ThemeSettings {
  colorTheme?: unknown;
  preferredDark?: unknown;
  preferredLight?: unknown;
  preferredHighContrast?: unknown;
  preferredHighContrastLight?: unknown;
  autoDetectColorScheme?: unknown;
  autoDetectHighContrast?: unknown;
  /** The default theme for this kind (the preferred-theme setting's own default). */
  kindDefault: string;
}

/**
 * The theme names that may be active, most likely first, the way VS Code chooses: the preferred theme for the kind
 * when the matching auto-detect setting is on, then `workbench.colorTheme`, then the kind's default.
 */
export function candidateThemes(kind: ThemeKind, s: ThemeSettings): string[] {
  const names: unknown[] = [];
  // A high-contrast theme chosen by hand is in colorTheme; the preferred one applies when the OS asks for high
  // contrast, and then colorTheme is usually a theme of another kind, which the uiTheme check skips.
  if (kind === 'hc-dark' || kind === 'hc-light') {
    names.push(s.colorTheme);
    if (s.autoDetectHighContrast !== false) names.push(kind === 'hc-dark' ? s.preferredHighContrast : s.preferredHighContrastLight);
  } else {
    if (s.autoDetectColorScheme === true) names.push(kind === 'dark' ? s.preferredDark : s.preferredLight);
    names.push(s.colorTheme);
  }
  names.push(s.kindDefault);
  const out: string[] = [];
  for (const n of names) {
    if (typeof n !== 'string' || !n) continue;
    const m = MIGRATED[n];
    const name = m === 'default' ? s.kindDefault : (m ?? n);
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

export interface ThemeContribution {
  /** The settings id (`id`, else `label`). */
  id: string;
  label?: string;
  uiTheme?: string;
  /** Absolute URI of the theme file, and of its extension folder. */
  uri: string;
  root: string;
}

/** The contribution a theme name refers to, for this kind: by `id` first, then by `label`; the uiTheme must match. */
export function findContribution(name: string, kind: ThemeKind, all: ThemeContribution[]): ThemeContribution | undefined {
  const fits = (c: ThemeContribution) => c.uiTheme === UI_THEME[kind];
  return all.find((c) => c.id === name && fits(c)) ?? all.find((c) => c.label === name && fits(c));
}
