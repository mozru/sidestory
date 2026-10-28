# Changelog

## Unreleased

- Resting the pointer on a link or a diagram box now lights up its code in the editor instead of showing a snippet (`sidestory.hoverPreview` is `editor` by default; `card` brings the snippet back). The lines get a mark in the scrollbar, and when they're out of view a faint arrow at the editor's edge points at them; when no editor shows the file, a note by the link says so. Nothing opens, and focus, the cursor and the step stay put. New setting `sidestory.hoverReveal` (off by default; `hoverReveal` in a manifest's `highlight`) scrolls the editor to the lines while you hover, and back when you move on.

## 0.2.8 (2026-10-28)

- Back and forward in the panel, as in a browser: ← → buttons at the top, VS Code's own Go Back / Go Forward keys while the panel has focus (on macOS also <kbd>Cmd</kbd>+<kbd>[</kbd> / <kbd>]</kbd> and <kbd>Alt</kbd>+<kbd>←</kbd> / <kbd>→</kbd>), the mouse's back and forward buttons, and the new commands **Sidestory: Back** / **Forward**. With nowhere to go in the panel, the keys do VS Code's own navigation. The trail's way back now reads **Up to *Title***. They retrace the steps you chose, the details you dived into and the sidestories opened in the panel, to the same step and scroll position; a run of <kbd>J</kbd>/<kbd>K</kbd> steps counts once. The history survives the panel being hidden and VS Code restarting.
- VS Code's shortcuts (<kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>, <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>P</kbd>, <kbd>F1</kbd>…) now work while you're in the page or a widget; before, keys pressed there never reached VS Code.
- The Claude Code skill now lists what Sidestory supports (steps, code links and hover previews, diagrams that follow the steps, motion, script-free interactivity, widgets, editor highlighting and its `highlight` options, overviews and details, branch coverage, comments) instead of prescribing a writing style: Claude follows the style you ask for, or your repository's.
- A sidestory can set how it highlights code: `"highlight"` in its manifest (`dim`, `clickSeconds`, `clickFrame`, `hoverPreview`) changes the defaults of `sidestory.dimUnfocused`, `sidestory.clickHighlightSeconds`, `sidestory.clickFrame` and `sidestory.hoverPreview` for it, and `"dim"` on an anchor for one step. Your own settings always win; the checker warns about bad values.

## 0.2.7 (2026-10-28)

- < > buttons sit right beside the step picker that narrow panels show, and beside every dropdown in a widget (`Select`; `arrows={false}` leaves them out), to step through without opening the list.
- The Claude Code skill mirrors the code's hierarchy: an overview sidestory with one box per part, and a detail sidestory for each part big enough to need one.
- Rest the pointer on a link or a diagram box in a sidestory (or Tab to it) and a small card shows the first lines of its code, colored like the editor, without moving the editor, the cursor or focus. New setting `sidestory.hoverPreview`: `card` (the default), `editor` (mark the lines in an editor already showing the file instead), `both`, or `off`.
- Sidestories written by Claude are more visual: the skill now has each step lead with a figure and keep its prose to a short caption, with a table of which picture fits which kind of step. The copied prompts ask for the same.
- New setting `sidestory.clickHighlightSeconds`: how long the code stays highlighted after you click a code link or an inline reference (1.5 seconds by default; `0` keeps it until the next one). When it fades, a frame now stays around those lines until the next click (`sidestory.clickFrame`, on by default; the `sidestory.clickFrameBorder` color). Fixed: clicking a link to another file could leave the previous file's highlight on for good.

## 0.2.6 (2026-10-27)

- A shorter README with animated pictures of how a sidestory follows the code, what happens when the code changes, and how a branch's changes get explained.
- The guide has a new "Moving parts" section, and the Claude Code skill now lists what a page can do (diagrams that follow the steps, CSS and SVG animation, widgets…), so agents use motion where it helps.
- The comments plugin's instructions and tool descriptions are about half as long, so they take less of Claude's context.

## 0.2.5 (2026-10-27)

- The checker (`check.cjs`) now reports every anchor VS Code flags, not only those widgets read: code lost (`anchor-lost`) or out of date (`anchor-stale`) as warnings, and changed a little (`anchor-changed`) or not checked because its file can't be read (`anchor-unchecked`) as info, with the step, where the code was and is now, and the command that fixes it. `explained-stale` now gives the `--accept` command (`--pin` leaves such anchors alone), and `--yes-widgets-may-read` also goes with `--accept`.
- Large sidestories open and update faster in the panel: placing the comment badges no longer forces a layout per step (500 sections: opening about twice as fast, updates about three times).
- Fixed: a sidestory's drift badge in the Sidestories view could stay out of date after an edit to a file with more than 2,000 anchors across all sidestories.
- Less work while typing: editing a sidestory's prose no longer refreshes the Sidestories view, the CodeLenses and This File (only a change to its steps does), and a typing pause in a code file re-resolves the other visible files only when an anchor actually moved.
- Branches with thousands of changed files stay responsive: finding a file's change no longer scans the whole list, so the compare buttons and Explorer badges update quickly.
- Comment threads load faster (the record of which comments are yours is read once per read of a repository's threads). Fixed: in a thread whose latest comment to Claude was retracted, **Copy Prompt** marked that retracted comment as copied, though the prompt was about an earlier one; likewise, a reply from Claude through the comment tools that names no comment now answers the latest comment that wasn't retracted.
- The checker (`check.cjs`) no longer hangs on deeply nested pages: a selector such as `p div div div div div div div` against a widget inside 60 nested `<div>`s took about 35 seconds and now takes a millisecond. Large stylesheets and many widgets are checked faster too.
- Files moved without `git mv` are paired faster in working-tree coverage, in the extension and in `check.cjs --coverage`: large files that can't be renames of each other are ruled out without comparing them line by line. The pairs found are the same.
- The panel's script is about 70% smaller (614 KB → 176 KB), so sidestories open faster: the panel checks widget messages with zod's small build instead of the full library.
- While a comment waits for Claude's answer, the 2-second check for a missed reply now re-reads only that thread instead of every thread in the repository. Views that ask for threads at the same moment share one read.
- Branch coverage while you type re-reads only the file you are editing; the other changed files are no longer read, decoded and hashed again on every pause. Diffs and coverage share one cache of files read from git, and an unsaved file is checked against the merge-base once rather than on every refresh.
- Panels no longer wake up every second when no widget is on screen: the heartbeat and the extension's freeze watchdog run only while a widget is mounted and the panel is visible (they used to run for any open sidestory with widgets, hidden or scrolled away). A widget that freezes the panel is still caught, also one that hangs as soon as it mounts.
- `check.cjs --coverage` makes the same few git calls however many sidestories a change touches (it made several per sidestory folder: 69 instead of 12 for a change editing 12 of them), and finds manifest line numbers in one pass (a 3,000-anchor manifest took 0.6 s). A finding about an anchor whose id is also a manifest field (`base`, `title`, `quote`…) now points at the anchor, not the field.
- The committed file texts kept for widgets' code access are capped at about 32 million characters in all (they were capped at 500 files of up to 10 MB each).

## 0.2.4 (2026-10-26)

- SVG animation (`<animate>`, `<animateTransform>`, `<animateMotion>`, `<set>`) now plays in the panel. Animations that would change a link or other URL, an event handler, `style`, `class` or the panel's own attributes are still removed, and a `url()` in their values (or in SVG attributes such as `fill`, `filter`, `mask` and `cursor`) can only point at the sidestory's own folder, as in CSS. SVG animation pauses in sections far off screen and stops at about its first frame for readers who asked for less motion.

## 0.2.3 (2026-10-26)

- **Steps open the file itself, not the branch's diff.** A step in a file the branch added used to open a diff that colored the whole file green, hiding the step. Now steps open a plain editor by default, with their lines highlighted (a step about removed code opens a read-only view of the old file).
- **Open Changes with Base**, a compare button in the editor's title bar (and in the Command Palette), switches a file the branch modified or renamed to its diff against the base, at the same lines. The panel keeps following the cursor there, and later steps in that file stay in the diff. **Open File** in the diff's title bar switches back.
- **Steps stand out in diffs:** the step's lines get a purple tint and frame, a purple mark in the scrollbar and the step's number and title after its first line, so they show even in a file the branch added (all green) or among many changes. The colors are `sidestory.diffFocusBackground` and `sidestory.diffFocusBorder`; high contrast themes get the frame in their contrast border color.
- To open steps in the diff as before, set `sidestory.changes.openStepsIn` to `"diff"`.

## 0.2.2 (2026-10-24)

- **Code blocks use the grammars of your installed extensions.** A `<pre><code class="language-…">` block is colored with the same TextMate grammar the editor uses for that language: VS Code's built-in language extensions (about 70 languages, including Dockerfile, PHP, Ruby, Lua, Swift, PowerShell and LaTeX, which weren't colored before) and any language extension you installed (SystemVerilog, VHDL, TOML…). Languages are named as VS Code names them: an id, an alias or a file extension (`ts`, `py`, `sv`). Installing or removing an extension recolors open sidestories.
- The regex engine is VS Code's own Oniguruma, so grammars behave as in the editor (if it can't be found, a JavaScript engine is used and a few patterns may stay uncolored). Sidestory no longer ships grammars: the package is about 220 KB smaller (1.99 MB → 1.77 MB).
- Without a SystemVerilog, Verilog, VHDL or TOML extension installed, those blocks are now plain (they were colored by grammars Sidestory used to ship). The first `language-` class names the language: `class="language-foo language-python"` used to pick Python and is now plain. `language-h` is C++, as `.h` files are in VS Code.

