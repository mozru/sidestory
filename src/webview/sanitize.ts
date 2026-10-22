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
 */
export function rewriteCss(css: string, baseUrl: string, from: string = baseUrl): string {
  if (css.length > MAX_CSS) return '';
  return (
    css
      // Undo hex escapes of ASCII letters and punctuation (e.g. \75 rl( is url( ), so they can't hide
      // url( or @import from the rules below. Letters never need escaping, so nothing legitimate changes.
      .replace(/\\0{0,4}(4[0-9a-f]|5[0-9a]|6[0-9a-f]|7[0-9a]|28|29|40)\s?/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/@import[^;]*;?/gi, '')
      // image-set() and image() take bare strings as URLs; make them invalid rather than parse them.
      .replace(/(-webkit-)?image(-set)?\(/gi, 'cx-blocked(')
      // Linear-time: each alternative stops at its own delimiter (no backtracking over the input).
      .replace(/url\(\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^)'"\s]*))\s*\)/gi, (_, d?: string, s?: string, b?: string) => {
      const u = d ?? s ?? b ?? '';
      const fixed = u.startsWith('#') ? u : resolveLocal(u, baseUrl, from);
      return fixed ? `url("${fixed.replace(/["\\]/g, '\\$&')}")` : 'none';
    })
  );
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
