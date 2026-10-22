# Prior art: Code Explainer

Researched 2026-10-21. Lens: the DESIGN.md brief, plus the hard requirement that **everything updates live** (no reloads, reopening or re-running, and scroll and focus are kept). Items marked *(unverified)* come only from secondary sources.

---

## 1. Code tours and doc-to-code linking

### CodeTour (Microsoft), the closest ancestor
- **Good:** `.tours/*.tour` JSON in the repo. Steps can be anchored to a file+line, a directory, a selection, or **a regex `pattern` instead of a line**, and `Record Mode` can default to pattern. A `ref` pins a tour to a branch, commit or tag; at a ref you don't have checked out, it replays files read-only. The status bar shows the tour and step, and clicking it re-opens the step. Ctrl/Cmd+←/→ moves between steps. Gutter markers show where tours exist. Step markdown supports `[#2]` step links, `[Tour#3]` cross-tour links, `command:` links, `>>` shell commands, and "Insert Code" on code blocks. There is a CI watcher (CodeTour Watch) that flags tours a PR breaks. Source: https://github.com/microsoft/codetour
- **Steal:** pattern anchors as a first-class resolver; step and explainer cross-links (`[#refill]`); `command:` links in explainers ("run this test"); a status-bar entry that "returns you to the current step"; a CI drift check on PRs; read-only replay at a pinned commit.
- **Avoid:** markdown inside the *comment widget* is a cramped canvas, with no diagrams and nothing visible beside the code. There is no drift *repair*, only detection. Steps are linear only, with no reverse link from code to step.

### Swimm: smart tokens and Auto-sync
- **Good:** docs embed "smart tokens" (identifiers) and "smart paths" stored with metadata in an invisible ("ghost") HTML tag, so the doc keeps its last-known text. Auto-sync weighs weak signals (line markers, token references, change size, git history), handles moves and 1:1 renames silently, and **marks a doc verified with no notification when the change is trivial**. Otherwise it creates a review task: *"We'd rather ask you to reselect a snippet than offer a strange suggestion."* CI checks are fast, and blocking merges is optional. Sources: https://swimm.io/blog/how-does-swimm-s-auto-sync-feature-work/, https://docs.swimm.io/changelog/release-1.0.0/
- **Steal:** (a) **inline token refs in prose** (`<code data-explain-token="cnt_q">`) that are validated and auto-renamed, not only section anchors; (b) a three-way outcome per anchor: *auto-healed silently*, *needs review*, *broken*; (c) store the last-known snippet text inside the doc, which we already do via `snippet`/`contentHash`; (d) an optional CI gate.
- **Avoid:** it requires full git history (it breaks on shallow clones, which matters for the GitHub Action, so use `fetch-depth: 0` or fall back to snippet search). The vendor admits its behavior is "not exhaustively predictable", so show users *why* an anchor moved.

### CodeSee (now part of GitKraken)
- Tours **alert when steps no longer apply**; it was a hosted SaaS, acquired and stalled, which backs "files over servers." https://codesee.io/interactive-code-tours

### Windsurf Codemaps (Cognition, Oct 2025) and DeepWiki
- **Good:** "just-in-time" maps generated from a *question*, nested sections each **linked to exact lines**, a "trace guide" per section explaining what connects the lines, a **text and diagram toggle**, clicking a node jumps to code, and maps can be `@{codemap}`-referenced back into agent prompts. They plan an open `.codemap` protocol. DeepWiki gives repo wikis with diagrams and source links. Sources: https://cognition.com/blog/codemaps, https://docs.devin.ai/work-with-devin/deepwiki
- **Steal:** **explainers as agent context**. Let users write `@explain:bit-reader#refill` in a Claude prompt (an MCP resource). Generate an explainer *from a question* ("how does refill interact with consume?"). Offer diagram and prose views of the same anchors.
- **Avoid:** a map is "a snapshot" with no freshness story. Our staleness model is the edge.

---

