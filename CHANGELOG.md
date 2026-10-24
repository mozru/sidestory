# Changelog

## Unreleased

The first release on the Marketplace.

### New in this release

- **Code links that work, and diagrams lit from the cursor.** `data-explain-code` links open their target: `#L10-L20`, or in SystemVerilog and Verilog a name (`#state_q`, `#u_fifo`), what drives a signal (`#driver(state_q)`), one arm of its `case` (`#driver(state_d).case(IDLE)`) or one port connection (`#u_ctrl(.start)`), found by a built-in scanner; other languages use VS Code's outline. With the editor cursor in a box's code, the box gets a ring, the tightest one winning; steps follow the cursor only through sections now, so an anchor used only by links no longer takes the step. New setting `sidestory.followCursorInDiagrams`.
- The checker reports page ids missing from the manifest and manifest anchors nothing uses, links inside `role="img"`, unnamed links, empty diagrams, and every code link it can't resolve, with what to link instead.
- On macOS, Next Step and Previous Step are <kbd>Ctrl</kbd>+<kbd>Option</kbd>+<kbd>]</kbd> / <kbd>[</kbd>: <kbd>Option</kbd>+<kbd>]</kbd> and <kbd>Option</kbd>+<kbd>[</kbd> type ‘ and “, which the old keys swallowed while a panel was open.
- Opening a sidestory with no editor open shows its first step's code at once.

- **Find your way in big repositories.** A **Sidestories** view in its own activity bar container lists every sidestory by package (each `.sidestory/` folder), group and overview, with **Start here**, a filter, and badges for code that changed. A **CodeLens** above explained code names the sidestory and step, and the status bar names the one for the cursor's line. **Go to Step…** finds any step by its title; **Open Sidestory…** lists recently opened sidestories first and opens a detail with its overview on the trail. Panels opened from these reuse a preview panel instead of piling up. New manifest fields `group` and `top`; new settings `sidestory.codeLens.enabled`, `statusBar.enabled`, `gutter.enabled` and `sidebar.followPanel`.
- The checker reports `group`, `unknown-detail` and `detail-self`, its `--json` report adds each sidestory's `title`, `group`, `steps` and `details`, and its HTML scanner is linear on any input.
- The extension starts with a small bootstrap in every workspace and loads the rest only once a workspace has sidestories or you run a command.
- **Explainers are now sidestories.** The folder is `.sidestory/<name>/` (was `.explain/<name>/`) and the page is `sidestory.html` (was `explainer.html`); rename both in your repository. Commands, settings, messages and the checker say "sidestory", and **Open Explainer** is now **Open Sidestory…**. The panel's tab shows the sidestory's title with the Sidestory icon. The HTML format is unchanged: `data-explain-*`, `<explain-widget>` and `import … from 'explainer'` stay as they are. Widgets ask for consent once more after the move.
- The checker's `--json` report names the folder `sidestory` (was `explainer`), and its `not-in-explain` warning is now `not-in-sidestory`.
- Code blocks (`<pre><code class="language-…">`) are colored in your VS Code theme, for 23 languages.
- A second example, `examples/tiny-lsm`: a log-structured merge-tree key-value store in Python, with seven sidestories and three widgets.
- A Claude Code plugin with a skill that writes sidestories: `/plugin marketplace add mozru/sidestory`, then `/plugin install sidestory@sidestory`.
- Fixes: a sidestory copied into a workspace where widgets were once allowed asks before running its widgets; Next Step pressed while a sidestory is still rendering is applied once it has; restored editor state no longer snaps the panel back to an earlier step; a resize keeps the step you chose in view.

### The basics

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
