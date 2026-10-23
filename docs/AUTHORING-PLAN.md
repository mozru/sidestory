# Authoring features for hardware sidestories: plan

> **Status: plan, not implemented.** Written 2026-10-23 and revised after two reviews: one by a hardware engineer who writes RTL sidestories, one on security, performance and correctness. It comes from a hardware team's feedback after writing real RTL sidestories. It covers eight features:
> 1. anchors with several parts;
> 2. diagram parts that light up per step;
> 3. clickable SVG;
> 4. symbol anchors;
> 5. waveforms;
> 6. theme tokens for diagrams;
> 7. a rendered preview from the checker;
> 8. diagrams that work as a live code map.
>
> Each section gives the format, the behaviour, security, performance, tests, docs and effort. The order of work, how to split it between agents, and how it fits with [NAVIGATION-PLAN.md](NAVIGATION-PLAN.md) come at the end, followed by open questions.
>
> **Wording.** User-facing text calls an explainer a **sidestory** (decided). Folders are `.sidestory/<name>/`. NAVIGATION-PLAN.md §2 does the rename and owns file names, so this plan says "the page" for the HTML file. HTML attributes keep the `data-explain-*` prefix, and elements keep the `explain-` prefix (`<explain-widget>`, and the new `<explain-wave>`).

## Contents