## 2. Side-by-side layouts: literate programming and docs

### Docco / Pycco / docco-next
- The original prose|code two-column layout, row-aligned per section, but bound to comment order. **Steal:** a "Docco-aligned" layout option in the web viewer for wide-screen PR review. https://www.boxuk.com/insight/literate-documentation-with-docco/

### VS Code Markdown preview (built-in two-way scroll sync)
- **Good:** the editor scrolls the preview and the preview scrolls the editor, with each direction toggleable (`markdown.preview.scrollPreviewWithEditor` / `scrollEditorWithPreview`). Double-click in the preview jumps to the source line. Sync is exact at block starts (via `data-line` source maps) and interpolates inside long blocks. Sources: https://vscode-docs1.readthedocs.io/en/latest/languages/markdown/, https://discourse.joplinapp.org/t/feature-request-better-synchronized-scrolling-in-desktop-app/3609
- **Steal:** **two independent toggles** (explainer→editor, editor→explainer); double-click a section to jump to its code; **interpolate between anchors** for smooth scroll-follow. Read `markdown-language-features` for the feedback-loop guard (it suppresses the echo scroll after a programmatic scroll).
- **Avoid:** scroll-position sync without semantic anchors drifts in long blocks. Anchor-based sync is ours.

### Mintlify, Fern ScrollWalkthrough, Redocly code walkthrough, Stripe-style docs
- **Good:** a column of prose steps beside a **pinned code panel**. Each step names a file and line range, and **other lines dim**. Redocly maps `chunk steps=[id]` in the code to step ids in the prose, so one chunk can serve many steps. It has file tabs, filters (e.g. language), and downloads. Sources: https://redocly.com/docs/realm/content/markdoc-tags/code-walkthrough/create-code-walkthrough, https://buildwithfern.com/learn/docs/writing-content/components/scroll-walkthrough
- **Steal:** the **many-to-many step↔chunk model** (an anchor can be cited by several sections); dim-the-rest (use a theme-colored decoration with opacity, and make it optional); an "authoring loop" where you write a step, set the chunk, and see the highlight live.

### Code Hike (scrollycoding, spotlight, focus, mark, callout)
- **Good:** layouts (Scrollycoding, Spotlight, Slideshow) plus code-level annotations written **as comments in the code block** (`// !focus`, `// !mark`, `// !callout`). It has **token transitions** (animated morph between code states), code mentions and links (hovering prose focuses lines), tooltip, diff, fold and collapse. The architecture is a remark/recma plugin that extracts annotations, then a `highlight()` step, then custom React components. Sources: https://codehike.org/docs, https://dev.to/fabianfrankwerner/code-hike-in-100-seconds-1d9o
- **Steal:** (a) **hover-to-focus**: hovering a `data-explain-ref` temporarily focuses those lines in the editor, and leaving restores them (a peek, no commitment); (b) an annotation vocabulary for the kit (focus, mark, callout, tooltip, fold) mapped onto **editor decorations** (`after` text for callouts, folding ranges for fold); (c) **token transitions** in the web viewer for before/after and diff explainers; (d) a "spotlight" layout where clicking a step swaps the code in place.
- **Avoid:** MDX and React-only, build-time. Our explainers are free HTML rendered live, so we copy the vocabulary, not the toolchain.

### Shiki Twoslash
- Runs the real TS language service at build time; `^?` renders static hovers and errors as pure HTML. **Steal:** the GitHub Action bakes LSP hover/definition data for anchored ranges into the web viewer. https://shiki.style/packages/twoslash

---

## 3. Scrollytelling and explorables

