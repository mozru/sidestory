// Trusted Types policies: the only ways this panel turns strings into HTML. The panel's CSP requires
// Trusted Types (inherited by the content frame and widget frames), and lists exactly these names plus
// `default`, which belongs to widget frames: the panel must never create a `default` policy here.
// See docs/WIDGETS-PLAN.md §3.
import { WIDGET_BOOTSTRAP } from '../shared/widget-bootstrap.ts';

interface Policy {
  createHTML(s: string): TrustedHTML;
}
interface TrustedTypesFactory {
  createPolicy(name: string, rules: { createHTML: (s: string) => string }): Policy;
}
declare global {
  // eslint-disable-next-line no-var
  var trustedTypes: TrustedTypesFactory | undefined;
  type TrustedHTML = string & { readonly __trustedHTML: unique symbol };
}

// Without Trusted Types (tests in other engines), strings pass through unchanged.
const make = (name: string): Policy => globalThis.trustedTypes?.createPolicy(name, { createHTML: (s) => s }) ?? { createHTML: (s) => s as TrustedHTML };

const staticPolicy = make('cx-static');
const sanitizePolicy = make('cx-sanitize');

/**
 * A widget frame's whole document: its own stricter CSP (docs/WIDGETS-PLAN.md §5.4) and the bootstrap,
 * nothing else; everything a widget runs arrives later by message. A constant: the bootstrap's hash is
 * computed at build time (scripts/build.mjs), and the policy ignores its input.
 */
const WIDGET_CSP = `default-src 'none'; script-src '${__CX_BOOTSTRAP_HASH__}' 'strict-dynamic'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; require-trusted-types-for 'script'; trusted-types default`;
const WIDGET_DOC = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="x-dns-prefetch-control" content="off"><meta http-equiv="Content-Security-Policy" content="${WIDGET_CSP}"><script>${WIDGET_BOOTSTRAP}</script></head><body></body></html>`;
const widgetPolicy = globalThis.trustedTypes?.createPolicy('cx-widget', { createHTML: () => WIDGET_DOC }) ?? { createHTML: () => WIDGET_DOC as TrustedHTML };

/** The srcdoc of every widget frame (the only HTML the cx-widget policy makes). */
export function widgetSrcdoc(): TrustedHTML {
  return widgetPolicy.createHTML('');
}

/**
 * Markup written in this source code. A tagged template with no substitutions, so it can only ever be a
 * constant: `el.innerHTML = staticHtml\`<b>x</b>\``.
 */
export function staticHtml(strings: TemplateStringsArray, ...values: never[]): TrustedHTML {
  if (values.length || strings.length !== 1) throw new Error('staticHtml takes constant markup only');
  return staticPolicy.createHTML(strings[0]!);
}

/** Parses author HTML into an inert document (no scripts run while parsing); only the sanitizer calls this. */
export function parseInert(html: string): Document {
  return new DOMParser().parseFromString(sanitizePolicy.createHTML(html) as unknown as string, 'text/html');
}