0. [What the code does today](#0-what-the-code-does-today)
1. [Anchors with several parts](#1-anchors-with-several-parts)
2. [Diagram parts that light up per step (`data-explain-on`)](#2-diagram-parts-that-light-up-per-step-data-explain-on)
3. [Clickable diagrams and a default look for links](#3-clickable-diagrams-and-a-default-look-for-links)
4. [Symbol anchors](#4-symbol-anchors)
5. [Waveforms](#5-waveforms)
6. [Theme tokens for diagrams](#6-theme-tokens-for-diagrams)
7. [A rendered preview from the checker (`--render`)](#7-a-rendered-preview-from-the-checker---render)
8. [Clickable diagrams as a live code map](#8-clickable-diagrams-as-a-live-code-map)
9. [Shared pieces](#9-shared-pieces)
10. [Order of work, splitting it, and NAVIGATION-PLAN.md](#10-order-of-work-splitting-it-and-navigation-planmd)
11. [Open questions](#11-open-questions)
12. [Review log](#12-review-log)

---

## 0. What the code does today

These findings shape the designs below. They were checked against the code during review.

| Finding | Where | Consequence |
|---|---|---|
| **`data-explain-ref` already works on any element, SVG included.** The sanitizer keeps `data-*` on every element. `decorateTree` sets `tabindex=0` and `role=link` (SVG elements have `tabIndex`). Clicks and Enter/Space go through `closest('[data-explain-ref]')`. | `sanitize.ts`; `main.ts` `decorateTree`, `onContentClick`, `onContentKey` | Item 3 is mostly styling, accessibility and docs. |
| **`content.css` recolors SVG links.** It gives every `[data-explain-ref]` `color` and a dotted underline, at specificity (0,1,0). In SVG that recolors `currentColor` strokes and fills, and underlines `<text>`. stream-dma works around it with `.dia [data-explain-ref] { text-decoration: none }` and explicit fills. | `content.css` | SVG and box links need their own rules (§3). |
| **`position: sticky` in the content never sticks.** The content frame is as tall as its content, and the panel scrolls (`fitFrame`). | `main.ts` `fitFrame` | One shared diagram can't stay on screen while the reader steps through prose. §2.4 handles this with copies. |
| **stream-dma repeats its diagram by hand.** The overview has its block diagram four times, with static `.focus-*` classes and hand-written dimming CSS. That accounts for most of its 86 KB. | `examples/stream-dma/.explain/dma-overview/` | `data-explain-on` replaces this pattern. |
| **Diagram links are hard for screen readers to reach.** `svg role="img"` makes its children presentational, so the box links inside stream-dma's diagrams are focusable but poorly exposed. | stream-dma pages, `tools/diagrams.py` | A diagram with links should be `role="group"` (or `figure`) with a label. The checker warns (§3.3). |
| **Ref-only anchors steal cursor-follow.** `anchorAtLine` picks the tightest anchor covering the line from every manifest anchor in the file, including anchors used only by `data-explain-ref` (stream-dma's `m-ctrl`, `m-fifo`, …). The session then makes that id active, and `decorateActive` moves the editor's focus bar to its lines. The panel ignores the `syncTo` (no section element), so the panel and the editor disagree, and the cursor doesn't reach the section that does cover the line. | `session.ts` `onSelection`; `sections.ts`; `main.ts` `followEditor` | Fix as part of §8.2. The panel tells the session which ids are sections (all `[data-explain-anchor]`, nested ones included), and cursor-follow considers only those. Until the panel has said so (first render, hidden panel), it falls back to every anchor, as today. Ref-only anchors drive the new "here" lighting instead. |
| **Image maps and `<foreignObject>` survive the sanitizer.** `<map>` and `<area>` are kept. `usemap` isn't in `URL_ATTRS`, so it's kept as written. `<area href>` goes through the link rules. `<foreignObject>` and its HTML survive. | `sanitize.ts` | Image maps and draw.io SVG need overlays and link handling, not sanitizer relaxations (§8.6, §8.7). |
| **Some attributes can fire a link without the reader aiming at it.** `accesskey` and `autofocus` survive the sanitizer. `accesskey` makes a keystroke click an element; `autofocus` plus Enter activates it. | `sanitize.ts` `DROP_ATTRS` | Drop both (§9.4). That matters more once links can open any repository file (§8.1). |
| **Panel state is namespaced but only partly protected.** The panel's own attributes are `data-cx-*` and its classes are `cx-*`. The sanitizer drops only `data-cx-hl` and resets `data-cx-props`. | `sanitize.ts`, `main.ts` | New panel state goes either in classes, which are harmless if an author writes them, or in `data-cx-*`, which the sanitizer drops wholesale (§9.4). |
| **Classes added after the morph restart transitions.** `render()` runs the morph, then `fitFrame()` (a forced style flush), then `decorate()`. A class the morph removed and `decorate` re-adds therefore restarts any transition on it. `cx-active` avoids this only because the incoming tree is decorated before the morph. | `main.ts` `render` | Every class and attribute the panel sets for these features is applied to the incoming tree before the morph, and stripped by `cleanHtml` (§9.5). |
| **`revealNow` has no containment check of its own.** It opens `fileUri(a.file)`. It's safe today only because a file outside the repository never resolves (`readInside` → `realPathInside` fails), so there's no range to reveal. | `session.ts` `revealNow` | Any new path that opens files without resolving first (§8.1 whole-file and line links) must check real paths itself. |

---

## 1. Anchors with several parts

**Problem.** One step is often about one event crossing modules: a `done` that leaves `gemm_tile_dispatch` and lands in `eai_control_done`. Today that takes a section anchor plus nested anchors. Nested anchors aren't steps, so the reader can't follow the event; they have to click.

### 1.1 Format

The single-part form stays exactly as it is. An anchor may instead have `parts`:

```json
"done": {
  "color": "charts.green",
  "highlight": ["done"],
  "parts": [
    { "label": "raised", "file": "rtl/gemm_tile_dispatch.sv", "symbol": "gemm_tile_dispatch.driver(tile_done)" },
    { "label": "seen",   "file": "rtl/eai_control.sv", "within": "eai_control.driver(done_q)", "range": [212, 214], "highlight": ["tile_done_i"] }
  ]
}
```

- **What a part has:** the fields of a single-part anchor that are about code (`file`, `range`, `quote`, `snippet` (v1), `symbol` and `within` (§4), `highlight`) plus an optional `label`.
  - A `label` uses the anchor-id grammar, up to 24 characters. It's shown in the part switcher and the Problems panel, and it addresses the part (§1.4).
- **What the anchor has:** `color`; `highlight`, which applies to every part and is merged with each part's own list; and an optional **`file`, which is the default for parts that don't name one.** "Where `in_rcvd_q` is cleared and where it's incremented" is two parts in one file.
- **Limits:**
  - 2–8 parts per anchor. A one-element `parts` is read as single-part, and the checker suggests flattening it.
  - At most **1,000 code targets** per manifest, counting each part and each single-part anchor. This bounds resolution as `LIMITS.anchors` (500) does today.
  - The existing per-quote limits apply per part.
- **The parsed model** (`core/manifest.ts`):
  - `Anchor` becomes `{ id, parts: AnchorPart[], color?, highlight }`. A single-part anchor is normalized to one part, so every consumer handles one shape.
  - `AnchorPart` is a **new type**. `AnchorSpec`, the shape thread anchors reuse (DESIGN.md §4.3), keeps `range` required and is unchanged, so the thread format doesn't drift with this feature.
  - A typed key helper (`partKey(id, i)`) replaces bare ids everywhere state is kept per code target: session `resolutions`, `hints`, `orphaned`, widget `confirmed` anchors, `decorateActive`.

### 1.2 Manifest version

- Readers accept versions **1, 2 and 3**. `SUPPORTED_VERSIONS` and `Manifest.version` widen.
- **A writer** (Pin, Re-anchor, `--pin`) sets `version` to **max(current, required)**. `required` is 3 only when an anchor has `parts`, or has `symbol` without `range`, or the manifest has a top-level `sv` block (§4.3). Otherwise it is 2.
  - A writer never downgrades a version, and never upgrades one for no reason. A v2 manifest that doesn't use the new features still opens in today's release.
  - Today `patchManifest` hard-sets `2`, so that changes, with tests for Pin on a v3 file.
- **Old readers and the new fields:**
  - Old readers ignore `symbol` on an anchor that also has `range` and `quote`, and resolve it by its quote. That degrades correctly, so it doesn't force v3.
  - Old readers also ignore `within`, so they search the quote over the whole file and may find it ambiguous. The guide notes that.
- **Ship early:** in the next release, before v3 exists, make the unsupported-version error say "Update the Sidestory extension to read it".
- `patchManifest` gains part-aware patches (`{ id, part?: number, … }`) and keeps its in-place, layout-preserving edits. A patch to `parts[i]` edits that element only.

### 1.3 Behaviour in the panel

- **Section state** is the worst state among its parts.
  - The badge names the part: "Code changed · seen".
  - The heading's tooltip lists every part with its label, file, lines and state.
  - The Re-anchor box appears when any part is stale or lost.
- **The part switcher** lives in the panel footer (trusted chrome, outside the content frame), next to "Step 3 of 7".
  - It's a button "Code 1/2 ›". Its tooltip is "raised · gemm_tile_dispatch.sv:88–92".
  - Its accessible name is "Show code part 2 of 2: seen, eai_control.sv".
  - Clicking it cycles through the parts. **H / L** in the panel go to the previous and next part; J / K stay steps.
  - The command **Sidestory: Next Code Part** gets a keybinding; it's an open question (§11).
  - **Hovering or focusing the switcher shows the other parts' code** in the §8.3 preview card, so the reader can see the sink of a handshake while the editor shows its source, without moving the editor.
  - It appears for multi-part steps only, and doesn't change the author's layout.

### 1.4 Behaviour in the editor

- **Which part a step reveals:** the part the reader last chose for that section in this panel, else part 1. It opens in the code column (`codeColumn`) as today, and the section stays one step.
  - **Two editors side by side** was not chosen as the default. The panel already takes one column, a third column at ~360 px is unreadable, and VS Code can't open an editor "below" another without layout commands that fight the user's own layout.
  - The switcher's hover card covers most of the need. A reader setting `sidestory.parts.layout: "split"` is an open question (§11).
- **Highlights in every part's file.** `Decorations.Focus` becomes `{ parts: {uri, range, highlight}[], color, dim, primary }`.
  - Every visible editor that shows a part's file gets the focus bar on that part's range, and the identifier chips.
  - Dimming fades the rest of each file that holds a part.
  - An editor opened later gets the decorations through the existing `refresh` on visible-editor changes.
- **Cursor-follow** maps a line in any part to its anchor.
  - `anchorAtLine` takes `partKey → Resolution` entries and returns `{id, part}`, with today's rule (non-stale first, then tightest), restricted to sections (§0).
  - The session posts `syncTo {anchorId, part}`, and the switcher shows "2/2", so the reader can see which part they're in.
- **Drift and live tracking** are per part: hints, orphan flags and hysteresis are keyed by `partKey`, and `resolveFile` resolves the parts in that file.
- **Addressing a part from HTML:** `anchor:label` or `anchor:n` (1-based) in `data-explain-ref` and `data-explain-on`.
  - Labels are preferred: they survive reordering the parts.
  - `:` is free because anchor ids can't contain it. It also keeps `#` for one meaning only, the fragment in `data-explain-code` (§8.1).
  - `data-explain-ref="done"` reveals part 1. `data-explain-ref="done:seen"` reveals that part.
  - `data-explain-on="done:seen"` is on while `done` is active **and** that part is the one shown.

### 1.5 Pin and Re-anchor

- **Pin Anchors** pins each part independently.
  - Its refusal list names the parts: "done · seen (eai_control.sv): out of date".
  - Its re-pin offer lists the parts as separate items.
- **Re-anchor Section to Selection.** After choosing the section, a second quick pick appears when it helps:
  - "Replace raised (gemm_tile_dispatch.sv:88–92)", "Replace seen …";
  - "**Add as a new part**", which asks for an optional label. This is how a reader turns a single-part anchor into a multi-part one without editing JSON. It writes `parts` and `version: 3`.
  - Single-part anchors offer "Replace" (the default, as today) and "Add as part 2".
  - Removing a part is a JSON edit; the guide shows it.
- **The checker:** `--pin` pins per part. Its consent list for anchors that widgets read is per part (file and line range).

### 1.6 Checker

- Validates `parts`: count, labels (unique within the anchor, valid grammar), the default `file`.
- Resolves and reports each part: `manifest.json: done · seen (rtl/eai_control.sv): code not found`.
- With `--json`, each anchor has `parts: [{label?, file, range, state, symbol?}]`.
- Validates `anchor:part` references in `data-explain-ref` and `data-explain-on`.

### 1.7 Widgets

- **`useAnchors()`:** each entry gains `parts: {label?, file, range, state}[]`. Its `file` and `range` are part 1's and its `state` is the section's, so existing widgets keep working.
- **`useAnchorCode(id)`:**
  - The result gains `parts: AnchorCode[]`, one per part, each `ok` or `unavailable` on its own terms. The top-level fields stay part 1's.
  - Every serving rule (pinned, committed or confirmed, not ignored, not secret-looking, ≤ 2,000 lines) applies **per part**.
  - The consent dialog and `--yes-widgets-may-read` list every part's file and lines.
- **`highlight(lines, { anchor, part })` and `reveal(id, { part, lines })`:** `part` is a label or a 1-based number, and defaults to 1.
- **`useStep()`** gains `part` (the part shown) and `setPart(p)`, which needs a click, like `reveal`.
- **The analyzer:** `anchorsRead` counts `useAnchorCode('done')` as reading every part of `done`.

### 1.8 Security

- Each part's `file` goes through `isSafeRelativePath` and the real-path check, exactly like a single anchor.
- Widget code access is per part, so a part can't ride on a sibling's consent.
- The 1,000-target cap bounds resolution. The per-anchor `WORK_BUDGET` applies per part.

### 1.9 Performance

- Resolution cost scales with targets, capped at 1,000, twice today's 500.
- `resolveFile` already groups work by file and slices at `SLICE_MS`, so this adds no new hot path.
- Decorations apply per visible editor, with at most 8 parts each.

### 1.10 Tests

- **Unit:**
  - `manifest`: the parts schema, the default `file`, labels, limits, the version rule (`max(current, required)`), normalization, and that `AnchorSpec` for threads still requires `range`.
  - `manifest-edit`: patching `parts[i]`, keeping the layout, Pin on a v3 file keeping v3, no upgrade without new features.
  - `sections`: `anchorAtLine` over parts, sections only.
  - `decorations`: focus across several files.
  - `pin`: per-part refusals.
  - `check-cli`: per-part findings, and `anchor:part` validation.
  - `widgets-host`: per-part serving and consent listing.
- **Playwright panel:** the footer switcher (click, H/L, accessible name, the hover card), the per-part badge, `syncTo` with a part, and `data-explain-on="done:seen"`.
- **e2e:**
  - Stepping to a two-part section reveals part 1.
  - The switcher reveals part 2 in the code column.
  - The cursor in part 2's file selects the section and shows "2/2".
- **Desktop:** the same on CRLF files. Re-anchor "Add as a new part" writes v3, and the panel updates live.

### 1.11 Docs

- **GUIDE:**
  - Under *Link sections to code*, a new part "One step, several places in the code".
  - The manifest table gains `parts`, `label`, the default `file` and version 3.
- **WIDGETS §6:** `parts`, the `part` options, `setPart`.
- **README:** one line in *Stays in sync*.
- **SKILL.md:** "When a step follows one event across modules (a `done` that leaves one block and lands in another), use one anchor with labelled `parts`, not nested anchors."

**Effort:** about 6 agent-days:
- core and manifest: 1.5;
- session and decorations: 1.5;
- panel footer and hover: 0.5;
- Pin and Re-anchor: 1;
- widgets: 1;
- checker and docs: 0.5.

---

## 2. Diagram parts that light up per step (`data-explain-on`)

**Problem.** Hardware sidestories are diagrams plus prose. What the team's own pages do, and plain HTML can't, is light up the boxes and wires each step is about and fade the rest. stream-dma fakes it with four copies of the diagram and static classes.

### 2.1 Format

```html
<figure data-explain-diagram>
  <svg viewBox="0 0 1100 610" role="group" aria-label="Block diagram of dma_top">
    <g data-explain-on="datapath backpressure" data-explain-ref="m-fifo">…FIFO box…</g>
    <g data-explain-on="datapath">…rd_rsp_data wire…</g>
    <g data-explain-on="control errors">…start strobe…</g>
    <g data-explain-on="">…a wire no step is about: fades whenever something is on…</g>
    <g>…legend: never fades…</g>
  </svg>
</figure>
```

- **`data-explain-on="<id> [<id>…]"`:** space-separated anchor ids, optionally with a part (`done:seen`, §1.4), on any SVG or HTML element (and on `<area>`, §8.6).
  - An element is **on** when one of its ids is the active anchor, or the step that contains it (`activeStepId()`).
  - An **empty** value marks a participant that is never on: it fades whenever something else is on.
  - Untagged elements are left alone by default, which keeps legends, titles and grids readable.
- **The scope** is where fading is computed: the nearest ancestor with `data-explain-diagram`, else the outermost `<svg>` ancestor.
  - A tagged element outside both (a table row in prose) still gets `cx-on`, but nothing fades around it.
- **`data-explain-diagram` takes space-separated words:**
  - `step` (the default): follows the active step.
  - `section`: always shows its own section's state, whatever step is active. This is right for per-section copies (§2.4), for the render (§7) and for print.
  - `dim-rest`: also fades **untagged content**, so authors don't have to tag every background wire.
    - The panel fades whole untagged subtrees. Each one gets a single `cx-dim` on its outermost element (a `<g>`, a leaf shape, or an HTML element) that holds no tagged element and isn't inside one.
    - **Never faded:** anything inside `<defs>`, `<marker>`, `<pattern>`, `<clipPath>`, `<mask>`, `<symbol>`, `<linearGradient>`, `<radialGradient>` and `<filter>`. These aren't drawn directly, and fading a marker's `path` would fade the arrowheads of lit wires too. Anything inside an element marked **`data-explain-keep`** (a legend or title) isn't faded either.

### 2.2 Behaviour

- **The panel sets the classes, as it does `cx-active`.** The content stays script-free. The panel computes:
  - `cx-on` on each element that is on;
  - **`cx-dim`** on exactly the elements that should fade: the outermost participants (tagged, or untagged graphics under `dim-rest`) that are not on, have no on descendant, and have no on or fading ancestor;
  - `cx-dimming` on a scope while anything in it is on.

  With nothing on, nothing changes, and the diagram looks as authored. Computing `cx-dim` in the panel rather than in CSS avoids two traps:
  - a tagged element nested inside a lit group fading inside it;
  - nested tagged elements multiplying their opacity (0.28² ≈ 0.08).

  It also keeps `:has()` out of the CSS, so there's no `:has()` invalidation cost.
- **Where it happens:** in `markActive()`, from structures cached per render in `decorate()`.
  - Per scope: its participants, its on-candidates by id, and its parent links.
  - The cache is keyed per scope, because `section` scopes light the same id differently from `step` scopes.
  - A step change touches only the elements whose state changes.
- **No flicker on live edits.** The classes are computed on the incoming tree before the morph (§9.5), and `cleanHtml` strips them so they never count as an author's edit. Otherwise `fitFrame`'s style flush would restart the transition on every keystroke.
- **Default styles** (`content.css`), inside `:where()` so any author rule wins:

  ```css
  :where([data-explain-diagram] *, svg *, [data-explain-on]) { transition: opacity 160ms ease; }
  :where(.cx-dim) { opacity: var(--cx-dim-opacity); }
  ```

  - Lit elements aren't recolored by default, because emphasis is diagram-specific.
  - Authors use the `--cx-on` token (§6): `.cx-on .wire { stroke: var(--cx-on); stroke-width: 3 }`.
  - The panel sets `--cx-step-accent` on the content root to the active section's accent, and `--cx-on` defaults to it. A diagram that sits in section 1 but lights up for step 5 takes step 5's color.
- **Reduced motion:** no transition, whether from `prefers-reduced-motion` or VS Code's `workbench.reduceMotion` (which the panel already mirrors).
- **High contrast:**
  - No fading, which matches the editor's `dimUnfocused`: `--cx-dim-opacity: 1` under `.vscode-high-contrast*` and `forced-colors: active`.
  - Lit elements get `outline: 2px dashed var(--vscode-contrastActiveBorder)` with `outline-offset: 2px`.
  - Chromium paints outlines on SVG graphics elements. Playwright confirms that before shipping, with a `drop-shadow` ring as the fallback.
- **Hover and focus are not followed by default.**
  - The lit state matches the editor's highlight, so the two always agree, and a reader hovering prose doesn't expect the diagram to change.
  - Authors can write a hover preview themselves with `:has()`; the guide gives the recipe: `.cx-content:has([data-explain-ref~="m-fifo"]:hover) [data-explain-on~="datapath"] { … }`.
  - Lighting from the editor cursor is §8.2, a separate class.
- **Widgets:** a widget inside a faded element is unaffected, since opacity isn't a placement problem. `useStepValue` already covers widgets.

### 2.3 Which ids are valid

The checker warns:
- `unknown-anchor`: an id isn't in the manifest;
- `never-on`: an id never becomes active, because no `data-explain-anchor` in the page uses it;
- `empty-diagram`: a `data-explain-diagram` holds no participants.

It notes (info) a tagged element with no scope: it lights up but fades nothing.

### 2.4 One diagram shared by sections, or one per section

The panel scrolls, not the frame, so a single diagram in section 1 is off screen by step 5. There are three supported patterns:

1. **One per section,** as stream-dma does. Every copy follows the active step. `data-explain-diagram="section"` makes each copy show its own section's state, which reads better when two copies are on screen at once.
2. **`data-explain-copy="<id>"` (new):** an empty placeholder the panel fills with a deep clone of the element with that id (a `data-explain-diagram` or an `svg`) in the same page.
   - **The clone is filtered.** It drops `data-explain-anchor` (no new steps), `data-explain-detail`, `data-explain-copy` (no recursion), `<explain-widget>` and `<explain-wave>`. Waves render once in the source, and the clone gets their rendered SVG, not their props.
   - **Ids:** an element that an IDREF inside the clone points at (`aria-labelledby`, `aria-describedby`) gets the per-copy id `cx-copy-<n>-<id>`, and the IDREF is rewritten to match. **Every other id is removed,** so `url(#arrow)` and `<use href="#…">` still resolve to the original's definitions.
   - **Waves:** `<explain-wave>` is unwrapped. The clone keeps the wave's rendered box, without the element or its props.
   - **Code links:** each `data-explain-code` in the source gets its effective value (the `data-explain-code-file` inheritance applied, §8.1) before copying. The value is stored marked, so `cleanHtml` restores what the author wrote. A clone placed under another ancestor then still opens the right file.
   - The placeholder's own `data-explain-diagram` applies to the clone, usually `section`.
   - **`data-explain-view="x y w h"`** on the placeholder overrides the clone's `viewBox`, so a section about the FIFO can show the diagram zoomed in on it.
   - Links inside the clone work. Author CSS that targets `#id` doesn't match the clone, and the guide says so.
   - **Order and caching:** copies are made in one non-recursive pass, after waves (§5) and inlined SVG (§8.7), on the incoming tree before the morph. Each clone is cached by a key over:
     - the source subtree as it stands after steps 1–3 of §9.3, with its rendered waves and inlined SVG;
     - the theme kind;
     - the versions of the inlined assets.

     So typing elsewhere doesn't re-clone 50,000 nodes, and a changed `arch.drawio.svg` or a theme switch does update every copy.
   - **Limits:** 16 copies per page and 50,000 cloned nodes in all. Past that, an Output note and an empty placeholder.
   - This takes stream-dma's overview from four 20 KB copies to one.
3. **A diagram at the top of the page** with short sections under it. This needs nothing new.

SVG `<use href="#dia">` also works for copies that all show the same state. Its instances can't be clicked as links, since events retarget to `<use>`, and they can't differ per section, so the guide recommends `data-explain-copy`.

### 2.5 Security

- No sanitizer relaxation: `data-explain-*` attributes already survive.
- The panel only toggles classes and clones already-sanitized nodes.
- The clone filter means a copy can't add steps, widgets, detail links or recursion.
- The `cx-*` classes are harmless if an author writes them: they only style.

### 2.6 Performance

- `markActive` costs O(elements whose state changes).
- Opacity transitions on SVG children repaint the SVG on the main thread for about 10 frames. **The budget is frame time, not style time:** for 2,000 participants, a step change keeps every frame under 16 ms in `perf.pw.ts`.
- Above 5,000 **tagged** elements in a page, the panel stops lighting and logs once.
  - Untagged subtrees under `dim-rest` don't count toward this cap: each fades as one element. A 20,000-shape draw.io export with 30 tagged boxes stays well under it.

### 2.7 Tests

- **Unit** (the extracted content modules, §9.3):
  - id matching: a step vs a nested anchor, `anchor:part`;
  - scope selection;
  - the `cx-dim` computation: nested tagged, a tagged child inside a lit group, `dim-rest` with `data-explain-keep`, empty `data-explain-on`;
  - `section` mode, cached per scope;
  - `data-explain-copy`: filtering (anchors, widgets, details, self-reference), id and IDREF rewriting, `data-explain-view`, limits, caching;
  - `cleanHtml` stripping every new class.
- **check-cli:** the findings above.
- **Playwright panel:**
  - stepping lights and fades the right elements, and nothing fades when nothing is on;
  - **a live edit keeps the state with no transition restart:** computed opacity is checked in the same frame after the morph;
  - a pure step change produces no `cx-updated` and no "updated" announcement;
  - reduced motion has no transition;
  - HC shows the outline and no fading;
  - `perf.pw.ts` measures frame time at 2,000 participants.
- **e2e:** the stream-dma overview, converted (§6.4): Alt+] steps light the diagram.

### 2.8 Docs

- **GUIDE:** a new subsection "**Diagrams that follow the steps**": the attributes, scopes, `dim-rest` and `data-explain-keep`, `section` mode, copies and `data-explain-view`, the hover recipe, HC behaviour.
- **WIDGETS §1 table:** "A diagram that changes per step" → `data-explain-on`.
- **SKILL.md:** "Draw one block diagram. Put `data-explain-diagram="step dim-rest"` on it, tag boxes and wires with `data-explain-on` for the steps they matter in, and mark the legend `data-explain-keep`. To repeat it in later sections, use `data-explain-copy` with `data-explain-diagram="section"`."

**Effort:** about 3.5 agent-days, plus 2 for `data-explain-copy`.

---

## 3. Clickable diagrams and a default look for links

### 3.1 What works already

Clicks, Enter and Space, `tabindex` and `role=link` all work on SVG elements (§0). The gaps are styling, accessibility, documentation and image maps (§8.6).

### 3.2 A built-in look for linked elements, SVG and HTML

This applies to `data-explain-ref` and `data-explain-code` (§8.1). It replaces today's single `[data-explain-ref]` rule. All rules are inside `:where()`, so author CSS wins without `!important`.

| Element kind | Rest | Hover | Keyboard focus |
|---|---|---|---|
| **Text links**: `a, span, code, abbr, b, strong, em, i, kbd, var, samp` outside SVG | link color, dotted underline (as today) | `--vscode-textLink-activeForeground` | outline `1px solid var(--cx-link-ring)` |
| **Boxes**: any other HTML element (`div`, `li`, `td`, `figure`, `img`) | `cursor: pointer`, no color change | `outline: 1px solid var(--cx-link-hover)`, `outline-offset: 2px` | `outline: 2px solid var(--cx-link-ring)`, `outline-offset: 2px` |
| **SVG elements**: anything inside an `svg` | `cursor: pointer`. Never `color` or `text-decoration`, so `currentColor` and `<text>` stay as authored. | `filter: drop-shadow(0 0 1px var(--cx-link-hover)) drop-shadow(0 0 2px var(--cx-link-hover))` | `outline: 2px solid var(--cx-link-ring)`, `outline-offset: 2px`; the drop-shadow ring is the fallback if outline doesn't paint (checked in Playwright) |

- **Tokens** (§6):
  - `--cx-link-hover` defaults to `--vscode-textLink-foreground`.
  - `--cx-link-ring` defaults to `--vscode-focusBorder`, and to `--vscode-contrastActiveBorder` in high contrast.
  - Setting either to `transparent` turns that effect off.
- **Opting out:** `data-explain-plain` on the linked element removes every built-in rule except `cursor`. It's an attribute rather than a class so the checker can see it.
- **Consistent everywhere:** these are the panel's rules, so links look the same in every sidestory, and stream-dma's override goes (§6.4).

### 3.3 Accessibility

- **Diagrams with links.** An SVG that contains links should be `role="group"` (or `figure`) with `aria-label`, not `role="img"`, whose children are presentational.
  - The checker warns (`links-in-img`), and stream-dma and `diagrams.py` are fixed.
  - The panel doesn't rewrite the author's `role`. Rewriting ARIA silently is surprising, and the checker catches it.
- **Names.** A linked `<g>` takes its name from its text. The checker notes (info, `ref-no-name`) a linked element with no text, `aria-label` or `<title>` child. In SVG, `<title>` gives both a name and a native tooltip.
- **Tab order** is document order, and `diagrams.py` emits blocks in reading order. There are no arrow keys inside a diagram: 12 boxes are 12 Tab stops, which is predictable.
- **Focus in HC** uses `--cx-link-ring`'s HC mapping above.

### 3.4 Security

No new surface: the same attributes and handlers. The opt-out is a boolean attribute.

### 3.5 Tests

- **Playwright panel:**
  - a `<g data-explain-ref>` with `stroke="currentColor"` keeps its computed stroke;
  - hover adds a filter;
  - Tab focus shows an outline, as screenshot diffs in light, dark and HC;
  - Enter and click post `openRef`;
  - `data-explain-plain` removes the look;
  - text links look as before.
- **check-cli:** `links-in-img`, `ref-no-name`.

### 3.6 Docs

- **README** *Linked both ways*: "Links in the text **and boxes or wires in a diagram** show their code when clicked", with a two-line SVG example.
- **GUIDE** *Link sections to code*: `data-explain-ref` on any element, an SVG `<g>` example, the built-in look and the opt-out, `role="group"`.
- **SKILL.md:** "Make diagram boxes clickable with `data-explain-ref` on their `<g>`. Give the `<svg>` `role="group"` and an `aria-label`."

**Effort:** about 1.5 agent-days.

---

## 4. Symbol anchors

**Problem.** Pinned quotes survive moves and small edits. RTL gets reformatted (verible-verilog-format, re-wrapped port lists, re-aligned assignments), and that changes line breaks. The whitespace-normalized, line-based quote then reads as "Out of date". Authors would rather say *what* the anchor is: whatever drives `state_q`.

### 4.1 Format

```json
"regs":    { "file": "rtl/dma_ctrl.sv", "symbol": "dma_ctrl.driver(state_q)" },
"ports":   { "file": "rtl/dma_ctrl.sv", "symbol": "dma_ctrl.header" },
"credit":  { "file": "rtl/dma_ctrl.sv", "symbol": "dma_ctrl.driver(credit_ok)", "range": [56, 59], "quote": { … } },
"control": { "file": "rtl/dma_top.sv",  "symbol": "dma_top.u_csr..u_wr_agen" },
"fsm":     { "file": "rtl/dma_ctrl.sv", "within": "dma_ctrl.driver(state_d)", "range": [70, 126], "quote": { … } }
```

- **`symbol`:** the anchor *is* that symbol, or that run of sibling symbols (`a..b`), and its range is the current extent.
  - `range` and `quote` are optional with `symbol`. An author or agent can write `{file, symbol}` with no line numbers, and Pin fills in `range` and `quote`. Until then the manifest is v3 (§1.2).
- **`within`:** the anchor is its quote, searched **only inside** that symbol's extent.
  - Use it for a step about part of a block. stream-dma's `fsm` anchor is the `case` inside `always_comb`, not the defaults above it.
  - It also disambiguates duplicates (the same `if (!rst_n)` in five blocks), and it survives moves farther than the resolver's 5,000-line `SCAN_RADIUS`.
  - It needs `range` or `quote`.
- `symbol` and `within` are exclusive.
- Both are strings of at most 200 characters, matching the grammar below. They are never compiled into a RegExp.
- **Compatibility.** DESIGN.md §4.2 reserved `symbol` with another meaning ("range relative to the symbol"). That was never implemented. The DESIGN decision log records the change.

### 4.2 Symbol paths for SystemVerilog and Verilog

Paths are scoped by **module definition**, with `.` between names as in SystemVerilog hierarchical names, and `::` for package scope only, as in the language.

| Target | Path | Extent |
|---|---|---|
| module, interface, program, package, class | `dma_ctrl`, `axi_if`, `dma_pkg` | keyword to `end…`, header included |
| module header (parameters and ports) | `dma_ctrl.header` | keyword to the `);` that ends the port list |
| port (ANSI or non-ANSI), net or variable, `parameter`/`localparam`, `typedef`, enum, `genvar`, `modport`, `clocking` | `dma_ctrl.state_q`, `dma_ctrl.BW`, `axi_if.mst`, `dma_pkg::req_t` | the declaration statement; for a port, its line(s) in the header up to its comma |
| **what drives a signal** | `dma_ctrl.driver(state_q)` | the `always*` block, `assign`, net declaration assignment (`wire x = …`) or recognized flop macro (§4.3) that assigns it |
| the kind-specific forms (optional) | `always_ff(x)`, `always_comb(x)`, `always_latch(x)`, `always(x)`, `assign(x)` | as `driver(x)`, restricted to that kind |
| a `case` item | `dma_ctrl.driver(state_d).case(WAIT_DATA)` | the item of the block's **outermost** `case` whose label list contains `WAIT_DATA` (labels compared as tokens, so `2'b10` and `{a, b}` work), to the end of its statement. A label found only in a nested `case`, or in two `case` statements at the outermost level, is `symbol-ambiguous`; the fix is a labelled `begin : …`. |
| instance | `dma_top.u_ctrl` | the instantiation statement, parameters and connections included |
| one port connection | `dma_top.u_ctrl(.rd_start)` | the `.rd_start(…)` connection, or `.rd_start` in the implicit form, with its line(s) |
| function, task | `dma_ctrl.next_len` | to `endfunction` / `endtask` |
| labelled block or statement (`always_ff begin : seq`, `label: always_ff …`, a generate `for`/`if` `begin : g_lane`, `a_no_ovf: assert property …`) | `dma_ctrl.seq`, `dma_packer.g_lane`, `dma_fifo.a_no_ovf` | the whole construct; a generate block's `for`/`if` header is included |
| inside a labelled generate block | `dma_packer.g_lane.driver(lane_q)` | as above |
| a run of sibling statements in one scope | `dma_top.u_csr..u_wr_agen`, `dma_fifo.driver(full)..driver(almost_full)` | from the first's start to the last's end. **Errors:** the two ends in different scopes, or the end before the start (after a reorder). Code inserted between them is included, so the run grows; the checker notes it when the extent passes the pinned range. |

**What counts as driving `x`** (in the scanner corpus, §4.10):
- `x` as the target of `=`, `<=`, `+=` and the other compound assignments, `x++` / `++x`, at statement position. A `<=` inside an expression (`if (cnt <= MAX)`) is a comparison, not an assignment.
- Every element of a concatenation target: `{carry, sum} = …` drives both.
- A bit, part or field select (`x[3] <=`, `x.f =`) drives `x`.
  - When different blocks drive different slices, the select can be part of the key, compared as tokens: `driver(x[7:4])`.
  - For interface and struct members, the longest dotted prefix that's unique wins: `driver(bus.valid)`.
- Assignments inside `for` loops and with intra-assignment delays (`<= #1 …`).

**What `driver()` doesn't do: cross instance ports.**
- A net in a top-level module that is driven only by an instance's output (`rd_start` in dma_top, driven through `u_ctrl`'s `.rd_start`) has no driver in that file. Neither has an input port (`rd_rsp_valid` in dma_rd_port).
- In both cases, `symbol-missing` lists what does mention the signal: "rd_start is connected at `dma_top.u_ctrl(.rd_start)`; it's driven inside dma_ctrl: `dma_ctrl.driver(rd_start)`", or "rd_rsp_valid is an input port: `dma_rd_port.rd_rsp_valid`".
- The guide says the same, and suggests a two-part anchor (the driver in the child module, plus the connection) for a wire in a top-level diagram.

**How names are chosen and checked:**
- **Pin and Re-anchor write `driver(…)`** with the signal a reader would name. In order:
  1. a signal in the anchor's `highlight` list that this block drives;
  2. otherwise, the first signal assigned in the functional branch.

  **The functional branch** is the `else` of a top-level `if` whose condition is the reset. The reset is recognized in either of two ways:
  - an identifier with a **whole segment** that names a reset. Identifiers are split on `_` and at case changes, then compared case-insensitively against `rst`, `rstn`, `rsti`, `rstni`, `reset`, `resetn`, `arst`, `arstn`, `areset`, `aresetn`, `srst`, `srstn`, `por`, `porn`; in general, any segment matching `n?(rst|reset)[nb]?i?` (so also `nrst`, `nreset`, `rstb`, `resetb`) or `por`. This matches `rst_n`, `rst_ni`, `aresetn`, `ARESETn`, `arst_n` and `por_n`. It doesn't match `first_q` or `wr_burst_len`, where `rst` is only part of a word;
  - a signal in the `always_ff` sensitivity list with an edge that isn't the clock (`negedge por_n`).

  With no such `if`, it's the whole body.
  - In dma_csr, rule 2 gives `irq_en_q`, the first assignment in its `if (csr_we)` decode. With `highlight: ["done_q"]`, rule 1 gives `done_q`.
  - The quick pick lists every alternative.
- **The kind forms** (`always_ff(x)`) are accepted for authors who want them.
  - A kind mismatch, such as a Verilog-2001 `always @(posedge clk)` later rewritten as `always_ff`, still resolves, with an info finding (`symbol-kind`).
  - The guide and the skill teach `driver(x)` only.
- **Ambiguity is an error, not a guess.**
  - Two blocks that drive the same `x` (with no slice key), or a name declared twice, is reported by the checker with both locations and "add a label (`begin : seq`)".
  - There are no ordinal suffixes: they break exactly when code is reordered.
  - `` `ifdef`` arms are the exception (§4.3).
- **Unqualified names** (`state_q`, no module) are accepted when unique in the file. They're useful for one-module files and are the short form in `data-explain-code` (§8.1).
- **Instance paths** like `dma_top.u_ctrl.state_q` read like SystemVerilog hierarchy, so authors and LLMs will write them. When such a path doesn't resolve as a definition path and its middle segment names an instance, the checker reports `instance-path`: "Paths are by module, not instance: did you mean `dma_ctrl.state_q` in rtl/dma_ctrl.sv?". Following instances across files is an open question (§11).
- **Extents include the comment block directly above** a symbol: consecutive comment lines with no blank line between them and the code, plus any attributes. That comment is usually the "why", and it's what authors anchor by hand. Every stream-dma anchor written by hand includes it.
  - A comment edit makes the anchor `changed`, which is right: the prose may depend on it.
  - The `header` of a module includes the file's leading comment only when it directly precedes the module.
- **Not addressable in v1:**
  - unlabelled generate blocks: `genblkN` numbering is easy to get subtly wrong, so the checker suggests a label;
  - macro-generated code other than flop macros the manifest declares (§4.3);
  - `` `include``d files: the anchor names the included file itself;
  - class methods beyond `pkg::cls.method`.

### 4.3 The built-in SystemVerilog scanner (`src/core/symbols/sv.ts`)

The CLI can't use VS Code providers, and most RTL users have no SystemVerilog language server. So the scanner is a tokenizer plus a structural pass, not a parser.

- **Tokenizer:**
  - `//` and `/* */` comments, kept as tokens for extents;
  - strings with escapes;
  - attributes `(* … *)`;
  - escaped identifiers (`\bus[0] `);
  - sized and unsized literals (`8'hFF`, `'0`, `'{`), time literals;
  - `` `define`` bodies with line continuations (skipped);
  - other macro uses as opaque tokens, with balanced parentheses skipped;
  - `` `include``, `` `timescale`` and the like ignored.
- **`` `ifdef`` / `` `ifndef`` / `` `elsif`` / `` `else`` / `` `endif``.** Arms often open a scope differently:

  ```systemverilog
  `ifdef ASYNC_RST always_ff @(posedge clk or negedge rst_n) begin `else always_ff @(posedge clk) begin `endif
  ```

  So the scanner never reads two arms in sequence.
  - Each arm is scanned against **a copy of the scope stack**, and the scan continues after `` `endif`` from **one chosen arm's** stack.
  - The chosen arm is the one the defines select: the manifest's `sv.defines` (below) or the checker's `--define NAME`, else the first arm.
  - Symbols declared in the arms not chosen are still recorded, tagged with their arm. They resolve only when no chosen-arm symbol has the name, with an info finding (`symbol-in-ifdef`).
- **Structure:** a stack of scopes with their end keywords.
  - Scopes: `module` / `macromodule` / `interface` / `program` / `package` / `class` / `checker`; `function` / `task` (`extern` and `pure virtual` prototypes have no body); `generate` / `endgenerate`; `begin` / `end` with labels; `fork` / `join*`; `case*` / `endcase` with item labels.
  - Bodies skipped: `specify`, `covergroup`, `property`, `sequence`, `clocking`, `primitive`.
  - Statement extents for `always*` without `begin`: `if` / `else` chains, `case`, and a single statement to its `;`.
  - Declarations: statements in a module scope that start with a data or net type (`logic`, `wire`, `reg`, `bit`, `int`, or a user type followed by an identifier), plus `parameter` / `localparam`, `typedef`, `genvar`, `modport`, and instantiations (`identifier [#(…)] identifier (…);`).
- **Flop and assignment macros** (lowRISC / OpenTitan style `` `FF(state_q, state_d, IDLE) ``). A manifest may declare them:

  ```json
  "sv": { "defines": ["SYNTHESIS"], "macros": { "FF": { "drives": 1 }, "FFL": { "drives": 1 } } }
  ```

  - A declared macro used as a statement drives its N-th argument (1-based). Its extent is the macro name plus its balanced parentheses, and a trailing `;` if there is one: lowRISC calls usually have none.
  - `sv` is a top-level, optional manifest block (v3). It's untrusted input:
    - names must match the identifier grammar;
    - at most 64 defines and 64 macros;
    - `drives` must be 1–16;
    - macros are looked up in a `Map` (or with `Object.hasOwn`), so `constructor` and `__proto__` are never "declared".
  - The checker accepts `--define NAME` too. **`--define` replaces the manifest's `sv.defines` when given;** it never merges with them, so a run's arm choice is the one on its command line.
  - A folder-wide config shared by all sidestories in a `.sidestory/` folder is an open question (§11), since NAVIGATION-PLAN.md owns that folder's layout.
- **Recovery.** When ends don't balance (unsupported syntax, a half-typed edit), the scanner closes scopes at the next matching end keyword and marks the result `partial`.
  - A partial scan never yields *ambiguous* or *missing* on its own: the resolver falls back to the quote (§4.5).
- **Scope of support.** The goal is the RTL teams write: synthesizable SystemVerilog and Verilog-2001, plus common testbench and assertion constructs. It is not UVM classes in depth or SV-2017 corner cases. The test corpus (§4.10) defines "supported".
- **Output:** `SymbolTable { symbols: {path, kind, aliases[], extent: LineRange, arm?}[], partial }`.
  - It is cached per (file, content hash) in the CLI and per (uri, document version) in VS Code. Both keys also include the sorted defines and the declared macro set: two sidestories with different `sv` blocks can share an RTL file without sharing an arm choice.
- **Cost.**
  - Files up to the existing 10 MB code limit, and a token budget of 20 M, after which the table is `partial`.
  - In the extension host the scan is **sliced** (yielding every `SLICE_MS`, like `resolveFile`, and abandoned when a newer document version arrives).
  - Files over 1 MB are rescanned only after 1 s without edits.

### 4.4 Other languages

- **In VS Code, for SystemVerilog and Verilog, the built-in scanner is authoritative,** even when a language server is installed.
  - The user's direction was to prefer `executeDocumentSymbolProvider` for every language. This plan departs from it here, because SV servers name always blocks differently, or not at all, and the CLI and the editor must agree on what `dma_ctrl.driver(state_q)` means.
- **In VS Code, every other language** uses `vscode.executeDocumentSymbolProvider`.
  - A path is the chain of `DocumentSymbol.name`s joined with `.` (`RetryClient.send`). Flat `SymbolInformation` results use `containerName`.
  - Results are cached per document version.
  - More than 2 s, or no provider at all, means "symbol unavailable", and the anchor resolves by its quote.
  - TypeScript and Python have providers built in. Language servers are often off in Restricted Mode; quotes cover that.
- **In the CLI, symbol anchors in other languages are resolved by their quote,** with an info finding `symbol-unchecked` ("checked only in VS Code").
  - A TypeScript scanner that names things exactly as tsserver does (arrow functions assigned to `const`s, object-literal methods, overloads) is a moving target. A mismatch would make the CLI and the editor disagree, which is worse than not checking.
  - A Python scanner (indentation-scoped `def` and `class`) is cheap, and is a follow-up (§11).

### 4.5 Resolution and precedence

The resolver (`core/resolve.ts`) gains a symbol step before the quote search.

1. **Find the symbol, giving extent E.** The result is found, missing, ambiguous, or unavailable (no table, a partial scan that didn't find it, or a provider timeout).
2. **`symbol` anchors when E is found.** Compare the quote with E's text as a token stream: whitespace and line breaks ignored, comments kept.
   - Equal tokens: `exact` (or `moved`). Reformatting is invisible.
   - Otherwise similarity gives S:
     - **S ≥ 0.5:** E, with the state from `classify` (changed or stale). A symbol anchor whose name still exists is never `lost`.
     - **S < 0.5, and the quote resolves elsewhere unambiguously as exact or moved:** **the quote wins**. Someone gave the name to other code, and the code the prose describes is elsewhere. State `changed`, flag `symbol: 'mismatch'`.
     - Otherwise: E, `stale`.
3. **E missing or ambiguous:** quote resolution as today, with the state capped at `changed` ("Code changed: symbol not found") even if the quote matches exactly, so the author notices the rename. Lost if the quote isn't found either.
4. **E unavailable:** quote resolution as today, with no cap.
5. **`within` anchors:** the quote search runs on the slice E, offset by E's start.
   - If nothing in E scores above `lost`, the whole file is searched.
   - A match outside E is capped at `changed`, flag `within: 'outside'`.
6. **A symbol anchor with no quote yet:** E, state `exact` (nothing to compare), plus "not pinned", as for range-only anchors today.

`Resolution` gains `symbol?: 'ok' | 'missing' | 'ambiguous' | 'mismatch' | 'unavailable'` and `method: 'symbol'`. The panel's badge tooltips and the checker phrase these.

**Live edits.** The symbol table is recomputed per document version, debounced with the existing resolve delay; a 10,000-line file scans in roughly 5–10 ms. `trackRange` hints still apply to the quote path.

### 4.6 Pin and Re-anchor

- **Pin** keeps `symbol` and `within`, and re-records `range` and `quote` from the current extent. A symbol anchor is confident whenever its symbol is found, unless the state is `mismatch`.
- **Re-anchor Section to Selection.** The selection is trimmed of blank lines first, and matching tolerates the comment block above.
  - **When it's exactly one symbol's extent,** or a run of siblings, the quick pick offers "**dma_ctrl.driver(state_d)** · follows the code through reformatting" first, then "Lines 61–126".
  - **When it's strictly inside one symbol,** it offers "Lines 70–126 **inside** dma_ctrl.driver(state_d)" (`within`), then plain lines.
  - The extents come from the scanner for SV, and from the provider otherwise.
- **The checker:**
  - `--pin` fills `range` and `quote` for symbol-only anchors.
  - `--pin --symbols` (SV only) upgrades existing anchors. Each anchor whose pinned range is exactly a symbol, or a run of siblings (comments tolerated), gets `symbol`. Each anchor whose range lies strictly inside one symbol gets `within`.
    - On stream-dma that covers:
      - module headers (`header`);
      - instance runs (`control`, `datapath`);
      - consecutive `assign`s (`backpressure`);
      - a commented driver (`credit`);
      - regions inside a block, via `within`: `fsm`, and `abort`, which is an `if` inside `always_comb`.

      The test in §4.10 asserts it.
    - **It shows what it would change and how ranges move**, because comment-inclusive extents grow them. For example: `ports: 10–43 → 1–43 (dma_ctrl.header, includes the file comment)`.
      - With `--dry-run`, it only prints.
      - An anchor whose range would grow by more than 5 lines is left alone unless `--pin --symbols --accept-growth` is given.
  - Without `--symbols`, an info finding (`could-be-symbol`) names the path to add.

### 4.7 Checker findings

| Code | Severity |
|---|---|
| `symbol-syntax` (not a valid path) | error |
| `symbol-missing` | error when the quote doesn't resolve either; warning when it does |
| `symbol-ambiguous` (candidates' lines, "add a label") | error |
| `instance-path` (with the definition path to use) | error |
| `symbol-mismatch` | warning |
| `within-outside` | warning |
| `symbol-partial-scan` (the file didn't scan cleanly; quote used) | info |
| `symbol-in-ifdef` | info |
| `symbol-kind` | info |
| `symbol-unchecked` (not SV; resolved by quote) | info |
| `could-be-symbol` | info |

### 4.8 Widgets

- `useAnchors()` parts gain `symbol?`.
- **Serving code from a symbol anchor must not widen what widgets read.** A symbol's current extent can grow beyond the lines the reader agreed to when the anchor was pinned (`--yes-widgets-may-read`, or the consent dialog). In the approximate branch of `decideCodeAccess`, only the quote has to be committed, so the growth could be uncommitted code.
  - So, for `symbol` and `within` anchors, widgets get code only when the state is `exact` or `moved`: the extent's tokens, comments included, equal the consented quote.
  - The text served is then exactly the consented code, however its lines wrap. A port list re-wrapped from 10 lines to 40 is still served, up to `MAX_CODE_LINES`, which is the case this feature exists for.
  - Anything else gets `changed-since-commit`, and pinning again (with consent) fixes it.
  - `matchedInFull` treats `method: 'symbol'` as matching only when the token comparison is equal.

### 4.9 Security and performance

- **Symbol strings are untrusted.** They're validated by grammar and length, matched by string comparison, and never turned into a RegExp, a file path or a command.
- **The scanner is linear,** with a token budget and slicing (§4.3). Pathological input (a 10 MB file of `begin`) is bounded by the budget and the existing code-size limit.
- **Provider calls** go only to documents the anchor already resolves to inside the repository. A provider is another installed extension, so it's trusted code.
- **Restricted Mode:** no change. Providers may be off; quotes cover it.

### 4.10 Tests

- **Unit: the scanner corpus** (`test/unit/fixtures/sv/`, each file with its expected table):
  - stream-dma's eight modules. These have no generate blocks, labels, packages or interfaces, so the corpus adds files that do;
  - `bit_reader.sv`;
  - a generate-heavy file: `for` / `if` / `case` generate, nested labels;
  - an interface with modports and a clocking block, and a package with typedefs and a struct;
  - `` `ifdef`` arms that open scopes differently (the async-reset pattern), with `sv.defines` choosing each arm;
  - duplicate declarations in arms;
  - comments and strings containing `begin`, `end`, `module`, `"//"`;
  - escaped identifiers and attributes;
  - Verilog-2001 non-ANSI ports;
  - `always` without `begin`, with `if` / `else` chains;
  - `<=` as a comparison inside `always_ff`;
  - concatenation targets;
  - slice drivers in separate `assign`s;
  - `+=` and `++`, `for` loops, `<= #1`;
  - interface-member targets;
  - signals assigned in reset and functional branches;
  - `case` items with several labels, and `default`; `unique0` / `priority case`; a one-hot `case (1'b1)` FSM with expression labels (`state_q[IDLE_BIT]`), compared as tokens;
  - labelled assertions;
  - a declared flop macro;
  - `extern` prototypes;
  - port connections (named and implicit `.clk`);
  - an unbalanced file (partial);
  - a 10 MB stress file, checked against the budget and the slicing.
- **Unit: the resolver.** Every precedence branch of §4.5:
  - reformatting (a re-wrapped port list and re-aligned assignments resolve `exact`);
  - a rename (capped at `changed`);
  - mismatch;
  - `within` outside;
  - hysteresis;
  - widget serving when an extent grows past the pinned range.
- **Unit: check-cli.** Every finding code; `--pin` of a symbol-only anchor; `--pin --symbols` on stream-dma producing the expected paths (§4.6); `--define`.
- **e2e:** reformat a file (a scripted edit that re-wraps a port list), and the section stays "exact"; Re-anchor offers the symbol item.
- **Desktop:** the TypeScript provider path in the sample workspace; a provider timeout falls back to the quote.

### 4.11 Docs

- **GUIDE,** under *How sections follow the code*, "**Anchor to a name**":
  - `driver(x)` first;
  - the path table, `symbol` vs `within`, runs (`a..b`), case items and connections;
  - precedence in plain words: "a name that still exists always finds its code; the quote says whether the code changed";
  - `sv.defines` and `sv.macros`;
  - what isn't addressable, and other languages.
- **SKILL.md, workflow step 3:**
  - "**For SystemVerilog and Verilog, anchor with `symbol`** instead of line numbers, using `driver(signal)` for logic: `{"file": "rtl/x.sv", "symbol": "x.driver(state_q)"}`.
  - Use `x.header` for the interface, `x.u_a..u_b` for a run of instances, and `within` for part of a block such as an FSM's `case`.
  - Paths are by module, not instance.
  - Run `--pin` to fill in lines and quotes.
  - When the checker says a name is ambiguous, ask the user before adding a label to their RTL."

**Effort:** about 13 agent-days:
- the SV scanner and its corpus: 6.5;
- resolver integration: 2.5;
- providers: 1;
- Pin and Re-anchor: 1.5;
- the checker (`--symbols`, `--define`) and docs: 1.5.

---

## 5. Waveforms

**Problem.** A cycle trace is the standard way to explain a handshake. Today it needs a hand-drawn SVG or a widget.

### 5.1 Two layers, one renderer

- **(a) `<explain-wave>` in plain HTML.** No widgets and no consent, so it works in Restricted Mode. The panel's trusted code renders it to static SVG.
- **(b) `<Wave>` in widgets** (`import { Wave } from 'explainer'`), for animated or interactive traces: the cycle a simulation is on, a cursor that follows a slider.
- **Shared modules:**
  - `src/shared/wave/parse.ts`: WaveJSON to a validated model.
  - `src/shared/wave/layout.ts`: the model to a flat list of primitives (`{kind: 'path' | 'rect' | 'text' | 'line', cls, …, on?, ref?, code?}`). Pure, no DOM.
  - Two thin back ends: `src/webview/content/wave.ts` (`createElementNS` and `textContent`, never markup strings) and `src/widget-runtime/runtime/wave.tsx` (React).

### 5.2 Format

```html
<explain-wave title="Valid/ready handshake: a beat transfers on each rising edge where both are high">
  <script type="application/json">
  { signal: [
      { name: 'clk',   wave: 'p......' },
      { name: 'valid', wave: '01..0..', code: 'rtl/dma_rd_port.sv#rd_rsp_valid' },     // an input port: its declaration
      { name: 'ready', wave: '0.1.1.0', code: 'rtl/dma_rd_port.sv#driver(rd_rsp_ready)', on: 'backpressure' },
      { name: 'data',  wave: 'x=.=x..', data: ['A', 'B'] },
      {},
      ['status', { name: 'busy', wave: '01...0.' }],
    ],
    head: { text: 'rd port', tick: 0 },
    marks: [ { on: 'rp-beats', cycles: [2, 3], label: 'transfers' }, { on: 'rp-beats', edge: 2 } ] }
  </script>
  <p>valid rises in cycle 1 and ready in cycle 2; beats A and B transfer at the edges ending cycles 2 and 3.</p>
</explain-wave>
```

- **WaveDrom's WaveJSON, a practical subset:**
  - `signal` entries: `{name, wave, data, period, phase}`, `{}` spacers, and groups (`["label", …]`, nested once);
  - wave characters `0 1 x z . = 2–9 | p P n N h H l L`: clock and data, gaps, and data colored by digit;
  - `data` as an array or a space-separated string;
  - `head` and `foot` with `text` and `tick` (cycle numbers), and `every`;
  - `config.hscale` (1–4).
- **Later (phase 2):** `node` / `edge` arrows (`a~>b`, `a->b`, `a-|>b`, `a|->b`, with labels), `<` / `>` sub-cycle marks, and `u` / `d`.
- **Sidestory additions:**
  - **Signal links.** `ref`, `code` (§8.1 syntax) and `on` on a signal entry make its name row clickable, light it with the steps, and light it from the editor cursor (`cx-here`, §8.2). So clicking `valid` opens its driver, and the cursor in that driver rings the row.
  - **`marks`** draw over all signals:
    - `cycles: [first, last]` (inclusive, 0-based like `tick`) is a translucent band;
    - `edge: n` is a vertical line at the rising edge that **ends** cycle n, which is when a transfer happens.

    Cycles and edges are counted on the page's cycle grid (`hscale` units, as `tick` counts). An edge is drawn where the first `p`/`P` clock signal's rising edge falls, so it follows that signal's `period` and `phase`. With no such clock, the edge is drawn on the grid line.

    `on` names anchors. The renderer gives each mark `data-explain-on`, so §2 lights the cycles a step talks about with no script. A mark without `on` is always shown.
- **The syntax WaveDrom itself accepts.** Authors and LLMs copy WaveDrom examples, which are JavaScript object literals: unquoted keys, single quotes, trailing commas, comments.
  - `parse.ts` accepts that JSON5 subset with a hand-written parser. No `eval`, no `Function`.
  - The child may be `<script type="application/json">` or WaveDrom's own `<script type="WaveDrom">`, so pages copied from WaveDrom work as they are.
- **The props child is lifted** into the panel-owned attribute `data-cx-wave` before scripts are dropped, exactly as `widgetPlaceholder` lifts widget props. A `wave` attribute is accepted too.
- **Other children** are the description and the fallback: shown when rendering fails, and exposed through `aria-describedby` (an IDREF within the frame) otherwise.
- **Attributes:**
  - `title`: the accessible name. The checker warns without it.
  - `scale`: overrides `hscale`.

### 5.3 Rendering and theming

- **Static SVG** with classes `cx-wave`, `cx-wave-sig`, `cx-wave-data-N`, `cx-wave-x`, `cx-wave-grid`, `cx-wave-tick` and `cx-wave-mark`, styled in `content.css` from the tokens of §6:
  - clocks: `--cx-wire-clock`;
  - levels: `--cx-wire-data`;
  - data fills: `--cx-box-fill`, with `2–9` mixed 25% with `--vscode-charts-*`;
  - `x`: a hatch pattern in `--cx-wire-muted`;
  - grid and ticks: `--cx-grid`;
  - names and labels: `--cx-label`.
- Pattern and marker ids are prefixed per instance (`cx-wave-<n>-…`).
- **Width.** One cycle is `20 × hscale` px at the SVG's natural size. A wave wider than the column scrolls sideways in a panel-owned wrapper (`overflow-x: auto`). Signal names stay visible in a separate SVG column outside the scrolling part.
- **High contrast.** No fill carries meaning by color alone: data segments keep outlines and labels, and `x` keeps its hatch. Colors map to `contrastBorder` and `foreground`.

### 5.4 Behaviour

- **Panel:**
  - Rendered in the content pipeline (§9.3) into a `data-cx-box` child of the element, on the incoming tree before the morph.
  - Cached by (wave text, theme kind), so unchanged waves aren't rebuilt.
  - `cleanHtml` removes the box.
  - Errors show in the box as one line, with details in Output.
- **Widgets:**
  - `<Wave wave={…} cursor={cycle} highlight={[{cycles: [a, b], cls}]} onCycleClick={(n) => …} className="…" />`, with the same parser and layout.
  - It is drawn with React elements and colored by the widget theme's tokens (§6.3).
  - `onCycleClick` is ordinary React, and no SDK permission is involved. Signal `ref` / `code` clicks go through `reveal` and its click rule.
- **Checker:** parses each `<explain-wave>` with the shared parser and reports:
  - `wave-syntax`, with JSON5 line and column;
  - `wave-limit`;
  - `wave-unknown-char`;
  - `wave-data-count` (fewer `data` labels than `=` segments);
  - `wave-no-title`;
  - `unknown-anchor` for `on` and `ref`;
  - link checks for `code` (§8.1).
- **Render (§7):** uses the panel renderer, so the output is identical.

### 5.5 Security and limits

- **The JSON is untrusted.** The parser is iterative, with depth capped at 8 for any nesting, objects and arrays alike.
  - It builds objects with `Object.create(null)` and rejects `__proto__`, `constructor` and `prototype` keys.
  - Caps: 64 KB of source, 64 signals, 1,024 cycles per signal, 20,000 rendered segments per wave, labels of 64 characters, 20 waves per page.
  - Over a cap, the wave doesn't render and shows its error.
- **Output is built with DOM APIs and `textContent`,** so no author string is parsed as markup. Class names come from a fixed table.
- **Attribute values are checked first:** `on`, `ref` and `code` from the JSON are validated with the attribute grammars before being set.
- **Sanitizer changes:**
  - lift `explain-wave`'s JSON or WaveDrom child into `data-cx-wave`;
  - drop any author `data-cx-wave` elsewhere (§9.4);
  - keep `title`, `scale`, `wave`, `class` and `style`.

### 5.6 Performance

Layout is O(signals × cycles): a 64 × 1,024 trace takes a few ms, and rendering makes about one node per segment. Waves are cached per text, so typing elsewhere costs nothing.

### 5.7 Tests

- **Unit:**
  - **`parse`:** every wave character, JSON5 forms, the WaveDrom script type, limits, deep nesting, `__proto__` keys, error positions.
  - **`layout`:** golden primitives for a handshake, a clock with `period` / `phase`, groups, gaps, `cycles` and `edge` marks, and signal links.
  - **Sanitizer:** the lifting.
  - **`check-cli`:** its findings.
- **Playwright panel:**
  - screenshots in light, dark and HC;
  - horizontal scroll with names kept visible;
  - marks light with the step;
  - signal rows are clickable and show `cx-here`;
  - a live edit of another section doesn't rebuild the wave (node identity kept).
- **Widgets (`test/widgets/compiled.pw.ts`):** `<Wave>` with a moving `cursor`.
- **Gallery:** the new gallery entry compiles (the existing guide test).

### 5.8 Docs

- **GUIDE,** a new subsection "**Waveforms**":
  - the format and the supported subset;
  - signal links;
  - marks (`cycles` vs `edge`) with `data-explain-on`;
  - accessibility: a title plus description children, "describe what happens, cycle by cycle, for readers who can't see the trace".
- **WIDGETS:**
  - §6: `Wave` in the SDK table;
  - §14: a gallery entry, "A handshake trace that follows a simulation".
- **SKILL.md:** "For handshakes and protocols, add an `<explain-wave>` (WaveDrom syntax). Link each signal to its driver with `code`, and light each step's cycles with `marks`."

**Effort:** about 5.5 agent-days:
- parser and layout: 2;
- panel back end and CSS: 1;
- signal links: 0.5;
- widget back end: 0.5;
- checker: 0.5;
- docs and tests: 1.

Edges in phase 2 add 2 more.

---

## 6. Theme tokens for diagrams

**Problem.** Every author maps diagram roles to `--vscode-charts-*` on their own, differently in every sidestory, and high contrast gets forgotten.

### 6.1 One file, three consumers

`src/shared/diagram-tokens.css` defines the tokens on `:root` from VS Code's variables, with high-contrast and `forced-colors` overrides. Three places import it:

- `content.css`;
- `src/widget-runtime/theme.css`, adding Tailwind names;
- the render harness (§7).

One source, so the three can't drift apart.

### 6.2 The tokens

| Token | Use | Maps to (default themes) | High-contrast override |
|---|---|---|---|
| `--cx-box-fill` | block body | `--vscode-editorWidget-background` → `--vscode-editor-background` | `--vscode-editor-background` |
| `--cx-box-fill-strong` | emphasized block | `color-mix(in srgb, var(--cx-box-stroke) 18%, var(--cx-box-fill))` | `--vscode-editor-background` (emphasis by stroke instead) |
| `--cx-box-stroke` | block outline | `--vscode-editorWidget-border` → `--vscode-panel-border` | `--vscode-contrastBorder` |
| `--cx-box-text` | text in blocks | `--vscode-editor-foreground` | same |
| `--cx-label` | secondary labels (widths, port names) | `--vscode-descriptionForeground` | `--vscode-editor-foreground` |
| `--cx-wire-data` | data path | `--vscode-charts-blue` | same (high-contrast themes define the charts colors) |
| `--cx-wire-addr` | addresses and configuration | `--vscode-charts-purple` | same |
| `--cx-wire-ctrl` | control strobes and handshakes | `--vscode-charts-orange` | same |
| `--cx-wire-status` | status back to control (done, busy) | `--vscode-charts-green` | same |
| `--cx-wire-irq` | interrupts and errors | `--vscode-charts-red` | same |
| `--cx-wire-clock` | clocks | `--vscode-charts-foreground` → `--vscode-editor-foreground` | `--vscode-editor-foreground` |
| `--cx-wire-reset` | resets | `--vscode-charts-yellow` | same |
| `--cx-wire-muted` | wires no step is about | `color-mix(in srgb, var(--vscode-descriptionForeground) 70%, transparent)` | `--vscode-descriptionForeground` |
| `--cx-domain-1` … `--cx-domain-4` | clock-domain region fills (CDC diagrams) | `color-mix(in srgb, var(--vscode-charts-{blue,green,purple,orange}) 10%, transparent)` | `transparent` (domains are told apart by a labelled border) |
| `--cx-arrow` | free-standing arrows and annotations | `--vscode-editor-foreground` | same |
| `--cx-grid` | grids, wave ticks, lane separators | `--vscode-charts-lines` → `--vscode-panel-border` | `--vscode-contrastBorder` |
| `--cx-dash-ctrl`, `--cx-dash-status`, `--cx-dash-irq`, `--cx-dash-reset` | `stroke-dasharray` values, so roles differ by more than color | `5 4`, `2 3`, `1 3`, `6 2 1 2` | same |
| `--cx-on` | lit elements (§2) | `var(--cx-step-accent, var(--vscode-focusBorder))` | `--vscode-contrastActiveBorder` |
| `--cx-dim-opacity` | faded elements (§2) | `0.28` | `1` (no fading) |
| `--cx-link-hover`, `--cx-link-ring` | linked elements (§3) | `--vscode-textLink-foreground`, `--vscode-focusBorder` | `--vscode-contrastActiveBorder` for both |
| `--cx-here` | lighting from the editor cursor (§8.2) | `--vscode-editor-findMatchHighlightBorder` → `--vscode-focusBorder` | `--vscode-contrastActiveBorder` |
| `--cx-accent` | section accent (exists) | the anchor's `color` | unchanged |

**How they look** (approximate default chart colors):
- **Dark Modern:** blue `#3794ff`, purple `#b180d7`, orange `#d18616`, green `#89d185`, red `#f14c4c`, yellow `#cca700`, on a `#1f1f1f` widget fill.
- **Light Modern:** blue `#1a85ff`, purple `#652d90`, orange `#d18616`, green `#388a34`, red `#e51400`, yellow `#bf8803`, on `#f8f8f8`.
- **High-contrast themes:** keep the chart hues on black or white, with `contrastBorder` outlines.

The GUIDE table shows a swatch strip per theme. It's rendered with `--render` (§7) from a token test page, so the docs can't drift from the CSS.

**`forced-colors: active`:**
- boxes are `Canvas` / `CanvasText`;
- wires are `CanvasText`, told apart by the dash tokens;
- `--cx-on` and `--cx-link-ring` are `Highlight`.

### 6.3 Widgets

`theme.css` imports the same file, and adds Tailwind names in `@theme inline`:
- `--color-wire-data` … `--color-wire-reset`;
- `--color-box`, `--color-box-strong`, `--color-box-stroke`;
- `--color-label`, `--color-grid`;
- `--color-domain-1..4`.

That gives classes such as `stroke-wire-data`, `fill-box` and `text-label`, and `--cx-*` stays usable directly in SVG props. WIDGETS §5 gets the table.

### 6.4 Updating stream-dma and `tools/diagrams.py`

- `diagrams.py` emits token variables instead of chart variables. It puts `role="group"` on diagrams with links (§3.3), and `data-explain-on` / `data-explain-keep` on its wires, blocks and legend.
- Each page's `/* dia-css */` block shrinks to role classes on tokens. The link overrides go, since the built-in look covers them.
- The `.focus-*` copies become one diagram with `data-explain-diagram="step dim-rest"`, plus `data-explain-copy` placeholders with `data-explain-diagram="section"` (§2.4).
- Anchors move to `symbol` / `within` with `--pin --symbols` (§4.6).
- Box links that don't need an anchor (`m-*` refs) become `data-explain-code` (§8.1), and the then-unused `m-*` anchors leave the manifest.
- `layout.json`, shared with the simulation widget, is unchanged. The widget switches to the Tailwind token names.
- The screenshots are regenerated with `--render` and compared by eye. README GIFs are re-shot only if they changed.

### 6.5 Security, performance, tests

- **Security:** none; this is static CSS.
- **Performance:** none.
- **Tests:**
  - **Unit:** the token file parses, and every token resolves (no undefined `var()`) under the four theme snapshots `test/webview/themes.ts` uses.
  - **Playwright:** the swatch page in light, dark and both high-contrast themes, with contrast checks: at least 3:1 for wires against `--cx-box-fill` and the editor background in the default themes, plus a warning list for themes that miss it.
  - **Widgets:** a `stroke-wire-data` class resolves.

### 6.6 Docs

- **GUIDE** *Styling*: the token table, and "use tokens, not `--vscode-charts-*`, for diagrams".
- **WIDGETS §5:** the Tailwind names.
- **SKILL.md, workflow step 4:** "Color diagrams with the `--cx-*` tokens (`--cx-wire-data`, `--cx-box-fill`, …) and the dash tokens, never hex values or ad-hoc chart colors."

**Effort:** about 2 agent-days, plus 2 for the stream-dma conversion.

---

## 7. A rendered preview from the checker (`--render`)

**Problem.** Authors and agents can't see what the reader sees without opening VS Code. The team used headless Chrome by hand.

### 7.1 Command line

```bash
node check.cjs .sidestory/dma-overview --render [--out <dir>] [--width 420] [--themes light,dark,hc-dark,hc-light] [--scale 2]
```

**Output:**
- `<out>/<name>/<NN>-<anchor>-<theme>.png`: one per step, with that step active (`cx-active`, `cx-on`, `cx-dim`, `--cx-step-accent`);
- `<out>/<name>/page-<theme>.png`: the whole page with nothing active;
- `<out>/<name>/contact-sheet.png`: all steps in a grid, light above dark;
- `report.json`: per step, the anchor, its parts' files, lines and states, and the image paths.

**Where it goes:**
- **Without `--out`,** a fresh directory from `mkdtemp(<os tmpdir>/sidestory-render-)`. That's unpredictable and created with mode 0700, so nothing can be planted in it on a shared `/tmp`. The path is printed at the end.
  - It isn't the repository, because a render inside a user's repo would get committed.
- **With `--out`,** the directory is checked with `lstat`, and refused if it or `<out>/<name>` is a symlink.
  - **Every output file is written by unlinking its path, then creating it exclusively** (`wx`, write to a new file only). A symlink planted inside `<out>/<name>` (as `contact-sheet.png`, say) is then never followed.
  - Images from an earlier render of the same sidestory (files matching the checker's own naming pattern) are removed first. An agent won't then read a stale step image after the number of steps drops.

**Options:**
- Default themes: light and dark.
- `--width` is the column width in CSS px. The default is 420, about the panel beside the code; the skill tells agents to also try 340.

**Exit codes:** `--render` runs the normal check first. Render findings (§7.5) join the report, and the usual rule applies: 1 for errors, 0 otherwise. "No browser" has its own code, **3**, because 2 means bad arguments and crashes today.

### 7.2 Finding a browser

No browser is bundled: the .vsix is 1.36 MB today and must stay under 2 MB. The checker looks, in order:

1. **`--browser <path>` or `CHROME_PATH`**, absolute paths only, and not inside the repository or the current directory.
2. **Standard installs:**
   - **macOS:** `/Applications/{Google Chrome,Google Chrome Canary,Chromium,Microsoft Edge,Brave Browser}.app/Contents/MacOS/…`, and the same under `~/Applications`.
   - **Linux:** `google-chrome-stable`, `google-chrome`, `chromium`, `chromium-browser`, `microsoft-edge-stable`, `microsoft-edge` and `brave-browser`, on `PATH`, plus `/usr/bin` and `/snap/bin`.
   - **Windows:** `Google\Chrome\Application\chrome.exe` and `Microsoft\Edge\Application\msedge.exe` under `%ProgramFiles%`, `%ProgramFiles(x86)%` and `%LocalAppData%`. Edge is on every Windows 10 and 11 machine.
3. **Playwright's cache:** `PLAYWRIGHT_BROWSERS_PATH`, `~/Library/Caches/ms-playwright`, `~/.cache/ms-playwright`, `%LOCALAPPDATA%\ms-playwright`. It prefers `chromium_headless_shell-*`, then `chromium-*`, newest first.

**Rules:**
- **`PATH` entries that are relative, or inside the repository or the current directory, are skipped.** A cloned repository must not be able to plant a `google-chrome` that the checker runs.
- **The version** is read after launch with CDP `Browser.getVersion`, not with `--version` (which prints nothing on Windows). It must be Chrome 118 or later, the first version with `@scope`, which the panel's inlined SVG relies on (§8.7). VS Code 1.95's Electron is Chromium 128. `chrome-headless-shell` binaries are launched without `--headless=new`, which they don't take.
- **No browser found** means exit code 3 and a message listing what was tried and how to fix it: "No Chrome, Edge or Chromium found. Install one, or set CHROME_PATH=/path/to/chrome, or run `npx playwright install chromium-headless-shell`." It never skips silently.

### 7.3 Driving it: one browser, DevTools protocol over a pipe

- **Launch once** with:
  - `--headless=new` (not for headless-shell), `--remote-debugging-pipe`, and `--user-data-dir=<a fresh mkdtemp dir>`;
  - `--no-first-run --no-default-browser-check --disable-extensions --disable-sync --disable-background-networking --disable-component-update --disable-default-apps --mute-audio --hide-scrollbars --force-color-profile=srgb`;
  - **no network at the browser level:** `--proxy-server=127.0.0.1:9 --proxy-bypass-list=<-loopback> --host-resolver-rules="MAP * ~NOTFOUND"`.
- **A pipe, not a port.** `--remote-debugging-pipe` uses file descriptors 3 and 4 of the child, so no TCP listener exists. With `--remote-debugging-port`, any local process could attach and run code in the browser.
- **The client** is a minimal CDP client, `src/cli/render/cdp.ts`: about 150 lines of NUL-delimited JSON, request ids and events. It uses:
  - `Target.createTarget`, `Page.setDocumentContent`, `Runtime.evaluate`;
  - `Emulation.setDeviceMetricsOverride`;
  - `Emulation.setEmulatedMedia`, with reduced motion on so transitions don't blur the shots;
  - `Page.captureScreenshot` with a clip;
  - **`Fetch.enable({patterns: [{urlPattern: '*'}]})`, called before any content is set:** every request the page makes pauses at the client, and the client **fails every one**. The allow list is empty:
    - the harness arrives through `Page.setDocumentContent` with its script inline (by nonce), so it's never fetched;
    - `data:` and `blob:` URLs never reach `Fetch` anyway.

    That's a second layer behind the proxy flags and the CSP.
- **Not chosen: one `--screenshot` launch per image.**
  - It costs 0.5–1 s per image, so 8 steps × 2 themes is 16 launches.
  - It can't apply step states without script in the page, or without re-serializing untrusted HTML in Node.
  - It can't clip to a section.
- **The OS sandbox stays on.**
  - Containers that run as root need Chrome's `--no-sandbox`, and Ubuntu 23.10+ restricts the unprivileged user namespaces Chrome's sandbox uses (Playwright's own Chromium runs with `--no-sandbox` there). The CLI passes `--no-sandbox` only with `--no-browser-sandbox`, and prints a warning.
  - When a launch fails in a way that matches a sandbox failure (the known stderr messages, or an exit before the pipe opens), the error says so and names the flag. CI uses the flag.
  - The content still can't run script (§7.4).
- **Lifetime:**
  - One browser per run, with its process tree killed on exit, on error and on Ctrl-C.
  - The temporary profile is deleted.
  - Timeouts: 120 s overall, 15 s per page.

### 7.4 Fidelity: the panel's own code renders it

- **A harness page** is built as `dist/render/harness.js` with esbuild, like the webview bundle. It's trusted code, loaded by nonce under the panel's CSP, and it does what the panel does:
  - it creates the content frame (`<iframe sandbox="allow-same-origin">`, **no `allow-scripts`**) with the same `srcdoc`;
  - it injects `content.css` and the tokens;
  - it runs **the same content pipeline** (§9.3): `sanitize()`, decoration, `data-explain-on`, `data-explain-copy`, waves, inlined SVG and image-map overlays;
  - it applies each step's state, then reports section rectangles for clipping.
- **Base URL.** The harness's base URL is a fake origin, `https://sidestory.invalid/<name>/`, never a `file://` path. With a `file://` base, `resolveLocal` would keep `file://` URLs inside the folder, and Chrome would read them itself, skipping the CLI's symlink, secret-name and size rules.
  - Every asset is localized to a blob URL. `Fetch` interception fails anything else.
- **Assets.** The CLI reads images, fonts, stylesheets and inlined SVG with the extension's rules: inside the sidestory folder after real paths, allowed types, 5 MB each and 20 MB in all, secret-looking names refused. It hands them to the harness as base64, which becomes blob URLs, as in the panel.
- **Theme variables.** VS Code's full `--vscode-*` sets for Dark Modern, Light Modern and the two high-contrast themes are captured once from a real VS Code by `scripts/capture-theme-vars.ts` (run in the e2e harness). They're stored as JSON in `src/cli/render/themes/`, about 30 KB each, so about 120 KB in the .vsix. Body classes and `--vscode-font-*` are set as VS Code sets them, with fonts as the OS provides them.
- **Widgets show their fallbacks** (`data-cx-wstate="off"`), as readers see them before consent.
  - **Running widgets in `--render` is out of scope for v1:** it would run repository code with no consent dialog, and an agent could pass a flag on the user's behalf (§11).
- **Code highlighting.** Code blocks are plain, unless the highlight worker (HIGHLIGHT-PLAN.md) is in `dist/`; then the CLI uses it in-process.

### 7.5 What it checks while rendering

These are things only a layout engine can see:

| Code | When |
|---|---|
| `render-overflow` | A section's content is wider than the column at `--width` (and at 340 px), outside a scrolling box. |
| `render-broken-image` | An image failed to load, or was refused. |
| `render-empty-section` | A section has zero height. |
| `render-wave-error` | A wave failed to render. |
| `render-tiny-text` | SVG text renders below 9 px at `--width`: a diagram too wide for the column. |
| `render-placement` | A widget placeholder's placement problem, using the same rules as `placement()` in `widgets.ts`, so it matches what readers would see. |

### 7.6 Security

The page is untrusted repository content. The layers:

1. **No script in the content:** a sandboxed iframe without `allow-scripts`, plus the panel's sanitizer and CSP. The CSP is `default-src 'none'`, script only by nonce and only for the harness, and images and fonts only from `blob:` and `data:`.
2. **No network:** at the browser (proxy and resolver rules), at the client (`Fetch` interception), and in the page (CSP).
3. **No file access by the browser:** a fake-origin base URL, and assets localized under the CLI's rules.
4. **No TCP debugging port:** a pipe instead.
5. **A fresh profile,** created with `mkdtemp` and deleted afterwards.
6. **The OS sandbox on** by default.
7. **The browser binary** comes only from absolute locations outside the repository.
8. **Safe output:** a `mkdtemp` directory by default, symlinked output refused, and file names built from validated anchor ids and fixed theme names, never from page content.
9. **`report.json` holds little page text:** anchor ids, and titles capped at 120 characters.

### 7.7 Performance

- Chrome starts in 0.3–0.8 s, and a step screenshot takes about 50–150 ms. For 8 steps × 2 themes that's about 3–5 s in all, using about 200–300 MB of memory while it runs.
- Images are clipped to their section, up to 4,000 px tall at `--scale 2`. Taller sections are cut, with an info finding.
- The contact sheet is laid out by the same browser in a trusted page, from the PNGs as data URLs, so no image library is needed.

### 7.8 Tests

- **Unit:**
  - browser discovery: a fake file system per OS; `PATH` and `CHROME_PATH` entries inside the repository skipped; a relative `CHROME_PATH` refused;
  - the CDP client against a fake pipe;
  - the `Fetch` allow rules;
  - argument parsing and exit codes;
  - output naming, the `mkdtemp` mode, symlinked `--out` refused, stale image cleanup.
- **Integration, in CI** with Playwright's Chromium via `CHROME_PATH` and `--no-browser-sandbox`:
  - render the sample workspace and stream-dma, and check the files, their size ranges and `report.json`;
  - a fixture with an over-wide diagram reports `render-overflow`;
  - **a hostile fixture** (`<img src=http://…>`, CSS `url(http://…)`, `@import`, `<meta http-equiv=refresh>`, `file:` URLs, an asset symlinked outside the folder, a 5 MB page) finishes. **No `Fetch.requestPaused` is allowed through** and a local listener sees no connection.
  - **A sandbox launch failure** (simulated) produces the guided error.
- **Snapshot, with pixel tolerance:** the bit-reader fixture's render against a committed baseline, on Linux CI only, since fonts differ per OS.

### 7.9 Docs

- **WIDGETS §13 (checking):** `--render` and its options.
- **GUIDE** *Troubleshooting*: "See what readers see".
- **SKILL.md workflow step 5,** a new sub-step: "Run the checker with `--render` (and `--width 340`) and **look at the PNGs**, light and dark, starting with the contact sheet. Fix overflow and unreadable diagrams before telling the user it's done. If no browser is found (exit code 3), say so and skip it; don't install one without asking."

**Effort:** about 7.5 agent-days:
- the content-pipeline extraction: 1.5;
- discovery and the CDP client with `Fetch`: 2.5;
- harness and themes: 1.5;
- checks and contact sheet: 1;
- tests and docs: 1.

---

## 8. Clickable diagrams as a live code map

More feedback from the same team: every small box (`i_order_q`, `i_in_buf`) should open its code without a manifest entry, and the diagram should follow the editor down to the element, not only the section.

### 8.1 Linking to code without an anchor: `data-explain-code`

**Format:**

```html
<figure data-explain-diagram data-explain-code-file="rtl/gemm_row_dispatch.sv">
  <svg …>
    <g data-explain-code="#i_order_q">…</g>                    <!-- file from the ancestor -->
    <g data-explain-code="#driver(i_in_buf)">…</g>
    <g data-explain-code="rtl/dma_fifo.sv#L34-L39">…</g>         <!-- its own file -->
  </svg>
</figure>
<a data-explain-code="rtl/dma_csr.sv">dma_csr.sv</a>
```

- **The path** comes before `#`. It's relative to the folder that holds `.sidestory/`, like manifest `file`s, and validated with the same `isSafeRelativePath`. It's **not** resolved against the page's URL; the guide says so, because HTML authors expect page-relative paths.
  - **An empty path** takes the nearest ancestor's **`data-explain-code-file`**. A 30-box diagram of one module names the file once.
- **After `#`** (optional):
  - a **symbol path** from §4, with the module optional when the name is unique in the file (`#i_order_q`, `#driver(i_in_buf)`, `#dma_ctrl.driver(state_q).case(IDLE)`); or
  - **`L10` / `L10-L20`**, GitHub style.

  With nothing after `#`, the file opens at the top. Symbols resolve with the SV scanner, or in VS Code with the language's provider for other languages.
- **Path-free form:** a bare `data-explain-code="dma_ctrl.state_q"` would need a repository-wide module index, so it's an open question (§11).
- **The trade-off, stated in the guide.** These links have **no pinned quote and no drift detection.**
  - A symbol link either finds its name or doesn't. Code that changes under the name opens without a "Code changed" badge.
  - A line link points wherever those lines are now.
  - So: use a manifest anchor (with `data-explain-ref`) for anything the prose makes claims about, and `data-explain-code` for "where is this thing".
- **Click and keyboard.** As with `data-explain-ref`, the panel posts `openCode {path, target}`. The extension then:
  - validates it: the schema, the path rules, the symbol grammar, line numbers at most 10,000,000;
  - **checks the real path** (`realPathInside` the repository) for every target kind, including whole-file and line links, which have no resolution step to rely on (§0);
  - opens `vscode.Uri.file(real)`;
  - finds the symbol or the lines, and reveals them with the flash decoration (`moveCursor: true`, like `openRef`).

  If the target is missing, a status bar message says so ("`i_order_q` not found in gemm_row_dispatch.sv") and nothing opens.
- **Secret-looking files** (the widget rule, on both the path's name and the real file's name) need a confirmation before opening: "This sidestory links to .env. Open it?" Unlike manifest anchors, these links are per element, unreviewed and easy to hide in a diagram. Manifest anchors keep today's behaviour.
- **Checker.** Every `data-explain-code` (and wave `code`) is validated:
  - **errors:** bad syntax; a file that doesn't exist inside the repository (real paths);
  - **warnings:** an SV symbol that's missing or ambiguous (the drift check a symbol link can have); a line range outside the file;
  - **info:** `code-link-lines`, suggesting a symbol for line links in SV files; `symbol-unchecked` for non-SV symbols (§4.4).
- **Implicit pinning was considered and not chosen** (`--pin` writing an implicit table of link quotes into the manifest). It would recreate anchors under another name, without their UI (no badge, no Re-anchor). A symbol that resolves is the useful check. An author who wants drift detection writes an anchor.
- **The same behaviour as `data-explain-ref`:** the default look (§3.2), the hover preview (§8.3) and cursor lighting (§8.2).
  - `data-explain-code` elements get `data-cx-ref`, so the existing `tabindex` / `role` cleanup in `cleanHtml` applies.
  - `decorateDetails` also ignores hosts inside `[data-explain-code]`.
  - `data-explain-ref` and `data-explain-code` on one element is an error in the checker; in the panel, the ref wins.

**How the panel guarantees the reader asked.** The page has no script, and widgets have no path to these messages, so only the panel's own handlers can post `openCode`.
- It's posted **synchronously from `onContentClick` / `onContentKey`, and only when `event.isTrusted`**, exactly like `openRef` today.
- The sanitizer drops `accesskey` and `autofocus` (§9.4). Without that, a keystroke elsewhere (via `accesskey`), or Enter right after load (via `autofocus`), could fire a link the reader didn't aim at.
- `<label for>` forwards a trusted click to its form control. The panel therefore **ignores `data-explain-ref` and `data-explain-code` on labelable elements** (`button`, `input`, `select`, `textarea`, `meter`, `output`, `progress`), and the checker warns about them. A label can then never fire a link.
- A page-sized transparent link remains possible: every click would open one file. That's annoying, not dangerous, and the same as an oversized `data-explain-ref` today.
- The extension rate-limits `openCode` to 10 a second as a backstop. That limit isn't the guarantee. SECURITY.md states the guarantee: no script in the content.

### 8.2 Linking back from the code: cursor lighting (`cx-here`)

**What the reader sees:** with the editor cursor in `i_order_q`'s declaration, the `i_order_q` box in the diagram gets a ring. Moving to the FSM's always block rings the FSM box. The diagram becomes a live map of the code.

- **A distinct state, not the step's lighting.** Elements get `cx-here`, and nothing fades.
  - The default look is `outline: 2px solid var(--cx-here)`, with a `drop-shadow` for SVG if the outline doesn't paint, plus a short fade-in that reduced motion turns off.
  - Fading stays the step's job, so the two never fight: a step can fade everything but the data path while the cursor rings the FIFO inside it.
- **What can light up:** elements with `data-explain-ref` (any manifest anchor, section or not, any part), `data-explain-code`, or a wave signal link, whose target contains the cursor line.
  - When several targets contain the line, **only the tightest lights up**, the `anchorAtLine` rule: the FSM box rather than the module box.
  - Identifier-based lighting (the box whose signal is the word under the cursor) is a follow-up (§11).
- **Where:** anywhere in the page, not just the current section. It's cheap, and only what's on screen is seen.
- **Steps don't change because of element links.** Section-level cursor-follow stays, with the §0 fix: only ids that are sections count. So:
  - the cursor in code a **section** covers switches to that step, as today, and then the boxes in that section's diagram ring;
  - the cursor in code that only a **box** covers rings the box and leaves the step alone, so the reader isn't pulled around for every box they pass through.
- **Data flow:**
  1. **After each render,** the panel sends `codeTargets {sections, refs, links}`:
     - `sections`: every `[data-explain-anchor]` id, nested ones included;
     - `refs`: the anchor ids that links use;
     - `links`: the distinct resolved `data-explain-code` values (with `data-explain-code-file` applied).

     These are deduplicated, capped at 500 links, and schema-validated. Until the first `codeTargets` arrives, or while the panel is hidden, cursor-follow uses every anchor (today's behaviour), and nothing lights up.
  2. **The session keeps a per-file index.** Anchors come from its existing resolutions. Links are resolved **lazily, per (file, document version)**: when the cursor enters a file a link points into, the session scans its symbols once (the §4.3 cache, sliced) and computes each link's extent.
  3. **On selection change** (the existing `CURSOR_DELAY` debounce, and only the reader's own moves, as today), the session finds the tightest target. It posts `here {ref?, link?}` only when that changed.
  4. **The panel** toggles `cx-here` from a `Map<target, Element[]>` built in `decorate()`. The class is also applied to the incoming tree before each morph (§9.5).
- **Performance:**
  - At most one scan per document version, and only for files that hold link targets.
  - Each cursor lookup is a linear pass over that file's targets (at most 500).
  - Files no target points into cost a single map miss, like NAVIGATION-PLAN.md §6.3.
  - `here` is posted only on change.
- **Turning it off:** the setting `sidestory.followCursorInDiagrams` (default on).

### 8.3 Code preview on hover and focus

**What the reader sees:** after hovering a linked element for 500 ms, or 150 ms after focusing it with the keyboard, a small card shows the target's lines.
- A header with the file name and line numbers.
- Up to **12 lines**, clipped with an ellipsis at 120 columns.
- Longer targets show the first 12 lines and "… 40 more lines. Click to open."

The same card serves the part switcher (§1.3).

- **Who renders it:** the panel, in its own document (trusted), in the overlay layer above the content frame (§9.2).
  - It's positioned from the element's rectangle: the frame offset plus `getBoundingClientRect()`, or for `<area>`, its shape's bounds (§8.6).
  - It goes below the element, flipped above when there's no room, and clamped 8 px inside the panel.
  - Maximum width is `min(panel − 16 px, 640 px)`.
- **What's in it:** code text only, set with `textContent`.
  - It's colored with highlight runs when the highlight host (HIGHLIGHT-PLAN.md, Shiki in the extension host) is available; the same run format becomes spans built with DOM APIs.
  - Otherwise it's plain monospace.
- **Data:** the panel asks with `peekCode {ref | link, part?}`. The extension resolves the target exactly as for a click: the same validation and real-path containment.
  - **Non-SV symbols are previewed only if their document is already open.** Otherwise the card says "Click to open". Resolving a non-SV symbol calls `executeDocumentSymbolProvider`, which opens the document and wakes language servers and linters; hovering shouldn't do that to any file the pointer passes over.
  - The reply is `{text, startLine, endLine, total, language, runs?}`, at most 12 lines of at most 400 characters.
  - Replies are cached per (real path, document version, target) on both sides.
  - Requests are rate-limited to 5 a second, keeping only the latest. A file not already in memory is read at most once a second.
- **Dismissing it** (WCAG 1.4.13):
  - Esc closes it and keeps focus on the element.
  - Moving the pointer off both the element and the card closes it.
  - The card is hoverable: the pointer can move onto it to select text, and it stays while hovered or focused.
  - A click on the element opens the code as usual and closes the card.
- **Accessibility:**
  - The card isn't a Tab stop.
  - The focused element gets an **`aria-description`** with the card's header and first line ("dma_fifo.sv lines 34 to 39: always_ff …"). For a target hidden by the secret filter, it gets the header only.
    - `aria-describedby` can't point from the content frame to the panel's document.
    - The attribute is panel-owned: it's marked with `data-cx-desc` so `cleanHtml` strips only the panel's, never an author's.
  - The full text is announced through the panel's existing live region when the card opens from a keyboard focus.
- **Security:**
  - The preview shows only code the element already points at, under the containment a click uses. It doesn't widen what the page can reach, and nothing in the frame can read the panel's document (no script).
  - **The secret-file filter applies, on both the path's name and the real file's name.** Hover is low-intent: a page shouldn't put a `.env` on screen during a screen share because the pointer passed over a box. The card says "Preview hidden for secret-looking files. Click to open."
  - Git-ignored files are previewed, as reveal opens them.
  - **`peeked` text is never forwarded to widget frames.** That would bypass code-access consent. The protocol type isn't in the widget message union, and a test asserts that.
- **Turning it off:** the setting `sidestory.codePreview` (default on).

### 8.4 The default look

Linked elements use §3.2 for both `data-explain-ref` and `data-explain-code`. The tokens are `--cx-link-hover`, `--cx-link-ring` and `--cx-here`, and the opt-out is `data-explain-plain`, so linked elements look the same in every sidestory.

### 8.5 Documenting that links work on any element, SVG included

This is §3.6, with `data-explain-code` added to the same README line and GUIDE subsection. The skill gains: "For a block diagram, give every box a link: `data-explain-ref` when a manifest anchor covers it, `data-explain-code="#symbol"` (with `data-explain-code-file` on the figure) for small parts."

### 8.6 Clickable areas on images (image maps)

Many teams have PNGs or draw.io exports they won't redraw.

- **Kept by the sanitizer:** `<map>`; `<area>` with `shape`, `coords`, `alt`, `href` and `data-explain-*`; and `usemap`.
  - Clicks already reach `onContentClick`, with the `<area>` as the event target. The `data-explain-ref` branch, and the new `data-explain-code` branch, handle it before the link branch.
- **Focus and keyboard.** Chromium makes an `<area>` focusable only when it has `href`. So the panel:
  - sets `href="#"` on linked areas that don't have one, marked `data-cx-href` so `cleanHtml` strips only the panel's;
  - sets `role="link"`, with the name from `alt`. The checker warns about linked areas without `alt`.

  Chromium draws the focus ring along the area's shape. A Playwright test confirms it, with the overlay ring (below) as the fallback.
- **Lighting and hover** (an `<area>` can't be styled). The panel draws an **overlay** for each image that has linked or tagged areas:
  - an SVG in the overlay layer (§9.2) with `pointer-events: none`, sized to the image's rendered box and scaled by rendered size over natural size;
  - shapes from `coords`: `rect`, `circle` and `poly` (`default` is ignored);
  - rings for hover and focus (the panel tracks `pointerover` and `focusin` on areas), for `cx-here`, and for `cx-on`.
- **No fading mask over images.** A ring on lit areas is enough, and a mask over a picture costs more than it's worth.
- **Following layout:** the overlay tracks the image through layout changes with the same ResizeObserver and scroll scheduling the widget layer uses. Like widgets, an image under a transform gets no overlay, and Output says so.
- **Hover preview** works the same (§8.3), anchored to the shape's bounds.
- **Limits:** 200 areas per map, 20 maps per page, 1,000 polygon points per area.

### 8.7 draw.io and other tools' SVG

- **Inline SVG from draw.io already works:**
  - `<foreignObject>` with HTML labels survives the sanitizer: no `<script>`, and handlers stripped;
  - so do `<switch>` and `requiredFeatures`;
  - the large `content` attribute (the compressed diagram) is harmless;
  - `@font-face` with remote URLs is dropped;
  - external links stay links.

  The checker notes a page over 1 MB.
- **Addition 1: `<img src="assets/arch.drawio.svg" data-explain-inline>`.** The panel fetches the asset through the existing asset path (inside the sidestory folder, real paths, size caps) and inlines it:
  - **Parsing** uses the **HTML parser** in an inert document, as foreign content via `parseInert`, taking only the `<svg>` element. That avoids XML-only features (DTD entities, `xml-stylesheet` processing instructions, `<parsererror>` documents), and adds no new Trusted Types policy.
  - **Sanitizing is inline mode**: the same rules, plus it **drops** `<explain-widget>`, `<explain-wave>`, `data-explain-copy`, `data-explain-anchor`, `data-explain-detail` and `data-explain-inline`. Without the last one, an asset could inline itself. An asset can link and light up (`data-explain-ref`, `-code`, `-on`, `sidestory:` links), but it can't add steps, widgets or anything the checker's widget analysis wouldn't see.
  - **Relative URLs inside the asset** resolve against **the asset's own URL** (the sanitizer's `from` parameter), and must still stay inside the folder.
  - **Ids are prefixed per instance** (`cx-svg-<n>-`). draw.io reuses ids across exports, so without a prefix they would collide with each other and with copies. Everything that refers to an id is rewritten to match:
    - `url(#…)` and `href="#…"` in attributes;
    - IDREFs (`aria-labelledby` and the like);
    - `#id` selectors and `url(#…)` inside the asset's `<style>`.
  - **Its `<style>` stays scoped.** The CSS (after `rewriteCss`) is parsed with `new CSSStyleSheet().replaceSync()`. The panel then writes out `@scope ([data-cx-inline="<n>"]) { … }` from the parsed rules' `cssText`, with id selectors rewritten, rather than hoisting the CSS to the page.
    - Writing it out from the CSSOM means unbalanced braces in the source can't leak rules outside the scope.
    - This is a correctness measure, not a security one: the asset is in the same folder as the page, at the same trust.
  - **What's kept from the `<img>`:** `class`, `style`, `width`, `height`, and its own `id`, unprefixed, so `data-explain-copy` can name the inlined diagram. `alt` becomes the `aria-label`.
  - **Without the attribute,** the `<img>` shows the picture, so the page degrades gracefully.
  - **Live updates:** teams edit `arch.drawio.svg` in the draw.io VS Code extension, and the sidestory updates live (assets already update on change).
  - **The checker** scans inlined assets for links (`data-explain-ref`, `data-explain-code`, `data-explain-on`, `sidestory:`) as it scans the page.
  - **Limits:** 2 MB per SVG, 50,000 elements, 10 inlined SVGs per page.
- **Addition 2: `sidestory:` links,** for tools that can only set a hyperlink on a shape (draw.io's "Edit Link", Mermaid's `click`, Visio):
  - `sidestory:ref/m-fifo` becomes `data-explain-ref="m-fifo"`;
  - `sidestory:code/rtl/dma_fifo.sv#driver(count_q)` becomes `data-explain-code`;
  - `sidestory:on/datapath+backpressure` becomes `data-explain-on`;
  - **combined forms** add `?on=…` to `ref` and `code`: `sidestory:ref/m-fifo?on=datapath+backpressure`. One hyperlink per shape is all those tools allow, and a box usually needs both.

  How the conversion works:
  - It happens on `<a>` and `<area>` `href` / `xlink:href` **before** URL rewriting, which would drop the unknown scheme. `sidestory:` never reaches the URL rewriter or the browser.
  - **The parse order is fixed: split first, then decode.**
    - The structure is split on the raw string: the kind (`ref` / `code` / `on`), the path, then `#target`, then `?on=`.
    - Then each piece is percent-decoded exactly once, so `%23` and `%3F` can never become structure.
    - Then each piece is validated with the attribute grammars. An invalid one is dropped with a warning.
  - **`?on=` comes last,** after the target: `sidestory:code/rtl/x.sv#driver(x)?on=a+b`. Unlike a URL, the `#target` part ends at `?on=`; a `?` inside a target is invalid anyway. `sidestory:code/rtl/x.sv?on=a#driver(x)` is also accepted. The tests cover both orders.
  - An `<a>` whose only purpose was the link becomes a plain `<g>`-like wrapper: `href` removed, the `data-explain-*` attributes set.
  - **To verify before relying on it:** that draw.io's Edit Link, Mermaid and Visio accept a custom scheme (a Playwright check on a real draw.io export). If one doesn't, `#sidestory:ref/…` (a fragment form) is the fallback.
- **A binding table that leaves the diagram untouched** (for tools whose re-exports drop hand-added links) is an open question (§11): a `data-explain-bind` JSON on the figure, mapping shape label text to `{ref | code, on}`.

### 8.8 Tests

- **Unit:**
  - the schemas of `openCode`, `peekCode`, `codeTargets` and `here`, including path and symbol rejection;
  - `data-explain-code-file` inheritance;
  - `sidestory:` conversion, including combined forms, double encoding, and hostile values (`sidestory:code/../x`, `sidestory:ref/__proto__`; `javascript:` still dropped);
  - inline-mode sanitizing: the drops, id prefixing and IDREF rewriting, `@scope` wrapping, relative URLs against the asset, DTD entities and processing instructions inert;
  - the tightest-target rule;
  - the cursor-follow fix (§0) in `session-lifecycle.test.ts`: sections only, nested sections included, the fallback before `codeTargets` arrives and while hidden;
  - **real paths:** an in-repository symlink to outside the repository is refused by `openCode`, `peekCode` and `data-explain-inline`;
  - **the secret filter** on preview and the confirmation on open, for both the path's name and the real file's name;
  - `peeked` can't be sent to widgets.
- **Playwright panel:**
  - clicking a `<g data-explain-code>` posts `openCode`;
  - **no `openCode` from untrusted or unaimed input:** a synthetic `click()`, `accesskey` and `autofocus` (both stripped), `<label for>`;
  - hover shows the card after 500 ms, and Esc closes it;
  - focus shows it with `aria-description`, checked in the accessibility tree;
  - a secret-looking target shows the hidden notice;
  - an image map: the focus ring and the overlay ring, aligned at two panel widths; `here` from a fake host message;
  - `data-explain-inline` swaps the image and keeps live updates;
  - `cx-here` survives a live edit with no transition restart.
- **isolation.pw.ts:** inlined SVG with `<script>`, `onload`, `<animate attributeName="href">`, `<foreignObject><iframe>`, `<explain-widget>` and `<style>` stays inert and scoped.
- **e2e:**
  - in the stream-dma overview, clicking a `data-explain-code` box opens the symbol;
  - moving the cursor into `dma_fifo.sv` rings the FIFO box without changing the step;
  - moving into a section's code changes the step, and isn't held by a ref-only anchor (§0).
- **Desktop:** the hover preview with highlighting (when the highlight host is built), on CRLF.

### 8.9 Docs

- **GUIDE,** a new section "**Diagrams as a map of the code**":
  - `data-explain-code`: the path base, `data-explain-code-file`, `#symbol`, `#L10-L20`;
  - no drift detection, and when to use an anchor instead;
  - cursor lighting;
  - hover previews;
  - image maps;
  - draw.io: `data-explain-inline` and `sidestory:` links, combined forms included;
  - the settings.
- **README** *Linked both ways*: one sentence, and a GIF of the cursor lighting boxes.
- **SECURITY:** rows for `openCode` (trusted input from the panel only, real paths, the confirmation for secret files), the preview (the secret filter, no provider wake-ups), and inline SVG (inline-mode sanitizing).
- **SKILL.md:** the line in §8.5, plus "For an existing PNG or draw.io diagram, add an image map, or `sidestory:` links in draw.io, rather than redrawing it."

**Effort:** about 15 agent-days:
- `data-explain-code` and its checker: 3;
- cursor lighting with the §0 fix: 2.5;
- the hover preview: 3;
- image-map overlays: 2.5;
- `data-explain-inline` (inline mode, ids, scoping): 2.5;
- `sidestory:` links: 1;
- docs: 0.5.

---

## 9. Shared pieces

### 9.1 Protocol additions (`src/shared/protocol.ts`)

- **Webview → extension:**
  - `openCode {path, target?}`
  - `peekCode {ref?, part?, link?}`
  - `codeTargets {sections, refs, links}`
  - `focusPart {anchorId, part}`
- **Extension → webview:**
  - `syncTo` gains `part`
  - `AnchorView` gains `parts`
  - `here {ref?, link?}`
  - `peeked {key, text, startLine, endLine, total, language, runs?}`, or `{key, hidden: 'secret' | 'missing' | 'click-to-open'}`

All are zod-validated as today, with caps on every string and array. `peeked` is never relayed to widgets.

### 9.2 The panel overlay layer

The hover card, the image-map overlays and the existing widget frames all need the same thing: draw over the content frame at an element's rectangle, and follow layout changes. That positioning and scheduling moves out of `widgets.ts` into `src/webview/overlay.ts`, used by all three.

### 9.3 The content pipeline extraction

The content pipeline moves out of `main.ts` into `src/webview/content/`: sanitize, decorate, diagram (on/dim, copies), wave, inline SVG, overlays. It runs in a fixed order on the incoming tree:

1. sanitize (with `sidestory:` conversion);
2. inline SVG;
3. waves;
4. copies;
5. decorate: refs, code links, areas;
6. step state: `cx-active`, `cx-on`, `cx-dim`, `cx-dimming`;
7. `cx-here`.

`--render` (§7.4) needs this, and it makes §2, §5 and §8 unit-testable without the whole panel.

### 9.4 Panel-owned attributes, and two dropped attributes

- **The sanitizer drops every author attribute that starts with `data-cx-`,** so the drop list can't fall behind new panel state. The exceptions:
  - `data-cx-props` on `<explain-widget>`;
  - `data-cx-wave` on `<explain-wave>`.

  Only the sanitizer sets those two, and only on those elements. Today only `data-cx-hl` is dropped.
- **It also drops `accesskey` and `autofocus` everywhere** (§0, §8.1).

### 9.5 State on the incoming tree, and `cleanHtml`

- **Everything the panel adds is applied to the incoming tree before the morph, as `cx-active` already is:**
  - classes: `cx-on`, `cx-dim`, `cx-dimming`, `cx-here`;
  - attributes: `--cx-step-accent`, `aria-description`, `href="#"` on areas;
  - rendered boxes: waves, copies, inlined SVG.

  Otherwise `fitFrame`'s style flush, between the morph and `decorate()`, would restart transitions on every live edit.
- **`cleanHtml` strips all of these.** Panel-added attributes carry a `data-cx-*` marker (`data-cx-ref`, `data-cx-href`, `data-cx-desc`), so an author's own `href="#"` or `aria-description` is never stripped.
  - A test asserts that a pure step change yields no `cx-updated` and no "updated" announcement.

---

## 10. Order of work, splitting it, and NAVIGATION-PLAN.md

### 10.1 Sequencing with NAVIGATION-PLAN.md

1. **The rename first:** NAVIGATION-PLAN.md §2, in its own commit, after the in-flight `src/` work lands. Nothing here starts before it, so nothing has to be changed twice (paths in examples, the checker's messages, the skill).
2. **NAVIGATION-PLAN.md phase 2 runs alongside this plan's phase 1.** That phase is pure core: `src/cli/html.ts` → `src/core/html-scan.ts`, `outlineHtml`, `group`, and its checker additions.
   - Its tokenizer move is the one shared file. The checker work here (`data-explain-on`, `data-explain-code`, `<explain-wave>`, `<area>`, inlined assets) builds on `html-scan.ts`, so it starts after that move lands, about two days in.
3. **The manifest model change (§1.1: `Anchor.parts`, `AnchorPart`, `partKey`) lands before NAVIGATION-PLAN.md phase 3, the index.**
   - The index then stores `anchors: {id, parts: [{fileKey, range, pinned}]}` from the start, and "Explained here" lenses can say "step 3, seen".
   - The `Anchor` type goes in one small PR that both plans build on.
4. **Both plans touch `onSelection` and `anchorAtLine`:** NAVIGATION-PLAN.md phase 5 (the Explained-here status bar and CodeLens) and the cursor fix here (§0, §8.2).
   - The rule "only sections count for cursor-follow" belongs in the shared helper both use.
   - Whichever lands second rebases.

### 10.2 Three agents, disjoint files

| Agent | Owns | Items |
|---|---|---|
| **A: anchors and the extension host** | `src/core/**` (manifest, resolve, sections, the new `symbols/`); `src/extension/session.ts`, `decorations.ts`, `pin.ts`, `manifest-edit.ts`, `extension.ts`; `src/extension/widgets/code-access.ts` and `host.ts` (per-part serving, the symbol rule of §4.8); `src/shared/protocol.ts`; `src/cli/check-widgets.ts` (the wiring) and `src/cli/checks/anchors.ts`; `package.json` contributions | 1, 4, and the host side of 8 (`openCode`, `peekCode`, `here`, link resolution, the §0 fix) |
| **B: the panel** | `src/webview/**` (`main.ts`, `sanitize.ts`, `content.css`, the new `content/`, `overlay.ts`, `preview.ts`); `src/shared/wave/**`; `src/shared/diagram-tokens.css`; `src/cli/checks/html.ts` (the on, code, wave, area and inline findings, exported for A to wire) | 2, 3, 5(a), 6 (tokens), the panel side of 1 (the footer) and the panel side of 8 |
| **C: CLI render, widget runtime and examples** | `src/cli/render/**`; `scripts/build.mjs` entries; `scripts/capture-theme-vars.ts`; `src/widget-runtime/**` (`Wave`, the `theme.css` import, SDK `part` options); `src/widget-types/**`; `examples/stream-dma/**`; `tools/diagrams.py`; the SV corpus files for the stream-dma upgrade | 7, 5(b), 6.3–6.4, and the widget SDK side of 1 |

Rules that keep them apart:

- **On day 0, A opens one contract PR** (half a day): the `protocol.ts` message types of §9.1, the `Anchor` / `AnchorPart` / `partKey` types, and the stub `src/cli/checks/` layout.
  - B and C code against it.
  - After that, only A edits `protocol.ts` and `check-widgets.ts`.
- **B's first task is the content-pipeline extraction (§9.3),** which C's harness needs.
  - Until it lands (about two days), C works on browser discovery, the CDP client, theme capture and the `Wave` back end, which don't need it.
- **Docs.** Each agent writes its own GUIDE and WIDGETS subsections, which are listed per item, in its own commits.
  - C owns SKILL.md and runs `npm run sync-skill` at the end of each phase.
  - `test/unit/skill.test.ts` catches anyone who forgets.
- **Tests** live with their owners:
  - A: `test/unit/symbols-*.test.ts`;
  - B: `test/webview/diagram.pw.ts`;
  - C: `test/unit/render-*.test.ts`.

  New e2e files (`diagrams.e2e.ts`, `parts.e2e.ts`, `codemap.e2e.ts`) keep the agents out of each other's way in `explainer.e2e.ts`.

### 10.3 Phases

Each phase ends with every suite green, and can ship on its own.

1. **Look and light** (about 1 week):
   - **B:** the content-pipeline extraction; tokens (§6); the link look (§3); `data-explain-on` with scopes, `dim-rest` and modes (§2); the sanitizer drops (§9.4).
   - **A:** the contract PR; `Anchor.parts` in the model (single-part only); the cursor-follow fix (§0).
   - **C:** browser discovery; the CDP client; theme capture; the stream-dma conversion to tokens and `data-explain-on`.
2. **Preview and waves** (about 1.5 weeks):
   - **C:** `--render` end to end (§7); `<Wave>`.
   - **B:** `<explain-wave>` (§5a); `data-explain-copy`; the overlay layer.
   - **A:** the SV scanner and its corpus (§4.3).
3. **Symbols and parts** (about 2 weeks):
   - **A:** symbol resolution and precedence, Pin and Re-anchor, `--symbols` (§4); then multi-part anchors end to end (§1).
   - **B:** the footer part switcher.
   - **C:** the widget SDK `parts` / `part` options; stream-dma's symbol anchors via `--pin --symbols`.
4. **Code map** (about 2 weeks):
   - **A:** `openCode`, link resolution, `here`, `peekCode`.
   - **B:** `data-explain-code` in the panel; cursor lighting; the hover preview; image-map overlays; `data-explain-inline`; `sidestory:` links; wave signal links.
   - **C:** render support for overlays and inline SVG; stream-dma's `m-*` refs moved to `data-explain-code`; the docs pass and skill sync.
5. **Extras, when wanted:**
   - wave edges and arrows;
   - a Python symbol scanner;
   - `sidestory.parts.layout: "split"`;
   - identifier-based cursor lighting;
   - a binding table for draw.io;
   - instance paths and a module index.

**Total:** about 56 agent-days; about 7 weeks with three agents in parallel. That's too much for one release; §10.4 cuts it.

### 10.4 Scope: the first release (about 15 agent-days)

The first release covers what the team does in every page and can't do today: diagrams that follow the steps, look consistent, open their code from any box, and light up from the editor.

| In release 1 | Agent-days | Cut down to |
|---|---|---|
| Sanitizer drops (`accesskey`, `autofocus`, every author `data-cx-*`, §9.4) | 0.5 | all of §9.4 |
| Theme tokens (§6) | 2 | §6.1–6.3 and the docs |
| The stream-dma **overview page** converted to tokens and `data-explain-on` (one diagram per section, with `section` mode) | 0.5 | So the flagship example matches the guide. The other pages, `diagrams.py` and copies follow in release 3. |
| Built-in link look and the docs on links on any element (§3, §8.4, §8.5) | 1.5 | all of §3 |
| `data-explain-on` (§2) | 3 | §2.1–2.3, including `section` (cheap) and `dim-rest` / `data-explain-keep` (without them, authors tag every wire), without `data-explain-copy` or `data-explain-view` |
| `data-explain-code` (§8.1) | 2.5 | `#L10-L20`, `#name`, `#driver(x)`, `data-explain-code-file`, trusted-handler posting, real-path checks, the confirmation for secret-looking files, checker validation. **It keeps the backstops too:** `openCode` rate-limited to 10 a second; `codeTargets` capped at 500 links, deduplicated and schema-validated; line numbers at most 10,000,000; labelable elements ignored. Non-SV `#name` links call the symbol provider on a click only. Cursor lighting resolves them only in documents already open, so release 1 never wakes a language server for a file the reader hasn't opened. No `sidestory:` links. |
| An SV scanner, lite version (§4.3) | 4 | Tokenizer (comments, strings, attributes, escaped names, `` `define`` skipped). **Only the first arm of each `` `ifdef`` is scanned**: the later arms get only a names-only pass, with no scope stack, used just for the skipped-arm hint below. That avoids the scope-stack desync without `sv.defines`. Scopes: `module` … `endmodule`, `begin`/`end` with labels, `case`/`endcase`, `fork`/`join`, `function`/`task`, `generate`. What it finds: declarations (ports, signals, parameters, typedefs, instances), `driver(x)` from `always*` blocks and `assign`s with the target rules of §4.2, **`case` items** (`#driver(state_d).case(IDLE)`, outermost `case`, so each bubble of an FSM diagram links to and lights from its own arm), and **port connections** (`#u_ctrl(.rd_start)`, so a wire in a top-level diagram, whose net is driven only through an instance output, has a real target). Not in it: runs, `.header`, macros, the manifest `symbol` / `within` fields. It's the same module the full version extends, so nothing is thrown away. **It keeps the §4.3 cost protections:** a 20 M token budget, then `partial`; slicing every `SLICE_MS`, abandoned when a newer document version arrives; files over 1 MB rescanned only after 1 s idle. A symbol found only in a later `` `ifdef`` arm reports `symbol-missing` with the hint "defined in a later `ifdef` arm (not scanned yet)", and the guide says so. |
| Cursor lighting (§8.2), with the cursor-follow fix (§0) | 2.5 | all of §8.2 |
| The `Anchor.parts` model type, normalized single-part only (§1.1) | 0.5 | Types and `partKey` only, so NAVIGATION-PLAN.md's index stores parts from the start (§10.1, step 3) |
| **Total** | **17** | Back to 16 by deferring the overview conversion; the next cut would be `section` mode. |

**Where this departs from the coordinator's first guess:**

- **Multi-part anchors (§1) move to release 2.** They're the most invasive item: manifest v3, decorations, cursor-follow, Pin, Re-anchor, widget serving and NAVIGATION-PLAN.md's index all change.
  - Even cut to the switcher, the checker and Pin, with no Re-anchor "add part" and no widget SDK changes, they cost about 4 days.
  - Nested anchors work in the meantime, and `data-explain-code` plus cursor lighting covers "show me where `done` lands" from a diagram.
  - Release 1 still lands the type (above), so nothing has to be migrated later.
- **`<explain-wave>` (§5) moves to release 2.** At about 4 days for the core subset, it would push the release past 19.
  - Authors can draw a trace in SVG with the tokens meanwhile.
  - If the budget stretches to about 19 days, waves are the first thing to add back: the core subset, with marks, without signal links or edges.
- **Line links alone aren't enough,** so the scanner lite is in.
  - RTL gets reformatted often, so `#L` links drift silently. `#name` and `#driver(x)` are what make code links and cursor lighting worth having on RTL.
  - Declarations alone would light a box only from its declaration line. `driver(x)` covers the block that does the work, so it's in.
- **`case` items and port connections are in the scanner lite** (+1 day). These were the hardware reviewer's round-3 call. Without them, an FSM diagram rings every bubble at once (the whole `always_comb`), and a top-level diagram's wires can link only to a declaration line that holds five nets.
- **Two cheap pieces stay in release 1:** `section` mode and `dim-rest`. Without `dim-rest`, the overview's 60 wires all need tagging by hand.
- **Agreed as later:**
  - full symbol paths and manifest `symbol` / `within`;
  - `` `ifdef`` arm choice, `sv.defines` and `sv.macros`;
  - `--render`;
  - image-map overlays;
  - draw.io inlining and `sidestory:` links;
  - the hover preview;
  - `data-explain-copy`.

**Release 2** (about 16 days), in this order:
- `<explain-wave>` with signal links (4.5): handshake traces are the second most common RTL figure;
- `--render` (7.5): agents writing pages need to see them, and it catches width problems;
- multi-part anchors with the switcher, the checker, Pin and Re-anchor (4, with the widget SDK later).

**Release 3:**
- full symbol anchors (§4);
- the hover preview;
- copies;
- the rest of the stream-dma conversion;
- image maps;
- draw.io (`data-explain-inline`, `sidestory:` links);
- the widget SDK for parts;
- the extras in §10.3 phase 5.

**Splitting release 1 between agents:**
- **A:** the scanner lite, `openCode` and link resolution, `here` and the cursor fix, the `Anchor.parts` type.
- **B:** the sanitizer drops, tokens, link look, `data-explain-on`, `data-explain-code` in the panel, `cx-here`.
- **C:** docs, skill sync, and the checker findings for the release-1 items. C also starts the release-2 `--render` groundwork (browser discovery, the CDP client), which no release-1 code depends on.

---

## 11. Open questions

1. **Part-switch keys.** H / L in the panel. Which global keybinding for **Next Code Part**: `Alt+\`, `Alt+.`, or none?
2. **`sidestory.parts.layout: "split"`.** Build it, or rely on the switcher's hover card (§1.3) until readers ask?
3. **Symbol syntax.** Dot paths with `driver(x)`, `.header`, `.case(LABEL)`, `u_a..u_b` and `u_ctrl(.port)`, instead of the original `dma_ctrl::always_ff[state_q]`. The original was avoided because `::` means package scope and `[…]` reads as a bit select. Is this the syntax the team wants?
4. **Instance paths and a module index.** Should `dma_top.u_ctrl.state_q`, or a bare `dma_ctrl.state_q` with no file, resolve by indexing module names across the repository? v1 reports "did you mean" instead.
5. **Where `sv.defines` and `sv.macros` live.** In each manifest (v1 of this plan), or in a folder-wide config next to the sidestories (NAVIGATION-PLAN.md owns that layout)?
6. **A Python symbol scanner for the CLI,** or keep non-SV symbols "checked only in VS Code"?
7. **`--render-widgets`.** Should it exist (running repository code headless, gated like `--yes-widgets-may-read`), or should renders always show fallbacks?
8. **Cursor lighting outside the current section.** This plan lights boxes anywhere and never changes the step for element links. Should it also offer the "Cursor is in …" pill when the lit box is in another section?
9. **Preview of git-ignored files.** Shown (proposed, as reveal does), or hidden like secret-looking files?
10. **stream-dma:** one diagram plus `data-explain-copy` (a smaller file, proposed), or generated copies, so the page reads the same in other HTML viewers?
11. **A draw.io binding table** (`data-explain-bind`, mapping shape labels to links), for tools whose re-exports drop links. Now, or after `sidestory:` links prove insufficient?
12. **Confirmation for secret-looking files on `data-explain-code` clicks.** It's proposed. Should manifest-anchor reveals of secret-looking files ask too, for consistency? That would change today's behaviour.

---

## 12. Review log

Two independent reviews of the first draft, both read-only against the code.

**The hardware engineer's review.** Accepted:
- `driver(x)` as the primary form;
- `.header`, runs of siblings (`a..b`), case items, port connections, labelled assertions, modports and clocking blocks;
- comment blocks included in extents;
- `--pin --symbols` covering the stream-dma anchors, plus `within` proposals;
- the `` `ifdef`` scan with stack copies, one chosen arm and `sv.defines`;
- declared flop macros (`sv.macros`);
- spelled-out assignment-target rules (concatenation, `<=` as a comparison, slices, interface members, compound assignments, delays) and a test for each;
- the default name taken from the functional branch;
- the `instance-path` finding;
- part addressing by label with `:`, keeping `#` for code fragments;
- parts inheriting a top-level `file`;
- the switcher's hover card;
- `data-explain-view` on copies;
- `dim-rest` and `data-explain-keep`;
- `data-explain-code-file`;
- wave signal links, `cycles` (inclusive) and `edge` marks, the WaveDrom script type;
- reset and clock-domain tokens;
- combined `sidestory:` links;
- no fading mask over images;
- the stream-dma corpus caveat.

Deferred to open questions: instance paths and a module index, the draw.io binding table, identifier-based cursor lighting.

**The security, performance and correctness review.** Accepted:
- `openCode` posted only from trusted handlers, with no time window;
- `accesskey` and `autofocus` dropped;
- real-path checks for every `openCode` target;
- the symbol-extent limit on widget code access;
- inline-mode sanitizing (drops, asset-relative URLs, id prefixing, `@scope`, HTML-parser parsing);
- a fake-origin base URL and `Fetch` interception for `--render`;
- `mkdtemp` output, symlink refusal and stale-image cleanup;
- exit code 3;
- sandbox-failure guidance;
- version detection through CDP;
- no non-SV provider calls on hover;
- the secret filter on the real file's name too;
- no `peeked` text to widgets;
- the JSON5 depth cap and null-prototype objects;
- the exceptions in §9.4 scoped to their elements;
- percent-decoding once;
- `aria-description` instead of a cross-document `aria-describedby`;
- every panel state on the incoming tree, with marked attributes in `cleanHtml`;
- `cx-dim` computed by the panel (no `:has()`);
- copy filtering, IDREF rewriting and caching;
- the wider effect of the §0 cursor bug (the focus bar moves), nested sections, and the fallback before `codeTargets`;
- the `usemap` wording;
- a sliced scanner;
- `max(current, required)` for versions;
- a separate `AnchorPart` type;
- `partKey`;
- frame-time budgets;
- every listed test gap.

**Round 2: the same reviewers on the revision.** No blockers.

*Hardware engineer.* Every round-1 finding was resolved except two, which came back as the two majors below. Accepted:
- **(major)** `dim-rest` must never fade inside `<defs>`, `<marker>`, `<pattern>` and the like. Otherwise the arrowheads of lit wires fade too.
- **(major)** `driver()` doesn't cross instance ports. `symbol-missing` now names the connection or the input port instead, and the broken wave example is fixed.
- **(minor)** The dma_csr example was wrong. The default name now prefers a `highlight` signal, then the functional branch.
- **(minor)** The reset heuristic now matches `rst` or `reset` anywhere, or the non-clock edge in the sensitivity list.
- **(minor)** Defines and macros are now part of the symbol-table cache key.
- **(minor)** `abort` moved to `within`. `--pin --symbols` now shows range growth, with `--dry-run` and `--accept-growth`.
- **(minor)** `.case()` matches only the outermost `case`, with labels compared as tokens.
- **(minor)** Edge cases of runs are defined.
- **(minor)** A macro's extent no longer needs a trailing `;`.
- **(nit)** Wave `edge` follows the first clock's `period` and `phase`.
- **(nit)** The "seen" part in the §1.1 example uses `within`.

*Security, performance and correctness.* Every round-1 finding was resolved adequately. Accepted:
- **(major)** The copy cache key now covers the source after inlining and waves, the theme kind and the asset versions.
- **(minor)** `data-explain-code-file` is resolved before copying, and the checker applies the same inheritance.
- **(minor)** Inline mode drops `data-explain-inline`, and the `<img>` id is kept unprefixed.
- **(minor)** Id prefixing covers `<style>`, which is written out from the CSSOM inside `@scope`. The render's minimum is Chrome 118.
- **(minor)** `sv` from the manifest is validated, looked up in a `Map`, and capped. `--define` replaces the manifest's defines.
- **(minor)** `sidestory:` links are split before they're decoded. `?on=` comes last, and both orders are tested.
- **(minor)** Output files are created exclusively (`wx`) after an unlink.
- **(minor)** `dim-rest` fades whole untagged subtrees, and only tagged elements count toward the cap.
- **(nit)** The widget rule for symbol anchors is token equality with no length cap, so reformatting still serves.
- **(nit)** The `Fetch` allow list is empty, the harness is set inline, and `Fetch.enable` comes first.
- **(nit)** The transition is on every element, so un-fading animates too.
- **(nit)** Labelable elements ignore links.
- **(nit)** The copy id and IDREF wording is fixed, and waves are unwrapped in copies.
- **(nit)** The `aria-description` of a secret-filtered target is the header only.

The security reviewer said that with these fixed, only nits remain.

**Round 3.** *Security, performance and correctness:* no blockers or majors. The release-1 cut ships nothing whose security fix is deferred. Folded in:
- **(minor)** The scanner-lite row restates the token budget, slicing and idle rescans.
- **(minor)** The `data-explain-code` row restates its backstops: the rate limit, the `codeTargets` caps and the line cap.
- **(nit)** The hint for symbols that exist only in a later `` `ifdef`` arm.
- **(nit)** Non-SV links are resolved only in open documents for cursor lighting.

After these, only nits remain.

*Hardware engineer, round 3:* no blockers. Its judgement of the cut: the priorities are right, and putting the scanner lite in is the correct call. Folded in:
- **(major)** `case` items in the scanner lite.
- **(major)** Port connections in the scanner lite.
- **(minor)** The reset heuristic matches whole identifier segments, so `first_q` and `*_burst*` no longer count as resets.
- **(minor)** The hint for symbols in a skipped `` `ifdef`` arm (already added for the security review).
- **(nit)** Waves come first in release 2.
- **(nit)** The overview page is converted in release 1.

Release 1 is now about 17 days.

**Round 4.** *Hardware engineer:* only nits remain. All three are folded in:
- later `ifdef` arms get a names-only pass for the hint;
- more active-low reset spellings are recognized;
- a corpus case for `unique0` / `priority` and one-hot `case (1'b1)`.

Both reviewers now report nits only.