### The Pudding / Scrollama / NYT sticky graphic
- **Good:** IntersectionObserver, not scroll handlers. An `offset` trigger line (0.5 default; react-scrollama 0.3) decides the active step, a `progress` 0–1 callback fires within a step, and the graphic uses CSS `position: sticky` (v2 dropped JS stuck-state). v3 re-measures with ResizeObserver. Sources: https://pudding.cool/process/introducing-scrollama/, https://pudding.cool/process/scrollytelling-sticky/, https://npmjs.com/package/scrollama
- **Steal:** **IntersectionObserver with a trigger line at about 30–40% of viewport height** to choose the active section, plus **ResizeObserver** so live content edits re-measure without reflow bugs. Per-section progress can drive *within-anchor* line focus (e.g. walk through L35→L40 as you scroll). Make it configurable per explainer.
- **Avoid:** scroll-jacking, and step transitions that fire on every pixel. Debounce editor reveals (only reveal when the active anchor *changes*, using `revealRange(..., InCenterIfOutsideViewport)`).

### Bret Victor / Nicky Case explorables
- Reactive documents (change an input, the prose updates); teach mechanics in isolation, then combine. **Steal:** kit components with live parameters (a `W` slider re-renders the bit window); "start small, build big" as Claude's default outline. https://worrydream.com/ExplorableExplanations/, https://blog.ncase.me/explorable-explanations

### Distill.pub
- Hover-linked figures, margin notes. **Steal:** comment badges as **margin notes** to keep prose clean; remember per-user read/unread. https://idl.uw.edu/papers/comm-interactive-articles

### Observable / marimo (reactive) vs Jupyter (hidden state)
- **Good:** dataflow cells **update in place** when their dependencies change, with no "re-run all". Jupyter's out-of-order execution creates hidden-state drift. Sources: https://arxiv.org/html/2511.21994, https://www.refontelearning.com/blog/marimo-vs-jupyter-reactive-notebooks
- **Steal:** treat each `data-explain-anchor` section as a **reactive cell**. When `explainer.html` changes, diff by anchor id and patch only the changed sections, while state derived from code (staleness, highlights, badges) recomputes automatically. This is the model for the "fully dynamic" requirement.
- **Avoid:** the arXiv paper shows reactive guarantees break on shared mutable state. Keep explainer scripts out of global state, or the patch-in-place model breaks.

---

## 4. Live update mechanics (the hard requirement)

### VS Code Webview lifecycle
- Hidden webviews are **destroyed** unless `retainContextWhenHidden` (heavy) is set. `setState/getState` persists JSON across hide and restart, and `WebviewPanelSerializer` restores across reloads. **Messages can't be delivered to a hidden webview.** Source: https://www.mintlify.com/Microsoft/vscode/api/guides/webview, https://vscode-api.js.org/interfaces/vscode.WebviewPanelOptions.html
- **Do:** keep `{scrollAnchorId, offsetWithinAnchor, openThreads, followMode}` in `setState` on every scroll (throttled). Have the extension **queue messages while hidden and replay a state snapshot on `onDidChangeViewState`**. Register a serializer so a window reload restores the pane exactly. Store scroll by *anchor id and offset*, not pixels, so it survives content edits.

### DOM morphing (idiomorph / morphdom / htmx 4)
- Morphing patches existing nodes in place, so **focus, caret, scroll and DOM state survive**. Idiomorph matches nodes using id-sets across the subtree, which beats morphdom's sibling-id matching. Sources: https://github.com/bigskysoftware/idiomorph/, https://four.htmx.org/docs/morphing-swaps-guide
- **Do:** replace the brief's `explainerUpdated → page reloads its content` with **`explainerPatched` → idiomorph the section by anchor id**. Never touch the subtree containing the focused element (a reply box being typed in). Mark edited sections with a brief "updated by Claude" flash. This is the single most important implementation choice for the requirement.

---

## 5. Review UX

### GitHub PR review
- Since 2018 a conversation is marked outdated **only when its exact anchoring line changes**. Copilot code review writes summaries, and Workspace splits work into current spec → proposed spec → plan, with a "View references" button. Sources: https://github.blog/changelog/2018-09-25-precision-review-comment-outdating/, https://github.com/githubnext/copilot-workspace-user-manual/blob/main/overview.md
- **Steal:** staleness keyed to the *exact anchored lines* (hash only the anchored range), so edits nearby don't stale it. Use "current vs proposed" as a change-explainer template.

