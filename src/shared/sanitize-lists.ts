// Elements the panel's sanitizer (src/webview/sanitize.ts) removes with everything inside them.
// `discard` deletes elements, which would take linked sections and code links with them.
export const DROPPED_ELEMENTS = [
  'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'meta', 'base', 'noscript', 'template', 'portal', 'form',
  'discard',
] as const;

// SVG animation elements the sanitizer keeps unless one would change a URL, an event handler or a panel attribute
// (it removes those, with their contents).
export const SVG_ANIMATION_ELEMENTS = ['animate', 'set', 'animateMotion', 'animateTransform'] as const;

// Elements whose contents the panel never shows: dropped, or SVG animation (which renders no children). Shared with
// the outline scanner (src/core/html-scan.ts) and coverage, so the steps the index lists match the steps the panel shows.
export const UNSHOWN_ELEMENTS = [...DROPPED_ELEMENTS, ...SVG_ANIMATION_ELEMENTS] as const;
