# Code Explainer

Rich, free-form HTML explainers that sit beside your code in VS Code and stay linked to it both ways.

- **Step through the explainer** and the editor shows and highlights the code each section is about.
- **Move your cursor in the code** and the explainer jumps to the section about it.
- **Everything updates live.** Edit the code (saved or not) or the explainer and the panel follows at once, keeping your place, your focus and anything you're typing. Sections follow code that moves, and tell you when the code changed, needs a look, or can't be found.
- **Native to your theme**, including high contrast.
- **Works locally and remotely:** Remote-SSH, WSL, Dev Containers, Codespaces, and browser VS Code backed by a server (code-server, openvscode-server, `code tunnel`). Not on vscode.dev or github.dev alone, which have no server to run it.
- **Safe with untrusted repositories**, so it runs in Restricted Mode. Explainer content can't run script, reach the network or read files outside the repository. See `SECURITY.md`.
- **Interactive widgets** (opt-in): live charts, simulations and diagrams written as React components, run in sandboxed frames only after you agree.

Open one with **Code Explainer: Open Explainer** from the Command Palette, or right-click a folder under `.explain/` in the Explorer. Step with the arrow buttons, <kbd>J</kbd>/<kbd>K</kbd> in the panel, or <kbd>Alt</kbd>+<kbd>]</kbd> / <kbd>Alt</kbd>+<kbd>[</kbd> anywhere.

## Writing an explainer

An explainer is a folder in your repository:

```
.explain/
  bit-reader/
    explainer.html   the page: any HTML and CSS
    manifest.json    which code each section is about
    assets/          optional: images, fonts, stylesheets
```

Open it with **Code Explainer: Open Explainer**.

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
| `file` | Path from the folder that contains `.explain/`, with `/` separators. |
| `range` | First and last line (1-based). A hint: the anchor follows the code as it moves. |
| `highlight` | Identifiers to mark everywhere in the file while the section is active. |
| `summary` | Top level, optional: one line shown when a parent explainer peeks at this one. |
| `color` | A theme color id, normally one of `charts.blue`, `charts.green`, `charts.yellow`, `charts.orange`, `charts.purple`, `charts.red`. Never a hex value: colors follow the user's theme. |

Then run **Code Explainer: Pin Anchors to the Current Code** to record each anchor's exact code and surrounding lines. That upgrades the manifest to `version: 2` with a `quote` per anchor, which is what lets an anchor survive edits, moves and duplicates. Until then a section is just a line range and can't tell when its code changes; the panel says so once per explainer. Pin edits only the anchors it pins and keeps the rest of `manifest.json` as you wrote it. It pins what the editors show, unsaved changes included, and says when it did.

Pin only pins anchors whose code it finds with confidence. It names each anchor it left alone and why (code changed, out of date, code not found, ambiguous, file missing), then lists the ones it could still pin: where the code is now, and the lines their `range` gives. Tick the ones whose code you changed on purpose to pin them there.

To point a section at different code:

- select the code and run **Code Explainer: Re-anchor Section to Selection** (also in the editor's context menu while an explainer is open), then pick the section; sections whose code is lost or out of date are listed first. The selection may be in another file of the same repository; or
- edit its `range` in the manifest and run Pin: when the recorded code can't be found with confidence, Pin offers the lines `range` gives. (If the recorded code is still there unchanged, Pin follows it instead; use Re-anchor.)

### Big systems: an overview with details

One explainer per piece, plus an overview that ties them together. In the overview, mark where a piece comes up with the name of its explainer (a sibling folder in `.explain/`):

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
- **Dive**: "Dive into *Title*" shows the detail explainer in the same panel. A trail at the top shows the way back; **Back**, a trail entry or <kbd>Esc</kbd> returns to the step you left.

Details can have details of their own (up to 16 levels). Give each explainer a one-line `summary` in its manifest for the peek. When the editor cursor is in code a detail covers but the explainer you're reading doesn't, the panel offers to dive into it.

### How sections follow the code

| State | Meaning | Shown as |
|---|---|---|
| exact / moved | The code is there, unchanged (it may have moved). | Normal |
| changed | Found, slightly edited. The text is probably still right. | "Code changed" badge |
| stale | Found roughly, but changed a lot. The text may be wrong. | Dashed outline, "Out of date" |
| lost | Can't be found. | "Code not found" |

This works on unsaved edits too, as you type.

### Styling

Use VS Code's theme variables so your explainer looks right in every theme:
`var(--vscode-editor-foreground)`, `var(--vscode-descriptionForeground)`, `var(--vscode-panel-border)`, `var(--vscode-editor-font-family)`, `var(--vscode-textLink-foreground)`, `var(--vscode-charts-blue)` and so on.

The built-in styles are light: body text in the editor font and colors, code blocks and tables that scroll sideways when wide, images no wider than the panel, and an outline on the current section. Nothing else is clipped, so your tooltips and pop-outs can overflow their boxes.

Interactivity without script works well, and readers keep what they set while you edit:
- **Steppers, tabs and switches** built from radio buttons and checkboxes with `:checked ~ …` or `:has(:checked)` rules. A switch the reader flipped stays flipped when you edit another part of the explainer; changing that control's own `checked` in the source resets it.
- **Pop-outs and footnotes** with `:target`: in-page links (`<a href="#id">`) set the target as in a browser.
- **`<details>`** for asides and quizzes, **hover and focus** effects (`:hover`, `:focus-within`, `:has(...)`), **CSS animation** and `@container` queries. Animations in sections far off screen pause until the reader gets there; honour `prefers-reduced-motion` for readers who ask for less motion.

### What's supported, and what's removed

Supported: HTML and CSS, inline `<style>`, stylesheets, images (SVG, PNG, JPEG, GIF, WebP, AVIF), fonts and videos from the explainer's own folder; inline SVG; tables; `<details>`; form controls (inputs, labels, selects) for CSS-driven interactivity; links.

Removed or ignored, for safety (see `SECURITY.md`):
- scripts of any kind, event handler attributes, `javascript:` links;
- `<iframe>`, `<object>`, `<embed>`, `<form>`, `<meta>`, `<base>`, popovers, SVG animation;
- anything from the network: remote images, fonts, stylesheets, `@import`;
- links to `localhost` or private addresses.

Limits: `explainer.html` up to 5 MB, `manifest.json` up to 1 MB, 500 anchors, each quote up to 2,000 lines, each asset up to 5 MB (20 MB per open explainer).

### Interactive widgets

For what CSS can't do (a chart that responds to a control, a simulation that runs, a table parsed from the real code), an explainer can hold **widgets**: React components written the way Claude writes artifacts, with Tailwind, shadcn/ui-style components, Recharts, D3, Motion, lucide-react and lodash. Each runs in its own sandboxed frame in the panel; the prose stays plain HTML. A widget knows the current step, can read the code its explainer points at, highlights lines in the editor, and shows code when clicked.

Place one in `explainer.html` with a fallback for readers who don't run widgets, and put the component next to it:

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
// .explain/bit-reader/widgets/refill.tsx
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

**Running widgets is your choice.** Widgets are code from the repository, so they run only when the workspace is trusted, `codeExplainer.widgets.enabled` is on in your user settings (a repository's settings can't turn it on), and you agree: the panel says how many widgets an explainer has and offers **Run widgets…**, which opens a VS Code dialog saying what they can do. Until then, and in Restricted Mode, you see the fallbacks. You're asked again when widget code arrives through git (checkout, pull, merge), not after your own edits. **Code Explainer: Revoke Widget Consent** takes it back. What widgets can and can't reach is in `SECURITY.md`.

**Writing them:** `docs/WIDGETS.md` is the guide (also for Claude): the contract, imports, theming, linking to code, placement, focus, state, performance, and a gallery. Problems show in the Problems panel as you save; **Code Explainer: Check Widgets** checks on demand, and a standalone checker ships with the extension for Claude Code and scripts (`node <extension>/dist/check.cjs .explain/<name>`; the guide has the exact command). **Code Explainer: Add Widget Types** adds type declarations so `tsc` and IntelliSense work on widget files without installing anything.

### Settings

| Setting | Default | |
|---|---|---|
| `codeExplainer.dimUnfocused` | `true` | Fade the rest of the file while you step through the explainer (never in high contrast themes). |

### Troubleshooting

**View › Output › Code Explainer** shows why a file was refused (missing, outside the repository after following links, too large) and other problems. Files that aren't open in an editor are read as UTF-8.

## Development

```bash
npm ci
npm run check          # typecheck, unit tests, build
npm run test:webview   # the panel in Chromium (first: npx playwright install chromium)
npm run test:e2e       # browser VS Code with the server in Docker
npm run package        # dist/code-explainer.vsix
node dist/check.cjs fixtures/sample-workspace/.explain/bit-reader   # the standalone widget checker (after a build)
node scripts/widget-types.ts           # regenerate src/widget-types/*.d.ts after updating a widget library
```

Press <kbd>F5</kbd> to open an Extension Development Host on `fixtures/sample-workspace`. Test plan for remote setups: `docs/TEST-PLAN.md`. Design notes (a draft that includes features not built yet): `docs/DESIGN.md`.