### Bitbucket / Phabricator / GitLab (comment drift)
- Bitbucket shifts comments by the net lines added above them, and marks them **"eclipsed"** when a later change overlaps, keeping them viewable against the original diff. Phabricator and GitLab users complain that threads vanish or become unfollowable across revisions. Sources: https://www.atlassian.com/blog/bitbucket/building-inline-comments-for-pull-requests-and-commits, https://secure.phabricator.com/T6876
- **Steal:** never hide a thread whose anchor broke. Show it **pinned to its last-known snippet** with "code changed since" and a mini-diff.

### Reviewable
- Per-participant **dispositions** (Discussing, Blocking, Working, Satisfied, Informing). A thread resolves automatically when someone is satisfied and nobody blocks. **Draft batching** publishes all drafts at once. "To reply" tracking and a red counter. Threads persist until explicitly resolved. Source: https://docs.reviewable.io/discussions
- **Steal:** a **"Working" disposition for Claude**. When Claude takes a thread it shows "Claude: working", flips to "Satisfied, edited section:refill" when done, and the human resolves. Add an "awaiting you" counter in the status bar.

### Graphite (Cursor-owned)
- AI reviewer and chat inside the PR page, plus an email-style inbox. **Steal:** a thread inbox TreeView (needs you / Claude working / resolved). https://graphite.com/docs/pr-page-overview

---

## 6. Agent narration and activity feeds

### Cline task timeline and checkpoints
- A **storyboard strip** of blocks (tool call, message, edit) in the task header, with hover for summary and time. A checkpoint after every tool use (a shadow git repo) offers compare and restore (task only, workspace only, or both). Sources: https://cline.bot/blog/cline-v3-15-unveiling-task-timeline-gemini-implicit-caching-new-community-docs, https://docs.cline.bot/features/checkpoints
- **Steal:** render `story.jsonl` as a **compact block strip** at the top of the pane; hover gives the summary, click focuses that entry's code. Story entries could carry a `checkpoint` (commit or stash ref) for "show diff since here".

### Devin
- A **Progress tab** unifies shell, edits and browser in one timeline. Commands link to progress updates, and **future steps appear greyed** in replay. Source: https://docs.devin.ai/work-with-devin/devin-session-tools
- **Steal:** a `plan` story entry renders as a checklist where upcoming items are greyed and turn active, then done, live. Clicking any past entry replays its focus.

### Zed (follow the agent)
- **Follow mode** tracks the agent's location as it navigates. Edits stream into buffers live, and the review is an editable multibuffer diff. Source: https://zed.dev/agentic, https://zed.dev/acp/editor/zed
- **Steal:** the "follow" metaphor and wording from Zed collaboration (follow a collaborator) applied to Claude, with the toggle on Claude's avatar chip. Use a **multi-range "what Claude touched" view** (a virtual document of all touched ranges) for end-of-task review.

