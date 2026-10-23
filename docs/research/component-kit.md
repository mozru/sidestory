# Component kit: research and design

> Written when the folder was `.explain/`, the page was `explainer.html` and sidestories were called explainers.

Status: research draft, 2026-10-21. Extends DESIGN.md §4.5 and §5.3. Versions and licenses come from the npm registry on 2026-10-21 unless a URL is cited. Re-verify before pinning.

## 1. Decisions

1. **Custom elements, built with Lit, rendering into Shadow DOM.**
   - The author's source (the light-DOM children) stays untouched.
   - The rendered output lives in the shadow root.
   - This split makes live updates safe: the page morph (§4) only ever touches the source, never the rendering.
   - With no JS, the source is what shows, which gives a free fallback (§6).
   - CSS custom properties inherit through the shadow boundary, so `--vscode-*` theming still works.
2. **Mostly in-house renderers, with a few lazy-loaded libraries.** Most of these visuals (bit fields, trace tables, linear pipelines, callouts) are trivial to lay out. Owning their SVG means every stroke and fill is a CSS variable: no hex values and no re-render when the theme changes. Libraries are only used where layout is genuinely hard: graph layout (ELK), sequence diagrams and long-tail diagrams (Mermaid), syntax highlighting (Shiki), and waveforms (WaveDrom).
3. **Syntax an LLM already knows.** Diagram bodies use a subset of Mermaid syntax. Waveforms use WaveJSON. Everything else uses plain HTML children with a few attributes. Claude writes Mermaid and WaveJSON fluently, and malformed input degrades to readable text.
4. **One binding convention everywhere.** Any item inside a component can carry `ref="<anchorId>"`. Clicking it focuses that code, and it lights up when the anchor is active.

## 2. Library evaluation

