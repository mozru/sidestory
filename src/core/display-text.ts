// Repository text shown in VS Code's own UI (docs/NAVIGATION-PLAN.md §11.4): titles, summaries, step titles,
// blurbs, group names and folder names are untrusted and may be crafted to mislead. They are cleaned once,
// when stored (`displayText`), and escaped for each surface when shown (`escapeIcons`, `plainForMessage`).

/**
 * Characters removed outright: C0 and C1 controls, U+2028/U+2029, bidirectional marks, overrides and
 * isolates, invisible characters, and tag characters. Lone surrogates are removed separately.
 */
const REMOVE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u00ad\u200b-\u200d\u2060-\u2064\ufeff]|\udb40[\udc00-\udc7f]/g;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
/** What `REMOVE` matches between words: it becomes a space, so "a\nb" doesn't read as "ab". */
const BREAKS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/**
 * Repository text made safe to show as plain text: no control, bidirectional, invisible or tag characters,
 * no lone surrogates, whitespace collapsed, and at most `max` characters (cut with "…", never inside a
 * surrogate pair).
 */
export function displayText(s: string, max: number): string {
  const clean = s.replace(BREAKS, ' ').replace(REMOVE, '').replace(LONE_SURROGATE, '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  let cut = Math.max(0, max - 1);
  // Never split a surrogate pair: back off from a high surrogate left at the end.
  const c = clean.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut--;
  return `${clean.slice(0, cut).trimEnd()}…`;
}

/**
 * Repository text as one terminal line, not cut or trimmed: line breaks and tabs become a space, and everything
 * `displayText` removes (other controls, escape sequences' ESC and CSI, bidirectional and invisible characters,
 * lone surrogates) is dropped.
 */
export function plainLine(s: string): string {
  return s.replace(/[\t\n\r\v\f\u2028\u2029]+/g, ' ').replace(REMOVE, '').replace(LONE_SURROGATE, '');
}

/** For surfaces that render `$(icon)` syntax (quick picks, the status bar, CodeLens titles): shown literally. */
export function escapeIcons(s: string): string {
  return s.replace(/\$\(/g, '\\$(');
}

/**
 * For notifications, which render `[text](link)`, `command:` links included: the text cleaned, then link
 * syntax broken so nothing in it can become a link.
 */
export function plainForMessage(s: string, max = 300): string {
  return displayText(s, max).replace(/\]\(/g, '] (');
}

/** Cuts a blurb at the first sentence end within `max` characters, else at `max` (with "…"). */
export function firstSentence(s: string, max: number): string {
  const text = displayText(s, Number.MAX_SAFE_INTEGER);
  const end = /[.!?](?=\s|$)/g;
  let m: RegExpExecArray | null;
  while ((m = end.exec(text)) && m.index < max) {
    if (m.index >= 20 || m.index + 1 === text.length) return text.slice(0, m.index + 1);
  }
  return displayText(text, max);
}

/** Middle-truncates to `max` characters: "Stream DMA engine › … › step 3". */
export function middleTruncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  let a = s.slice(0, head);
  let b = s.slice(s.length - tail);
  const hc = a.charCodeAt(a.length - 1);
  if (hc >= 0xd800 && hc <= 0xdbff) a = a.slice(0, -1);
  const tc = b.charCodeAt(0);
  if (tc >= 0xdc00 && tc <= 0xdfff) b = b.slice(1);
  return `${a}…${b}`;
}
