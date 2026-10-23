<!-- Copied from docs/ by scripts/sync-skill.mjs; edit the original. -->
# Sidestory guide

The full reference for writing and reading sidestories. For a quick tour, see the [README](https://github.com/mozru/sidestory/blob/main/README.md); for widgets, [WIDGETS.md](WIDGETS.md); for the security model, [SECURITY.md](https://github.com/mozru/sidestory/blob/main/SECURITY.md).

## Contents

- [Where it runs](#where-it-runs)
- [Reading a sidestory](#reading-a-sidestory)
- [Writing a sidestory](#writing-a-sidestory)
  - [Link sections to code](#link-sections-to-code)
  - [The manifest](#the-manifest)
  - [Big systems: an overview with details](#big-systems-an-overview-with-details)
  - [How sections follow the code](#how-sections-follow-the-code)
  - [Styling](#styling)
  - [What's supported, and what's removed](#whats-supported-and-whats-removed)
  - [Interactive widgets](#interactive-widgets)
- [Settings](#settings)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Where it runs

- **Locally and remotely:** Remote-SSH, WSL, Dev Containers, Codespaces, and browser VS Code backed by a server (code-server, openvscode-server, `code tunnel`). Not on vscode.dev or github.dev alone, which have no server to run it.
- **In Restricted Mode.** Sidestory content can't run script, reach the network or read files outside the repository, so untrusted repositories are safe to read. Widgets never run there. See [SECURITY.md](https://github.com/mozru/sidestory/blob/main/SECURITY.md).
- **In every theme**, including high contrast: colors, fonts and focus come from your VS Code theme.

![The stream DMA overview's block diagram in the Default Light Modern theme](https://github.com/mozru/sidestory/raw/main/media/marketplace/block-diagram-light.png)

## Reading a sidestory

Open one with **Sidestory: Open Sidestory** from the Command Palette, or right-click a folder under `.sidestory/` in the Explorer.

- **Step through the sidestory** and the editor shows and highlights the code each section is about. Step with the arrow buttons, <kbd>J</kbd>/<kbd>K</kbd> in the panel, or <kbd>Alt</kbd>+<kbd>]</kbd> / <kbd>Alt</kbd>+<kbd>[</kbd> anywhere.
- **Move your cursor in the code** and the sidestory jumps to the section about it.
- **Everything updates live.** Edit the code (saved or not) or the sidestory and the panel follows at once, keeping your place, your focus and anything you're typing. Sections follow code that moves, and tell you when the code changed, needs a look, or can't be found.

## Writing a sidestory

A sidestory is a folder in your repository:

```
.sidestory/
  bit-reader/
    sidestory.html   the page: any HTML and CSS
    manifest.json    which code each section is about
    assets/          optional: images, fonts, stylesheets
```

Open it with **Sidestory: Open Sidestory**.

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
| `highlight` | Identifiers to mark everywhere in the file while the section is active. |
| `summary` | Top level, optional: one line shown when a parent sidestory peeks at this one. |
| `color` | A theme color id, normally one of `charts.blue`, `charts.green`, `charts.yellow`, `charts.orange`, `charts.purple`, `charts.red`. Never a hex value: colors follow the user's theme. |

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
- **Dive**: "Dive into *Title*" shows the detail sidestory in the same panel. A trail at the top shows the way back; **Back**, a trail entry or <kbd>Esc</kbd> returns to the step you left.

Details can have details of their own (up to 16 levels). Give each sidestory a one-line `summary` in its manifest for the peek. When the editor cursor is in code a detail covers but the sidestory you're reading doesn't, the panel offers to dive into it.

Two complete examples in this repository work this way: [`examples/stream-dma`](https://github.com/mozru/sidestory/blob/main/examples/stream-dma), a DMA engine in SystemVerilog, and [`examples/tiny-lsm`](https://github.com/mozru/sidestory/blob/main/examples/tiny-lsm), a log-structured merge-tree key-value store in Python, each with an overview, a sidestory per component, block diagrams and widgets.

### How sections follow the code

| State | Meaning | Shown as |
|---|---|---|
| exact / moved | The code is there, unchanged (it may have moved). | Normal |
| changed | Found, slightly edited. The text is probably still right. | "Code changed" badge |
| stale | Found roughly, but changed a lot. The text may be wrong. | Dashed outline, "Out of date" |
| lost | Can't be found. | "Code not found" |

This works on unsaved edits too, as you type.

### Styling

Use VS Code's theme variables so your sidestory looks right in every theme:
`var(--vscode-editor-foreground)`, `var(--vscode-descriptionForeground)`, `var(--vscode-panel-border)`, `var(--vscode-editor-font-family)`, `var(--vscode-textLink-foreground)`, `var(--vscode-charts-blue)` and so on.

The built-in styles are light: body text in the editor font and colors, code blocks and tables that scroll sideways when wide, images no wider than the panel, and an outline on the current section. Nothing else is clipped, so your tooltips and pop-outs can overflow their boxes.

Interactivity without script works well, and readers keep what they set while you edit:
- **Steppers, tabs and switches** built from radio buttons and checkboxes with `:checked ~ …` or `:has(:checked)` rules. A switch the reader flipped stays flipped when you edit another part of the sidestory; changing that control's own `checked` in the source resets it.
- **Pop-outs and footnotes** with `:target`: in-page links (`<a href="#id">`) set the target as in a browser.
- **`<details>`** for asides and quizzes, **hover and focus** effects (`:hover`, `:focus-within`, `:has(...)`), **CSS animation** and `@container` queries. Animations in sections far off screen pause until the reader gets there; honour `prefers-reduced-motion` for readers who ask for less motion.

#### Code blocks

Mark a code block's language with a class, as in Markdown renderers:

```html
<pre><code class="language-python">def area(r):
    return 3.14159 * r * r</code></pre>
```

It's colored like the editor beside it, in the reader's own color theme (light, dark or high contrast, including their `editor.tokenColorCustomizations`), and recolored when they switch themes. Write the code as plain text (escape `<` and `&` as `&lt;` and `&amp;`); a block with markup inside its `<code>` (a `<mark>`, say) is left exactly as written. The class may be on the `<pre>` instead, and `lang-x` works too.

| Language | Class names |
|---|---|
| TypeScript, TSX | `ts`, `typescript`, `mts`, `cts`, `tsx` |
| JavaScript, JSX | `js`, `javascript`, `mjs`, `cjs`, `jsx` |
| Python | `py`, `python`, `python3` |
| C, C++ | `c`, `h`, `cpp`, `c++`, `cc`, `cxx`, `hpp`, `hh` |
| Rust, Go, Java, C# | `rs`, `rust`, `go`, `golang`, `java`, `cs`, `csharp`, `c#` |
| SystemVerilog, Verilog, VHDL | `sv`, `systemverilog`, `svh`, `v`, `verilog`, `vhdl`, `vhd` |
| JSON, YAML, TOML | `json`, `jsonc`, `json5`, `yaml`, `yml`, `toml` |
| Shell, SQL | `sh`, `bash`, `shell`, `zsh`, `console`, `sql` |
| HTML, CSS, Markdown, diff | `html`, `htm`, `css`, `md`, `markdown`, `diff`, `patch` |

Other languages stay plain monospace, as do blocks over 2,000 lines or 100,000 characters (and single lines over 2,000 characters). Colors are the editor's without semantic highlighting. In a remote window (SSH, WSL, containers), a color theme installed only on your own machine may not be readable; code blocks then use VS Code's default theme of the same kind.

### What's supported, and what's removed

Supported: HTML and CSS, inline `<style>`, stylesheets, images (SVG, PNG, JPEG, GIF, WebP, AVIF), fonts and videos from the sidestory's own folder; inline SVG; tables; `<details>`; form controls (inputs, labels, selects) for CSS-driven interactivity; links.

Removed or ignored, for safety (see [SECURITY.md](https://github.com/mozru/sidestory/blob/main/SECURITY.md)):
- scripts of any kind, event handler attributes, `javascript:` links;
- `<iframe>`, `<object>`, `<embed>`, `<form>`, `<meta>`, `<base>`, popovers, SVG animation;
- anything from the network: remote images, fonts, stylesheets, `@import`;
- links to `localhost` or private addresses.

Limits: `sidestory.html` up to 5 MB, `manifest.json` up to 1 MB, 500 anchors, each quote up to 2,000 lines, each asset up to 5 MB (20 MB per open sidestory).

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

## Settings

| Setting | Default | |
|---|---|---|
| `sidestory.dimUnfocused` | `true` | Fade the rest of the file while you step through the sidestory (never in high contrast themes). |
| `sidestory.widgets.enabled` | `true` | Run interactive widgets (each workspace still asks first). Application scope: only your user settings count. In browser VS Code (code-server, openvscode-server), set it in the **User** tab of the Settings editor, which lives in the browser; the server's (Remote) settings file doesn't apply. |

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
