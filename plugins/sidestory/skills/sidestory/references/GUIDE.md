<!-- Copied from docs/ by scripts/sync-skill.mjs; edit the original. -->
# Sidestory guide

The full reference for writing and reading sidestories. For a quick tour, see the [README](https://github.com/mozru/sidestory/blob/main/README.md); for widgets, [WIDGETS.md](WIDGETS.md); for the security model, [SECURITY.md](https://github.com/mozru/sidestory/blob/main/SECURITY.md).

## Contents

- [Where it runs](#where-it-runs)
- [Reading a sidestory](#reading-a-sidestory)
  - [Finding your way in big repositories](#finding-your-way-in-big-repositories)
- [Writing a sidestory](#writing-a-sidestory)
  - [Link sections to code](#link-sections-to-code)
  - [The manifest](#the-manifest)
  - [Big systems: an overview with details](#big-systems-an-overview-with-details)
  - [Diagrams that follow the steps](#diagrams-that-follow-the-steps)
  - [Code links without an anchor](#code-links-without-an-anchor)
  - [How sections follow the code](#how-sections-follow-the-code)
  - [Styling](#styling)
  - [What's supported, and what's removed](#whats-supported-and-whats-removed)
  - [Checker rules](#checker-rules)
  - [Interactive widgets](#interactive-widgets)
- [Explaining a branch](#explaining-a-branch)
  - [Base, side and trivial marks](#base-side-and-trivial-marks)
  - [The coverage rule](#the-coverage-rule)
  - [Which sidestories count](#which-sidestories-count)
  - [Coverage in VS Code](#coverage-in-vs-code)
  - [Checking coverage](#checking-coverage)
  - [Coverage in CI](#coverage-in-ci)
- [Comparing versions](#comparing-versions)
- [Comments and Claude](#comments-and-claude)
  - [Local or shared](#local-or-shared)
  - [Turning on Ask Claude](#turning-on-ask-claude)
- [Settings](#settings)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Where it runs

- **Locally and remotely:** Remote-SSH, WSL, Dev Containers, Codespaces, and browser VS Code backed by a server (code-server, openvscode-server, `code tunnel`). Not on vscode.dev or github.dev alone, which have no server to run it.
- **In Restricted Mode.** Sidestory content can't run script, reach the network or read files outside the repository, so untrusted repositories are safe to read. Widgets never run there. See [SECURITY.md](https://github.com/mozru/sidestory/blob/main/SECURITY.md).
- **In every theme**, including high contrast: colors, fonts and focus come from your VS Code theme.

![The stream DMA overview's block diagram in the Default Light Modern theme](https://github.com/mozru/sidestory/raw/main/media/marketplace/block-diagram-light.png)

## Reading a sidestory

Open one with **Sidestory: Open Sidestory…**, or right-click a folder under `.sidestory/` in the Explorer. The editor shows and highlights the code of the current step.

**The step changes only on a click or a key**, never on scrolling, so diagrams, widgets and the editor stay on the step you chose while you read ahead:

- the step tabs, the picker narrow panels show and its < > buttons, a click in a section, a link;
- <kbd>J</kbd>/<kbd>K</kbd> in the panel, or <kbd>Alt</kbd>+<kbd>]</kbd> / <kbd>[</kbd> anywhere (<kbd>Ctrl</kbd>+<kbd>Option</kbd>+<kbd>]</kbd> / <kbd>[</kbd> on macOS, where <kbd>Option</kbd>+<kbd>]</kbd> types a quote);
- <kbd>Tab</kbd> from one section into another;
- Back / Forward, **Sidestory: Go to Step…**, a CodeLens, and the cursor pill (below).

Clicking a step tab (or picking a step) moves the code to it, and scrolls the page only when the step's section is off screen. Clicking the section you're already on only gives the panel focus. A widget that changes the step (`goToStep`, its next / previous buttons, a box in its diagram) keeps the page on the widget. Opening code scrolls the editor once, and not at all when the lines are already on screen.

- **Rest the pointer on a link or a diagram box** (or Tab to it) and its code lights up in the editors that show its file, with a mark in the scrollbar; your focus, cursor and step stay put. An arrow at the editor's edge points at lines out of view ("↑ Refill · L35–38"), and a note by the link says when no editor shows the file. Click to open the code. `sidestory.hoverReveal` also scrolls the editor to the lines while you hover, and back afterwards unless you clicked the link or went to that editor; `sidestory.hoverPreview` shows a `card` with the first lines instead, `both`, or `off`.
- **Move the cursor in the code** and the panel offers the step about it ("Cursor is in … · Show"); the step changes only if you click it. Boxes and links that point at the code under the cursor get a ring.
- **Right-click** in the page for **Copy** (with text selected), **Open Code** (on a link), **Go to This Step** (in another section), **Comment** and **Ask Claude** (on the section you clicked, with your selection quoted).
- **Back and forward** as in a browser: the ← → buttons, the mouse's back and forward buttons, **Sidestory: Back** / **Forward**, or VS Code's Go Back / Go Forward keys while the panel has focus (<kbd>Alt</kbd>+<kbd>←</kbd> / <kbd>→</kbd> on Windows; <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>-</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>-</kbd> or <kbd>Alt</kbd>+<kbd>←</kbd> / <kbd>→</kbd> on Linux; <kbd>Ctrl</kbd>+<kbd>-</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>-</kbd>, <kbd>Cmd</kbd>+<kbd>[</kbd> / <kbd>]</kbd> or <kbd>Alt</kbd>+<kbd>←</kbd> / <kbd>→</kbd> on macOS). History holds the steps you chose, the details you dived into and the sidestories opened in the panel, with their scroll position; a run of <kbd>J</kbd>/<kbd>K</kbd> steps counts once. With nowhere to go in the panel, the keys are VS Code's as usual (on Windows the mouse buttons always are).
- **VS Code's shortcuts work inside the page** and widgets (<kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>, <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>P</kbd>, <kbd>F1</kbd>…; a widget passes on only common ones). Copy, paste, undo, select-all and the scroll keys stay with the page (Ctrl+Page Up/Down still switch editors), and typing in a text field stays with the field.
- **Everything updates live.** Edit the code (saved or not) or the sidestory and the panel follows, keeping your place, focus and anything you're typing. Sections follow code that moves, and say when it changed, needs a look, or can't be found.

### Finding your way in big repositories

The **Sidestories** view (the Sidestory icon in the activity bar, shown once a workspace has sidestories, or **Sidestory: Show Sidestories**) lists every sidestory:

- **Packages.** Each `.sidestory/` folder is a package, listed apart (`services/auth/.sidestory/`, `services/billing/.sidestory/`), with anchor paths relative to the folder that holds it. Detail links stay inside one package; a `.sidestory/` inside another sidestory is ignored.
- **Start here.** In each package, a sidestory named `overview`, else the only one named `*-overview`, else the only top-level sidestory with details, is pinned first.
- **Tops and details.** A sidestory nothing links to is top-level, with its details nested under it in page order; a detail linked from several places appears under each. `group` files top-level sidestories in folders, and `top: true` keeps a linked one at the top level.
- **What needs you.** Each row shows its problems (errors, broken detail links, steps out of date or lost) and open comment threads ("2 problems · 3 comments, 1 for you"), with a warning or comment icon; the tooltip lists them.
- **Filter** (the funnel in the title bar) matches titles, names, summaries and groups, and shows each match once, under its shortest path from a top-level sidestory.
- The view selects the open panel's sidestory (`sidestory.sidebar.followPanel`), but never expands a row you collapsed.

Elsewhere:

- A **CodeLens** above explained code names the sidestory and step ("Overview › Detail · step 3: Title"); click it to open the sidestory there. The status bar names the sidestory for the cursor's line.
- **This File** (in the Sidestory sidebar) lists every step that covers the active editor's file.
- **Explain with Sidestory** (right-click a file) opens the first step that covers it, or copies a prompt to explain it.
- **Go to Step…** finds a step by title in the current package or all of them.

Opening from the view, a CodeLens or a picker reuses a panel that holds nothing you'd lose: the panel you were last reading, if it's under the same top-level sidestory, or a *preview* panel you haven't moved in yet (it says so, with **Keep Open**). **Open in New Panel** always opens another.

## Writing a sidestory

A sidestory is a folder in your repository:

```
.sidestory/
  GUIDELINES.md      optional: how your team's sidestories should read and look
  bit-reader/
    sidestory.html   the page: any HTML and CSS
    manifest.json    which code each section is about
    assets/          optional: images, fonts, stylesheets
```

Open it with **Sidestory: Open Sidestory…**.

**`.sidestory/GUIDELINES.md`** is to sidestories what CLAUDE.md is to code: your standing guidance for writing them (tone, how deep to go, what the diagrams look like, colors, naming, what to leave out). Claude's Sidestory skill and the copied prompts read it before writing or updating one, and when you give Claude guidance meant to last ("our diagrams always…"), it offers to add it there. Commit it with your sidestories so the team shares it. On a branch, a change to it counts like any other file's.

A page can be mostly pictures (block diagrams that light up per step, timelines, before/after, byte layouts, animation), with widgets the reader drives where they help. The code is right beside the page, so the page doesn't need to retell it. How it reads is up to you; the rest of this section is what it can do.

### Link sections to code

Mark any element that is about some code with `data-explain-anchor`, and name it in the manifest:

```html
<section data-explain-anchor="refill" data-explain-title="Refill">
  <h2>Refill below the valid bits</h2>
  … anything …
</section>
```

- Top-level anchored elements become the steps in the navigator. Nested anchored elements (a figure inside a section) are linked too, but aren't steps.
- `data-explain-title` sets the step's short label; otherwise the first heading is used.
- `<a data-explain-ref="state">peek</a>` jumps the editor to another anchor's code when clicked, without changing the current step.
- `--cx-accent` is set on each anchored element to its color, so your CSS can use `var(--cx-accent)`.

#### Links on any element, diagram boxes included

`data-explain-ref` works on any element, not just `<a>`: a word in the text, a table row, a card, or a box or wire in an inline SVG. Readers click it, or Tab to it and press <kbd>Enter</kbd>, and the editor jumps to that code. For a block diagram, put it on each block's `<g>`:

```html
<svg viewBox="0 0 400 120" role="group" aria-label="The FIFO between the read and write ports">
  <g data-explain-ref="fifo">
    <title>dma_fifo: show its code</title>
    <rect x="150" y="20" width="100" height="60" rx="6" fill="var(--cx-box-fill)" stroke="var(--cx-box-stroke)"/>
    <text x="200" y="55" text-anchor="middle" fill="var(--cx-box-text)">dma_fifo</text>
  </g>
</svg>
```

Linked elements look the same in every sidestory, and your own CSS always wins over this:

| Linked element | At rest | Hover | Keyboard focus |
|---|---|---|---|
| Text (`a`, `span`, `code`, `b`, `strong`, `em`, `i`, `abbr`, `kbd`, `var`, `samp`) | link color, dotted underline | the active link color | a thin ring |
| Any other HTML element (`div`, `li`, `td`, `figure`, `img`) | unchanged, pointer cursor | an outline | a thicker ring |
| Anything inside an `<svg>` | unchanged, pointer cursor: its colors, `currentColor` and `<text>` stay as you drew them | a soft glow around its shape | a ring |

- Set `--cx-link-hover` or `--cx-link-ring` to `transparent` to turn that effect off, or to another color.
- `data-explain-plain` on a linked element removes the built-in look (only the pointer cursor stays), for a link you style yourself.
- A reader opens a link by clicking it, or by tabbing to it and pressing <kbd>Enter</kbd> (not <kbd>Space</kbd>, which scrolls). Resting the pointer on it, or tabbing to it, lights its code as described in [Reading a sidestory](#reading-a-sidestory).
- **Give a diagram with links `role="group"` and an `aria-label`**, not `role="img"`: screen readers don't see the children of an image, so its links would be out of their reach. Give each linked `<g>` a name with a `<title>` (which is also a tooltip) or an `aria-label`.
- Links on form controls (`button`, `input`, `select`, `textarea`, `meter`, `output`, `progress`) or on a widget are ignored, and so are clicks on a control or widget inside a link: those clicks are for the control. Output says so.

### The manifest

```json
{
  "version": 1,
  "title": "A backward bit reader in five moves",
  "anchors": {
    "refill": {
      "file": "rtl/bit_reader.sv",
      "range": [35, 38],
      "highlight": ["in_byte", "c"],
      "color": "charts.purple"
    }
  }
}
```

| Field | Meaning |
|---|---|
| `file` | Path from the folder that contains `.sidestory/`, with `/` separators. |
| `range` | First and last line (1-based). A hint: the anchor follows the code as it moves. |
| `highlight` | On an anchor: identifiers to mark everywhere in the file while the section is active (not the top-level `highlight` object below). |
| `summary` | Top level, optional: one line shown when a parent sidestory peeks at this one, and in the sidebar and pickers. |
| `group` | Top level, optional: a group name (1–60 characters) to file the sidestory under in the Sidestories view. A grouped sidestory is always listed at the top level, even when another one links to it as a detail. |
| `top` | Top level, optional: `true` keeps a sidestory at the top level of the view without a group, even when another one links to it. |
| `highlight` | Top level, optional: how this sidestory highlights code, over the defaults of the matching settings: `dim` (`true`/`false`, `sidestory.dimUnfocused`), `clickSeconds` (0–3600, `sidestory.clickHighlightSeconds`), `clickFrame` (`true`/`false`, `sidestory.clickFrame`), `hoverPreview` (`editor`, `card`, `both` or `off`, `sidestory.hoverPreview`) and `hoverReveal` (`true`/`false`, `sidestory.hoverReveal`). For example `"highlight": {"dim": false, "clickSeconds": 3}`. Settings the reader has set win; bad values are ignored, and the checker warns about them. |
| `dim` | Optional, on an anchor: `true` or `false` fades (or doesn't fade) the rest of the file for this step, over the sidestory's `highlight.dim`; for a step about a whole file, say. |
| `color` | A theme color id, normally one of `charts.blue`, `charts.green`, `charts.yellow`, `charts.orange`, `charts.purple`, `charts.red`. Never a hex value: colors follow the user's theme. |
| `id` | Top level, optional: a stable id (a ULID) that local comment threads find their sidestory by. The checker's `--pin` adds one (the VS Code command doesn't); once it is there, never change or remove it, also when you rewrite the manifest. |

Then run **Sidestory: Pin Anchors to the Current Code** to record each anchor's exact code and surrounding lines. That upgrades the manifest to `version: 2` with a `quote` per anchor, which is what lets an anchor survive edits, moves and duplicates. Until then a section is just a line range and can't tell when its code changes; the panel says so once per sidestory. Pin edits only the anchors it pins and keeps the rest of `manifest.json` as you wrote it. It pins what the editors show, unsaved changes included, and says when it did.

Pin only pins anchors whose code it finds with confidence. It names each anchor it left alone and why (code changed, out of date, code not found, ambiguous, file missing), then lists the ones it could still pin: where the code is now, and the lines their `range` gives. Tick the ones whose code you changed on purpose to pin them there.

To point a section at different code:

- select the code and run **Sidestory: Re-anchor Section to Selection** (also in the editor's context menu while a sidestory is open), then pick the section; sections whose code is lost or out of date are listed first. The selection may be in another file of the same repository; or
- edit its `range` in the manifest and run Pin: when the recorded code can't be found with confidence, Pin offers the lines `range` gives. (If the recorded code is still there unchanged, Pin follows it instead; use Re-anchor.)

### Big systems: an overview with details

One sidestory per piece, plus an overview that ties them together. In the overview, mark where a piece comes up with the name of its sidestory (a sibling folder in `.sidestory/`):

```html
<section data-explain-anchor="reader">
  <h2>The bit reader</h2>
  <p>Bytes arrive last-first; it hands out bits on demand.</p>
  <div data-explain-detail="bit-reader"></div>
</section>
```

Readers then choose, per piece:

- **Skip**: just read on; the overview stands on its own.
- **Peek**: "*Title* in brief" opens the detail's `summary` in place.
- **Dive**: "Dive into *Title*" shows the detail sidestory in the same panel. A trail at the top shows the way back; **Up to *Title***, a trail entry or <kbd>Esc</kbd> returns to the step you left. The panel's ← button and <kbd>Alt</kbd>+<kbd>←</kbd> go back too, and → dives in again (see [Reading a sidestory](#reading-a-sidestory)).

Details can have details of their own (up to 16 levels). Give each sidestory a one-line `summary` in its manifest for the peek. When the editor cursor is in code a detail covers but the sidestory you're reading doesn't, the panel offers to dive into it. The Sidestories view lists details under their overviews ([above](#finding-your-way-in-big-repositories)).

Two complete examples in this repository work this way: [`examples/stream-dma`](https://github.com/mozru/sidestory/blob/main/examples/stream-dma), a DMA engine in SystemVerilog, and [`examples/tiny-lsm`](https://github.com/mozru/sidestory/blob/main/examples/tiny-lsm), a log-structured merge-tree key-value store in Python, each with an overview, a sidestory per component, block diagrams and widgets.

### Diagrams that follow the steps

A block diagram can light up the boxes and wires each step is about, and fade the rest. Tag them with `data-explain-on` and the ids of the anchors they matter in:

```html
<figure data-explain-diagram="step dim-rest">
  <svg viewBox="0 0 1100 610" role="group" aria-label="Block diagram of dma_top">
    <g data-explain-on="datapath backpressure" data-explain-ref="m-fifo">…the FIFO box…</g>
    <g data-explain-on="datapath">…the rd_rsp_data wire…</g>
    <g data-explain-on="control errors">…the start strobe…</g>
    <g data-explain-keep>…the legend…</g>
  </svg>
</figure>
```

- **`data-explain-on="<id> …"`** (space-separated) works on any SVG or HTML element. It's **lit** while one of its ids is the current step, or the nested anchor the reader is on inside that step (a card or figure with its own `data-explain-anchor`, which the reader clicked or the editor cursor reached). A nested anchor adds to what its step lights; it can't narrow it, so to light single boxes from cards, give the step itself nothing to light (as the stream DMA overview's first step does). An empty `data-explain-on=""` marks a part that is never lit.
- **Ids must match anchor ids exactly**, case included. One that matches nothing never lights, without an error, so check them against the manifest.
- **What fades:** while anything in a diagram is lit, the tagged parts that aren't lit fade. A part inside a lit group stays lit. With nothing lit (a step the diagram isn't about), the diagram looks exactly as you drew it.
- **The diagram** is the nearest element with `data-explain-diagram`, or else the outermost `<svg>`. A tagged element outside both (a table row in the text) lights up, and nothing fades around it.
- **`data-explain-diagram` takes these words:**
  - `step` (the default): follows the current step.
  - `section`: always shows the state of the section it's in (that section and the step holding it, never a nested anchor the reader is on), whatever step is current. Use it when a section has its own copy of the diagram (for a long page, where the first copy is off screen by step 5).
  - `dim-rest`: untagged parts fade too, so you tag only what each step is about, not every background wire. It fades everything untagged in the diagram element, HTML included: on a `<figure>`, that's the `<figcaption>` too, unless you mark it `data-explain-keep` or put `data-explain-diagram` on the `<svg>`.
- **`data-explain-keep`** on an element (a legend, a title) keeps it and everything inside it from fading (unless it sits inside a tagged part that fades: opacity applies to everything inside). Arrowhead markers, gradients, patterns and the rest of `<defs>` never fade, so a lit wire keeps its arrowhead.
- **Lit parts aren't recolored.** Style them yourself with the `.cx-on` class and the `--cx-on` color: `.wire.cx-on path { stroke: var(--cx-on); stroke-width: 3 }` for a tagged `<g class="wire">`. Without such a rule, lit parts look as drawn, and only the fading tells them apart. `--cx-on` is the color of the section the reader is on (a nested anchor's own color, else its step's); a `section` diagram uses its own section's. To pick your own, set `--cx-on` on the diagram element.
- **How to tag a diagram:**
  - put each wire's path, arrowhead and label in one `<g>` and tag the group, so the label fades and lights with its wire;
  - light both ends of every lit wire, and the block that drives each signal the step's text names;
  - add a box's own anchor id to its list (`data-explain-on="datapath m-fifo"`), so it lights while the reader is on its card or nested section.
- **Fading** is `opacity: var(--cx-dim-opacity)` (0.28 in dark themes, 0.4 in light ones) on the class `cx-dim`, with a short transition (none for readers who asked for reduced motion). Override `.cx-dim` to fade differently.
- **High contrast:** nothing fades; lit HTML elements get a dashed outline, and lit SVG shapes a halo, in the theme's contrast color. Your `.cx-on` rule matters most here.
- **Hover:** the diagram follows the steps, not the pointer. For a hover preview, write it with `:has()`: `.cx-content:has([data-explain-ref~="m-fifo"]:hover) [data-explain-on~="datapath"] { … }`.

The stream DMA overview ([`examples/stream-dma`](https://github.com/mozru/sidestory/blob/main/examples/stream-dma)) works this way: one diagram at the top that follows the steps, and a copy with `data-explain-diagram="section dim-rest"` in the fallbacks of the simulation widgets, for readers who don't run widgets.

#### Moving parts

A diagram can move without a widget, using CSS animation or SVG animation (`<animate>`, `<animateMotion>`, `<animateTransform>`, `<set>`). Motion is good at showing which way data flows and what loops. This example has the two common patterns, a dash that flows along the lit wire (CSS) and a beat that travels it (SVG):

```html
<style>
  .wire path { fill: none; stroke: var(--cx-wire-data); stroke-width: 2; }
  .beat { fill: var(--cx-on); display: none; }
  .wire.cx-on .beat { display: inline; }
  /* Data flows along the wires the current step lights, and nowhere else. */
  .wire.cx-on path { stroke: var(--cx-on); stroke-width: 3; stroke-dasharray: 8 6; animation: flow 0.8s linear infinite; }
  @keyframes flow { to { stroke-dashoffset: -14; } }
  /* Less motion: the OS setting, and VS Code's own (workbench.reduceMotion). */
  @media (prefers-reduced-motion: reduce) { .wire.cx-on path { animation: none; } }
  body.vscode-reduce-motion .wire.cx-on path { animation: none; }
</style>
<g class="wire" data-explain-on="datapath">
  <path d="M180 60 H300" />
  <!-- A beat travelling the wire, every 1.5 s. -->
  <circle class="beat" r="4"><animateMotion dur="1.5s" repeatCount="indefinite" path="M180 60 H300" /></circle>
</g>
```

- **Tie motion to the steps** with `.cx-on` rules, as above, so only the part the reader is on moves. A whole diagram that never stops moving is noise.
- **Make the first frame read on its own.** For readers who asked for less motion, SVG animation stops at about its first frame. CSS animation keeps running unless you stop it, as the two rules above do.
- **Keep it calm:** a beat along a wire, a counter that ticks, a FIFO that fills. Use a widget when the reader should drive it (start, pause, step, change the input).
- Animation can't change links, event handlers, `style`, `class` or `data-cx-` attributes (see [what's removed](#whats-supported-and-whats-removed)). Animations in steps far off screen pause until the reader gets there.

### Code links without an anchor

A box in a diagram often deserves a link to its code without a manifest entry or a step of its own. `data-explain-code` opens a file, some lines or a symbol:

```html
<figure data-explain-diagram data-explain-code-file="rtl/gemm_row_dispatch.sv">
  <svg …>
    <g data-explain-code="#u_order_fifo">…</g>                 <!-- the file from data-explain-code-file -->
    <g data-explain-code="#driver(order_q)">…</g>
    <g data-explain-code="rtl/dma_fifo.sv#L34-L39">…</g>         <!-- its own file -->
  </svg>
</figure>
<a data-explain-code="rtl/dma_csr.sv">dma_csr.sv</a>
```

- **The path**, before `#`, is from the folder that holds `.sidestory/`, as a manifest `file` is, with `/` separators. It is **not** relative to the page. An empty path takes the nearest `data-explain-code-file` around the element, so a diagram of one module names its file once.
- **After `#`** (optional; without it the file opens at the top):
  - `L10` or `L10-L20`: those lines;
  - a symbol in SystemVerilog or Verilog:
    - a name declared in the file: a signal, port, parameter, typedef or instance (`#order_q`, `#BW`, `#u_ctrl`);
    - what drives a signal: `#driver(state_q)`, the `always` block, `assign` or declaration that assigns it (`#driver(x[7:4])` when blocks drive different slices). `driver()` stays inside one module: a net in a top-level module that only an instance output drives has no driver there, so link the connection or the child's driver (`rtl/dma_ctrl.sv#driver(rd_start)`);
    - one arm of that block's outermost `case`: `#driver(state_d).case(IDLE)`, so each bubble of an FSM diagram opens its own arm. A label found in two `case` statements, or only in a nested one, is ambiguous: link the lines instead;
    - one port connection of an instance: `#u_rd_port(.start)`, where the name in `(.x)` is the instance's port, as in `.start(rd_start)`. That's the link for a wire in a top-level diagram;
    - inside a labelled block or generate block: `#g_lane.driver(lane_q)`.

    Prefix the module (`#dma_ctrl.driver(state_q)`) when a name isn't unique in the file. Only the first arm of each `` `ifdef `` is read, so a name declared only in a later arm isn't found.
  - a symbol in other languages: the names VS Code's outline shows (`#RetryClient.send`), found when the reader clicks (and, for the cursor ring below, in files the reader already has open).
- **The cursor lights it.** With the editor cursor in a link's code, the element gets a ring (`--cx-here`); when several links contain the line, only the tightest does, so the cursor in an FSM's `case` arm rings that bubble, not the whole module. Links to `data-explain-ref` anchors light the same way. This never changes the step. Turn it off with `sidestory.followCursorInDiagrams`.
  - Links inside a widget's fallback are never opened or lit.
  - Lighting goes by line: a line holding several connections (`.clk, .rst_n, .start,`) lights only one of their links. Put the connections a diagram links to on lines of their own.
  - Code written through macros (`` `FF(state_q, state_d, IDLE) ``) isn't followed yet; link its line (`#L50`). The checker says so when a name only appears in a macro call.
- **No drift detection.** A symbol link either finds its name or doesn't, and a line link points wherever those lines are now; neither says "Code changed". Use a manifest anchor and `data-explain-ref` for code the text makes claims about, and `data-explain-code` for "where is this thing".
- It looks and behaves like `data-explain-ref`: a click, or <kbd>Enter</kbd> after tabbing to it, opens the code at the target's first line, with the same built-in look. With both on one element, `data-explain-ref` wins. A link that doesn't parse (a path outside the repository, `#L0`) is ignored, and **View › Output › Sidestory** says why. A target that isn't there (a renamed signal, lines past the end) opens nothing; the status bar says it wasn't found, and Output says what the file has instead (an input port, a connection to link, a name in a later `` `ifdef `` arm).
- Links open only when the reader clicks one or presses <kbd>Enter</kbd> on it, and only files inside the repository, after following symlinks, and never inside `.git`. A file whose name looks like it holds secrets (`.env`, `*.pem`, `secrets.json` …, by the link's name or the real file's) opens only after the reader confirms.
- **The checker checks every code link** (`check.cjs`, as in [WIDGETS.md §13](WIDGETS.md#13-checking-your-work-and-consent)): errors for bad syntax and files that aren't in the repository, warnings for SystemVerilog symbols that are missing or ambiguous and for lines past the end, and, for line links in SystemVerilog, the symbol that would follow the code instead. It also checks that every `data-explain-anchor`, `data-explain-ref` and `data-explain-on` id is in the manifest, and that every manifest anchor is used by the page or a widget.

### How sections follow the code

| State | Meaning | Shown as |
|---|---|---|
| exact / moved | The code is there, unchanged (it may have moved). | Normal |
| changed | Found, slightly edited. The text is probably still right. | "Code changed" badge |
| stale | Found roughly, but changed a lot. The text may be wrong. | Dashed outline, "Out of date" |
| lost | Can't be found. | "Code not found" |

This works on unsaved edits too, as you type.

The checker (`check.cjs`) finds each anchor's code the same way, in the files on disk, and reports what the panel would flag:

- `anchor-lost` (warning): the code isn't in the file any more, or the file doesn't exist. The message names the step (or the anchor), the file and the range it was last pinned at. If the code moved or was rewritten, re-anchor it: set the anchor's `file` and `range` to the code, delete its `quote` and run `--pin` (or **Re-anchor Section to Selection**). If it was removed on purpose, remove the step, or an anchor that isn't a step and what refers to it.
- `anchor-stale` (warning): the code changed a lot since it was pinned ("Out of date"), or more than `--pin` re-pins by itself. The message says where the code is now and the command that re-pins it there (`--accept <anchor>`): run it only once the prose fits the code. If widgets read the anchor, that command needs `--yes-widgets-may-read`, and the user's go-ahead.
- `anchor-changed` (info): the code changed a little ("Code changed"); `--pin` re-pins it once you've checked the prose.
- `anchor-unchecked` (info): the file wasn't read (a link out of the repository, a folder, too large), so the anchor wasn't checked.

Code that is there, or only moved, is fine. When a widget reads a head-side anchor whose code is lost or out of date, the anchor's finding is the only one (an error when the file is missing, as the widget's would be); a base-side anchor keeps the widget's finding too, since widgets read the working tree. Base-side anchors are checked against the merge-base only for the sidestory the check compares (`--coverage`, `--pin` or `--accept` on a sidestory with a `base`); otherwise, and for the other sidestories `--coverage` checks, they're skipped. Their messages say how to re-anchor them.

### Styling

Use VS Code's theme variables so your sidestory looks right in every theme:
`var(--vscode-editor-foreground)`, `var(--vscode-descriptionForeground)`, `var(--vscode-panel-border)`, `var(--vscode-editor-font-family)`, `var(--vscode-textLink-foreground)` and so on. For diagrams, use the diagram tokens below rather than `--vscode-charts-*`.

#### Diagram tokens

Color diagrams by role, not by hue. Each token follows the reader's theme, and has its own value in high-contrast themes and Windows contrast modes, so a diagram drawn with them needs no theme-specific CSS. Widgets get the same tokens ([WIDGETS.md §5](WIDGETS.md#5-theming)).

| Token | For | Default themes | High contrast |
|---|---|---|---|
| `--cx-box-fill` | block body | widget background | editor background |
| `--cx-box-fill-strong` | an emphasized block | box fill tinted by the stroke | editor background (emphasize with the stroke) |
| `--cx-box-stroke` | block outline | widget border | contrast border |
| `--cx-box-text` | text in blocks | editor foreground | the same |
| `--cx-label` | secondary labels (widths, port names) | description text | editor foreground |
| `--cx-wire-data` | data path | `charts.blue` | the same |
| `--cx-wire-addr` | addresses and configuration | `charts.purple` | the same |
| `--cx-wire-ctrl` | control strobes and handshakes | `charts.orange` | the same |
| `--cx-wire-status` | status back to control (done, busy) | `charts.green` | the same |
| `--cx-wire-irq` | interrupts and errors | `charts.red` | the same |
| `--cx-wire-clock` | clocks | `charts.foreground` | editor foreground |
| `--cx-wire-reset` | resets | `charts.yellow` | the same |
| `--cx-wire-muted` | wires no step is about | description text, 70% | description text |
| `--cx-domain-1` … `--cx-domain-4` | clock-domain region fills | blue, green, purple, orange at 10% | transparent (label the regions' borders) |
| `--cx-arrow` | free-standing arrows and annotations | editor foreground | the same |
| `--cx-grid` | grids, ticks, lane separators | `charts.lines` | contrast border |
| `--cx-dash-ctrl`, `--cx-dash-status`, `--cx-dash-irq`, `--cx-dash-reset` | `stroke-dasharray`, so roles differ by more than color | `5 4`, `2 3`, `1 3`, `6 2 1 2` | the same |
| `--cx-on` | parts the current step lights ([above](#diagrams-that-follow-the-steps)) | the active section's color | contrast active border |
| `--cx-dim-opacity` | parts that fade | `0.28` (dark), `0.4` (light) | `1` (nothing fades) |
| `--cx-link-hover`, `--cx-link-ring` | linked elements' hover and focus ([above](#links-on-any-element-diagram-boxes-included)) | link color, focus border | contrast active border |
| `--cx-here` | elements linked to the code the editor cursor is in | find-match border, else focus border | contrast active border |

```css
.wire.data { stroke: var(--cx-wire-data); stroke-width: 4; }
.wire.ctrl { stroke: var(--cx-wire-ctrl); stroke-dasharray: var(--cx-dash-ctrl); }
.block rect { fill: var(--cx-box-fill); stroke: var(--cx-box-stroke); }
.block text { fill: var(--cx-box-text); }
```

Never hex values: they vanish or glare in someone's theme. In Windows contrast modes every wire is drawn in the text color, so give each role a dash or a width as well as a color. In Light Modern, the orange and yellow chart colors read below 3:1 on a light box; make those wires a little thicker.

The built-in styles are light: body text in the editor font and colors, code blocks and tables that scroll sideways when wide, images no wider than the panel, and an outline on the current section. Nothing else is clipped, so your tooltips and pop-outs can overflow their boxes.

Interactivity without script works well, and readers keep what they set while you edit:
- **Steppers, tabs and switches** built from radio buttons and checkboxes with `:checked ~ …` or `:has(:checked)` rules. A switch the reader flipped stays flipped when you edit another part of the sidestory; changing that control's own `checked` in the source resets it.
- **Pop-outs and footnotes** with `:target`: in-page links (`<a href="#id">`) set the target as in a browser.
- **`<details>`** for asides and quizzes, **hover and focus** effects (`:hover`, `:focus-within`, `:has(...)`), `@container` queries, and CSS and SVG animation ([Moving parts](#moving-parts)).

#### Code blocks

Mark a code block's language with a class, as in Markdown renderers:

```html
<pre><code class="language-python">def area(r):
    return 3.14159 * r * r</code></pre>
```

It's colored like the editor beside it, with the same grammars and in the reader's own color theme (light, dark or high contrast, including their `editor.tokenColorCustomizations`), and recolored when they switch themes. Write the code as plain text (escape `<` and `&` as `&lt;` and `&amp;`); a block with markup inside its `<code>` (a `<mark>`, say) is left exactly as written. The class may be on the `<pre>` instead, and `lang-x` works too.

The grammars are the ones the reader's VS Code already has: its built-in language extensions (TypeScript, Python, C++, Go, Rust, HTML, Markdown with its fenced code, and many more) and any language extension they installed. SystemVerilog, Verilog, VHDL and TOML aren't built into VS Code: readers need a language extension for them (for SystemVerilog and Verilog, for example, *Verilog-HDL/SystemVerilog/Bluespec SystemVerilog*, `mshr-h.veriloghdl`), or those blocks stay plain.

Name the language the way VS Code does: a language id (`typescript`, `python`, `systemverilog`), an alias (`bash`, `c++`, `c#`) or a file extension (`ts`, `py`, `rs`, `yml`, `md`). `python3`, `py3`, `golang`, `node`, `console`, `shell`, `shell-session`, `make` and `json5` work too. Prefer the language id when a short extension could mean several languages (`v`). The first `language-` (or `lang-`) class names the language; later ones are ignored.

A language the reader has no grammar for stays plain monospace, as do blocks over 2,000 lines or 100,000 characters (and single lines over 2,000 characters). Colors are the editor's without semantic highlighting. In a remote window (SSH, WSL, containers), a color theme or language extension installed only on your own machine may not be readable; code blocks then use VS Code's default theme of the same kind, and languages without a grammar on the remote side stay plain.

### What's supported, and what's removed

Supported: HTML and CSS, inline `<style>`, stylesheets, images (SVG, PNG, JPEG, GIF, WebP, AVIF), fonts and videos from the sidestory's own folder; inline SVG; tables; `<details>`; form controls (inputs, labels, selects) for CSS-driven interactivity; links.

Removed or ignored, for safety (see [SECURITY.md](https://github.com/mozru/sidestory/blob/main/SECURITY.md)):
- scripts of any kind, event handler attributes, `javascript:` links;
- `accesskey`, `autofocus` and invoker commands (`command`, `commandfor`, `interestfor`), which could move focus or fire a link the reader didn't aim at, and attributes starting with `data-cx-`, which belong to the panel;
- `<iframe>`, `<object>`, `<embed>`, `<form>`, `<meta>`, `<base>`, popovers, `<discard>`;
- SVG animation that would change a link or another URL (`href`, `xlink:href`, `src`, …), an event handler, `style`, `class` or a `data-cx-` attribute; an animation's own `href` must be an in-page `#id`, and a `url()` in its values (or in `fill`, `filter`, `mask`, `cursor` and the like) is held to the same rules as in CSS;
- anything from the network: remote images, fonts, stylesheets, `@import`;
- links to `localhost` or private addresses.

Limits: `sidestory.html` up to 5 MB, `manifest.json` up to 1 MB, 500 anchors, each quote up to 2,000 lines, each asset up to 5 MB (20 MB per open sidestory).

### Checker rules

The checker's findings are errors, warnings or info. The repository decides how serious each one is, and where one doesn't apply, at four levels; the narrowest wins:

| Level | Where | Example |
|---|---|---|
| Every sidestory | `.sidestory/checks.json` | `{ "rules": { "anchor-stale": "error", "box-unlinked": "warning", "no-fallback": "off" } }` |
| One sidestory | its `manifest.json` | `"checks": { "box-unlinked": "off" }` |
| One step | its anchor in the manifest | `"refill": { "file": "…", "range": […], "checks": { "anchor-changed": "off" } }` |
| One element | the page | `<g data-explain-ignore="box-unlinked: legend, not code">` |

A level is `"error"`, `"warning"`, `"info"` or `"off"`; the rule names are the codes the checker prints. An error makes the checker exit with 1, so it fails CI and an agent's run. VS Code's Problems panel uses the same levels for widget diagnostics.

- **A step's `"checks"`** take the findings about its code: `anchor-lost`, `anchor-stale`, `anchor-changed`, `anchor-unchecked`. Other rules go in the manifest's or the repository's.
- **An element's exception** only turns rules off, for that element and what's inside it. It needs a reason after the colon; the checker warns without one, and when it no longer silences anything. The report's last line counts what was ignored and why.
- **Some rules can't be turned down**, and trying is an error (`rule-locked`): those that guard the reader (`code-link-secret`, `secret-file`, `outside-folder`, `pin-needs-consent`, `bad-specifier`, `dynamic-import`), errors that mean the page or a widget doesn't load (a manifest VS Code rejects, a widget that doesn't compile), and the rules' own findings (`checks-json`, `ignore-no-reason`, `unused-ignore`…). A passing check means the page works.
- **Branch coverage** (`--coverage`) isn't affected by the rules, so they can't hide an unexplained change. To let coverage pass with some changes left, set a share in the repository root's `.sidestory/checks.json`: `"coverage": { "minimum": 90 }` passes once 90% of the changes that need explaining (trivial ones aren't counted) are explained; the rest are still listed, and `--json` reports `minimum`. Changes in a `.sidestory/` folder (widget code), links, submodules, binaries and moves must still all be explained. The minimum is read from the file as it is at the merge-base, so when CI passes `--base` with the protected branch, a branch can't lower its own bar.

`box-unlinked` (a warning) is a diagram part that lights up on a step (`data-explain-on`, inside an `<svg>`) with no code link on it or around it, so a reader can't click it to see its code.

### Interactive widgets

For what CSS can't do (a chart that responds to a control, a simulation that runs, a table parsed from the real code), a sidestory can hold **widgets**: React components written the way Claude writes artifacts, with Tailwind, shadcn/ui-style components, Recharts, D3, Motion, lucide-react and lodash. Each runs in its own sandboxed frame in the panel; the prose stays plain HTML. A widget knows the current step, can read the code its sidestory points at, highlights lines in the editor, and shows code when clicked.

![The DMA simulation widget paused mid-transfer: the FSM in WAIT_DATA, the FIFO almost full, and a waveform of the run so far](https://github.com/mozru/sidestory/raw/main/media/marketplace/widget-closeup.png)

Place one in `sidestory.html` with a fallback for readers who don't run widgets, and put the component next to it:

```html
<section data-explain-anchor="refill">
  <h2>Refill</h2>
  <explain-widget src="widgets/refill.tsx" title="Refill simulator" height="200">
    <script type="application/json">{"width": 64}</script>
    <img src="assets/refill.svg" alt="The window before and after a refill">
  </explain-widget>
</section>
```

```tsx
// .sidestory/bit-reader/widgets/refill.tsx
import { useStepValue, useWidgetState } from 'explainer';
import { Button } from '@/components/ui/button';

export default function Refill({ width = 64 }: { width?: number }) {
  const [valid, setValid] = useWidgetState('valid', 20);
  const color = useStepValue({ refill: 'var(--chart-1)' }, 'var(--muted-foreground)');
  return (
    <div className="flex items-center gap-3">
      <Button size="sm" onClick={() => setValid((v) => Math.min(width, v + 8))}>Refill a byte</Button>
      <span style={{ color }}>{valid} of {width} bits valid</span>
    </div>
  );
}
```

**Running widgets is your choice.** Widgets are code from the repository, so they run only when the workspace is trusted, the `sidestory.widgets.enabled` setting is on (it is by default; it's a user setting, so a repository's settings can't turn it on), and you agree: the panel says how many widgets a sidestory has and offers **Run widgets…**, which opens a VS Code dialog saying what they can do. Until then, and in Restricted Mode, you see the fallbacks. You're asked once per sidestory, and again when widget code arrives through git (checkout, pull, merge), not after your own edits or when you switch back to a version you already agreed to. Consent is kept in VS Code's workspace storage (in browser VS Code, per browser profile). **Sidestory: Revoke Widget Consent** takes it back. A widget that freezes the panel is turned off by a watchdog: its box offers **Try again**, and **Sidestory: Enable Widgets** turns every widget the watchdog stopped back on (and the setting, if it's off). What widgets can and can't reach is in [SECURITY.md](https://github.com/mozru/sidestory/blob/main/SECURITY.md).

**Writing them:** [WIDGETS.md](WIDGETS.md) is the guide (also for Claude): the contract, imports, theming, linking to code, placement, focus, state, performance, and a gallery. Problems show in the Problems panel as you save; **Sidestory: Check Widgets** checks on demand, and a standalone checker ships with the extension for Claude Code and scripts (`node <extension>/dist/check.cjs .sidestory/<name>`; [WIDGETS.md §13](WIDGETS.md#13-checking-your-work-and-consent) has the exact command). **Sidestory: Add Widget Types** (or `check.cjs --types` from a terminal) adds type declarations so `tsc` and IntelliSense work on widget files without installing anything.

## Explaining a branch

A sidestory can explain a change instead of a piece of code: what a branch or pull request changes, step by step, in the order a reviewer wants it. It is an ordinary sidestory with a `base`, committed with the branch so reviewers get it with the PR. The checker tells you which changes it doesn't explain yet.

### Base, side and trivial marks

```json
{
  "version": 3,
  "title": "Retry with full jitter",
  "summary": "Why retries now wait a random time below a growing ceiling.",
  "base": "main",
  "trivialFiles": ["package-lock.json", "**/__snapshots__/**"],
  "anchors": {
    "ceiling": { "file": "src/retry.ts", "range": [40, 52] },
    "old-loop": { "file": "src/retry.ts", "side": "base", "range": [20, 31], "color": "charts.red" },
    "trivial-1": { "file": "src/api.ts", "range": [3, 9], "trivial": true, "why": "import order" }
  }
}
```

| Field | Meaning |
|---|---|
| `base` | Top level: what the branch is compared with, a branch or tag name (`main`, `release/2.1`, `origin/main`) or a full commit id. Short commit ids, `HEAD` and names with `..` or `@{` are refused. `main` also finds `origin/main` when there is no local `main` (a CI checkout). The comparison is the **merge diff**: from the merge-base of `base` and the branch to the branch, so work that landed on `main` after the branch started isn't in it. Without a base, a sidestory is a plain story about the code as it is. |
| `side` | Anchor: `"base"` anchors **removed** code, in the merge-base's version of the file (the old path, for a renamed file). It needs a `base` and `"version": 3`. Absent means the code as it is now. |
| `trivial`, `why` | Anchor: `"trivial": true` marks a mechanical change (formatting, import order, a rename, generated code) that needs no explanation; `why` (1–200 characters) is required, and reviewers see it. A trivial mark isn't a step: don't give it a section. Name them `trivial-1`, `trivial-2`, …. A trivial mark on a pure deletion goes on the base side. |
| `trivialFiles` | Top level: globs (`*`, `**`, `?`) of whole files whose changes need no explanation, relative to the folder holding `.sidestory/`. Name them narrowly: `**`, `*`, or a pattern that matches more than half of the changed files is flagged. |
| `id` | Top level: a stable id (a ULID). `--pin` writes it when there is none; never change or remove it: local comment threads find their sidestory by it, and `--coverage` reports `id-changed` or `id-removed` (errors) for a manifest whose `id` differs from, or is missing compared with, its version at the merge-base (or, for the working tree, at HEAD). `--pin` puts back an id the manifest had (with `--coverage`, or for a sidestory with a `base`). A new sidestory replacing an archived one under the same folder name may have an id of its own; for one replacing a deleted one, `--new-id` turns the id check (and that restore) off for the run. |

Trivial is never the same as explained: the count says "9 explained · 3 trivial · 0 left", and a reviewer sees which changes were waved through and why.

### The coverage rule

The checker splits the merge diff into **changes**: runs of added and removed lines, with runs separated by a single unchanged line counted as one change. Line endings and a missing final newline aren't changes, and blank lines need no cover (unless a change is nothing but blank lines). Where the lines around an addition repeat (a function appended after other `}` lines), the addition is placed as late as it can go, as git shows it. Only anchors the page uses count (a section, a `data-explain-ref` or a `data-explain-on`), plus trivial marks. A change is explained when:

- **Added lines:** every added line is inside an anchor (current side) in that file.
- **Removed lines:** every removed line is inside a `"side": "base"` anchor, **or** an anchor on the current side covers where they were: the whole new range of a replacement (one anchor explains a rewrite, old lines included), or, for a pure deletion of at most 20 lines, both lines around it. A larger deletion needs a base-side anchor or a trivial mark.

Some lines covered and some not is **partly explained**, which counts as not explained. A line added inside a pinned anchor that isn't in the anchor's pinned code was written after the step: it **needs a look** (`changed-since-pinned`) until you read the step, make the prose cover it, and accept it with `--accept <anchor>`. A broad anchor (over 40 lines and more than 5 times the changed lines it covers) still counts, with a warning.

A file whose lines can't be compared counts as **one change**: a binary file, a Git LFS file (its pointer changed), a symbolic link, a submodule, a type change (a file becoming a link, say), and a path Sidestory won't read (control characters, `..`, `.git` or a leading `:`, or, from the working tree, a name Windows reads differently, like `con`, `nul.txt` or `a.`). No anchor can cover such a change and Mark as Trivial can't either: only a `trivialFiles` match marks it, so put binary assets there (`"assets/**/*.png"`). **Moves count too.** Files renamed or copied across folders make one move change per moved prefix: the old and new paths without their common trailing part, so moving `src/a` to `src/b`, subfolders and all, is one change ("12 files moved src/a → src/b"), pure moves and moved-and-edited files alike; renames within one folder that share a transform are one change too ("30 files renamed in src/components (*.js → *.ts)": the same extension change, or the same substitution at the start or end of the name keeping at least 3 characters of it), and any other rename in place is a change of its own ("renamed lib/retry.js → lib/retry-policy.js"), as is every rename that can switch a file off (an added `.disabled`, `.bak`, `.off`, `.orig`, `.old` or `~`, or code renamed to a non-code extension). A move can switch code off (`src/auth.js` → `src/disabled/auth.js`), so it needs a mention: **one sentence in a step** anchored in any of the moved files explains the whole group. A trivial mark or a `trivialFiles` match covers only its own file's move, so a group is trivial only when every moved file has one; a trivial mark on one file never waves through another's move. Every report of a move lists its files. Edited files keep their line changes as well. Not counted (the report lists them): mode-only changes, a sidestory's own two files (`manifest.json` and `sidestory.html` of a complete sidestory), and its shared comment threads' event files (`threads/t_<id>/e_<id>.json`, which **Share** writes, when the file is a valid event with those ids; anything else at such a name counts). Everything else in a `.sidestory/<name>/` folder (widget code, assets, a helper script, any other file under `threads/`) counts like code anywhere, and code renamed onto a sidestory's own file counts as that code's deletion. Anything under `.sidestory/archive/` is one change, except an archived sidestory moved there unchanged from a sidestory complete at the merge-base, its manifest rewritten only in `base`, `head` and `landed`.

### Which sidestories count

A sidestory counts toward a branch when it was **added on that branch** (its `manifest.json` isn't there at the merge-base) and its `base` gives the same merge-base. So once a branch lands, its sidestory sits on `main` and never counts for a later branch, even one that edits it. **A follow-up PR on a landed sidestory needs its own sidestory**: write a new one for the follow-up, and link the old one with `data-explain-detail` if it helps.

### Coverage in VS Code

Sidestory doesn't add a file tree of its own for the branch: use the one you already have. [Git Tree Compare](https://marketplace.visualstudio.com/items?itemName=letmaik.git-tree-compare) is the one we recommend (it lists every file the branch changes against its base, committed or not); GitLens and the Source Control view work too. Sidestory's commands work from the right-hand (working tree) side of their diffs; the left side of Git Tree Compare's diff may be another commit than Sidestory's merge-base, so it's only read as the base side when it is that commit. Sidestory marks the files in all of them, and in the Explorer, with **file decorations**:

- a **badge**: `✓` every change explained (some may be trivial), `–` every change marked trivial, `◐` partly, `○` none yet, `!` code added inside a step since it was written;
- a **colour**: one for done, one for changes left;
- a **tooltip** with the counts and the steps that explain the file ("2 of 3 changes explained · 1 marked trivial · Step 2 of Retry with jitter").

A binary file, a link or a submodule is one change, marked like any other file (`○` until a `trivialFiles` match covers it). Files that aren't counted (a sidestory's own two files, line endings or mode only) get no mark. A move shows once, on its group's first file ("12 files moved src/a → src/b", its files in the tooltip); the other moved files say "moved with <that file> · 1 change for the group". Next Unexplained Change opens the first file's diff. Mark as Trivial on a move marks the move of the file the cursor is in (else the group's first file), on its first unchanged line (or, when that file is covered already, the first file that isn't), and names the files of the group that still need a mark; one sentence in a step (Copy Prompt: Explain This Change) covers them all.

The steps of a sidestory that explains the branch open the file itself, with the step's lines highlighted; a step about removed code opens a read-only view of the file at the merge-base. For a file the branch modified or renamed, **Open Changes with Base** (a compare button in the editor's title bar, shown while that editor has focus, like VS Code's own Open Changes beside it; also **Sidestory: Open Changes with Base** in the Command Palette, which works from the panel too) opens the branch's diff of it in the same place, at the same lines. The panel keeps following the cursor on either side, and later steps in that file open in the diff while it's showing; **Open File** in the diff's title bar (or **Sidestory: Open File**) goes back. A file the branch added or deleted has no such button: its diff would be one color from top to bottom. In a diff, the step's lines get a purple tint and frame (the `sidestory.diffFocusBackground` and `sidestory.diffFocusBorder` colors; purple so neither the added green nor the removed red hides it; high contrast themes get only the frame, in their contrast border color), a purple mark in the scrollbar, and the step's number and title after its first line. To have steps open in the diff every time, set `sidestory.changes.openStepsIn` to `"diff"`.

The mark is per file; for the changes inside one, open it:

- **This File** (in the Sidestory sidebar), besides the steps covering the file, lists its changes that aren't done yet (unexplained, partly explained, or changed since their step was written), each with its state: click one to go to its lines (the diff for a removed line). It offers **Copy Prompt: Explain This Change** for your agent, and **Mark as Trivial…** for a change that needs no explanation (it asks for the `why`). A file that counts as one change as a whole is named by its kind ("binary file", "symlink", "submodule", "too large") and has no Mark as Trivial: give it a `trivialFiles` glob. Changed files whose paths Sidestory won't read have no file to open: **This branch** (with `sidestory.sidebar.thisBranch` on) lists them ("2 files with unsupported paths"), and a click copies them for `trivialFiles`.
- With `sidestory.sidebar.thisBranch` on, the **Sidestories** view groups the sidestories that count toward the branch under **This branch**, with how many changes are left, each detail nested under its overview as in the list below; when none counts yet, or some changes are left, it offers a prompt to copy for your agent. When the branch can't be compared (the base set for it isn't found, it shares no commit with its base, there's no `main` or `master`, or git failed), the group says so, and clicking the row opens **Sidestory: Set Base…**.
- **Sidestory: Next Unexplained Change** and **Previous Unexplained Change** walk the changes that are left, across the branch's files; **Next Changed File** and **Previous Changed File** walk every changed file. In a diff or a changed file they have keys: <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>PageDown</kbd> / <kbd>PageUp</kbd> for the unexplained changes and <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>PageDown</kbd> / <kbd>PageUp</kbd> for the files (on macOS <kbd>Ctrl</kbd>+<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>Down</kbd> / <kbd>Up</kbd> and <kbd>Ctrl</kbd>+<kbd>Cmd</kbd>+<kbd>Down</kbd> / <kbd>Up</kbd>).

The base is, in order: the one you picked with **Sidestory: Set Base…** (kept per repository and branch; its first item says which base is in use and where it came from, and a base is saved only once it resolves); else the `base` of a sidestory added on this branch; else the branch's `branch.<name>.vscode-merge-base` git setting (the one VS Code's own Source Control uses); else the `sidestory.changes.defaultBase` setting; else the remote's default branch, then `main`, then `master`. Which sidestories count is decided as in the checker. The extension counts with the same code as the checker, so the marks and `check.cjs --coverage` agree; it reads the repository through VS Code's built-in Git extension and never runs git itself.

### Checking coverage

```bash
CHECK="$(ls ~/.vscode*/extensions/paperkite.sidestory-*/dist/check.cjs | sort -V | tail -n 1)"
node "$CHECK" --coverage --base main              # every change of this branch, and what explains it
node "$CHECK" .sidestory/retry-jitter --pin --coverage
```

- With a sidestory folder, the comparison uses its `base` (or `--base`); without one, `--base` is required. Either way every sidestory that counts is checked and named.
- The working tree is compared by default, untracked files included (ignored ones aren't), and a deleted file paired with a similar untracked one counts as a rename. `--committed` compares `HEAD` instead (what CI sees); `--head <commit>` compares that commit.
- `--json` adds `coverage`: every file and change with its lines, status (`explained`, `partly`, `unexplained`, `trivial`, `needsLook`) and the anchors that explain it.
- `--pin` pins base-side anchors against the merge-base, never the working tree, and never re-pins an anchor with lines added since it was pinned; `--accept <anchor>[,…]` does, once you've updated the step.
- A change explained by a step whose code changed a lot since it was pinned is `explained-stale`, unless the step's own `anchor-stale` already says so (`--json` marks the change `stale` either way).
- Every manifest the branch edits keeps its `id` (`id-changed`, `id-removed`); `--new-id` turns that check off for the run, for a new sidestory that replaces a deleted one under the same folder name.
- Exit codes: **0** clean, **1** errors, **2** bad arguments, **3** no errors but some change isn't explained or marked trivial.

The checker runs git itself (the extension doesn't), carefully: see [SECURITY.md](https://github.com/mozru/sidestory/blob/main/SECURITY.md#the-checker-and-git).

### Coverage in CI

To check every pull request, add a workflow. It checks out the PR's head (not GitHub's merge commit) with full history, so the diff is exactly merge-base → head, and runs the checker from outside the checkout, so nothing in the PR can replace it. Until the checker is published on npm, it comes from the extension's VSIX at a version you pin, checked against the SHA-256 you recorded:

```yaml
# .github/workflows/sidestory-coverage.yml
name: Sidestory coverage
on: pull_request
permissions: { contents: read }
jobs:
  coverage:
    runs-on: ubuntu-latest
    env:
      SIDESTORY_VERSION: "0.1.0"        # the extension release you checked
      SIDESTORY_SHA256: "<sha256 of that VSIX>"
    steps:
      - uses: actions/checkout@v4
        with: { ref: "${{ github.event.pull_request.head.sha }}", fetch-depth: 0, persist-credentials: false }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - name: Get the checker, outside the checkout
        working-directory: ${{ runner.temp }}
        run: |
          curl -fsSL --compressed -o sidestory.vsix \
            "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/paperkite/vsextensions/sidestory/${SIDESTORY_VERSION}/vspackage"
          echo "${SIDESTORY_SHA256}  sidestory.vsix" | sha256sum -c -
          unzip -q sidestory.vsix 'extension/dist/*' -d sidestory
      - env: { BASE: "origin/${{ github.base_ref }}" }
        run: node "$RUNNER_TEMP/sidestory/extension/dist/check.cjs" --coverage --base "$BASE" --committed
        # exit 3 = some change isn't explained. Use `|| [ $? -eq 3 ]` to report without failing.
```

Record the hash once from a VSIX you downloaded and checked yourself (`sha256sum sidestory.vsix`), and update both values together when you move to a newer release. Values from the event reach the script through `env:`, never inside it, and `persist-credentials: false` keeps the token out of `.git/config`.

## Comparing versions

On a branch that changes a sidestory you already have, show reviewers what changed in it: **Sidestory: Compare with…** (the compare button in the panel's title bar) opens another version of the sidestory beside the current one, read-only from git:

- **Your branch's base** (its merge base): what this branch changed in the sidestory.
- **The previous version**: the last commit that changed it.
- **Any commit, branch or tag** you type.

The two panels move together: pick a step in either and both show it. In the older version's title bar, **Open This Step's Code Changes** opens VS Code's diff of that step's file then and now, and **Open Page Source Changes** the diff of `sidestory.html`. Its code links open the code as it was at that commit. Updating a sidestory on the branch as you change the code keeps it current after the merge; for branch coverage, though, only a sidestory added on the branch counts ([Which sidestories count](#which-sidestories-count)).

## Comments and Claude

Comment on a step of a sidestory, or on lines of code, and ask Claude about it without leaving the panel.

**In the panel:** press <kbd>C</kbd> to comment on the active step, <kbd>A</kbd> to ask Claude (select text on the page first and the comment starts with it quoted; Claude also gets the step's title and the lines it explains; characters you can't see are left out), <kbd>T</kbd> to show or hide the **Comments** pane under the sidestory, <kbd>N</kbd> / <kbd>Shift</kbd>+<kbd>N</kbd> for the next or previous thread with something new for you. Steps with threads show a count on their chip and a badge at the section's corner. In the composer, <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Enter</kbd> sends in the mode shown (**Comment** or **Ask Claude**), and <kbd>Esc</kbd> closes it and keeps your draft. With **Ask Claude**, choose **Answer only** (the default) or **Let Claude edit**.

**In the editor:** select lines (or just put the cursor on one) and press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>C</kbd> (<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>C</kbd> on macOS), or right-click and choose **Comment on These Lines** or **Ask Claude About These Lines**, or use the gutter **+** on lines a step covers. The thread is on those lines, and Claude gets the file and the lines. The thread opens in VS Code's own comment widget, with **Comment** and **Ask Claude** buttons; <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Enter</kbd> runs the first. The setting `sidestory.comments.ranges` (`steps` or `everywhere`) says where the **+** appears; `everywhere` overlaps the GitHub Pull Requests extension, and VS Code then asks which one to use. Code comments go on files as they are in your working tree: in a branch's diff, comment on its right side (with `sidestory.changes.includeUncommitted` on); the left side, an older version from git, takes none.

**The Comments view** (in the Sidestory sidebar) lists threads: *For you* (new replies in threads you took part in, and Claude's suggestions to resolve), *Waiting for Claude* (with **Copy Prompt: Answer Waiting Comments**, and **Stop Waiting** for an answer you got elsewhere), *Open*, *Resolved*, and *Elsewhere* (local threads whose sidestory was renamed, archived or replaced).

### Local or shared

New threads are **local**: kept in `.sidestory/.local/`, which ignores itself through its own `.gitignore` (`*`), so they never reach a commit. **Share** moves a thread to `.sidestory/<name>/threads/`, committed with the sidestory, where teammates see it after a pull; **Make Local** moves it back (a committed thread stays in git history). Each comment is its own small file, so branches never conflict. The first Share offers to add `.sidestory/**/threads/** linguist-generated=true` to `.gitattributes`, which collapses thread files in GitHub's "Files changed". `sidestory.comments.defaultLocation` flips the default, and `sidestory.comments.authorName` sets the name on your comments (otherwise git's `user.name`; never an email address).

### Turning on Ask Claude

Ask Claude sends your comment to a running **Claude Code** session, which answers in the thread. It needs the `sidestory-comments` plugin (and **Node 20 or later** on `PATH`) and Claude Code started with Sidestory's channel:

```
/plugin marketplace add mozru/sidestory
/plugin install sidestory-comments@sidestory
```

| You use | Start Claude Code with |
|---|---|
| Claude Code, Pro or Max (no organization), or a Console API key | `claude --dangerously-load-development-channels plugin:sidestory-comments@sidestory`. Claude Code shows a warning at every start; choose "I am using this for local development". Sidestory isn't on Anthropic's channel allowlist during the research preview, so plain `--channels` doesn't register it. |
| Team or Enterprise, or a Console organization with managed settings | An Owner turns channels on (Organization settings › Claude Code › Channels, or `channelsEnabled: true`); then the command above works. For plain `claude --channels plugin:sidestory-comments@sidestory`, the admin also adds `{ "marketplace": "sidestory", "plugin": "sidestory-comments" }` to `allowedChannelPlugins` (which replaces Anthropic's list), and you set `sidestory.claude.channelFlag` to `channels`. |
| Bedrock, Google Cloud's Agent Platform, Foundry; `claude -p`, the Agent SDK | Channels aren't available: use **Copy Prompt**, or ask Claude to "check the Sidestory comments". |
| The Claude Code VS Code extension | It can't pass the flag: run `claude` with the flag in VS Code's terminal. |

**Sidestory: Copy Claude Command with Comments** copies the right command, with `--allowedTools` for the four comment tools so Claude's first reply doesn't stop for an approval in a terminal you aren't looking at. To allow them everywhere instead, add them to `permissions.allow` in `~/.claude/settings.json`:

```json
{ "permissions": { "allow": ["mcp__plugin_sidestory-comments_sidestory__ack", "mcp__plugin_sidestory-comments_sidestory__reply", "mcp__plugin_sidestory-comments_sidestory__get_thread", "mcp__plugin_sidestory-comments_sidestory__list_threads"] } }
```

These tools only read and write thread files; edits Claude makes still ask as usual. A shell alias such as `alias claude-sidestory='claude --dangerously-load-development-channels plugin:sidestory-comments@sidestory'` saves typing. A **separate Claude Code session for questions while reading** works best: a comment that arrives while Claude is busy lands in its current turn, and a smaller model may set it aside; the comment then shows **Send Again**.

**What you see:** "Sent to Claude · <session>", then "Claude is on it" once Claude acknowledges, then the reply in the thread. "No Claude session with Sidestory's channel is running here" means none was found; **Choose a Session…** lists sessions whose channel couldn't be detected, and **Copy Prompt** copies a prompt to paste anywhere. With several sessions in a repository, the send button names the one it goes to; its ▾ changes it, and your choice is remembered. A session in another worktree isn't offered. If the channel doesn't register on Claude Code's v2 MCP runtime, start Claude Code with `MCP_PROTOCOL_NEGOTIATION=legacy`.

**Other agents** (Codex, Cursor): **Sidestory: Copy MCP Server Config** copies a server entry with the tools (no push); then ask the agent to answer the waiting comments. Without MCP, `node <extension>/dist/check.cjs threads --waiting --json` lists them.

**Without channels** (work accounts often block them): ask Claude, in the session that wrote the sidestory, to watch for your comments. With the Sidestory skill it runs `node <extension>/dist/check.cjs threads --watch --json` in the background, which prints a line for each comment of yours that waits for an answer (your questions still unanswered when it starts, then each new comment), and answers each one in its thread.

Comments from other people, and anything from the repository, reach Claude only when it reads them, labelled as theirs; [SECURITY.md](https://github.com/mozru/sidestory/blob/main/SECURITY.md#comments-and-claude) has the details.

## Settings

A sidestory's `highlight` in its manifest can change the defaults of the first five (fading, the click highlight and its frame, hovering); your own settings always win.

| Setting | Default | |
|---|---|---|
| `sidestory.dimUnfocused` | `true` | Fade the rest of the file while you step through a sidestory (never in high contrast themes). |
| `sidestory.clickHighlightSeconds` | `1.5` | How long the code stays highlighted after you click a code link or an inline reference, or a widget points at it, in seconds. `0` keeps it until the next one, or until the panel shows another sidestory. |
| `sidestory.clickFrame` | `true` | When that highlight fades, keep a frame around the lines (the `sidestory.clickFrameBorder` color) until the next one, or until the panel shows another sidestory. |
| `sidestory.hoverPreview` | `editor` | What resting the pointer on a link or a diagram box (or tabbing to it) shows: `editor` (its lines highlighted in the editors that show the file, with a scrollbar mark and an arrow at the edge when they're out of view; a note by the link when no editor shows the file; nothing is opened), `card` (the first lines of its code, in a small card in the panel), `both`, or `off`. A click still opens the code. |
| `sidestory.hoverReveal` | `false` | While you hover a link, scroll the editor that shows its file to the lines (focus stays in the panel), and back once you're done in the panel, unless you clicked the link or went to that editor (moved the pointer there, scrolled it, clicked in it). |
| `sidestory.followCursorInDiagrams` | `true` | Ring the boxes and links (`data-explain-ref`, `data-explain-code`) whose code holds the editor cursor. |
| `sidestory.codeLens.enabled` | `true` | A CodeLens above explained code (at most 30 per file; hidden while that sidestory is open in a panel). Language-overridable. |
| `sidestory.statusBar.enabled` | `true` | The sidestory for the cursor's line in the status bar, when no open panel shows it. |
| `sidestory.gutter.enabled` | `false` | A gutter glyph and an overview ruler mark on explained code. |
| `sidestory.sidebar.followPanel` | `true` | Select the open panel's sidestory in the Sidestories view (never expanding a row you collapsed). |
| `sidestory.sidebar.thisBranch` | `false` | Show the **This branch** group at the top of the Sidestories view (the sidestories that explain the branch, what's left, and the prompts). In a workspace with no sidestory yet it shows anyway, to offer explaining the branch. |
| `sidestory.changes.defaultBase` | `""` | The branch, tag or commit a branch is compared with (`develop`, `origin/develop`) when none was set with **Sidestory: Set Base…**, no sidestory added on the branch gives a `base`, and Git recorded no base for the branch (`branch.<name>.vscode-merge-base`, which VS Code's Source Control sets); empty means the remote's default branch, then `main`, then `master`. |
| `sidestory.changes.includeUncommitted` | `true` | Compare the working tree (staged, unstaged and untracked changes) rather than the last commit, for coverage, its decorations and the diffs steps open. Turn it off to see what CI sees. |
| `sidestory.changes.openStepsIn` | `"editor"` | Where the steps of a sidestory that explains a branch open: `editor` (the file itself; removed code in a read-only view of the old file) or `diff` (the branch's diff of the file). |
| `sidestory.changes.suggestExplain` | `true` | Offer **Copy Prompt: Explain This Branch** under "This branch" in the Sidestories view when the branch has changes and no sidestory explains it yet. |
| `sidestory.changes.markUnexplained` | `false` | Mark unexplained changes in the gutter of the branch's diffs, also when no sidestory with this base is open. |
| `sidestory.widgets.enabled` | `true` | Run interactive widgets (each workspace still asks first). Application scope: only your user settings count. In browser VS Code (code-server, openvscode-server), set it in the **User** tab of the Settings editor, which lives in the browser; the server's (Remote) settings file doesn't apply. |
| `sidestory.comments.defaultLocation` | `local` | Where new comment threads are kept: `local` (only on this machine) or `shared` (committed). Application scope. |
| `sidestory.comments.authorName` | (git's `user.name`) | The name on your comments; never an email address. Application scope. |
| `sidestory.comments.ranges` | `steps` | Where the editor's comment **+** appears: lines a step covers, or `everywhere`. |
| `sidestory.comments.stateDir` | (per-user default) | Where Ask Claude's delivery records and presence are kept, shared with the comments plugin. Machine scope. |
| `sidestory.claude.channelFlag` | `dev` | The flag the copied Claude command uses: `dev` (`--dangerously-load-development-channels`) or `channels`. |

## Troubleshooting

**View › Output › Sidestory** shows why a file was refused (missing, outside the repository after following links, too large) and other problems. Files that aren't open in an editor are read as UTF-8.

## Development

```bash
npm ci
npm run check          # typecheck, unit tests, build
npm run test:webview   # the panel in Chromium (first: npx playwright install chromium)
npm run test:e2e       # browser VS Code with the server in Docker
npm run package        # dist/sidestory.vsix
node dist/check.cjs fixtures/sample-workspace/.sidestory/bit-reader   # the standalone widget checker (after a build)
node scripts/widget-types.ts           # regenerate src/widget-types/*.d.ts after updating a widget library
```

Press <kbd>F5</kbd> to open an Extension Development Host on `fixtures/sample-workspace`. Test plan for remote setups: [TEST-PLAN.md](https://github.com/mozru/sidestory/blob/main/docs/TEST-PLAN.md). Design notes (a draft that includes features not built yet): [DESIGN.md](https://github.com/mozru/sidestory/blob/main/docs/DESIGN.md). Releasing: [RELEASE.md](https://github.com/mozru/sidestory/blob/main/docs/RELEASE.md).