| Library | Version / date | License | Size | Theming | Verdict |
|---|---|---|---|---|---|
| **Mermaid** | 12.2.0, 2026-10-13 | MIT | multi-MB; 12.0's IIFE grew about 500 kB gz from inlined ELK, while ESM loads ELK as a separate chunk ([12.0 notes](https://newreleases.io/project/github/mermaid-js/mermaid/release/mermaid@12.0.0)) | `base` theme plus `themeVariables`. These need concrete colors, so resolve the vars first. 12.x changed the default look to `neo`/`redux-color`. | **Lazy chunk** for `<ex-sequence>` and the `<ex-mermaid>` escape hatch. Pin `look: 'classic'` and `theme: 'base'`. |
| **ELK.js** | 0.12.0, 2026-07-17 | EPL-2.0 OR GPL-3.0+ (fine for bundling unmodified) | 1.43 MB min / 437 kB gz (bundlephobia) | Layout only; we draw | **Lazy chunk**. Layered layout for `<ex-pipeline>` and `<ex-state-machine>` once they stop being linear. |
| **Graphviz WASM** | @viz-js/viz 3.31.0, 2026-09-28 (MIT); @hpcc-js/wasm-graphviz 1.30.0, 2026-10-21 (Apache-2.0) | | viz about 524 kB gz ([depscope](https://depscope.dev/pkg/npm/@viz-js/viz)) | Output SVG has hard-coded colors that need post-processing | **Not in v1.** ELK covers the layout need. Keep as an option for `engine="dot"`. |
| **D2** | @terrastruct/d2 0.1.33, 2025-08-17 | MPL-2.0 | Go→WASM in a web worker, 60 MB unpacked ([jsDelivr README](https://cdn.jsdelivr.net/npm/@terrastruct/d2@0.1.33/README.md)) | Its own themes | **Reject.** Too heavy, needs a worker plus WASM CSP, has had no release for over a year, and an HN commenter called the JS API "not super officially ready" ([HN](https://hn.svelte.dev/item/44954524)). |
| **Excalidraw** | 0.18.1, 2026-04-20 | MIT | 46.8 MB unpacked, needs React, loads fonts from a CDN by default ([npm](https://npmjs.com/@excalidraw/excalidraw)) | n/a | **Reject** as a runtime dependency. Authors may export `.excalidraw` to SVG and use `<img>`. |
| **Rough.js** | 4.6.6, 2023-11-20 | MIT | 8.8 kB gz | Takes stroke and fill strings | **Optional** `look="sketch"` on our SVG diagrams. Off in high-contrast. Stable but dormant. |
| **WaveDrom** | wavedrom 3.7.0, 2026-08-31 | MIT ([repo](https://github.com/wavedrom/wavedrom)) | moderate | Skins are embedded style blocks, so we swap in a generated "theme skin" | **Use** for `<ex-waveform>`, as a lazy chunk. |
| **bit-field** (WaveDrom reg) | 1.9.0, 2024-02-22 | MIT | small | onml output, fixed styling. Rated low on maintenance ([depscope](https://depscope.dev/pkg/npm/bit-field)) | **Don't depend on it.** Accept its `reg` JSON as an input format for our own `<ex-bitfield>` renderer. |
| **Surfer** | v0.7.0, 2026-04-27 | **EUPL-1.2** (copyleft; [repo](https://gitlab.com/surfer-project/surfer)) | Rust/egui → WASM canvas, several MB | Its own TOML themes, canvas-rendered, so no CSS vars | **Link out, don't embed.** It can be embedded in web apps and has a remote-control protocol, WCP ([CAV'25](https://ics.jku.at/files/2025CAV_Surfer.pdf)), and the repo ships `surfer-vscode`. Use it for "Open full trace" via WCP or the Surfer extension. |
| **wellen** (VCD/FST/GHW parser behind Surfer) | crate 0.25.7, 2026-10-13 | BSD-3 | native | n/a | **Use in the slicing tool** (§3.9), not in the webview. |
| **Shiki** | 4.5.0, 2026-10-01 | MIT | Fine-grained core plus per-language and theme chunks | Supports dual themes and a `css-variables` theme ([docs](https://shiki.style/guide/dual-themes), [colors](https://shiki.style/guide/theme-colors)) | **Use** for `<ex-code>`. See the theming note in §5. |
| **Code Hike** | 1.1.0, 2026-03-17 | MIT | | React/MDX only ([depscope](https://depscope.dev/pkg/npm/codehike)) | **Borrow the idea**, not the library: comment annotations such as `// !mark`. |
| **Observable Plot** | 0.6.17, 2025-02-14 | ISC | 130 kB gz | Attribute colors, so resolve tokens first | **Optional lazy chunk** for `<ex-chart>`. Slow release cadence but stable. |
| **Lit** | 3.3.3, 2026-05-14 | BSD-3 | 6 kB gz | n/a | **Use** as the base for every kit element. |
| **vscode-elements** | @vscode-elements/elements 2.5.1, 2026-02-21 | MIT | Lit-based ([index](https://docsearch.algolia.com/mcp/docs/repo/vscode-elements/elements)) | Reads `--vscode-*` | **Use for viewer chrome** (toolbar, tabs, buttons, collapsibles), not inside explainer visuals. Actively maintained. Not to be confused with the dead `@bendera/vscode-webview-elements`. |
| **idiomorph** | 0.8.0, 2026-09-05 | 0BSD | tiny | n/a | **Use** for in-place updates of the page DOM. |

Budget:
- **Core kit** (Lit, runtime, and all non-diagram components): under 60 kB gz.
- **Lazy chunks**, loaded by dynamic `import()` from bundled files under `localResourceRoots`: ELK, Mermaid, Shiki grammars, WaveDrom, Plot.
- **No CDN** and no `eval`.
- Run ELK on the main thread (`elk.bundled.js`) so the CSP needs no `worker-src`.

## 3. Components

Every component is block-level and works inside or outside a `data-explain-anchor` section. The common attributes are:
- `ref`: binds an item to an anchor.
- `tone`: a `charts.*` color name, one of `blue | red | yellow | orange | green | purple`. It defaults to the anchor's `color` from the manifest.
- `caption`: a caption for the component.

### 3.1 `<ex-pipeline>`: block diagram or dataflow
The body uses Mermaid flowchart syntax (subset: nodes, `-->`, `-- label -->`, `subgraph`, LR/TD). A purely linear chain renders as a flex row of blocks with no layout library. Anything else uses ELK layered layout and our own SVG.

```html
<ex-pipeline caption="Bytes in, bits out">
flowchart LR
  in_byte[in_byte · 8b] -- refill --> buf_q[(buf_q · 64-bit window)]
  buf_q -- "<< rd_bits" --> peek[peek]
  cnt_q{{cnt_q}} -.-> in_ready & avail
</ex-pipeline>
```
**Binding:**
- A node whose id equals an anchor id binds automatically.
- Otherwise, map ids to anchors with `refs="buf_q:state cnt_q:state in_byte:refill"`.
- Edges can bind too, with `refs="buf_q->peek:consume"`.

**Unsupported syntax:** the component falls back to rendering the body with Mermaid (§3.10) and shows a small "rendered by Mermaid" note in dev mode.

### 3.2 `<ex-state-machine>`
The body uses the Mermaid `stateDiagram-v2` subset. It is laid out with ELK, with the initial state on the left and self-loops drawn as arcs. In the active step, the current state fills with its tone and the transition into it is emphasized.

```html
<ex-state-machine refs="FILL:refill DRAIN:consume">
stateDiagram-v2
  [*] --> EMPTY
  EMPTY --> FILL : in_valid
  FILL --> DRAIN : avail
  DRAIN --> FILL : cnt_q <= W-8
</ex-state-machine>
```
An optional `trace="EMPTY FILL FILL DRAIN"` adds a play control that steps through the states. Clicking a transition label focuses the anchor of the guarding condition.

### 3.3 `<ex-sequence>`
The body uses Mermaid `sequenceDiagram` and is rendered by Mermaid (lazy) with `theme: base` and themeVariables resolved from tokens (§5).
- **Binding:** `refs` maps participants by name, and messages by their 1-based index (`refs="#2:handshake #4:refill"`).
- **How the binding is applied:** the component post-processes the SVG, tagging message groups in document order.

```html
<ex-sequence refs="#1:handshake #3:refill">
sequenceDiagram
  participant P as producer
  participant R as bit_reader
  P->>R: in_valid + in_byte
  R-->>P: in_ready
  R->>R: buf_q |= byte << (W-8-cnt)
</ex-sequence>
```

### 3.4 `<ex-bitfield>`: register map or bit window
Our own SVG renderer. MSB is on the left. The component can split into lanes of `lane-width` bits.
- **Two input forms:** `<field>` children, or a `<script type="application/json">` holding WaveDrom `reg` JSON. The second form exists because Claude knows it.
- **Markers:** these cover the mockup's "bit-window bar" and "shift bars".

```html
<ex-bitfield width="64" caption="buf_q after 5 bytes">
  <field bits="63:24" name="valid (40)" ref="state" tone="blue"></field>
  <field bits="23:16" name="next byte lands here" ref="refill" tone="purple"></field>
  <field bits="15:0"  name="empty" muted></field>
  <marker at="24" label="W−cnt_q"></marker>
</ex-bitfield>
```
**For the before/after shift picture**, put two bitfields in `<ex-compare>`. Add `animate-from="#prev-id"` to tween the field positions when the step becomes active.

### 3.5 `<ex-trace-table>`: cycle or iteration trace
The body is a plain `<table>`, since an LLM writes tables perfectly. The component adds:
- sticky headers;
- per-column number formats: `format="buf_q:hex cnt_q:dec"`;
- a highlight on any cell that differs from the row above (`highlight-changes`);
- row binding with `<tr ref>`;
- a row cursor that follows the active step.

```html
<ex-trace-table highlight-changes format="buf_q:hex">
<table>
  <tr><th>cycle<th>rd_en<th>rd_bits<th>in_valid<th>cnt_q<th>buf_q</tr>
  <tr ref="refill"><td>1<td>0<td>0<td>1<td>8<td>0xA500000000000000</tr>
  <tr ref="consume"><td>2<td>1<td>3<td>0<td>5<td>0x2800000000000000</tr>
</table>
</ex-trace-table>
```

### 3.6 `<ex-compare>`: before/after or option A/B
It has two or more slotted panes with headers, laid out side by side (stacked below 520 px).
- `diff` mode: when both panes are `<ex-code>`, it renders a line diff.
- `sync-scroll` attribute: links scrolling between the panes.

```html
<ex-compare>
  <div slot="before" label="Naive: shift first, then OR">…any HTML or components…</div>
  <div slot="after"  label="Ours: OR below valid bits" ref="refill">…</div>
</ex-compare>
```

### 3.7 `<ex-callout>` and `<ex-rules>`
- **Callout kinds:** `note | why | gotcha | invariant | perf`, each with a codicon and tone. Callouts contain free HTML.
- **Rule cards:** `<ex-rules>` lays out `<rule>` children as a card grid. This is the mockup's step 3.

```html
<ex-callout kind="invariant" ref="state">Bits above <code>W−cnt_q</code> are always valid; bits below are always zero.</ex-callout>
<ex-rules>
  <rule ref="handshakes" title="Accept a byte">only when 8 free bits remain: <code>cnt_q ≤ W−8</code></rule>
  <rule ref="handshakes" title="Serve a read">only when enough bits are valid: <code>cnt_q ≥ rd_bits</code></rule>
</ex-rules>
```

### 3.8 `<ex-steps>`: in-section procedure
A vertical numbered timeline in which each `<li ref>` is a step. It is distinct from the page-level stepper, which the viewer generates from sections. When the active anchor matches an item, that item gets the "you are here" treatment. `<ex-step-header n="3" tone="green">` gives a section a numbered, tinted header, like the mockup.

```html
<ex-steps>
  <li ref="consume">Shift the window left by <code>rd_bits</code>.</li>
  <li ref="refill">OR the new byte in just below the valid bits.</li>
</ex-steps>
```

### 3.9 `<ex-waveform>`: optional RTL plugin
Rendered by WaveDrom (lazy) with a theme skin. There are two sources:
- **Inline WaveJSON:** a `<script type="application/json">` block.
- **A real trace slice:** `src="assets/tb_refill.wave.json"`, produced from a VCD/FST file by the plugin's `slice_trace` MCP tool (wellen-based, run where the files are) with `signals`, `from` and `to`.

The webview never parses VCD files. Both viewers just read the small JSON.

`<mark at="3" ref="refill">` puts time markers on the trace. The active step draws a highlighted column. Clicking a signal name focuses its declaration (resolved via the anchor's `highlight` identifiers). `full-trace="sim/tb.fst"` adds "Open in Surfer".

```html
<ex-waveform caption="One refill, one read">
<script type="application/json">
{ "signal": [
  { "name": "clk",      "wave": "p......" },
  { "name": "in_valid", "wave": "01.0..." },
  { "name": "rd_en",    "wave": "0..10.." },
  { "name": "cnt_q",    "wave": "=.==.=.", "data": ["0","8","16","13"] } ] }
</script>
<mark at="1" ref="refill"></mark><mark at="3" ref="consume"></mark>
</ex-waveform>
```

### 3.10 `<ex-code>`, `<ex-mermaid>`, `<ex-chart>`
- **`<ex-code anchor="refill">`** is a live, Shiki-highlighted excerpt pulled from the resolved anchor, so it is never stale. It can also hold inline code with `lang`. It supports Code Hike-style comment annotations (`// !mark`, `// !callout[/x/] text`) and `lines="+1..-1"` for context.
- **`<ex-mermaid refs=…>`** is the escape hatch for any Mermaid diagram type. It uses the same theming and binding by node id.
- **`<ex-chart>`** wraps Observable Plot (optional). Its body is a JSON spec: `{marks:[{type:"barY", data:…, x:…, y:…}]}`. Use it for numbers such as latency or utilization, not for structure.

## 4. Runtime: binding, active step, live updates

A ~3 kB runtime (`ex-runtime`) owns the connection between the components and the viewer.

**Click → code**
- Any element in a kit shadow root with `ref` dispatches `ex:focus {anchorId, mode}`, with `composed: true` and bubbling.
- The runtime maps a plain click to `focusAnchor` and Ctrl/⌘-click to `openRef` (§5.2).
- Items with a ref get `role="button"`, `tabindex=0` and Enter/Space handling. Hover shows the anchor's file:line in a tooltip.
- In the static viewer, the same event scrolls and highlights the embedded code pane.

**Active state → components**
- The runtime keeps an **active set**: the current section's anchor, plus any anchor whose range contains the editor cursor (from `cursorMoved`). This lets a diagram node light up for a sub-range without the page changing sections.
- The runtime reflects the set to `<html data-ex-active="refill state">` and calls `el.setActive(set)` on every kit element.
- Components toggle `.is-active` on the matching items and dim others to about 55% opacity. They never use color alone: active items also get a 2 px `focusBorder`-style outline.
- Components scroll internally (trace rows, wide waveforms) to keep the active item in view. They never scroll the page; the runtime owns page scrolling.
- `stale` anchors (`staleAnchors`) get a dashed outline and the stale color.

**Live updates (no reload)**
- On `explainerUpdated`, the runtime fetches the new `explainer.html` and **morphs** `<main>` with idiomorph. Elements are matched by `id`, and by `data-explain-anchor` and `ref`.
- Because renders live in shadow roots, the morph only changes source children. Each kit element watches its own light DOM and attributes (MutationObserver plus `attributeChangedCallback`), hashes the normalized source, and re-renders on the next animation frame only if the hash changed.
- Scroll position, the active step, open collapsibles and in-flight animations survive the update.
- Manifest changes (anchor colors, ranges) are pushed as a `manifest` message. Components re-tone without re-layout.
- A **parse error** shows the previous good render plus a compact error chip ("line 3: unexpected `->>`"). The page never goes blank mid-edit. The MCP plugin's `lint_explainer` tool runs the same parsers headlessly, so Claude sees the errors too.

**Theme changes:** pure-CSS components need nothing. Library-backed ones (Mermaid, WaveDrom, Plot) listen for `body` class mutations (`vscode-light/dark/high-contrast`) and re-render from freshly resolved tokens.

## 5. Theming

**Token layer.** The kit CSS defines semantic tokens once. Components use only `--ex-*`:

```css
:root {
  --ex-fg: var(--vscode-editor-foreground, CanvasText);
  --ex-bg: var(--vscode-editor-background, Canvas);
  --ex-muted: var(--vscode-descriptionForeground, GrayText);
  --ex-border: var(--vscode-panel-border, var(--vscode-contrastBorder, GrayText));
  --ex-focus: var(--vscode-focusBorder, Highlight);
  --ex-code-font: var(--vscode-editor-font-family, ui-monospace, monospace);
  --ex-tone-blue: var(--vscode-charts-blue, #3794ff); /* … red yellow orange green purple */
  --ex-tint: color-mix(in srgb, var(--ex-tone) 14%, transparent);
  --ex-stale: var(--vscode-sidestory-staleForeground, var(--vscode-editorWarning-foreground));
}
```

Our `contributes.colors` (for example `sidestory.focusBackground`) surface as `--vscode-sidestory-focusBackground` and slot into the tokens.

**Fills and strokes.**
- Our SVG uses classes styled with `fill: var(--ex-tint); stroke: var(--ex-tone)`, so a theme switch costs zero JS.

**Libraries that need concrete colors** (Mermaid `themeVariables`, Plot, Rough.js): `resolveTokens()` reads `getComputedStyle` once per theme and passes hex values. The component re-renders on theme change.

**High contrast** (`body.vscode-high-contrast` / `vscode-high-contrast-light`, and `forced-colors: active` in the static viewer):
- tints drop to `transparent`;
- every shape gets a 1 px `--vscode-contrastBorder` stroke;
- the active state becomes a 2 px `--vscode-contrastActiveBorder` stroke plus bold label;
- dimming is disabled (opacity reads as noise in HC);
- tones are kept only as stroke color;
- `look="sketch"` is ignored;
- changed cells in trace tables get an underline marker as well as color.

**Code colors.** Shiki can't see VS Code's token colors from inside a webview. The extension host therefore finds the active theme's JSON (via `workbench.colorTheme` → the contributing extension's `contributes.themes[].path`) and posts it to the webview, where Shiki loads it as a custom theme. If that fails, it falls back to Shiki's `css-variables` theme mapped onto `--vscode-symbolIcon-*` / `--vscode-debugTokenExpression-*` variables. The static viewer ships `github-light`/`github-dark` dual themes.

**Icons:** codicons font (`@vscode/codicons`, CC-BY-4.0, so include attribution).

## 6. Static web viewer fallback

1. **Same bundle.** The kit and runtime run unchanged in the web viewer. A `theme-shim.css` defines the `--vscode-*` variables the kit uses, with Light+ and Dark+ values under `prefers-color-scheme`, plus a manual toggle. vscode-elements also works there because it reads the same variables.
2. **Prerendered snapshots.** The GitHub Action renders each kit element headlessly. It stores the SVG/HTML in `<template data-ex-prerendered="<source-hash>">` beside the source, still using CSS variables. On load, a component whose hash matches adopts the snapshot instantly and skips loading Mermaid, ELK or WaveDrom. This makes PR viewer pages fast and keeps them working with JS disabled (with a small inline loader as the only script).
3. **No-JS degradation.** An undefined element shows its light DOM:
   - tables, callouts, rules, steps and compare panes are already readable HTML;
   - diagram bodies are styled `ex-pipeline:not(:defined){white-space:pre; font-family:var(--ex-code-font)}`, so the Mermaid text reads as pseudo-code;
   - waveforms show their caption plus a link to the JSON.
4. **Anchors.** `focusAnchor` scrolls the embedded code pane at the pinned commit. The active set comes from the section in view. `slice_trace` output is committed under `assets/`, so waveforms never need the original trace.
5. **Explainers without the kit** still work everywhere. The kit is optional (Principle 2).

## 7. Explainer style guide (for Claude)

This text ships in the MCP server's `get_authoring_guide` tool and the plugin skill.

1. **One idea per section.** Each `data-explain-anchor` section answers one question about one span of code, such as "how does refill avoid clobbering valid bits?" If you need "and", split the section.
2. **Lead with the claim, then show it.** Start with a one-sentence takeaway (`<p class="lede">`), then add one visual, then at most about 120 words of prose. Code is in the left pane, so don't paste it unless you are annotating it.
3. **Pick the visual form to fit the idea, and vary it.** Don't use the same component in two consecutive sections.

   | The idea is about… | Use |
   |---|---|
   | what connects to what, data flow | `ex-pipeline` |
   | modes and transitions | `ex-state-machine` |
   | who talks to whom, in order | `ex-sequence` |
   | bit layout, packing, alignment | `ex-bitfield` |
   | how values evolve over time or iterations | `ex-trace-table` (software, or a few cycles) / `ex-waveform` (signal timing) |
   | a design choice or a transformation | `ex-compare` |
   | rules, invariants, preconditions | `ex-rules` / `ex-callout kind="invariant"` |
   | an ordered procedure inside one function | `ex-steps` |
   | quantities | `ex-chart` (rarely) |

4. **Bind everything clickable.** Every node, row, field and rule that corresponds to code gets a `ref`. Prefer node ids equal to anchor ids. Never reference an anchor that is missing from `manifest.json`. Run `lint_explainer` before finishing.
5. **Use real values.** Trace tables and waveforms should use values from the code's actual behavior or a real test run (`slice_trace`), never invented values that contradict the logic. Mark illustrative data with `caption="illustrative"`.
6. **Keep diagrams small.** Use at most 7 nodes, 10 edges, 8 trace rows, 6 waveform signals and 12 cycles. If it's bigger, split it across sections or zoom into one part.
7. **Color has meaning or none.** Use `tone` only to tie a visual element to its section's anchor color. Never write hex values, inline `style` colors or fonts. Use only the kit's tokens or `--vscode-*` variables.
8. **Never rely on color alone.** Pair a tone with a label, icon or position. Assume high contrast.
9. **Label names exactly as in the code** (`cnt_q`, not "the counter"). Put them in `<code>` in prose and use them as node labels.
10. **Use free HTML when the kit doesn't fit.** Write plain semantic HTML with `data-explain-anchor`/`data-explain-ref`. Don't bend a component into something it isn't.
11. **Keep updates minimal.** When refreshing a stale section, edit that section only, and keep its ids and `ref`s stable so live morphing preserves the reader's place.
12. **Use about 3–8 sections** per explainer, in the order a newcomer needs them (interface → state → rules → behavior → edge cases), not file order.

## 8. Open items

- Verify that Mermaid 12 with `look: 'classic'` and `theme: 'base'` looks right for sequence diagrams in high contrast.
- Measure WaveDrom's size and how robust the skin override is. If the override is brittle, write our own WaveJSON-subset renderer.
- Licenses: elkjs (EPL-2.0) and codicons (CC-BY-4.0) need attribution notices. Surfer (EUPL-1.2) may be used only as an external tool, never bundled.
