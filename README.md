# Sidestory

**Rich sidestories beside your code: diagrams, live widgets and prose that walk through the code with you, and that you or your AI agent can write.**

![Stepping through the stream DMA overview: each step lights its part of the block diagram, fades the rest, and highlights its code in the editor beside it](media/marketplace/hero.gif)

A sidestory is an HTML page in your repository (`.sidestory/<name>/`) whose sections are pinned to the code they describe. Sidestory opens it beside the editor and keeps the two in step: diagrams, tables, block diagrams and interactive React widgets on one side, the real code, highlighted, on the other. Great for onboarding, design reviews, hardware (RTL) walkthroughs and anything too big for comments.

> **Preview.** Sidestory is new; feedback and bug reports are welcome on [GitHub](https://github.com/mozru/sidestory/issues).

## Linked both ways

Step through the sidestory (arrow buttons, <kbd>J</kbd>/<kbd>K</kbd>, or <kbd>Alt</kbd>+<kbd>]</kbd> / <kbd>Alt</kbd>+<kbd>[</kbd> anywhere; <kbd>Ctrl</kbd>+<kbd>Option</kbd>+<kbd>]</kbd> / <kbd>[</kbd> on macOS) and the editor scrolls to the code each section is about, highlights it and marks the identifiers that matter. Move the cursor in the code and the sidestory follows: the boxes that point at that code light up, and the step moves to the section about it.

![Clicking lines in dma_ctrl.sv: the IDLE, READ_BURST and WAIT_DATA states light up in the overview's diagram, then a line in the error override takes the sidestory to its Errors step](media/marketplace/cursor-follow.gif)

## Diagrams that follow the code

Block diagrams are plain inline SVG, and two attributes make them live:

- **Lighting per step.** Tag boxes and wires with `data-explain-on="datapath backpressure"` and they light up while the reader is on those steps; with `data-explain-diagram="step dim-rest"`, everything else fades.
- **Clickable boxes.** A box with `data-explain-ref` or `data-explain-code` opens its code when clicked, and rings while the editor cursor is in that code. For SystemVerilog, `data-explain-code` names a symbol instead of lines: `#driver(state_q)`, `#driver(state_d).case(IDLE)`, `#u_ctrl(.start)`.

![The block diagram of a stream DMA engine in the sidestory, dark theme](media/marketplace/block-diagram-dark.png)

## Live widgets

Sidestories are free-form HTML and CSS, so they can hold anything a page can: tables, tabs, steppers and quizzes, all in your VS Code theme. For what CSS can't do, add **widgets**: React components written the way Claude writes artifacts (Tailwind, shadcn/ui-style components, Recharts, D3, Motion), each in its own sandboxed frame. A widget knows the current step, can read the code its sidestory points at, and highlights lines in the editor as it runs.

![A cycle-accurate simulation of the DMA engine: beats move along the data path, the FIFO fills, and the editor highlights the FSM state the controller is in](media/marketplace/widget-sim.gif)

## Big systems: an overview, then the details

Write one sidestory per piece and an overview that ties them together. Readers skip a piece, **peek** at its one-line summary in place, or **dive** into its own sidestory in the same panel, with a trail at the top to come back to the step they left. Details can have details of their own.

![From the DMA overview, peek at dma_ctrl, dive into its sidestory and its state graph widget, then return through the trail](media/marketplace/dive.gif)

## Find your way

- **The Sidestories view.** The Sidestory icon in the activity bar lists every sidestory by package, overviews first (**Start here**) with their details under them, in page order. Click one to open it; filter by title or summary.
- **Explained here.** A CodeLens above explained code names the sidestory and step (*Overview › Detail · step 3: Credit*); click it to open the sidestory at that step. The status bar names it too.
- **Find a step.** **Sidestory: Go to Step…** finds any step by its title or blurb, in this package or all of them.

![The Sidestories view expands the DMA overview's details; a CodeLens in dma_ctrl.sv opens its sidestory at the Credit step; Go to Step finds "backpressure"](media/marketplace/navigation.gif)

## Any language: a Python example

Code blocks in the page are syntax-highlighted in your editor's theme, with the grammars of the language extensions you already have (mark them `class="language-python"`, as in Markdown), and anchors work in any language. [`examples/tiny-lsm`](examples/tiny-lsm) is a small log-structured merge-tree key-value store in Python, with an overview, a sidestory per component and simulations of its write, compaction, read and scan paths.

![tiny-lsm's overview: the "A put" step shows a highlighted Python code block, then the write-path simulation steps through db.py in the editor](media/marketplace/python.gif)

## Comments, and Ask Claude

Comment on a step (<kbd>C</kbd> in the panel) or on lines of code (**Sidestory: Comment on Selection**, or the gutter **+** on lines a step covers), reply and resolve. Threads show in a pane under the sidestory, in the editor, and in the **Comments** view. They stay on your machine (`.sidestory/.local/`, ignored by git) until you **Share** one, which commits it with the sidestory.

**Ask Claude** (<kbd>A</kbd>, or **Ask Claude About Selection**) sends your comment to a Claude Code session started with Sidestory's channel, and Claude answers in the thread. Install the channel with `/plugin install sidestory-comments@sidestory`; **Sidestory: Copy Claude Command with Comments** copies the command that starts Claude Code with it. Codex, Cursor and other MCP clients get the same tools from **Sidestory: Copy MCP Server Config**. Details: [Comments and Claude](docs/GUIDE.md#comments-and-claude).

## Stays in sync with the code

Sections are anchored to the code they describe, not just to line numbers. Insert lines above, move a function, or edit the code (saved or not) and the section follows it as you type. When the code itself changes, the section says so: **Code changed**, **Out of date** when it changed a lot, or **Code not found**. **Sidestory: Pin Anchors to the Current Code** records each anchor's code; **Re-anchor Section to Selection** points a section at new code. Edits to the sidestory show up live too, keeping your place.

## Write them with any AI agent

Sidestories are plain files: `sidestory.html`, `manifest.json` and optional widget `.tsx` files. Claude Code, Codex or any other agent (or you) can write them, and a checker that ships with the extension catches mistakes without running anything: problems appear in the Problems panel as you save, **Sidestory: Check Widgets** checks on demand, and a command-line checker serves agents in a terminal.

![A widget that imports an unavailable library: the checker's diagnostic for .sidestory/retry-backoff/widgets in the Problems panel, and the panel keeps running the last good version](media/marketplace/problems.png)

## Safe by default

Sidestories are content from the repository, so Sidestory treats them like untrusted input. The page itself can't run script, reach the network or read files outside the repository, which is why it works in **Restricted Mode**. Widgets are code, so they run only in trusted workspaces, only with the `sidestory.widgets.enabled` user setting on, and only after you agree in a VS Code dialog that says what they can do. Until then you see each widget's fallback. Details: [SECURITY.md](SECURITY.md).

![The consent dialog before widgets run: the code they can read, and that they may be able to reach the network](media/marketplace/consent-dialog.png)

## Quick start

### 1. Install

Install **Sidestory** from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=paperkite.sidestory), or run:

```bash
code --install-extension paperkite.sidestory
```

### 2. Open an example

Clone [the repository](https://github.com/mozru/sidestory) and open the [`examples/stream-dma`](examples/stream-dma) folder in VS Code: a memory-to-memory DMA engine in eight SystemVerilog modules, with an overview and a sidestory per block. Run **Sidestory: Open Sidestory…** from the Command Palette and pick **dma-overview**. For Python, open [`examples/tiny-lsm`](examples/tiny-lsm) and pick **lsm-overview**. The smaller [`fixtures/sample-workspace`](fixtures/sample-workspace) has a bit reader and a retry loop.

### 3. Write your first sidestory

A sidestory is a folder under `.sidestory/` in your repository; file paths in its manifest are relative to the folder that contains `.sidestory/`. Mark each section with `data-explain-anchor` and say in `manifest.json` which code it is about.

`.sidestory/retry/sidestory.html`:

```html
<section data-explain-anchor="delay" data-explain-title="Delay">
  <h2>How long to wait</h2>
  <p>The ceiling doubles every attempt until <code>maxMs</code>; the wait is a random point below it.</p>
</section>

<section data-explain-anchor="loop" data-explain-title="The loop">
  <h2>The loop</h2>
  <p>Try, and on failure sleep for <a data-explain-ref="delay">the delay</a> before the next attempt.</p>
</section>
```

`.sidestory/retry/manifest.json`:

```json
{
  "version": 1,
  "title": "Retry with full-jitter backoff",
  "summary": "Why retries wait a random, growing time.",
  "anchors": {
    "delay": { "file": "src/retry.ts", "range": [14, 18], "highlight": ["ceiling"], "color": "charts.blue" },
    "loop": { "file": "src/retry.ts", "range": [20, 30], "color": "charts.green" }
  }
}
```

Open it with **Sidestory: Open Sidestory…**, then run **Sidestory: Pin Anchors to the Current Code** so the anchors follow the code through edits. The [guide](docs/GUIDE.md) covers every attribute, the manifest, overviews and details, styling and limits.

### 4. Or ask your agent

**Claude Code** learns Sidestory from a plugin. Install it once:

```text
/plugin marketplace add mozru/sidestory
/plugin install sidestory@sidestory
```

Then ask in plain words, for example *"Explain how the DMA controller works, with Sidestory."* Claude reads the guides bundled in the plugin, writes the sidestory, runs the checker and pins the anchors.

**Codex** and other agents that support [Agent Skills](https://agentskills.io) can use the same skill: copy [`plugins/sidestory/skills/sidestory`](plugins/sidestory/skills/sidestory) into the agent's skills folder (for Codex, `~/.codex/skills/sidestory`).

Any other agent: point it at the guides. **Sidestory: Copy a Prompt for Your Agent** copies this prompt; fill in the code and a name:

> Write a sidestory for `<the code to explain>` in `.sidestory/<name>/`: a section per part, a diagram where it helps, and a widget only where interaction makes it clearer. Follow https://github.com/mozru/sidestory/blob/main/docs/GUIDE.md and https://github.com/mozru/sidestory/blob/main/docs/WIDGETS.md, then run the checker until it reports no errors.

The checker ships with the extension; **Sidestory: Copy Widget Check Command** copies the exact command for your machine. It looks like:

```bash
node "$(ls ~/.vscode*/extensions/*sidestory*/dist/check.cjs | sort -V | tail -n 1)" .sidestory/dma-ctrl
```

Add `--pin` to pin anchors from the files on disk, or `--json` for a machine-readable report.

## Explaining a branch

A sidestory with a `"base"` in its manifest explains a branch: its steps cover the branch's changes against that base. To browse the branch itself, use a branch-diff tool you already like: [Git Tree Compare](https://marketplace.visualstudio.com/items?itemName=letmaik.git-tree-compare) (recommended), GitLens, or Source Control. Sidestory adds to them rather than replacing them:

- **Coverage marks on files.** Each changed file gets a small badge wherever VS Code decorates files (Git Tree Compare, Source Control, the Explorer, tabs): `✓` every change explained, `–` all marked trivial, `◐` partly, `○` not yet, `!` code added since its step was written. The tooltip says how much (`2 of 3 changes explained · Step 3 of Retry with jitter`).
- **This branch**, at the top of the Sidestories view: the sidestories that explain the branch with their totals (`vs main · 9 explained · 3 trivial · 1 left`), and **Copy Prompt: Update the Sidestory for New Changes** while something is left. With none yet, **Copy Prompt: Explain This Branch** copies a prompt for Claude Code (or your agent); **Don't Suggest on This Branch** hides it.
- **Steps open the file itself**, the step's lines highlighted (removed code in a read-only view of the old file), and the cursor moves the panel. Changed lines no step explains get a dotted mark in the gutter while the sidestory is open.
- **Open Changes with Base**, a compare button in the editor's title bar while you're in a file the branch modified or renamed (also in the Command Palette), switches to the branch's diff at the same place. The panel keeps following the cursor there, later steps in that file stay in the diff, and **Open File** switches back. Files the branch added or deleted have no button: their diff would be all green or all red.
- **In a diff**, the step's lines get a frame and the step's title, so they stand out among the diff's colors. Set `sidestory.changes.openStepsIn` to `"diff"` to open steps in the diff straight away.
- **This File** lists every step, in any sidestory, that covers the file you're in, and for a changed file the changes not explained yet.
- **One change at a time:** with the cursor in a change (in its diff or the changed file), the editor's context menu has **Copy Prompt: Explain This Change**, **Mark as Trivial…** (asks why, and writes it into the sidestory), and **Re-pin This Step** for a step whose code grew, once you've updated its prose.

The base: **Sidestory: Set Base…** when you picked one for the branch, else the `"base"` of a sidestory added on the branch, else the branch base Git recorded, the `sidestory.changes.defaultBase` setting, the remote's default branch, or `main` (then `master`). When sidestories on the branch name different bases, **This branch** offers to switch.

Tip: VS Code's diffs switch to inline view when they're narrow, which hides removed code's highlight. With the panel beside them, set `"diffEditor.useInlineViewWhenSpaceIsLimited": false` to keep them side by side.

## Commands

| Command | What it does |
|---|---|
| **Sidestory: Open Sidestory…** | Pick a sidestory and open it beside the code, recently opened first; a detail opens with its overview on the trail (also on a folder's context menu in the Explorer). |
| **Sidestory: Go to Step…** | Find a step by its title or blurb, in this package or across all of them, and open the sidestory there. |
| **Sidestory: Show Sidestories for This Code** | The sidestories that explain the code under the cursor (also in the editor's context menu). |
| **Sidestory: Show Sidestories** | Show the Sidestories view, even in a repository with none yet. |
| **Sidestory: Explain with Sidestory** | Open the steps that explain a file, or copy a prompt to explain it (Explorer, editor and tab context menus). |
| **Sidestory: Copy a Prompt for Your Agent** | Copy a prompt that asks your coding agent to write a sidestory. |
| **Sidestory: Next Step** / **Previous Step** | Move through the sidestory (<kbd>Alt</kbd>+<kbd>]</kbd> / <kbd>Alt</kbd>+<kbd>[</kbd>, or <kbd>Ctrl</kbd>+<kbd>Option</kbd>+<kbd>]</kbd> / <kbd>[</kbd> on macOS; <kbd>J</kbd>/<kbd>K</kbd> in the panel). |
| **Sidestory: Pin Anchors to the Current Code** | Record each anchor's code so sections follow it through edits and say when it changed. |
| **Sidestory: Re-anchor Section to Selection** | Point a section at the selected code (also in the editor's context menu). |
| **Sidestory: Check Widgets** | Check the open sidestory's widgets now; results go to the Problems panel. |
| **Sidestory: Copy Widget Check Command** | Copy the command-line checker's command for this machine, for agents and scripts. |
| **Sidestory: Add Widget Types** | Write type declarations so `tsc` and IntelliSense work on widget files. |
| **Sidestory: Enable Widgets** | Turn widgets back on after the watchdog stopped one (and the setting, if it's off). |
| **Sidestory: Revoke Widget Consent** | Forget that you agreed to run this workspace's widgets. |
| **Sidestory: Next Unexplained Change** / **Previous…** | Open the branch's diff at the next change no step explains, from the active editor, in the sidestory's step order (<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>PageDown</kbd> / <kbd>PageUp</kbd>, <kbd>Ctrl</kbd>+<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>Down</kbd> / <kbd>Up</kbd> on macOS). |
| **Sidestory: Next Changed File** / **Previous…** | Open the next changed file's diff against the base, in path order (<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>PageDown</kbd> / <kbd>PageUp</kbd>, <kbd>Ctrl</kbd>+<kbd>Cmd</kbd>+<kbd>Down</kbd> / <kbd>Up</kbd> on macOS). |
| **Sidestory: Copy Prompt: Explain This Branch** | Copy a prompt that asks your agent to explain the branch's changes, step by step. |
| **Sidestory: Copy Prompt: Explain This Change** | Copy a prompt for the change at the cursor (editor context menu, This File). |
| **Sidestory: Mark as Trivial…** | Mark the change at the cursor, or the selected lines, as needing no explanation, with a reason. |
| **Sidestory: Re-pin This Step** | Pin a step whose code grew since it was written, once its prose covers the new lines. |
| **Sidestory: Comment on Selection** / **Ask Claude About Selection** | Comment on the selected lines, or send the comment to Claude (also in the editor's context menu). |
| **Sidestory: Next Comment for You** / **Previous Comment for You** | Go to the next thread with something new for you. |
| **Sidestory: Copy Claude Command with Comments** | Copy the command that starts Claude Code with Sidestory's channel and its comment tools allowed. |
| **Sidestory: Copy MCP Server Config** | Copy an MCP server entry with the comment tools, for Codex, Cursor and other clients. |
| **Sidestory: Set Base…** | Pick the branch to compare this branch with, kept per repository and branch. It wins over a sidestory's `base`; **Use the Default Base** goes back. |

## Settings

| Setting | Default | |
|---|---|---|
| `sidestory.dimUnfocused` | `true` | Fade the rest of the file while you step through a sidestory (never in high contrast themes). |
| `sidestory.followCursorInDiagrams` | `true` | Ring the boxes and links in a sidestory whose code holds the editor cursor. |
| `sidestory.codeLens.enabled` | `true` | A CodeLens above code a sidestory explains, naming it and its step (at most 30 per file, then one that lists them all; hidden while a visible panel shows that sidestory). Can be set per language. |
| `sidestory.statusBar.enabled` | `true` | Name in the status bar the sidestory that explains the cursor's line, when no open panel shows it. |
| `sidestory.gutter.enabled` | `false` | A book in the gutter, and a mark in the overview ruler, on code a sidestory explains. |
| `sidestory.sidebar.followPanel` | `true` | Select the sidestory a panel shows in the Sidestories view. |
| `sidestory.changes.openStepsIn` | `"editor"` | Where steps of a sidestory with a base open: plain editors (**Open Changes with Base** switches to the diff), or the branch's diff. |
| `sidestory.changes.suggestExplain` | `true` | Offer **Copy Prompt: Explain This Branch** under **This branch** when no sidestory explains the branch. |
| `sidestory.changes.defaultBase` | `""` | The branch to compare with when none was set with **Set Base…**, no sidestory on the branch gives one, and Git recorded no base for the branch (empty: the remote's default branch, then `main` or `master`). |
| `sidestory.changes.includeUncommitted` | `true` | Count uncommitted changes (staged, unstaged, untracked) in coverage and the diffs steps open. |
| `sidestory.changes.markUnexplained` | `false` | Mark unexplained changed lines in the diff's gutter even when no sidestory with this base is open. |
| `sidestory.comments.defaultLocation` | `"local"` | Where new comment threads are kept: `local` (only on this machine) or `shared` (committed with the sidestory). |
| `sidestory.comments.authorName` | `""` | The name on your comments (empty: git's `user.name`); never an email address. |
| `sidestory.comments.ranges` | `"steps"` | Where the editor's comment **+** appears: on lines a step covers, or `everywhere`. |
| `sidestory.comments.stateDir` | `""` | Where Ask Claude's delivery records are kept, shared with the comments plugin (empty: the per-user default). |
| `sidestory.claude.channelFlag` | `"dev"` | The flag the copied Claude command uses for Sidestory's channel: `dev` or `channels`. |
| `sidestory.widgets.enabled` | `true` | Run interactive widgets; each workspace still asks first. A user setting: a repository's settings can't turn it on. In browser VS Code, set it in the **User** tab of the Settings editor. |

## Requirements

- VS Code 1.95 or later.
- Works locally and over Remote-SSH, WSL, Dev Containers, Codespaces and browser VS Code backed by a server (code-server, openvscode-server, `code tunnel`). Not on vscode.dev or github.dev alone, which have no server to run it.
- Nothing else to install: widget libraries ship with the extension.

## Learn more

- [Guide](docs/GUIDE.md): writing sidestories, the manifest, overviews and details, anchor states, styling, what's supported, limits, troubleshooting, development.
- [Writing widgets](docs/WIDGETS.md): the widget contract, imports, theming, linking to code, checking, and a gallery. Written for people and for agents.
- [Security](SECURITY.md): the threat model and what widgets can and can't reach.
- [Changelog](CHANGELOG.md)
- Examples: [stream DMA](examples/stream-dma) (SystemVerilog) and [tiny-lsm](examples/tiny-lsm) (Python)

## License

[MIT](LICENSE)
