// Elements the panel's sanitizer (src/webview/sanitize.ts) removes with everything inside them. Shared with the
// outline scanner (src/core/html-scan.ts), so the steps the index lists match the steps the panel shows.
// SVG animation elements can rewrite a sanitized attribute (such as href) after the fact.
export const DROPPED_ELEMENTS = [
  'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'meta', 'base', 'noscript', 'template', 'portal', 'form',
  'animate', 'set', 'animateMotion', 'animateTransform', 'discard',
] as const;
