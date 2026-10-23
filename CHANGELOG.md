# Changelog

## Unreleased

- **Explainers are now sidestories.** The folder is `.sidestory/<name>/` (was `.explain/<name>/`) and the page is `sidestory.html` (was `explainer.html`); rename both in your repository. Commands, settings, messages and the checker say "sidestory", and **Open Explainer** is now **Open Sidestory…**. The panel's tab shows the sidestory's title with the Sidestory icon. The HTML format is unchanged: `data-explain-*`, `<explain-widget>` and `import … from 'explainer'` stay as they are. Widgets ask for consent once more after the move.
- The checker's `--json` report names the folder `sidestory` (was `explainer`), and its `not-in-explain` warning is now `not-in-sidestory`.
- Code blocks (`<pre><code class="language-…">`) are colored in your VS Code theme, for 27 languages.
- A second example, `examples/tiny-lsm`: a log-structured merge-tree key-value store in Python, with seven sidestories and three widgets.
- A Claude Code plugin with a skill that writes sidestories: `/plugin marketplace add mozru/sidestory`, then `/plugin install sidestory@sidestory`.
- Fixes: a sidestory copied into a workspace where widgets were once allowed asks before running its widgets; Next Step pressed while a sidestory is still rendering is applied once it has; restored editor state no longer snaps the panel back to an earlier step; a resize keeps the step you chose in view.

## 0.1.0 (unreleased)

First release.

- Free-form HTML sidestories beside the editor, linked to the code both ways: move through the sidestory and the editor shows and highlights the code; move the cursor and the sidestory follows.
- Big systems: an overview sidestory can point to detail sidestories, which readers skip, peek at in place, or dive into and come back from, with a trail showing where they are.
- Readers keep their place in interactive sidestories: switches, tabs, open `<details>` and typed text survive edits to the sidestory. CSS `:target` works.
- Pin Anchors says why it left an anchor alone and lets you accept intended code changes; **Re-anchor Section to Selection** (also a button on sections whose code is lost or out of date) points a section at new code. Pin keeps the manifest's formatting.
- Live: edits to the code (saved or not) and to the sidestory appear immediately, keeping your place, focus and anything you're typing.
- Sections follow code that moves, and say when it changed, needs a look, or can't be found.
- Theme-native: colors, fonts and high-contrast support come from your VS Code theme.
- Works in Restricted Mode, over Remote-SSH, WSL, Dev Containers, Codespaces and browser VS Code.
- Safe with untrusted repositories: sidestory content can't run script, reach the network, read files outside the repository, or cover the panel's controls (see SECURITY.md).
- Interactive widgets (opt-in): React components in a sidestory, written like Claude artifacts (Tailwind, shadcn/ui-style components, Recharts, D3, Motion, lucide-react, lodash), each in a sandboxed frame. They follow the steps, read the code their sidestory points at, highlight lines, and reveal code when clicked; what the reader sets is kept. They run only in trusted workspaces, with `sidestory.widgets.enabled` on, after you agree in a VS Code dialog, and readers without them see each widget's fallback. Guide: `docs/WIDGETS.md`; boundary and accepted risks: `SECURITY.md`.
- Widget checking without running anything: diagnostics in the Problems panel, **Check Widgets**, and a standalone checker for Claude Code and scripts (`node dist/check.cjs <sidestory-dir> [--json] [--types] [--pin]`), which can also pin anchors from the files on disk (asking before it pins code that widgets read). **Add Widget Types** adds declarations for `tsc` and IntelliSense.
