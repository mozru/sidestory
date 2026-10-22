// Turns explainer HTML (untrusted repo content) into inert nodes for the shadow root.
// The CSP already blocks scripts and remote loads; this also removes anything that could
// navigate, embed or phone home, and rewrites relative URLs to the explainer folder.
// The result is handed over as nodes, never re-serialized and re-parsed (which invites mXSS).

// SVG animation elements can rewrite a sanitized attribute (such as href) after the fact.
const DROP = 'script, iframe, frame, frameset, object, embed, applet, meta, base, noscript, template, portal, form, animate, set, animateMotion, animateTransform, discard';
const URL_ATTRS = ['src', 'href', 'poster', 'srcset', 'xlink:href', 'action', 'formaction', 'background', 'data'];
/** Attributes that are dropped outright: popovers render in the top layer, above any containment. */
const DROP_ATTRS = new Set(['popover', 'popovertarget', 'popovertargetaction', 'ping']);
/** Elements whose `name` becomes a property of the document (DOM clobbering). */
const NAMED = new Set(['img', 'embed', 'object', 'form', 'iframe', 'frame', 'frameset']);
/** Elements whose href may point outside: a click opens the browser, nothing loads by itself. */
const LINKS = new Set(['a', 'area']);

export interface Sanitized {
  /** `<style>` and local `<link rel="stylesheet">` elements from anywhere in the page. */
  styles: Node[];
  body: Node[];
}

/** `importNode` adopts nodes into the target document (passed bound, so clobbered documents can't interfere). */
export function sanitize(html: string, baseUrl: string, importNode: (node: Node, deep: boolean) => Node = (n, deep) => document.importNode(n, deep)): Sanitized {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const el of doc.querySelectorAll(DROP)) el.remove();
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || DROP_ATTRS.has(name) || (name === 'name' && NAMED.has(el.localName))) el.removeAttribute(attr.name);
      else if (name === 'style') el.setAttribute('style', rewriteCss(attr.value, baseUrl));
      else if (URL_ATTRS.includes(name)) {
        const fixed = rewriteUrl(el.localName, name, attr.value, baseUrl);
        if (fixed === null) el.removeAttribute(attr.name);
        else el.setAttribute(attr.name, fixed);
      }
    }
  }
  const styles = [...doc.querySelectorAll('style, link')].map((el) => {
    el.remove();
    if (el.localName === 'style') el.textContent = rewriteCss(el.textContent ?? '', baseUrl);
    return el;
  });
  // Keep <style>, and stylesheet links whose URL survived the rewrite (local files only).
  const keep = styles.filter((el) => el.localName === 'style' || ((el.getAttribute('rel') ?? '').split(/\s+/).includes('stylesheet') && el.hasAttribute('href')));
  return {
    styles: keep.map((el) => importNode(el, true)),
    body: [...doc.body.childNodes].map((n) => importNode(n, true)),
  };
}

/**
 * Points `url()` references at the explainer folder (or nowhere) and drops `@import`.
 * Relative URLs resolve against `from` (a stylesheet's own URL), and must stay inside `baseUrl`.
 *
 * A small hand-written scanner rather than regular expressions: every step moves forward through
 * the text, so the time is linear whatever the input (regexes here kept turning out quadratic on
 * crafted input). Escapes outside strings are decoded first, so they can't hide `url(`, `@import`
 * or `image-set(` from the rules; the scanner then rewrites exactly the text the browser will parse.
 */
