# Code Explainer

Rich, free-form HTML explainers that sit beside your code in VS Code and stay linked to it both ways.

- **Step through the explainer** and the editor shows and highlights the code each section is about.
- **Move your cursor in the code** and the explainer jumps to the section about it.
- **Everything updates live.** Edit the code (saved or not) or the explainer and the panel follows at once, keeping your place, your focus and anything you're typing. Sections follow code that moves, and tell you when the code changed, needs a look, or can't be found.
- **Native to your theme**, including high contrast.
- **Works everywhere VS Code does:** locally, over Remote-SSH, WSL, Dev Containers, Codespaces and VS Code in the browser.
- **Safe with untrusted repositories**, so it runs in Restricted Mode. Explainer content can't run script, reach the network or read files outside the repository. See `SECURITY.md`.

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
| `color` | A theme color id, normally one of `charts.blue`, `charts.green`, `charts.yellow`, `charts.orange`, `charts.purple`, `charts.red`. Never a hex value: colors follow the user's theme. |

Then run **Code Explainer: Pin Anchors to the Current Code** to record each anchor's exact code and surrounding lines. That upgrades the manifest to `version: 2` with a `quote` per anchor, which is what lets an anchor survive edits, moves and duplicates. Re-run it after you change which lines a section covers.

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

### What's supported, and what's removed

Supported: HTML and CSS, inline `<style>`, stylesheets, images (SVG, PNG, JPEG, GIF, WebP, AVIF), fonts and videos from the explainer's own folder; inline SVG; tables; `<details>`; links.

Removed or ignored, for safety (see `SECURITY.md`):
- scripts of any kind, event handler attributes, `javascript:` links;
- `<iframe>`, `<object>`, `<embed>`, `<form>`, `<meta>`, `<base>`, popovers, SVG animation;
- anything from the network: remote images, fonts, stylesheets, `@import`;
- links to `localhost` or private addresses.

Limits: `explainer.html` up to 5 MB, `manifest.json` up to 1 MB, 500 anchors, each quote up to 2,000 lines, each asset up to 5 MB (20 MB per open explainer).

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
```

Press <kbd>F5</kbd> to open an Extension Development Host on `fixtures/sample-workspace`. Test plan for remote setups: `docs/TEST-PLAN.md`. Design notes (a draft that includes features not built yet): `docs/DESIGN.md`.