## 0.2.1 (2026-10-24)

### Comments, and Ask Claude

- **Comment on a sidestory.** Press <kbd>C</kbd> in the panel to comment on the step you're reading, or select code and run **Sidestory: Comment on Selection** (also in the editor's context menu and from the gutter **+** on lines a step covers). Reply, edit, delete and resolve. Threads show in a **Comments** pane under the sidestory (<kbd>T</kbd>), as counts on the step chips, in VS Code's own comment widgets in the editor, and in a new **Comments** view in the Sidestory sidebar (*For you*, *Waiting for Claude*, *Open*, *Resolved*, *Elsewhere*). <kbd>N</kbd> / <kbd>Shift</kbd>+<kbd>N</kbd> jump to the next thread with something new for you.
- **Local by default.** New threads stay on your machine (`.sidestory/.local/`, which git ignores) and are never committed. **Share** moves a thread next to the sidestory so it is committed and teammates see it; **Make Local** moves it back. Shared threads never count as unexplained changes of a branch.
- **Ask Claude.** Press <kbd>A</kbd> (or **Ask Claude About Selection**) to send your comment to a Claude Code session you started with Sidestory's channel; Claude's answer appears in the thread. Choose **Answer only** or **Let Claude edit**. It needs the new `sidestory-comments` plugin (`/plugin install sidestory-comments@sidestory`) and Node 20 or later; **Sidestory: Copy Claude Command with Comments** copies the command that starts Claude Code with it. Without a session, **Copy Prompt** works with any agent; **Copy MCP Server Config** gives Codex, Cursor and other MCP clients the same comment tools, and `check.cjs threads` lists waiting comments for agents without MCP.
- Other people's comments reach Claude only when it reads them, labelled with who wrote them; only comments you send with Ask Claude are pushed to it. Details in SECURITY.md.
- New settings: `sidestory.comments.defaultLocation`, `sidestory.comments.authorName`, `sidestory.comments.ranges`, `sidestory.comments.stateDir` and `sidestory.claude.channelFlag`. See the guide's "Comments and Claude".

