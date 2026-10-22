# Writing widgets

A **widget** is a small React component inside an explainer: a live chart, a simulation, a diagram the reader can drag, a control panel. You write it the way you'd write a Claude artifact (TSX, Tailwind, shadcn/ui-style components, Recharts, D3, Motion, lucide-react, lodash), in a file next to `explainer.html`, and place it in the HTML with `<explain-widget>`. The prose stays plain HTML; only widgets run code, each in its own sandboxed frame.

This guide is written for whoever writes the widget, Claude included. Read it all before writing the first one; the rules on size, linking to code and placement are the ones people trip over.

## Contents

1. [Widget or CSS?](#1-widget-or-css)
2. [A minimal complete example](#2-a-minimal-complete-example)
3. [The contract](#3-the-contract)
4. [Imports](#4-imports)
5. [Theming](#5-theming)
6. [Linking to the code](#6-linking-to-the-code)
7. [Placement](#7-placement)
8. [Focus and keyboard](#8-focus-and-keyboard)
9. [State](#9-state)
10. [Motion and performance](#10-motion-and-performance)
11. [What doesn't work](#11-what-doesnt-work)
12. [Accessibility](#12-accessibility)
13. [Checking your work, and consent](#13-checking-your-work-and-consent)
14. [Gallery](#14-gallery)

## 1. Widget or CSS?

Explainers already do a lot without script, and that version works for every reader: in Restricted Mode, with widgets turned off, and before anyone agrees to run them. Reach for CSS first:

| Want | Use |
|---|---|
| Tabs, a stepper, a before/after switch, a quiz | Radio buttons and checkboxes with `:checked ~ …` or `:has(:checked)` (README, "Styling") |
| Footnotes, pop-outs | `:target`, `<details>` |
| Hover callouts, highlighting parts of a diagram | `:hover`, `:focus-within`, inline SVG |
| A diagram that changes per step | An SVG per step, or classes switched by the stepper above |
| Simple animation | CSS animation (honour `prefers-reduced-motion`) |

Use a widget when the reader needs **computation**: a chart of data that changes with a control, a simulation that runs, a layout computed by D3, a table parsed from the real code, anything with more state than a few radio buttons can hold. Then give it a fallback (§3) so the explainer still reads well without it.

## 2. A minimal complete example

The section in `explainer.html`. The widget element has an **explicit closing tag** (`<explain-widget … />` doesn't close in HTML and would swallow the rest of the section), JSON props in a child script, and a **fallback** shown whenever the widget isn't running:

```html
<section data-explain-anchor="refill" data-explain-title="Refill">
  <h2>Refill below the valid bits</h2>
  <p>A byte arrives and lands just below the bits already in the window.</p>
  <explain-widget src="widgets/refill.tsx" title="Refill simulator" height="200">
    <script type="application/json">{"width": 64}</script>
    <img src="assets/refill.svg" alt="The 64-bit window before and after a refill: the new byte sits just below the valid bits">
  </explain-widget>
</section>
```

`widgets/refill.tsx`, in the explainer's folder:

```tsx
import { useEffect } from 'react';
import { highlight, useAnchorCode, useIsMyStepActive, useStepValue, useWidgetState } from 'explainer';
import { Button } from '@/components/ui/button';

export default function Refill({ width = 64 }: { width?: number }) {
  // What the reader sets: kept across reloads, edits and scrolling away (plain useState isn't).
  const [valid, setValid] = useWidgetState('valid', 20);
  // Follows the explainer's steps: one value per step id, and a fallback.
  const color = useStepValue({ state: 'var(--chart-2)', refill: 'var(--chart-1)' }, 'var(--muted-foreground)');
  // The real code of the "refill" anchor, live. null while loading; status 'unavailable' when the reader's
  // panel won't give it (the reason goes to you, the author, through the checker, never to readers).
  const code = useAnchorCode('refill');
  const active = useIsMyStepActive();
  const canRefill = valid <= width - 8;

  // Lines are relative to the anchor: 1 is its first line. Highlights show only while this step is
  // current, so re-apply them when it becomes current. No click needed.
  useEffect(() => {
    if (active) highlight(canRefill ? [2, 3] : 1);
  }, [active, canRefill]);

  return (
    <div className="space-y-3 p-1">
      <div className="flex gap-px" role="img" aria-label={`${valid} of ${width} bits valid`}>
        {Array.from({ length: width }, (_, i) => (
          <div key={i} className="h-4 flex-1 rounded-[1px]" style={{ background: i < valid ? color : 'var(--muted)' }} />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={!canRefill} onClick={() => setValid((v) => v + 8)}>Refill a byte</Button>
        <Button size="sm" variant="outline" onClick={() => setValid((v) => Math.max(0, v - 5))}>Read 5 bits</Button>
        <span className="text-sm text-muted-foreground">{valid} / {width} bits valid</span>
      </div>
      {code === null ? (
        <p className="text-xs text-muted-foreground">Loading the code…</p>
      ) : code.status === 'ok' ? (
        <pre className="overflow-x-auto rounded-md bg-muted p-2 text-xs">{code.text.split('\n')[1]?.trim()}</pre>
      ) : null /* unavailable: render your own empty state, or nothing */}
    </div>
  );
}
```

Then run the checker (§13) and fix what it reports.

## 3. The contract

**The element.** `<explain-widget>` goes anywhere in `explainer.html` that normal flow reaches (§7).

| Attribute or child | Meaning |
|---|---|
| `src` | The widget file, relative to the explainer folder: `.tsx`, `.jsx`, `.ts` or `.js`. Required. |
| `title` | The widget's accessible name (default: the file name). Always give one. |
| `height` | Initial height in px (default 240) until the widget reports its own. Set it close to the real height so the page doesn't shift. |
| `aspect` | Instead of `height`: a ratio like `16/9`. |
| `id` | A stable key for the widget's saved state (default: the section's anchor, `src` and position). Give one if you'll move the widget around. |
| `<script type="application/json">` child | Props, as a JSON object (at most 16 KB). Never executed. Escape `</` as `<\/` inside it. |
| `props` attribute | Props as JSON, if there's no JSON child (the child wins when both are given). |
| Any other children | The **fallback**: shown when widgets can't run (Restricted Mode, turned off, no consent yet), while loading, and on an error. Readers using a screen reader get it as the widget's description. Make it a real substitute: an image with good alt text, a table, or a sentence. |

**The file.** Its **default export** is a React component (`export default function Name(props) { … }`). It gets the JSON props as its props, so give every prop a default. Named exports are fine for your own helpers; other files in the explainer folder can be imported (§4).

**The box is sized by its content.** A widget's frame is exactly as tall as what it renders, and as wide as the column it sits in.
- **No viewport heights.** `h-screen`, `min-h-screen`, `h-dvh`, `100vh` and `window.innerHeight` don't mean the widget's box (the runtime neutralizes the classes, `innerHeight` is the panel's height, and a widget that keeps growing is frozen with a message). Use fixed heights: `h-64`, `style={{ height: 320 }}`.
- **Give charts a height or an aspect.** `<ResponsiveContainer width="100%" height={240}>`, never `height="100%"` (its parent has no height to be a percentage of; the runtime falls back to 300 px and the checker warns). For SVG, a `viewBox` with `className="w-full h-auto"` scales with the width.
- **Size to the container's width, not fixed pixels.** The panel can be 340 px or 1400 px wide. Use `w-full`, flex and grid, `viewBox`; wrap rows (`flex-wrap`).
- **Transparent root.** The page behind the widget is the explainer, in the reader's theme. Don't paint a page background (`bg-white`, `bg-gray-900`, `min-h-screen bg-…`). Cards and panels inside are fine (`Card`, `bg-card`, `bg-muted`).
- **Height** is capped at 20,000 px; keep widgets to what fits on a screen or two.

## 4. Imports

Exactly these, checked by the compiler with "did you mean" suggestions (anything else is an error):

| Import | Provides |
|---|---|
| `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client` | React 19. The JSX runtime is automatic: no `import React` needed (it's allowed). |
| `@/components/ui/card`, `button`, `badge`, `input`, `label`, `slider`, `switch`, `checkbox`, `tabs`, `select`, `progress`, `separator`, `alert`, `tooltip`, `scroll-area` | shadcn/ui-compatible components styled with the VS Code theme (below). |
| `@/lib/utils` (`cn`), `clsx`, `tailwind-merge` (`twMerge`, `twJoin`) | Class helpers. |
| `recharts` | Charts. `ResponsiveContainer` is adapted for content-sized boxes. |
| `d3`, and the d3 modules in it (`d3-array`, `d3-axis`, `d3-brush`, `d3-chord`, `d3-color`, `d3-contour`, `d3-delaunay`, `d3-dispatch`, `d3-drag`, `d3-dsv`, `d3-ease`, `d3-fetch`, `d3-force`, `d3-format`, `d3-geo`, `d3-hierarchy`, `d3-interpolate`, `d3-path`, `d3-polygon`, `d3-quadtree`, `d3-random`, `d3-scale`, `d3-scale-chromatic`, `d3-selection`, `d3-shape`, `d3-time`, `d3-time-format`, `d3-timer`, `d3-transition`, `d3-zoom`) | All resolve to the one d3 bundle. |
| `motion/react`; also `motion` and `framer-motion` | Motion (Framer Motion). |
| `lucide-react` | Icons, by name: `import { Play, Pause } from 'lucide-react'` (also `PlayIcon`, `LucidePlay`). Not `import * as Icons`: only the icons you name are sent. |
| `lodash` | `import _ from 'lodash'` or named imports. |
| `explainer` | The SDK (§6). |
| `./file.tsx`, `./file.ts`, `./file.jsx`, `./file.js` | Your own modules in the explainer folder (extension optional; `./dir` finds `index.tsx`). |
| `./data.json` | JSON data, imported as a value. |
| `./image.svg`, `.png`, `.webp`, `.jpg`, `.jpeg`, `.gif` | The image as a data URL: `import url from './ring.svg'`, then `<img src={url} alt="…">`. |

The components export shadcn's names: `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardAction`, `CardContent`, `CardFooter`; `Button`, `buttonVariants`; `Badge`, `badgeVariants`; `Input`; `Label`; `Slider`; `Switch`; `Checkbox`; `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent`; `Select`, `SelectTrigger`, `SelectValue`, `SelectContent`, `SelectItem`, `SelectGroup`, `SelectLabel`, `SelectSeparator`; `Progress`; `Separator`; `Alert`, `AlertTitle`, `AlertDescription`; `Tooltip`, `TooltipTrigger`, `TooltipContent`, `TooltipProvider`; `ScrollArea`, `ScrollBar`. Differences from shadcn: `Select` renders a native `<select>` (its popup always fits), `Slider` is a native range input with shadcn's array API (`value={[n]}`, `onValueChange={(v) => …}`), and tooltips stay inside the widget's box.

Files you import: inside the explainer folder only (no `..` out of it, no absolute paths, URLs, `?` or `#`); at most 50 files and 1 MB of code and JSON per widget; images at most 1 MB each and 5 MB in all. Files with secret-looking names (`.env*`, `*secret*`, `*token*`, `*credential*`, `*.key`, `*.pem` and the like) are refused.

**Not available**, with what to use instead:

| Import | Instead |
|---|---|
| `three` | SVG, d3, or CSS 3D transforms |
| `mathjs` | `Math`, d3-array |
| `papaparse` | `import data from './data.json'`, or `d3.csvParse` on a string |
| `chart.js` | recharts |
| `tone` | not available |
| `axios`, `fetch`, any network | import the data as `./data.json` |
| `d3-sankey`, `d3-cloud` | d3-shape, or recharts' `Sankey` |
| `@radix-ui/*` | the `@/components/ui/*` components |
| other npm packages | write it yourself, or copy the code into a file in the explainer folder |

Also not supported: dynamic `import()`, top-level `await` (put async work in an effect), and `require()` of anything but the above.

## 5. Theming

The widget's frame gets the reader's VS Code theme. Use **theme tokens**, never fixed colors, and the widget looks native in light, dark and high-contrast themes.

| Token (Tailwind class / CSS variable) | From VS Code |
|---|---|
| `bg-background`, `text-foreground` / `var(--background)`, `var(--foreground)` | editor background and foreground |
| `bg-card`, `text-card-foreground` | widget (hover/find) background |
| `bg-popover`, `text-popover-foreground` | hover widget |
| `bg-primary`, `text-primary-foreground` | button |
| `bg-secondary`, `text-secondary-foreground` | secondary button |
| `bg-muted`, `text-muted-foreground` | code block background, description text |
| `bg-accent`, `text-accent-foreground` | list hover |
| `text-destructive`, `bg-destructive` | error foreground |
| `border-border`, `border-input`, `ring-ring` / `outline-ring` | widget border, input border, focus border |
| `var(--chart-1)` … `var(--chart-6)` (`fill-chart-1`, `stroke-chart-2`, `bg-chart-3`, …) | `charts.blue`, `orange`, `green`, `purple`, `red`, `yellow` |
| `font-sans`, `font-mono` | the workbench font, the editor font |

- The variables hold **complete colors**: write `var(--primary)` or `bg-primary/20`, never `hsl(var(--primary))` (the checker warns).
- For SVG and chart libraries, pass the variables as colors: `stroke="var(--chart-1)"`, `fill="var(--muted-foreground)"`. `useTheme().color('--chart-1')` gives the computed value when a library needs a literal.
- **`dark:` follows VS Code**: `<html>` has `.dark` in dark and dark high-contrast themes, `.light` otherwise, and `.hc` in both high-contrast themes. Prefer tokens over `dark:` pairs.
- **No page backgrounds**: no `bg-white`, `bg-gray-50`, `bg-slate-900` on the root. Tailwind's palette colors (`bg-blue-500`) ignore the theme; use them only for small accents where nothing else fits, and never for text.
- **High contrast**: the components draw `contrastBorder` and `focusBorder` there. In your own markup, give shapes a border (`border border-border`) rather than relying on fills, keep focus visible, and never convey anything by color alone: add a label, a pattern or an icon.
- Text uses the workbench font by default; use `font-mono` for code.

## 6. Linking to the code

A widget knows the explainer it's in: the current step, the anchors and their code. It can highlight lines and, from a click, show code in the editor. All from `import { … } from 'explainer'`:

| SDK | |
|---|---|
| `useActiveStep()` | The current step's anchor id, or null. |
| `useMyAnchor()` | The anchor of the section the widget sits in (nearest enclosing `data-explain-anchor`). |
| `useIsMyStepActive()` | True while that section is the current step. |
| `useIsActive(id)` | True while step `id` is current. |
| `useStep()` | `{ id, index, count, next(), prev() }` for the current step. |
| `useStepValue({ stepId: value, … }, fallback)` | The value for the current step: the simplest way to make a widget follow the steps. |
| `useAnchors()` | Every anchor: `{ id, title, step, file, range, state, color }`, live. `step` is −1 for nested anchors. |
| `useAnchorCode(id)` | `null` while loading, then `{ status: 'ok', text, startLine, language, state }` (live, unsaved edits included) or `{ status: 'unavailable', reason }`. Call it directly with a literal id (`useAnchorCode('refill')`): a widget gets the code only of the anchors it names that way (any anchor if the id is computed, which makes Pin and the reader confirm every anchor). |
| `highlight(lines, { anchor?, identifiers? })` | Highlights lines in the editor, **relative to the anchor's current first line** (1 = its first line; `[2, 4]` = its lines 2–4). Default anchor: the widget's own; another anchor works if it is the current step or nested in it. `highlight()` clears. |
| `reveal(id, { lines?, highlight? })` | Shows an anchor's code in the editor. Returns `Promise<boolean>`. |
| `goToStep(id)` | Makes a step current. Returns `Promise<boolean>`. |
| `<Ref anchor="id" lines={[2, 3]}>text</Ref>` | A link-styled button that reveals code when clicked. |
| `useWidgetState(key, initial)` | State that survives remounts (§9). |
| `useTheme()`, `useVisible()`, `useReducedMotion()` | Theme kind and colors; whether the widget is on screen; whether the reader wants less motion. |
| `asset(path)` | A data URL for an image the widget also imports; prefer `import url from './x.png'`. |

Arguments the panel can't use (line numbers below 1 or not whole, an id that isn't an anchor id, identifiers that aren't identifiers) aren't sent: the call does nothing (`reveal` and `goToStep` return `false`), and the error is shown on the widget and in Output.

To turn a line of `useAnchorCode` text into a `highlight` line: line *i* of `code.text.split('\n')` (0-based) is `highlight(i + 1)`. Its line in the file is `code.startLine + i`.

**What needs a click.** Anything that moves the editor or the explainer must come from the reader's click or key press in the widget, so a widget can't yank the reader around:

| Works automatically | Needs a click in the widget |
|---|---|
| Reading steps, anchors, code, theme, visibility; step-driven animation; `useWidgetState`; `highlight` within the current step's anchor | `reveal`, `goToStep`, `<Ref>`, `next`/`prev`, called **synchronously in the click or key handler** |

So `onClick={() => reveal('refill')}` works, while `onClick={async () => { await something(); reveal('refill'); }}` fails (call it before any `await`), and so do calls from `useEffect`, timers or promise callbacks (the checker warns). Calls that are refused return `false` and are logged for you in **Output › Code Explainer**. The panel already reveals each step's code as the reader moves through the explainer, so widgets rarely need `reveal` at all; `highlight` is the everyday tool.

`highlight` shows only while its anchor's step is current (the panel clears highlights on every step change, before telling widgets about it), so call it from an effect that depends on `useIsMyStepActive()`, as below. It never scrolls, opens files or takes focus, and it's limited to about 10 calls a second.

### Pattern: a stepper synced to the sections

The widget follows the explainer's steps; its own buttons move the explainer. The section ids are the explainer's step ids.

```tsx
import { useStep, useStepValue } from 'explainer';
import { Button } from '@/components/ui/button';

const STAGES = ['fetch', 'decode', 'execute', 'writeback'];

export default function Stages() {
  const current = useStepValue({ fetch: 0, decode: 1, execute: 2, writeback: 3 }, -1);
  const step = useStep();
  return (
    <div className="space-y-2">
      <ol className="grid grid-cols-4 gap-2">
        {STAGES.map((s, i) => (
          <li key={s} aria-current={i === current ? 'step' : undefined}
            className={`rounded-md border px-2 py-2 text-center text-sm ${i === current ? 'border-primary font-semibold' : 'border-border text-muted-foreground'}`}>
            {s}
          </li>
        ))}
      </ol>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={step.index <= 0} onClick={() => step.prev()}>Previous step</Button>
        <Button size="sm" disabled={step.index >= step.count - 1} onClick={() => step.next()}>Next step</Button>
      </div>
    </div>
  );
}
```

### Pattern: a simulation that highlights the current line

The reader steps a simulation; the editor highlights the line being "executed". Highlighting needs no click, so a running simulation can drive it too.

```tsx
import { useEffect } from 'react';
import { highlight, useAnchorCode, useIsMyStepActive, useWidgetState } from 'explainer';
import { Button } from '@/components/ui/button';

export default function Trace() {
  const code = useAnchorCode('refill');
  const active = useIsMyStepActive();
  const [line, setLine] = useWidgetState('line', 1);
  const lines = code?.status === 'ok' ? code.text.split('\n') : [];

  useEffect(() => {
    if (active && lines.length) highlight(line);
  }, [active, line, lines.length]);

  if (code === null) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (code.status === 'unavailable') return <p className="text-sm text-muted-foreground">Step through the code in the editor.</p>;
  return (
    <div className="space-y-2">
      <pre className="overflow-x-auto rounded-md bg-muted p-2 text-xs">
        {lines.map((l, i) => (
          <div key={i} className={i + 1 === line ? 'bg-accent text-accent-foreground' : undefined}>
            <span className="mr-3 select-none text-muted-foreground">{code.startLine + i}</span>{l}
          </div>
        ))}
      </pre>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => setLine((l) => (l % lines.length) + 1)}>Step</Button>
        <Button size="sm" variant="outline" onClick={() => setLine(1)}>Reset</Button>
      </div>
    </div>
  );
}
```

### Pattern: a visualization parsed from the anchor's code

Read the real code and draw from it, so the picture can't drift from the source. Parse defensively (the code changes as people edit it), and show something sensible while it's loading or unavailable.

```tsx
import { useAnchorCode } from 'explainer';

export default function CaseCount({ anchor = 'decode' }: { anchor?: string }) {
  const code = useAnchorCode(anchor);
  if (code?.status !== 'ok') return <p className="text-sm text-muted-foreground">The decoder handles several opcodes.</p>;
  const cases = code.text.split('\n').filter((l) => /^\s*\w+\s*:/.test(l) && !/default\s*:/.test(l));
  return (
    <p className="text-sm">
      The decoder handles <strong>{cases.length}</strong> opcodes, from <code className="font-mono">{cases[0]?.trim().split(':')[0]}</code> to{' '}
      <code className="font-mono">{cases.at(-1)?.trim().split(':')[0]}</code>.
    </p>
  );
}
```

**`useAnchorCode` is limited on purpose.** Widgets get an anchor's code only when the explainer's author demonstrably knew that code: the anchor is **pinned** (its `quote` in `manifest.json`), the quote is either committed in git or was confirmed by the reader in VS Code, the file isn't ignored by git or secret-looking, and the anchor is at most 2,000 lines. Otherwise the widget gets `{ status: 'unavailable', reason }` with one of `not-pinned`, `unconfirmed`, `ignored`, `secret-file`, `lost`, `changed-untracked`, `changed-since-commit`, `too-large`, or `not-requested` (the widget asked for an anchor it doesn't name in a direct `useAnchorCode('id')` call). Readers never see the reason (an explainer mustn't be able to ask readers to pin things); the checker and VS Code's Problems panel tell you, the author. Always render something useful for `null` and `unavailable`.

## 7. Placement

Widget frames are laid over their placeholders by the panel, so the panel must be able to follow where the placeholder is. The checker reports what it can see in the HTML and CSS; the panel checks the real layout and names the element and property in the error.

- **Fine:** normal flow; sections; `<details>` (a widget in a closed one just isn't mounted until it's opened); CSS tabs and radio steppers (a widget in an unselected tab is unmounted, its `useWidgetState` kept); `overflow: hidden` or `clip` ancestors (the widget is clipped to them, without their rounded corners).
- **Only while not scrolling:** inside `overflow: auto`/`scroll` boxes (wide tables, code blocks). The widget shows while that box doesn't actually overflow; when it does, readers get the fallback and "This widget can't be shown at this width". Keep widgets out of scrolling boxes.
- **Not supported** (readers get the fallback): any ancestor with a `transform`, `translate`, `rotate` or `scale`; `clip-path`, `mask` or `filter`; `content-visibility`; `position: fixed` or `sticky`; or animations and transitions of geometry (transform, position, size). Hover-only effects (`:hover { transform: … }`) are tolerated: the frame may be a few px off during the hover.
- Don't style `explain-widget` itself beyond margins: the panel makes it `display: block` and sets its height.

## 8. Focus and keyboard

- **Never take focus.** `autoFocus` is stripped (the checker warns) and `focus()` does nothing unless the reader is interacting with the widget (or focus is already inside it): focus taken from the editor would steal the reader's typing. Focus that arrives without the reader's click is given back, and a widget that keeps doing it is unmounted.
- Readers reach a widget with Tab (its placeholder is a tab stop) and enter it with Enter or a click. **Esc leaves** the widget, and so do Tab past its last control and Shift+Tab past its first. Don't use Escape for your own UI unless you call `preventDefault()` on it, and then only while something (a menu, an edit) is open.
- A **pointer** click anywhere in the widget hands focus back to the panel right after your handler runs, so explainer shortcuts keep working; clicks in text inputs, selects and ranges (or their labels) keep focus, as does a handler that moves focus into one. Keyboard activation (Enter or Space) keeps focus in the widget.
- While focus is inside a widget, VS Code's shortcuts don't reach VS Code. A key press with Ctrl, Cmd or Alt that the widget doesn't handle hands focus back to the panel, so the next shortcut works (copy, paste, cut, undo, redo and select-all stay with the widget, as does anything typed into a text field).
- Make every control a real `<button>`, `<input>` or `<select>` (or a component from `@/components/ui`), not a `<div onClick>`.

## 9. State

- **`useWidgetState(key, initial)`** for anything the reader sets: slider positions, the current simulation step, a selected tab. It survives reloads, live edits of the widget's source or the HTML, scrolling far away, switching editor tabs and VS Code restarts. Values must be JSON (numbers, strings, arrays, plain objects); at most 64 KB per widget (a larger state isn't saved, with an error for you), and the panel keeps 256 KB for all widgets, dropping the least recently used.
- **Plain `useState` resets** whenever the widget remounts: when the reader scrolls far away and back, switches editor tabs, or you edit the widget. Use it only for transient things (hover, an animation tick).
- Keys are per widget. Don't store what you can compute, and don't store code from `useAnchorCode`.
- `localStorage` and `sessionStorage` work but are in memory only and start empty on every mount.

## 10. Motion and performance

- **Reduced motion.** Motion components already follow the reader's preference (the OS setting or VS Code's `workbench.reduceMotion`). For everything else, check `useReducedMotion()`: turn off Recharts animation (`isAnimationActive={!reduced}`), skip CSS transitions and auto-play.
- **Off screen, widgets pause.** While a widget is scrolled away, its timers, intervals, animation frames and CSS animations are suspended; they resume when it comes back. `useVisible()` tells you, if you need to pause more.
- **Spread heavy work over frames.** A loop that runs for more than **1 s** without letting the browser breathe is stopped with an error ("spread heavy work over frames"). Long synchronous work (a big force layout computed in one go, a regex on a huge string) can trip the **watchdog**, which disables the widget: the panel pings widgets every second and treats about 3 s without an answer as a hang, and VS Code steps in when the panel misses heartbeats for 10 s or is late by over 2 s three times in a minute. Compute incrementally with `requestAnimationFrame` or `d3.timer`, a few milliseconds per frame, and memoize (`useMemo`).
- **Budgets.** At most **8 widgets are mounted** at once (those near the reader's viewport) and **24 per explainer**; the rest show their fallback until the reader scrolls near them. Mounting a widget takes tens of milliseconds; keep each widget's own work small.
- Keep data small: import JSON rather than embedding megabytes in props (props are limited to 16 KB).

## 11. What doesn't work

| | |
|---|---|
| Network | `fetch`, XHR, WebSocket, EventSource and `sendBeacon` fail with "Widgets can't use the network. Import data as a file instead"; remote images, fonts, stylesheets and media are blocked. Bundle everything as imported files. |
| Persistent storage | `localStorage`/`sessionStorage` are in memory; cookies and IndexedDB aren't available. Use `useWidgetState`. |
| Popups and dialogs | `window.open`, `alert`, `confirm`, `prompt`, `print`, fullscreen: blocked. Show messages in the widget. |
| Navigation | Links and `location` changes don't navigate anything useful (a frame that navigates is reset). Use `<Ref>` or `reveal` for code, and plain text for URLs. |
| Code from strings | `eval`, `new Function`, string timers, inline event-handler strings, `<script>` elements: blocked. |
| Forms | Forms never submit, and `onSubmit` never fires: handle the button's `onClick` (and Enter in an input with `onKeyDown`). |
| Web Workers, WebAssembly | Not supported. |
| Clipboard, camera, microphone, geolocation | Not available. |
| `window.innerHeight`, `100vh`, `h-screen` | `window.innerHeight` is the panel's height; `h-screen` and `min-h-screen` size to the content; a raw `100vh` is the widget's own frame, so a widget sized with it keeps growing and its height is frozen with a message (§3). Give widgets a fixed height. |

## 12. Accessibility

- `title` on `<explain-widget>` names the widget; the fallback describes it. Write both for someone who can't see the widget.
- Use real controls (`Button`, `Slider`, `Switch`, `Select`, native inputs) with labels (`<Label htmlFor>`, `aria-label`).
- Charts and drawings: `role="img"` with an `aria-label` that states what matters ("Latency rises from 4 to 40 cycles as the queue fills"), or a table next to them.
- Keep focus visible (the components do; for your own controls, `focus-visible:outline-2 focus-visible:outline-ring`).
- Don't convey anything by color alone; check the widget in a high-contrast theme.
- Announce important changes sparingly with `aria-live="polite"`.
- Respect reduced motion (§10).

## 13. Checking your work, and consent

Checking compiles the widgets but runs nothing, so it needs no consent.

- **In VS Code**, problems in widget files and `explainer.html` appear in the Problems panel as you save; **Code Explainer: Check Widgets** checks an explainer on demand. When Claude Code is connected to the IDE, it reads these diagnostics.
- **From a terminal** (Claude Code in the user's repository), run the checker that ships with the extension, `dist/check.cjs` in the extension's folder (for example `~/.vscode/extensions/code-explainer.code-explainer-0.1.0/dist/check.cjs`):

  ```bash
  node ~/.vscode/extensions/code-explainer.code-explainer-0.1.0/dist/check.cjs .explain/<name>
  ```

  The version in the folder name changes. To find it (this also covers VS Code Insiders and `~/.vscode-server` on remote hosts), list the candidates and use the newest:

  ```bash
  ls ~/.vscode*/extensions/*code-explainer*/dist/check.cjs
  node "$(ls ~/.vscode*/extensions/*code-explainer*/dist/check.cjs | tail -n 1)" .explain/<name>
  ```

  **Code Explainer: Copy Widget Check Command** copies the exact command for this machine. Options: `--json` for a machine-readable report; `--pin` to pin anchors (below).

  It checks each `<explain-widget>`: the file compiles; imports and named imports exist; props are a JSON object under 16 KB; the anchor ids in `reveal`, `goToStep`, `highlight`, `<Ref>`, `useAnchorCode`, `useIsActive` and `useStepValue` exist (and are steps where they must be); each anchor read by `useAnchorCode` is pinned, not secret-looking and unchanged; `highlight` has an anchor to highlight in; navigation isn't called from effects, timers or after `await`; the artifact habits of §3 and §11; a title and a fallback; and the placement problems of §7 it can see in the HTML and CSS. Each finding is a line `file:line: error|warning|info code: message`. The exit code is 1 when there are errors, 0 otherwise (2 for bad arguments). Fix every error; read every warning.

- **Pinning.** `--pin` records each anchor's current code from the files on disk into `manifest.json`, like **Pin Anchors** in VS Code: only anchors whose code it finds with confidence, never for secret-looking files, keeping the manifest's formatting. Anchors that widgets read with `useAnchorCode` are **not** pinned by `--pin` alone, because pinning lets widgets read that code: the checker lists those files and line ranges instead. **Never pass `--yes-widgets-may-read` on your own.** Show the user the files and line ranges the checker printed, say that widgets in this explainer will be able to read that code, and run `--pin --yes-widgets-may-read` only after they agree. Quotes pinned this way still show as `unconfirmed` to widgets until the manifest is committed or the reader confirms them in VS Code ("Let widgets read N anchors…").
- **Types.** **Code Explainer: Add Widget Types** writes `.explain/tsconfig.json` and declaration files for React, the libraries, the components and `explainer`, so `tsc` and IntelliSense work on widget files without installing packages.

**Consent.** Widgets are code from the repository, so they run only when VS Code trusts the workspace, the `codeExplainer.widgets.enabled` setting is on (a user setting; a repository can't turn it on), and the reader agrees. The first time, the panel shows "This explainer has N interactive widgets" with **Run widgets…**, which opens a VS Code dialog saying what widgets can do; until then readers see the fallbacks. When you add widgets to an explainer, **tell the user they'll be asked to run them** when they open it. Their answer covers the code they agreed to run. Their own edits (or yours) keep running without a question; code that arrives through git asks again: changed widget code after a checkout, pull or merge, and widget files they never agreed to that git brought (another explainer's widgets after a clone or pull). Without git, the answer lasts for the workspace. Edits made while VS Code was closed may ask once more, and so may an edit committed right after saving (before VS Code has seen the save) or committed only in part (`git add -p`). **Code Explainer: Revoke Widget Consent** undoes it, and also forgets which anchors the reader let widgets read (including those confirmed when pinning).

## 14. Gallery

Five short, complete widgets to start from. Each compiles as is (a test keeps them that way).

### A Recharts line chart with a control

```tsx
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useReducedMotion, useWidgetState } from 'explainer';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';

export default function LatencyChart({ service = 4 }: { service?: number }) {
  const [load, setLoad] = useWidgetState('load', 70);
  const reduced = useReducedMotion();
  const rho = Math.min(load, 95) / 100;
  const data = Array.from({ length: 16 }, (_, i) => ({ depth: i + 1, latency: Math.round((service * (i + 1)) / (1 - rho) / 4) }));
  const axis = { stroke: 'var(--border)', tick: { fill: 'var(--muted-foreground)', fontSize: 12 } };
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Label htmlFor="load" className="w-32 shrink-0">Load: {load}%</Label>
        <Slider id="load" aria-label="Load" min={10} max={95} step={5} value={[load]} onValueChange={(v) => setLoad(v[0] ?? 70)} />
      </div>
      <div role="img" aria-label={`Latency grows with queue depth, to ${data[15]?.latency} cycles at depth 16`}>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
            <XAxis dataKey="depth" {...axis} />
            <YAxis {...axis} />
            <Tooltip contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border)', color: 'var(--popover-foreground)' }} />
            <Line type="monotone" dataKey="latency" stroke="var(--chart-1)" strokeWidth={2} dot={false} isAnimationActive={!reduced} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
```

### A D3 diagram, rendered by React

Let D3 compute (scales, layouts, paths) and React render: no `d3.select` on the DOM, and the SVG scales with the column through its `viewBox`.

```tsx
import { useMemo } from 'react';
import * as d3 from 'd3';

type Tree = { name: string; children?: Tree[] };

const MODULES: Tree = {
  name: 'top',
  children: [
    { name: 'fetch', children: [{ name: 'icache' }, { name: 'predictor' }] },
    { name: 'decode' },
    { name: 'execute', children: [{ name: 'alu' }, { name: 'mul' }, { name: 'lsu' }] },
  ],
};

export default function ModuleTree({ tree = MODULES }: { tree?: Tree }) {
  const width = 640;
  const height = 220;
  const { nodes, links } = useMemo(() => {
    const root = d3.hierarchy(tree);
    d3.tree().size([width - 80, height - 60])(root);
    const link = d3.linkVertical().x((d: any) => d.x + 40).y((d: any) => d.y + 24);
    return { nodes: root.descendants(), links: root.links().map((l: any) => link(l) as string) };
  }, [tree]);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img" aria-label="Module hierarchy">
      {links.map((d: string, i: number) => (
        <path key={i} d={d} fill="none" stroke="var(--border)" strokeWidth={1.5} />
      ))}
      {nodes.map((n: any) => (
        <g key={n.data.name} transform={`translate(${n.x + 40},${n.y + 24})`}>
          <circle r={6} fill={n.children ? 'var(--chart-1)' : 'var(--background)'} stroke="var(--chart-1)" strokeWidth={2} />
          <text y={-12} textAnchor="middle" fontSize={12} fill="var(--foreground)">{n.data.name}</text>
        </g>
      ))}
    </svg>
  );
}
```

### A Motion stepper that follows the explainer

```tsx
import { motion } from 'motion/react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useStep, useStepValue } from 'explainer';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const STAGES = ['Fetch', 'Decode', 'Execute', 'Write back'];

export default function PipelineStepper() {
  const stage = useStepValue({ fetch: 0, decode: 1, execute: 2, writeback: 3 }, 0);
  const step = useStep();
  return (
    <div className="space-y-3">
      <div className="relative grid grid-cols-4 gap-2 pb-2">
        {STAGES.map((s, i) => (
          <div key={s} className={cn('rounded-md border px-2 py-3 text-center text-sm', i === stage ? 'border-primary font-semibold' : 'border-border text-muted-foreground')}>
            {s}
          </div>
        ))}
        <motion.div
          aria-hidden
          className="absolute bottom-0 left-0 h-1 w-1/4 rounded-full bg-primary"
          animate={{ x: `${stage * 100}%` }}
          transition={{ type: 'spring', stiffness: 260, damping: 30 }}
        />
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" aria-label="Previous step" disabled={step.index <= 0} onClick={() => step.prev()}><ChevronLeft /></Button>
        <Button size="sm" variant="outline" aria-label="Next step" disabled={step.index >= step.count - 1} onClick={() => step.next()}><ChevronRight /></Button>
        <span className="text-sm text-muted-foreground" aria-live="polite">Stage {stage + 1} of {STAGES.length}: {STAGES[stage]}</span>
      </div>
    </div>
  );
}
```

### A control panel in a card

```tsx
import { Gauge } from 'lucide-react';
import { useWidgetState } from 'explainer';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';

const BRAM_BITS = 18 * 1024;

export default function FifoSizer() {
  const [depth, setDepth] = useWidgetState('depth', 512);
  const [width, setWidth] = useWidgetState('width', '32');
  const [registered, setRegistered] = useWidgetState('registered', true);
  const bits = depth * Number(width);
  const brams = Math.ceil(bits / BRAM_BITS);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Gauge className="size-4" /> FIFO sizing</CardTitle>
        <CardDescription>How depth and width map to block RAMs.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2">
          <Label htmlFor="depth">Depth: {depth} entries</Label>
          <Slider id="depth" aria-label="Depth" min={16} max={4096} step={16} value={[depth]} onValueChange={(v) => setDepth(v[0] ?? 512)} />
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <div className="grid gap-2">
            <Label htmlFor="width">Width</Label>
            <Select value={width} onValueChange={setWidth}>
              <SelectTrigger id="width" className="w-32"><SelectValue placeholder="Width" /></SelectTrigger>
              <SelectContent>
                {['8', '16', '32', '64'].map((w) => <SelectItem key={w} value={w}>{w} bits</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Switch id="registered" checked={registered} onCheckedChange={setRegistered} />
            <Label htmlFor="registered">Registered output</Label>
          </div>
        </div>
        <div className="grid gap-2">
          <div className="flex items-center justify-between text-sm">
            <span>{bits.toLocaleString()} bits in {brams} block RAM{brams === 1 ? '' : 's'}</span>
            <Badge variant={brams <= 2 ? 'secondary' : 'destructive'}>{registered ? 2 : 1}-cycle read</Badge>
          </div>
          <Progress value={(bits / (brams * BRAM_BITS)) * 100} aria-label="Block RAM use" />
        </div>
      </CardContent>
    </Card>
  );
}
```

### A table driven by the code

Parses the ports out of the `interface` anchor. Clicking a port name reveals it in the editor (a click, so `<Ref>` works); hovering a row highlights it while this step is current.

```tsx
import { highlight, Ref, useAnchorCode, useIsMyStepActive } from 'explainer';

const PORT = /^\s*(input|output|inout)\s+(?:logic|wire|reg|bit)?\s*(\[[^\]]+\])?\s*(\w+)/;

export default function PortTable({ anchor = 'interface' }: { anchor?: string }) {
  const code = useAnchorCode(anchor);
  const active = useIsMyStepActive();
  if (code === null) return <p className="text-sm text-muted-foreground">Reading the ports…</p>;
  if (code.status !== 'ok') return <p className="text-sm text-muted-foreground">The module's ports are listed in the code.</p>;
  const ports = code.text.split('\n').flatMap((text, i) => {
    const m = PORT.exec(text);
    return m ? [{ line: i + 1, dir: m[1]!, width: m[2] ?? '1 bit', name: m[3]! }] : [];
  });
  return (
    <table className="w-full text-left text-sm" onMouseLeave={() => active && highlight()}>
      <caption className="sr-only">Ports of the module</caption>
      <thead className="text-muted-foreground">
        <tr><th className="py-1 font-medium">Port</th><th className="font-medium">Direction</th><th className="font-medium">Width</th></tr>
      </thead>
      <tbody>
        {ports.map((p) => (
          <tr key={p.name} className="border-t border-border hover:bg-accent" onMouseEnter={() => active && highlight(p.line, { anchor })}>
            <td className="py-1 font-mono"><Ref anchor={anchor} lines={p.line}>{p.name}</Ref></td>
            <td>{p.dir}</td>
            <td className="font-mono">{p.width}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```
