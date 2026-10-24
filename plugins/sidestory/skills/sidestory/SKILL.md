---
name: sidestory
description: Write or update sidestories — step-by-step walkthroughs of code with diagrams and optional interactive React widgets, shown beside the code in VS Code and linked to it both ways. Use when the user asks to explain, walk through, document or visualize code "with Sidestory", asks for a sidestory (or an explainer), a code walkthrough or a block diagram of how some code works, or mentions `.sidestory/`, sidestory.html or manifest.json in a `.sidestory/` folder.
---

# Writing sidestories

A sidestory is a folder `.sidestory/<name>/` at the repository root (the folder that holds `.sidestory/`):

- `sidestory.html`: any HTML and CSS, no script. Sections marked `data-explain-anchor` are the steps.
- `manifest.json`: which code each anchor is about.
- `assets/` (optional), plus widget `.tsx` files when the sidestory has interactive widgets.

The Sidestory VS Code extension (`paperkite.sidestory`) shows it beside the code. The editor follows the steps, and the steps follow the cursor.

## Before writing

Read the reference that ships with this skill:

- [references/GUIDE.md](references/GUIDE.md), section "Writing a sidestory": the anchors, the manifest, overview → detail sidestories, styling, and what's supported. Read it every time.
- [references/WIDGETS.md](references/WIDGETS.md): read all of it before writing an interactive widget. Most explanations don't need one, and CSS-only interactivity comes first.

Look at existing sidestories in `.sidestory/` and match their style.

## Workflow

1. **Understand the code** the user named. Read it properly, follow the data and control flow, and find the non-obvious parts (invariants, edge cases, the reason it's built this way).
2. **Plan the steps**, usually 4–10: the big picture first (what it is, its interface, a block diagram), then the parts in the order data or control flows through them. For a big system, write an overview sidestory plus one detail sidestory per part, linked with `data-explain-detail`. Name the overview `overview` or `<area>-overview` so the sidebar pins it as **Start here**; in a repository with many sidestories, give top-level ones a `group` in their manifests.
3. **Write `manifest.json`.** Give it a `title`, a one-line `summary`, and one anchor per step: `file` (path from the repository root, `/` separators), `range` (1-based first and last line), `highlight` (identifiers worth marking), and `color` (a theme color id such as `charts.blue`, never a hex value). Start from the `version: 1` form in the guide and let the checker pin it.
4. **Write `sidestory.html`.** One `<section data-explain-anchor="…" data-explain-title="…">` per step, each with a heading, tight prose and a diagram where it helps. Draw diagrams in inline SVG or HTML/CSS. Use `<a data-explain-ref="anchor">…</a>` to point at other code from inside a step. For diagrams (the guide's "Diagrams that follow the steps", "Code links without an anchor" and "Diagram tokens"):
   - **Color them with the diagram tokens** (`--cx-wire-data`, `--cx-wire-ctrl`, `--cx-box-fill`, `--cx-box-stroke`, `--cx-label`, …) and the dash tokens (`--cx-dash-ctrl`, …), never hex values or ad-hoc `--vscode-charts-*` colors. They follow light, dark and high-contrast themes.
   - **Make it follow the steps.** Draw one block diagram, put `data-explain-diagram="step dim-rest"` on its `<svg>`, tag boxes and wires with `data-explain-on="<anchor ids>"` for the steps they matter in, and mark the legend `data-explain-keep`. A section that needs the diagram again gets its own copy with `data-explain-diagram="section dim-rest"`.
     - Ids must match manifest anchor ids exactly; a wrong one never lights. The checker reports ids that aren't in the manifest, and manifest anchors nothing uses.
     - Put each wire's path, arrowhead and label in one `<g>`, and tag the group.
     - Light both ends of every lit wire, and the block driving each signal the step's text names. Add a box's own anchor id to its list when it has a card or nested section.
     - Add a rule for lit parts, e.g. `.box.cx-on rect { stroke: var(--cx-on); stroke-width: 2.5 }` and `.wire.cx-on path { stroke-width: 3 }` for tagged `<g class="box">` and `<g class="wire">`: without one, only the fading marks them, and high-contrast themes don't fade.
   - **Make every box a link:** `data-explain-ref="<anchor>"` on its `<g>` when a manifest anchor covers it; for small parts, `data-explain-code="#symbol"` (`#u_fifo`, `#driver(state_q)`, `#driver(state_d).case(IDLE)`, `#u_rd_port(.start)` for a connection in a top-level module, where `driver()` doesn't reach into instances) with `data-explain-code-file="<path>"` on the figure, or `data-explain-code="<path>#L10-L20"`. Prefer symbols to line ranges in SystemVerilog: they keep pointing at the code when it's edited. Links get a built-in look; don't restyle their colors.
   - A box lights up while the reader's cursor is in its code, the tightest box winning, so link each box to the code that does its work: `#driver(x)` for the block that drives a signal, `#driver(state_d).case(IDLE)` for one FSM bubble.
   - Give a diagram with links `role="group"` and an `aria-label`; one without links `role="img"` and an `aria-label`. Name each linked `<g>` with a `<title>`.
5. **Check and pin** with the checker that ships inside the extension:

   ```bash
   node "$(ls ~/.vscode*/extensions/paperkite.sidestory-*/dist/check.cjs ~/.cursor*/extensions/paperkite.sidestory-*/dist/check.cjs 2>/dev/null | tail -n 1)" .sidestory/<name> --pin
   ```

   Fix every error and read every warning, then run it again until it's clean. It checks every `data-explain-code` link too: when it says a symbol isn't found, its message says what to link instead (an input port, a connection in the parent, a name in a later `` `ifdef `` arm).
   - If no checker is found, the extension isn't installed here. Tell the user to install `paperkite.sidestory`, and in VS Code run **Sidestory: Pin Anchors to the Current Code**.
   - **Never pass `--yes-widgets-may-read` on your own.** If the checker says some anchors weren't pinned because widgets read their code, show the user the files and line ranges, explain that the widgets will be able to read that code, and add the flag only if they agree.
6. **Tell the user** the sidestory's name, and that they open it with **Sidestory: Open Sidestory**. If it has widgets, also say that VS Code will ask them once before running the widgets.

## Style

- Explain *why* and *how it fits together*, not a line-by-line paraphrase. The code is right beside the text.
- Keep each step short enough to read while looking at the code: a heading, a few sentences, and at most one figure.
- Name real signals, functions and variables in `<span class="mono">` or `<code>`, and make the anchors point at exactly the code the step talks about.
- When updating an existing sidestory after code changes, run the checker first. It reports anchors whose code changed or was lost. Fix the text and the ranges, then pin again.
