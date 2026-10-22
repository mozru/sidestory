// The contract between the widget compiler (extension host) and the widget runtime (inside widget frames):
// which import specifiers a widget may use, and which prebuilt library provides each.
// Library files live at dist/widget-libs/<id>.js. Each registers its modules on globalThis.__cxLibs under
// the exact specifiers listed here; the runtime's `require` looks them up there.
// See docs/WIDGETS-PLAN.md §2 and §3.

/** A prebuilt library: the file to send to a widget frame, and the specifiers it registers. */
export interface WidgetLibrary {
  id: string;
  specifiers: string[];
  /** Libraries that must be loaded first (their scripts come earlier in the frame). */
  deps: string[];
}

export const WIDGET_LIBRARIES: WidgetLibrary[] = [
  { id: 'react', specifiers: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'], deps: [] },
  { id: 'clsx', specifiers: ['clsx', 'tailwind-merge', '@/lib/utils'], deps: [] },
  { id: 'ui', specifiers: [], deps: ['react', 'clsx'] }, // @/components/ui/* (registered per component below)
  { id: 'recharts', specifiers: ['recharts'], deps: ['react'] },
  { id: 'd3', specifiers: ['d3'], deps: [] },
  { id: 'motion', specifiers: ['motion/react'], deps: ['react'] },
  { id: 'lucide', specifiers: [], deps: ['react'] }, // the icon factory; icons are generated per widget as 'lucide-react'
  { id: 'lodash', specifiers: ['lodash'], deps: [] },
  // Always loaded: Tailwind's browser build, then the runtime (require, SDK as 'explainer', mount, shims).
  { id: 'tailwind', specifiers: [], deps: [] },
  { id: 'runtime', specifiers: ['explainer'], deps: ['react', 'motion'] },
];

/** shadcn/ui-compatible components provided by the 'ui' library, registered as `@/components/ui/<name>`. */
export const UI_COMPONENTS = [
  'card', 'button', 'badge', 'input', 'label', 'slider', 'switch', 'checkbox', 'tabs', 'select', 'progress', 'separator', 'alert', 'tooltip', 'scroll-area',
] as const;

/** The d3 modules contained in the `d3` bundle; imports of these resolve to `d3`. */
export const D3_MODULES = [
  'd3-array', 'd3-axis', 'd3-brush', 'd3-chord', 'd3-color', 'd3-contour', 'd3-delaunay', 'd3-dispatch', 'd3-drag', 'd3-dsv', 'd3-ease', 'd3-fetch',
  'd3-force', 'd3-format', 'd3-geo', 'd3-hierarchy', 'd3-interpolate', 'd3-path', 'd3-polygon', 'd3-quadtree', 'd3-random', 'd3-scale',
  'd3-scale-chromatic', 'd3-selection', 'd3-shape', 'd3-time', 'd3-time-format', 'd3-timer', 'd3-transition', 'd3-zoom',
] as const;

/** Specifiers rewritten before lookup. */
export const WIDGET_ALIASES: Record<string, string> = {
  motion: 'motion/react',
  'framer-motion': 'motion/react',
  ...Object.fromEntries(D3_MODULES.map((m) => [m, 'd3'])),
};

/** Imports authors (and Claude) commonly reach for that aren't available, with what to use instead. */
export const UNAVAILABLE_IMPORTS: Record<string, string> = {
  three: 'Three.js is not available in widgets yet; use SVG, d3 or CSS 3D transforms.',
  mathjs: 'mathjs is not available; use plain JavaScript Math or d3-array.',
  papaparse: 'papaparse is not available; import the data as ./data.json, or use d3.csvParse.',
  'chart.js': 'Chart.js is not available; use recharts.',
  tone: 'Tone.js is not available in widgets.',
  axios: 'Widgets have no network access; import data as ./data.json.',
  'd3-sankey': 'd3-sankey is not part of the d3 bundle; draw the flow with d3-shape, or use recharts Sankey.',
  'd3-cloud': 'd3-cloud is not part of the d3 bundle.',
};

/** Allowed extensions for widget files and their relative imports. */
export const WIDGET_SOURCE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'] as const;
export const WIDGET_DATA_EXTENSIONS = ['.json'] as const;
export const WIDGET_IMAGE_EXTENSIONS = ['.svg', '.png', '.webp', '.jpg', '.jpeg', '.gif'] as const;

/** The library id that provides a (non-relative) specifier, after aliases; undefined if not allowed. */
export function libraryFor(specifier: string): string | undefined {
  const s = WIDGET_ALIASES[specifier] ?? specifier;
  if (s === 'lucide-react') return 'lucide';
  if (s.startsWith('@/components/ui/')) return UI_COMPONENTS.includes(s.slice(16) as (typeof UI_COMPONENTS)[number]) ? 'ui' : undefined;
  return WIDGET_LIBRARIES.find((l) => l.specifiers.includes(s))?.id;
}