### Cursor (plan mode, review panel), Copilot agent mode, JetBrains Junie
- Cursor: an editable Markdown plan, an interactive clarifying-questions UI, and a session-level Review panel. **Users revolted when per-change inline accept/reject was demoted**, and edits made via shell scripts don't appear in the inline review. Copilot agent mode shows every tool call transparently and has "Undo Last Edit". Junie asks multiple-choice questions before planning. Sources: https://cursor.com/changelog/2-1, https://forum.cursor.com/t/bring-back-per-change-apply-inline-diff-review-you-re-throwing-away-your-best-ux-advantage/160856, https://forum.cursor.com/t/agent-edits-made-via-the-terminal-script-shell-writes-dont-appear-in-the-inline-edit-review-ui/162348, https://code.visualstudio.com/blogs/2025/02/24/introducing-copilot-agent-mode, https://blog.jetbrains.com/junie/2026/06/junie-coding-agent-out-of-beta/
- **Steal:** when Claude asks a question in a thread (`thread_open`), allow **multiple-choice answer buttons** rendered inline. **Avoid:** narration that depends on the agent self-reporting. Detect touched files via file watchers too, so shell-written edits still appear (Cursor's gap).

---

## Top 15 ideas to adopt (ranked)

1. **Patch, never reload.** Use idiomorph to morph by `data-explain-anchor` id on every `explainer.html` change. Skip the subtree holding focus, and flash changed sections. Replace the `explainerUpdated` reload semantics. (idiomorph, Observable)
2. **Scroll state as `{anchorId, offset}`** in `setState`, plus a serializer, plus a queue-and-replay of messages while the webview is hidden. Reopening and reloading are invisible to the user. (VS Code webview docs)
3. **IntersectionObserver trigger line (~35% vh) plus ResizeObserver** for the active section, revealing the editor only when the active anchor *changes*, with an echo-suppression guard between the two scroll directions. (Scrollama, VS Code markdown preview)
4. **Two independent sync toggles** (explainer→code, code→explainer), plus double-click a section to jump. (VS Code markdown preview)
5. **Hover-to-peek:** hovering any `data-explain-ref` temporarily focuses lines in the editor and restores them on leave. Click commits. (Code Hike code mentions)
6. **Three-state anchor health:** auto-healed (silent, with a log of why), needs review, broken. Hash only the exact anchored range. (Swimm, GitHub 2018 outdating)
7. **Inline smart tokens** in prose (`data-explain-token`), validated and auto-renamed alongside section anchors. (Swimm)
8. **Never orphan threads:** a broken anchor shows the last-known snippet plus a mini-diff of "code changed since". (Bitbucket "eclipsed")
9. **Dispositions with Claude as "Working"**, auto-resolving when satisfied and not blocked, with an "awaiting you" counter. (Reviewable)
10. **Story strip with greyed future plan items**, click to replay focus, and file-watcher capture of edits Claude didn't narrate. (Cline, Devin, Cursor gap)
11. **Explainers as agent context:** an MCP resource `@explain:<name>#<anchor>` so humans can point Claude at a section. (Codemaps `@{codemap}`)
12. **Many-to-many anchors↔sections plus a dim-the-rest decoration** (theme opacity, optional). (Redocly, Fern)
13. **Annotation kit = Code Hike vocabulary mapped to decorations**: focus, mark, callout (`after` text), fold, tooltip (HoverProvider). Token transitions in the web viewer for diffs.
14. **PR web viewer extras:** a Docco-aligned layout option, plus **baked LSP hovers** (Twoslash-style) recorded by the GitHub Action, plus a CodeTour-Watch-style CI drift check.
15. **Pattern anchors and `command:` links** (run test, open waveform) from CodeTour, plus multiple-choice answer buttons on Claude's questions (Cursor, Junie).

## Top 5 pitfalls

1. **Reload-on-change.** Re-setting `webview.html` or full re-render loses scroll, focus, half-typed replies and diagram state. It violates the hard requirement. Messages to a hidden webview are dropped, so you must queue them.
2. **Scroll feedback loops and jitter.** Two-way sync without echo suppression and debounce ping-pongs. Revealing on every pixel thrashes the editor. Follow mode must never steal focus or the cursor while the user types.
3. **Silent wrong anchors.** A confident but wrong auto-heal is worse than "needs review". Shallow clones break history-based mapping (Swimm). Show the resolution source and fall back visibly.
4. **Vanishing or eclipsed threads** across revisions (Phabricator, GitLab complaints). Never hide; pin to the last-known snippet.
5. **Narration that lies by omission or overwhelms.** Self-reported story logs miss shell edits (Cursor). Whole-doc regeneration (Code Wiki style) clobbers human edits. Demoting fine-grained review controls causes user revolt (Cursor 2026 forum). Keep per-section, per-change granularity.