export function rewriteCss(css: string, baseUrl: string, from: string = baseUrl): string {
  if (css.length > MAX_CSS) return '';
  // As the CSS tokenizer does first: every newline form is \n (they all end strings), NUL is U+FFFD.
  const normalized = css.replace(/\r\n?|\f/g, '\n').replace(/\0/g, '\uFFFD');
  const decoded = decodeEscapesOutsideStrings(normalized);
  // Renamed, never deleted: deleting text after the scan could move string boundaries and expose a url().
  return rewriteUrlFunctions(decoded, baseUrl, from)
    .replace(/@import/gi, '@cx-blocked')
    // image-set(), image() and src() take bare strings as URLs; make them invalid rather than parse them.
    .replace(/(-webkit-)?image(-set)?\(|\bsrc\(/gi, 'cx-blocked(');
}

const isHex = (c: string) => /^[0-9a-f]$/i.test(c);

/**
 * Replaces CSS escapes outside strings with the characters they stand for. An escape that decodes to
 * a backslash, a quote, "/", "*" or a control character is dropped, so escapes can't be chained, open
 * strings or comments.
 * Comments are removed, so a quote inside one can't make the later passes see a string that isn't there.
 */
function decodeEscapesOutsideStrings(css: string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const c = css[i]!;
    if (c === '"' || c === "'") {
      // Copy a string verbatim, including its own escapes, up to the closing quote or line end.
      let j = i + 1;
      while (j < css.length && css[j] !== c && css[j] !== '\n') j += css[j] === '\\' ? 2 : 1;
      out += css.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 2;
      out += ' '; // not nothing: "/" + comment + "*" must not become the start of a new comment
      continue;
    }
    if (c !== '\\') {
      out += c;
      i++;
      continue;
    }
    const next = css[i + 1];
    if (next === undefined || next === '\n') {
      i += 2; // a stray backslash, or a line continuation: drop it
      continue;
    }
    let decoded: string;
    if (isHex(next)) {
      let j = i + 1;
      while (j < css.length && j < i + 7 && isHex(css[j]!)) j++;
      const code = parseInt(css.slice(i + 1, j), 16);
      if (/\s/.test(css[j] ?? '')) j++; // one whitespace ends a hex escape
      decoded = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : '';
      i = j;
    } else {
      decoded = next;
      i += 2;
    }
    // Nor may an escape become "/" or "*": the browser would read the output's "/*" as a comment.
    if (!/[\\"'/*\x00-\x1f\x7f]/.test(decoded)) out += decoded;
  }
  return out;
}

/** Rewrites every url(...) outside strings, in one forward pass. */
function rewriteUrlFunctions(css: string, baseUrl: string, from: string): string {
  let out = '';
  let i = 0;
  const ws = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
  while (i < css.length) {
    const c = css[i]!;
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== c && css[j] !== '\n') j += css[j] === '\\' ? 2 : 1;
      out += css.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const startsUrl = (c === 'u' || c === 'U') && css.slice(i, i + 4).toLowerCase() === 'url(' && !/[\w-]/.test(css[i - 1] ?? '');
    if (!startsUrl) {
      out += c;
      i++;
      continue;
    }
    // url( [ws] ( "string" | 'string' | bare ) [ws] )
    let j = i + 4;
    while (ws(css[j])) j++;
    let value = '';
    const q = css[j];
    if (q === '"' || q === "'") {
      let k = j + 1;
      while (k < css.length && css[k] !== q && css[k] !== '\n') k += css[k] === '\\' ? 2 : 1;
      value = css.slice(j + 1, k);
      j = k + 1;
    } else {
      let k = j;
      while (k < css.length && !ws(css[k]) && !'()"\'\\'.includes(css[k]!)) k++;
      value = css.slice(j, k);
      j = k;
    }
    while (ws(css[j])) j++;
    if (css[j] !== ')') {
      // Malformed: don't guess. Neutralize it and carry on after what we consumed.
      out += 'none';
      i = j;
      continue;
    }
    const fixed = value.startsWith('#') ? value : resolveLocal(value, baseUrl, from);
    out += fixed ? `url("${fixed.replace(/["\\]/g, '\\$&')}")` : 'none';
    i = j + 1;
  }
  return out;
}

/** Larger stylesheets are dropped: rewriting them would tie up the panel. */
const MAX_CSS = 500_000;

/** Resolves a URL attribute. Returns null for URLs that must not load. */
function rewriteUrl(tag: string, attr: string, value: string, baseUrl: string): string | null {
  const v = value.trim();
  if (attr === 'srcset') {
    const parts = v.split(',').map((p) => {
      const [u, ...rest] = p.trim().split(/\s+/);
      const fixed = u ? resolveLocal(u, baseUrl) : null;
      return fixed ? [fixed, ...rest].join(' ') : null;
    });
    return parts.every((p) => p !== null) ? parts.join(', ') : null;
  }
  if (v.startsWith('#')) return v; // in-page fragments, SVG <use href="#id">
  if (attr === 'href' && LINKS.has(tag) && /^(https?|mailto):/i.test(v)) return v;
  return resolveLocal(v, baseUrl);
}

/** A data: image, or a path that stays inside the explainer folder; anything else is refused. */
function resolveLocal(value: string, baseUrl: string, from: string = baseUrl): string | null {
  if (/^data:image\/(png|gif|jpe?g|webp);/i.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//') || value.startsWith('\\')) return null;
  try {
    const resolved = new URL(value, from);
    return resolved.href.startsWith(baseUrl) ? resolved.href : null;
  } catch {
    return null;
  }
}
