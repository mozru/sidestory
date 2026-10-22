# Code Explainer

Rich, free-form HTML explainers that sit beside your code in VS Code and stay linked to it both ways:

- Move through the explainer and the editor shows and highlights the code each section is about.
- Move your cursor in the code and the explainer jumps to the section about it.
- Edit the code, the explainer, or both: everything updates live. Sections follow code that moves, and say so when the code changed or can't be found.

Explainers are plain files in your repo, under `.explain/<name>/`:

```
.explain/bit-reader/
  explainer.html   free-form HTML; sections declare what code they're about
  manifest.json    where that code is
```

```html
<section data-explain-anchor="refill">…anything…</section>
<a data-explain-ref="refill">the refill path</a>
```

Run **Code Explainer: Open Explainer** from the Command Palette.

## Development

```bash
npm install
npm run check          # typecheck, unit tests, build
npm run test:webview   # the explainer panel in a browser harness (needs: npx playwright install chromium)
npm run test:e2e       # real VS Code in a browser, server in Docker
```

Press F5 to open an Extension Development Host on `fixtures/sample-workspace`.
Design: `docs/DESIGN.md`. Test plan for remote setups: `docs/TEST-PLAN.md`.
