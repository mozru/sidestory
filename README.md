# Sidestory

**Explain your code in a page that sits beside it, with diagrams, live widgets and prose that move with you as you read. Write one yourself, or have your AI agent write it.**

![Stepping through the stream DMA overview: each step lights its part of the block diagram, fades the rest, and highlights its code in the editor beside it](media/marketplace/hero.gif)

A sidestory is an HTML page in your repository, under `.sidestory/<name>/`, with each section pinned to the code it talks about. Sidestory opens it next to your editor and keeps the two in step. Use it for onboarding, design reviews, hardware (RTL) walkthroughs, and anything too big for a comment.

> **Preview.** Sidestory is new. Feedback and bug reports are welcome on [GitHub](https://github.com/mozru/sidestory/issues).

## Quick start

1. **Install** from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=paperkite.sidestory), or run `code --install-extension paperkite.sidestory`. You need VS Code 1.95 or later. It works locally and over Remote-SSH, WSL, Dev Containers, Codespaces and server-backed browser VS Code (code-server, openvscode-server, `code tunnel`), but not on vscode.dev or github.dev alone. There's nothing else to install.
2. **Try an example.** Clone [the repo](https://github.com/mozru/sidestory), open one of these folders, run **Sidestory: Open Sidestory…** and pick the overview.

   | Folder | What it explains | Open |
   |---|---|---|
   | [`examples/stream-dma`](examples/stream-dma) | A DMA engine in eight SystemVerilog modules | **dma-overview** |
   | [`examples/tiny-lsm`](examples/tiny-lsm) | A log-structured merge-tree store in Python | **lsm-overview** |
   | [`fixtures/sample-workspace`](fixtures/sample-workspace) | A bit reader and a retry loop (small) | any |

3. **Write your own**, or [ask your agent to](#let-your-ai-agent-write-one).

## Reading a sidestory

- **Step through** with the step tabs, the < > buttons, <kbd>J</kbd>/<kbd>K</kbd> in the panel, or <kbd>Alt</kbd>+<kbd>]</kbd> / <kbd>[</kbd> from anywhere (<kbd>Ctrl</kbd>+<kbd>Option</kbd>+<kbd>]</kbd> / <kbd>[</kbd> on macOS). The editor scrolls to each step's code, highlights it and marks the names that matter.
- **The step changes only on a click or a key.** Scrolling the page never changes it, so the diagrams and the editor stay put while you read ahead.
- **Rest the pointer on a link** or a diagram box to light up its code in the editor; click to open it.
- **Move the cursor in the code** and diagram boxes for that code get a ring; the panel offers the step about it ("Cursor is in … · Show").
- **Right-click** in the page for Copy, Open Code, Go to This Step, Comment and Ask Claude.
- **Back and forward** as in a browser: the ← → buttons, <kbd>Alt</kbd>+<kbd>←</kbd> / <kbd>→</kbd> or VS Code's own navigate keys.

![Clicking lines in dma_ctrl.sv: the IDLE, READ_BURST and WAIT_DATA states light up in the overview's diagram, and the panel offers the step about the code; a line in the error override offers its Errors step](media/marketplace/cursor-follow.gif)

Big systems get an overview plus one sidestory per piece. From the overview, **peek** at a piece's one-line summary or **dive** into its own sidestory; a trail at the top takes you back.

![From the DMA overview, peek at dma_ctrl, dive into its sidestory and its state graph widget, then return through the trail](media/marketplace/dive.gif)

To find what's been explained: the **Sidestories** view in the activity bar (overviews first, details under them, with each one's problems and open comments), a **CodeLens** above explained code, and **Sidestory: Go to Step…**.

![The Sidestories view expands the DMA overview's details; a CodeLens in dma_ctrl.sv opens its sidestory at the Credit step; Go to Step finds "backpressure"](media/marketplace/navigation.gif)

## What a page can hold

Free-form HTML and CSS in your VS Code theme: tables, tabs, steppers, quizzes, plus:

- **Diagrams that follow along.** Tag an inline SVG box with `data-explain-on="datapath"` and it lights up on that step while the rest fades. Boxes can link to code (lines, or for SystemVerilog a signal such as `#driver(state_q)`).
- **Motion.** CSS and SVG animation play in the panel, so a beat can travel the wire the current step lights. See [Moving parts](docs/GUIDE.md#moving-parts).
- **Live widgets.** React components in a sandboxed frame, written the way Claude writes artifacts (Tailwind, shadcn/ui-style components, Recharts, D3, Motion). A widget knows the current step, can read the code the page points at, and highlights lines in the editor.
- **Code blocks in any language**, highlighted in your editor's theme.

![The block diagram of a stream DMA engine in the sidestory, dark theme](media/marketplace/block-diagram-dark.png)

![A cycle-accurate simulation of the DMA engine: beats move along the data path, the FIFO fills, and the editor highlights the FSM state the controller is in](media/marketplace/widget-sim.gif)

![tiny-lsm's overview: the "A put" step shows a highlighted Python code block, then the write-path simulation steps through db.py in the editor](media/marketplace/python.gif)

## It keeps up with the code

Sections are tied to the code itself, not to line numbers, and follow it as you type, saved or not. When the code really changes, the section says so. **Sidestory: Pin Anchors to the Current Code** records each section's code; **Sidestory: Re-anchor Section to Selection** points a section at different code.

![When the code changes: lines added above and the section follows; a small edit and it says Code changed; a rewrite and it says Out of date; the code deleted and it says Code not found. Each state names what to do next](media/marketplace/anchor-states.gif)

## Let your AI agent write one

A sidestory is plain files (`sidestory.html`, `manifest.json`, optional widget `.tsx` files), so any agent can write one.

- **Claude Code:** `/plugin marketplace add mozru/sidestory`, then `/plugin install sidestory@sidestory`, and ask *"Explain how the DMA controller works, with Sidestory."* Claude writes the page in the style you ask for, checks it and pins the anchors.
- **Codex** and other [Agent Skills](https://agentskills.io) agents: copy [`plugins/sidestory/skills/sidestory`](plugins/sidestory/skills/sidestory) into the agent's skills folder (`~/.codex/skills/sidestory` for Codex).
- **Any other agent:** **Sidestory: Copy a Prompt for Your Agent**.

Keep your team's guidance (tone, depth, diagram style) in `.sidestory/GUIDELINES.md`, a CLAUDE.md for sidestories: the skill and the copied prompts read it first.

A **checker** ships with the extension. Its findings show in the Problems panel when you save, and agents run it from a terminal (**Sidestory: Copy Widget Check Command** copies the exact command; `--pin` pins anchors, `--json` is for scripts). A repository can raise, lower or turn off its rules in `.sidestory/checks.json`; see [Checker rules](docs/GUIDE.md#checker-rules).

![A widget that imports an unavailable library: the checker's diagnostic for .sidestory/retry-backoff/widgets in the Problems panel, and the panel keeps running the last good version](media/marketplace/problems.png)

To write one by hand, see [Writing a sidestory](docs/GUIDE.md#writing-a-sidestory) and [WIDGETS.md](docs/WIDGETS.md).

## Explaining a branch

Add a `"base"` to a sidestory's manifest and its steps explain a branch's changes against that base. Browse the diff in the tool you already use ([Git Tree Compare](https://marketplace.visualstudio.com/items?itemName=letmaik.git-tree-compare) works best; GitLens and Source Control work too): badges show which changes have a step.

![Explaining a branch: as steps get written the changed files' badges go from not yet to partly to explained, tests and docs are marked trivial, and new code in an explained file gets a warning badge. This branch keeps the count](media/marketplace/branch-coverage.gif)

- **Open Changes with Base** in the editor title bar switches a step's file to the branch's diff.
- Right-click a change for **Copy Prompt: Explain This Change**, **Mark as Trivial…** or **Re-pin This Step**.
- **Sidestory: Next Unexplained Change** walks through what's left.
- **This branch** in the Sidestories view (turn on `sidestory.sidebar.thisBranch`) shows the totals and offers a prompt for your agent.
- In CI, `check.cjs --coverage` fails a pull request with unexplained changes; `"coverage": {"minimum": 90}` in `.sidestory/checks.json` lets it pass at 90%.

Details, including how the base is chosen: [Explaining a branch](docs/GUIDE.md#explaining-a-branch).

## Compare with another version

**Sidestory: Compare with…** (the button in the panel's title bar) opens another version of the sidestory beside it, read-only from git: your branch's base, the previous version, or any commit, branch or tag. The two panels move through the steps together, and VS Code's diff shows a step's code changes or the page source's.

## Comments, and Ask Claude

Comment on a step (<kbd>C</kbd> in the panel) or on code (<kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>C</kbd>, or right-click → **Comment on These Lines**). Threads stay on your machine until you **Share** one, which commits it with the sidestory.

**Ask Claude** (<kbd>A</kbd>) sends your comment to a running Claude Code session, and Claude replies in the thread. Install `/plugin install sidestory-comments@sidestory` and start Claude with the command **Sidestory: Copy Claude Command with Comments** copies. Where channels are blocked, ask Claude to watch for your comments instead. For Codex, Cursor and other MCP clients, use **Sidestory: Copy MCP Server Config**. See [Comments and Claude](docs/GUIDE.md#comments-and-claude).

## Safe by default

A page can't run script, reach the network or read files outside the repository, so it works in **Restricted Mode**. Widgets run only in a trusted workspace, with `sidestory.widgets.enabled` on, after you agree in a dialog that says what they can do; until then you see their static fallback. See [SECURITY.md](SECURITY.md).

![The consent dialog before widgets run: the code they can read, and that they may be able to reach the network](media/marketplace/consent-dialog.png)

## Commands

The ones you'll use most; all are in the Command Palette.

| Command | What it does |
|---|---|
| **Sidestory: Open Sidestory…** | Pick a sidestory and open it beside the code. |
| **Sidestory: Go to Step…** | Find any step by its title. |
| **Sidestory: Next Step** / **Previous Step** | Move through the page (<kbd>Alt</kbd>+<kbd>]</kbd> / <kbd>[</kbd>). |
| **Sidestory: Back** / **Forward** | Go back or forward in the panel's history. |
| **Sidestory: Show Sidestories for This Code** | List the pages that explain the code under the cursor. |
| **Sidestory: Copy a Prompt for Your Agent** | Copy a prompt that asks your agent to write a sidestory. |
| **Sidestory: Pin Anchors to the Current Code** | Record each section's code, so it can follow edits. |
| **Sidestory: Re-anchor Section to Selection** | Point a section at the selected code. |
| **Sidestory: Comment on These Lines** / **Ask Claude About These Lines** | Comment on, or ask Claude about, the selected lines or the cursor's line. |
| **Sidestory: Compare with…** | Open another version of the sidestory beside it. |
| **Sidestory: Set Base…** | Choose what a branch is compared with. |
| **Sidestory: Check Widgets** | Check the open page's widgets now. |
| **Sidestory: Revoke Widget Consent** | Forget that you agreed to run this workspace's widgets. |

## Settings

The ones people change most; the [guide](docs/GUIDE.md#settings) lists all of them.

| Setting | Default | |
|---|---|---|
| `sidestory.dimUnfocused` | `true` | Fade the rest of the file while you step through. |
| `sidestory.hoverPreview` | `editor` | What resting on a link shows: its code lit in the `editor`, a `card`, `both`, or `off`. |
| `sidestory.hoverReveal` | `false` | Also scroll the editor to the code while you hover. |
| `sidestory.clickHighlightSeconds` | `1.5` | How long code stays lit after you click a link (`0`: until the next one). |
| `sidestory.codeLens.enabled` | `true` | Show a CodeLens above explained code. |
| `sidestory.gutter.enabled` | `false` | Show a book icon in the gutter on explained code. |
| `sidestory.sidebar.thisBranch` | `false` | Show **This branch** in the Sidestories view. |
| `sidestory.changes.openStepsIn` | `"editor"` | Open a branch's steps in the file, or in the `"diff"`. |
| `sidestory.comments.defaultLocation` | `"local"` | Keep new threads `local` or `shared` (committed). |
| `sidestory.widgets.enabled` | `true` | Run widgets (each workspace still asks first; user settings only). |

## Learn more

- [Guide](docs/GUIDE.md): reading and writing sidestories, the manifest, diagrams, styling, checker rules, branches, comments, settings
- [Writing widgets](docs/WIDGETS.md): the widget contract, imports, theming, and a gallery
- [Security](SECURITY.md) · [Changelog](CHANGELOG.md) · [MIT License](LICENSE)