### Explain a branch

- **A sidestory can explain a branch.** Give it a `"base"` (`"base": "main"`) and its steps open the branch's diff against that base: added code highlighted on the right, removed code on the left (anchors with `"side": "base"`, manifest version 3). The cursor on either side moves the panel. The diff is against the merge-base, so work that landed on `main` after the branch started isn't in it.
- **See what's explained, in the tools you already use.** Sidestory has no file tree of its own for a branch: browse it with Git Tree Compare (recommended), GitLens or Source Control. Each changed file gets a small badge there and in the Explorer: `✓` every change explained, `–` all marked trivial, `◐` partly, `○` not yet, `!` code added inside a step since it was written. The tooltip says how much, and which step explains it.
- **This branch**, at the top of the Sidestories view, sums up the branch (`vs main · 9 explained · 3 trivial · 1 left`), and offers **Copy Prompt: Explain This Branch** for your agent when nothing explains it yet. A new **This File** view lists the steps that cover the file you're in and the changes in it still to explain.
- **Work through the changes:** **Next / Previous Unexplained Change** and **Next / Previous Changed File** (with keyboard shortcuts), and in the editor's context menu **Copy Prompt: Explain This Change**, **Mark as Trivial…** (asks why, and writes it into the sidestory) and **Re-pin This Step**. **Sidestory: Set Base…** picks the branch to compare with. Everything is read through VS Code's Git extension; the extension never runs git itself.
- **The checker counts coverage:** `check.cjs --coverage` lists every change of the branch as explained, trivial or left, and exits with 3 when something is left, so it can gate pull requests in CI (a recipe is in the guide). `--accept <anchor>` accepts code added inside a step once its prose covers it. It runs git hardened against hostile repositories.
- **Manifests get a stable `id`**, which `--pin` adds. Comment threads find their sidestory by it, so `--coverage` now reports an error when a branch changes a sidestory's `id` (`id-changed`) or drops it (`id-removed`); `--pin` puts back a dropped `id`, and `--new-id` turns the check off for a new sidestory that replaces a deleted one under the same name.
- The Claude Code skill explains the current branch by default, and updates an existing sidestory rather than starting over.
- New settings: `sidestory.changes.defaultBase`, `sidestory.changes.includeUncommitted`, `sidestory.changes.openStepsIn`, `sidestory.changes.suggestExplain` and `sidestory.changes.markUnexplained`.

## 0.2.0 (2026-10-24)

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
