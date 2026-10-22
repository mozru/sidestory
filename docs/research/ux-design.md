# Code Explainer: UX / UI spec

Companion to `docs/DESIGN.md`. Written 2026-10-21. Opinionated; argue with it in a PR.

**Prime directive: nothing ever requires a reload.** Code edits, explainer edits (Claude or human), comments, narration and staleness stream into a pane that keeps your scroll position, focus, half-typed text and active step. Every design choice below is checked against that.

Sources drawn on: the VS Code webview UX guidelines, Code Hike scrollycoding, IntersectionObserver stepping, chat scroll-anchoring patterns ("follow the edge only when at it", pills), and agent activity feeds.

---

## 0. Live-update architecture (the foundation)

Replace `explainerUpdated → page reloads` with **section-level patches**.

| Extension → Webview | Payload | Notes |
|---|---|---|
| `explainerPatch` | `{rev, sections:[{id, html, hash, by, changedBlocks?}], order, removed}` | Only sections whose normalized-HTML hash changed. `by` = `claude` / `human` / `external`. |
| `codeChanged` | `{anchorIds, state}` | `state`: `moved` / `editing` / `stale` / `missing` / `fresh`. |
| `threadEvent` | `{threadId, anchorId, event}` | One appended JSONL line, not "refresh threads". |
| `story` | `{entry, seq}` | As DESIGN §5.2. |
| `syncTo` | `{anchorId, origin, epoch}` | Cursor/follow driven. |

**Patch pipeline in the webview**

1. Split the explainer into a keyed list of top-level `[data-explain-anchor]` sections (unanchored prose between them becomes implicit keyed blocks `__gap-N`).
2. Coalesce patches per animation frame. Apply with a DOM morph (idiomorph-style, keyed by `id` / `data-explain-anchor`), never `innerHTML` on the whole document.
3. **Scroll preservation (manual, deterministic):** set `overflow-anchor: none` on the scroller; before patching, pick the *reading anchor* (first block element crossing the reading line, §3.1), record its viewport offset; after patching, correct `scrollTop` by the delta. If that element was removed, fall back to its section's top.
4. **Protected subtrees** are never morphed: anything containing `document.activeElement`, an active text selection, an open composer, or an expanded `<details>` the user toggled (we preserve toggle state by key). If a patch targets a protected section, stage it and show an inline "Update ready · Apply" bar in that section; auto-apply on blur/selection clear (or after 20 s idle).
5. **Our chrome lives outside author HTML.** Composers, thread cards, badges and banners are injected into per-section slots (`<ce-section-chrome>` siblings) owned by us, so author-HTML morphs can't touch a half-typed comment.
6. After each patch, dispatch `explain:patched {ids}` so kit components/diagrams re-init only what changed.
7. **Attribution.** MCP writes record `{section, by:"claude", at}` (in `story.jsonl` `done.links`, or a small `.explain/<name>/edits.jsonl` written by the MCP server). Unattributed file changes while `explainer.html` is dirty in an editor are `human`; else `external`.
8. **Human editing explainer.html in VS Code** gets live preview: patch on `onDidChangeTextDocument`, debounced 250 ms, no save needed. The active section follows the cursor in the HTML source (it's just another anchor resolver).

---

## 1. Explainer pane

### 1.1 Anatomy (top → bottom)

1. **Header (sticky, 32 px)**: title (ellipsized), **linked chip**, **follow toggle**, overflow `…` (open source HTML, copy link, settings). Native view-title actions duplicate these (guideline: actions in the toolbar *and* the view).
2. **Step navigator**: the "rail" (§1.2).
3. **Article**: author HTML, max line length ~72ch, centered.
4. **Story strip (sticky bottom)**: Claude's narration (§1.6).
5. **Pills layer**: floating above the story strip: "↓ 2 new replies", "Cursor in Step 4 →", "Claude is at L35–40 →".

### 1.2 Navigator: rail, not stepper

Explainers are free-form and uneven; a Prev/Next stepper hides structure and lies about length. Use a **rail**: a vertical outline whose items double as a minimap.

- Each item: step number in a `charts.*` color dot, title, and state glyphs on the right (`$(warning)` stale, `$(circle-filled)` small blue updated, `$(comment-discussion) 2`, `$(check)` visited).
- Item heights are proportional to section length (min 20 px), so the rail *is* a minimap; a translucent "viewport" thumb shows what's on screen.
- Prev/Next arrows and "3 / 5" stay in the header for presentation-style reading, but they are secondary.
- Hovering an item previews the code range in the editor (decoration only, no scroll) after 300 ms; click = navigate.

### 1.3 Widths (pane is 300–1000 px)

| Width | Layout |
|---|---|
| **< 420 px (narrow)** | Rail collapses to a header **step picker**: `● 3/5 Handshakes ▾` plus a 3 px segmented progress bar (segments colored by state). Section action bar goes into a `…` menu. Story strip = one line. Code blocks scroll horizontally; tables become stacked cards when the kit is used. |
| **420–720 px** | Segmented progress bar under the header (click a segment = jump; hover = title tooltip). Rail available as a toggle overlay (`o`). |
| **≥ 720 px (wide)** | Sticky left rail (180–220 px) + article. |
| **≥ 960 px** | Same, plus article max-width so lines don't run; extra space becomes margin. Threads stay **inline** (below their section) at every width: one model across VS Code and the web viewer, and no margin-collision layout to maintain. |

Use container queries on the pane root, not media queries, so the same CSS works embedded in the web viewer.

### 1.4 Section states

States compose; each uses a different visual channel, so any combination stays readable.

| State | Channel | Treatment |
|---|---|---|
| **active** | left bar | 3 px bar in the section's `charts.*` color; heading weight 600; rail item `list-activeSelectionBackground`. Exactly one. |
| **visited** | rail only | `$(check)` in rail; no change in the article (don't grey out content people scroll back to). |
| **updated** | tag + shimmer | On patch: 1.2 s shimmer sweep across *changed blocks only* (`changedBlocks`), then a persistent tag `$(sparkle) Updated by Claude · 2m` (or "Edited by you" / "Changed on disk"). Tag has **Show changes** (inline word diff using `diffEditor-inserted/removedTextBackground`) and clears once the section has been active ≥ 2 s. Rail gets a blue dot until then. |
| **stale** | bar style + banner | Left bar turns dashed, `editorWarning-foreground`; compact banner at section top (§3.9). Content stays at full opacity: it's still the best explanation you have. |
| **editing** (soft stale) | dot | Anchored code is modified but unsaved: a small amber dot on the rail item; no banner. Becomes **stale** on save if the hash still differs. Avoids banner flicker while typing. |
| **moved** | nothing loud | Re-resolved by symbol/snippet to new lines: silently update, tooltip "Moved from L35–40 → L41–46". |
| **missing** | banner | Like stale but `errorForeground`, with "Re-anchor to selection". |
| **has-threads** | badge | `$(comment-discussion) 2` badge in the section's top-right; unread = `badge-background` filled, read = outline. Resolved threads count separately and are hidden behind "1 resolved". |
| **Claude working here** | bar animation | When a story `status.focus` intersects the section's range, the left bar gets a slow 2 s pulse plus "Claude is editing this" in the section header. |

### 1.5 Linked indicator and follow toggle

**Linked chip** (header): `$(link) bit_reader.sv` with three states.
- **Linked**: sync active both ways.
- **Paused** (`$(debug-pause)`): the user scrolled the pane away while the editor shows another file, or the anchored file isn't visible. Click re-links (reveals the active step's code).
- **Broken** (`$(warning)`): file missing or no anchors resolved; click shows details.

Tooltip: "Scroll here → editor follows · Move cursor → explainer follows."

**Follow toggle** `$(eye)` / `$(eye-closed)`: "Follow Claude". It is mirrored in the status bar, off by default, and it persists per workspace.

### 1.6 Story strip

Sticky bottom, `role="log"`, collapsible.

- **Collapsed (one line, 28 px):** `◐ Claude · Refactoring the refill path · 2/5 · 14s` with `$(loading~spin)` while active, `$(pass)` when idle, and `$(error)` when it failed. Click expands it.
- **Expanded (≤ 40% pane height, internally scrolled):**
  - **Now**: the current status, with a focus link `rtl/bit_reader.sv:35–40 →`.
  - **Plan**: a checklist: done `$(pass-filled)`, current `$(loading~spin)`, pending `$(circle-large-outline)`. Plan items reorder or replace with a 200 ms FLIP animation, never a re-render jump.
  - **Done**: reverse-chronological; each entry links to its sections (`section:refill` → scrolls the pane, shows the updated tag).
- **Attention states:** when Claude asks a question (`thread_open` by Claude), the strip tints with `inputValidation-infoBackground` and shows "Claude asked a question in Step 3 → Answer". This is the only story event allowed to raise the strip's prominence.
- **Idle:** auto-collapses 10 s after the last `done`. If there's no story file, the strip is hidden entirely.

---

## 2. Editor-side visuals

All colors are `ThemeColor`s; our own are contributed under `codeExplainer.*` with light/dark/hcLight/hcDark defaults (they also appear in the webview as `--vscode-codeExplainer-*`).

| Element | Spec |
|---|---|
| **Focus range** | `isWholeLine`, `backgroundColor: codeExplainer.focusBackground` (defaults to `editor.rangeHighlightBackground`), left border `0 0 0 2px solid codeExplainer.focusBorder` (per-step variant tinted from the step's `charts.*` color), overview-ruler mark in the same color, `rangeBehavior: ClosedClosed`. |
| **Identifier chips** | `highlight` identifiers in the file: `backgroundColor` of `editor.wordHighlightBackground`, `borderRadius: 3px`, 1 px `editor.wordHighlightBorder`. Only in the focused file; capped at 200 ranges. Exact token match via a word-boundary regex (language-agnostic), upgraded to `executeDocumentHighlights` when available. |
| **Dimming** | `opacity: 0.55` on all non-focus lines, **only in reading mode** (the focus came from the explainer). Cleared instantly on the first keystroke, on a mouse click outside the range, or on `Esc`. Never dim while the cursor drives. Setting `codeExplainer.dim: reading|never|always`. |
| **Gutter** | Reserved for native things: the Comments API "+" and thread glyphs, git. We add only a stale glyph (`$(warning)`-shaped SVG, light/dark variants) on the first line of a stale anchor. No step-number gutter icons: they fight breakpoints and folding. |
| **CodeLens** | On the first line of each anchored range: `$(book) Step 3 · Handshakes` · `$(comment-discussion) 2` · `$(sparkle) Ask Claude`. Stale: `$(warning) Explainer out of date · Refresh with Claude`. Lenses refresh via `onDidChangeCodeLenses`, debounced 500 ms (lenses popping in and out shift the text, so update in place, never remove/re-add while the user types; recompute on save or 2 s idle). Setting to disable. |
| **Hover** | On anchored lines: step title, a 2-line plain-text summary (first `<p>` of the section), state, and command links `Open in explainer` · `Ask Claude`. Trusted `MarkdownString` with `supportThemeIcons`. |
| **Status bar** | Left: `$(book) 3/5 Handshakes` (click = reveal pane; tooltip lists steps). Right: `$(loading~spin) Claude: Refactoring refill…` while the story is active (click = expand the story strip), plus the follow toggle `$(eye)`. The background is never tinted per step (the mockup did; real themes and the native status bar don't allow it cleanly; use the icon color only). |
| **Claude cursor** | With follow on and a `status.focus`: a ghost decoration on those lines (`codeExplainer.claudeFocusBackground`, a dotted left border) plus an `after` text label ` ◂ Claude`. This is shown even with follow off (it is passive, no scroll). |

---

## 3. Interaction choreography

### 3.1 Scroll → editor (pane drives)

- **Reading line** at 30% of pane height (min 72 px below the header). The active section is the last section whose top is above the reading line. **Hysteresis**: ±24 px before switching. At scroll bottom, the last section becomes active even if short.
- Detected with an IntersectionObserver (`rootMargin` placing a 1 px band at the reading line) plus a `scroll` fallback; no per-frame layout reads.
- **Editor reveal**: trailing debounce 120 ms with a 500 ms max-wait (flinging through 5 steps doesn't spam reveals, but the editor still keeps up). `revealRange(range, InCenterIfOutsideViewport)`; skip if the range is fully visible. **Never moves the cursor, never takes focus.**
- If the anchored file isn't open: open it in the other column with `preserveFocus: true, preview: true`.

### 3.2 Cursor → section (editor drives)

- Source: `onDidChangeTextEditorSelection`, ignoring `kind === Command` (programmatic). Debounce 150 ms. Fire only when the **resolved section changes**, so moving within a step does nothing.
- Overlapping anchors: pick the smallest containing range; on a tie, the current active wins (stickiness).
- Cursor outside all anchors: keep the last active section, and the linked chip shows "No step here".
- Pane response: smooth-scroll (200 ms) that puts the section top at the reading line. Does not scroll if the section already straddles the reading line.
- **Respect the reader:** if the pane had user scroll/keyboard input in the last 2 s, or it has focus, don't scroll; show the pill `Cursor is in Step 4 →`.
- Editor scrolling (visible-range changes) does **not** drive the pane. Only the cursor expresses intent; viewport scrolling is browsing.

### 3.3 Feedback loops and scroll fights

1. Explainer → editor never moves the cursor, so it can't trigger §3.2.
2. Every programmatic pane scroll sets `programmatic = epoch` until `scrollend` (or 400 ms); IO callbacks during it are ignored.
3. **Lease rule:** the last surface to receive *human* input holds the "lead" for 1.5 s; incoming sync requests from the other surface during the lease become pills, not motion.
4. Follow mode has the lowest priority: it never preempts a human lease (§3.8).
5. All messages carry `epoch`; the receiver drops anything older than the last applied epoch (remote latency can reorder).

### 3.4 Click an inline ref (`data-explain-ref`)

- Click: reveal the range, a 600 ms decoration flash (focus background fades in and back), no dimming, and the active section is unchanged. Cmd/Ctrl-click opens it to the side.
- Hover (300 ms): editor peek decoration on the range plus a tooltip "rtl/bit_reader.sv:35–40".
- Refs render as links (`textLink-foreground`) with a trailing `$(go-to-file)` at 0.7 opacity; a stale ref gets a dotted underline in the warning color.

### 3.5 Keyboard

In the pane, single-key shortcuts apply when focus isn't in an input. They are discoverable through `?` and listed in the `…` menu.

| Key | Action |
|---|---|
| `j` / `k` | next / previous section (scroll + reveal) |
| `]` / `[` | next / previous **attention** item (stale, updated, unread thread) |
| `Enter` | reveal the active step in the editor *and* focus the editor |
| `c` | comment on the active section (opens the composer) |
| `a` | Ask Claude about the active section |
| `t` | toggle the threads of the active section |
| `f` | toggle follow mode |
| `o` | rail overlay / step picker |
| `g g` / `G` | first / last |
| `Esc` | close composer/overlay; clear dimming; return focus to the editor (two-stage) |

Global commands (with `when: codeExplainer.active`): `Code Explainer: Next/Previous Step` (suggested `Ctrl+Alt+]` / `[`, not bound to conflict-prone keys by default), `Focus Explainer`, `Toggle Follow Claude`, `Ask Claude About Selection`.

### 3.6 Asking Claude

**From a section:** a hover/focus action bar at the section's top-right (`$(comment)` Comment · `$(sparkle)` Ask Claude · `$(link)` Copy link). This opens an inline composer under the section (`--vscode-input-*`, autosizing). Context chips above the textarea show what will be sent: `Step 3 · Handshakes`, plus `bit_reader.sv:19–21` (removable). `Cmd/Ctrl+Enter` sends; `Esc` with text asks before discarding. Drafts persist per section through `vscode.setState`, so they survive the pane being hidden.

**From a code selection:** the editor context menu, a CodeLens, the lightbulb ("Ask Claude about this"), or the Comments API "+". This creates a native code thread (`kind: code`) and mirrors it in the pane under the section that contains the range (or under "Code threads" if none does).

**Optimistic UI and honest delivery.** The comment appears instantly with a delivery line that progresses:
- `$(clock) Sending…`: written locally; ~immediate.
- `$(check) Delivered to Claude`: channel acked (or `$(history) Queued: Claude sees it at its next step` for the hook fallback).
- `$(loading~spin) Claude is replying…`: the channel/story signals pickup.
- `$(warning) No Claude session`, with buttons **Run headless** · **Copy as prompt**.

If the write fails, the comment stays with `$(error) Not saved · Retry`; the text is never lost.

### 3.7 Claude replying while you read

- A reply lands as one `threadEvent`. If the thread is **expanded and in view**, it fades in (150 ms) and the scroll is compensated if it was inserted above the reading anchor. If it is **out of view or collapsed**, the badge increments and the pill shows `↓ Claude replied in Step 3`. Never auto-expand, never auto-scroll.
- If the reply has `edits: ["section:refill"]`, the reply card shows `Edited Step 5 → View changes` and the section gets the updated state.
- Thread bottom-pinning (chat-style): only when the user is already at the thread's last message.

### 3.8 Claude edits the section you are reading

1. The patch arrives for the active section. If it is unprotected (§0.4), morph it in place with reading-anchor scroll compensation: the paragraph under your eyes stays put.
2. Changed blocks shimmer once; the tag `Updated by Claude · just now · Show changes`. **Show changes** toggles an inline diff of the section (old text struck through, in removed color), so you can see what you were just reading versus now.
3. If your reading paragraph was deleted, keep the old one as a ghost (50% opacity, struck, "Removed by Claude") until the section is left. This keeps your place and your context.
4. If the section is protected (you are typing a comment in it, or have text selected), show the staged-update bar instead.
5. If Claude is actively streaming multiple edits to it (several patches within 5 s), batch: only one shimmer, after 1.5 s of quiet.

### 3.9 Follow mode while you type

- Follow on, Claude posts a focus: if the editor is not focused or no keystroke was made in 3 s, reveal the range (no cursor move), sync the pane, and show the ghost "◂ Claude" decoration.
- If the user typed in the last 3 s, the editor is dirty, or the pane has focus: **hold**. Show a chip in the status bar and as a pane pill: `Claude is at bit_reader.sv:35–40 → Jump`. Only the most recent focus is kept (no queue replay). It auto-releases after 3 s of idle *only if* the editor is not dirty; otherwise it waits for an explicit jump.
- Follow never opens a new editor tab while the user is typing; it never switches files on the user without a jump.

### 3.10 Stale anchors

Detection runs on `onDidChangeTextDocument` (debounced 400 ms, unsaved buffer), file watchers and git checkout. Re-resolve via symbol → snippet → range.

- Resolved with a hash match at new lines → **moved** (silent).
- Hash differs, unsaved → **editing** (dot).
- Hash differs, saved → **stale**. The banner reads: `$(warning) Code changed since this was written · L35–40 · [Show code diff] [Refresh with Claude] [Mark still accurate] [Re-anchor…]`.
  - **Show code diff** opens a native diff (pinned commit vs working tree, scoped to the range).
  - **Refresh with Claude** creates a thread pre-filled with the diff context. The banner becomes `$(loading~spin) Claude is refreshing…` and clears itself when the patch arrives, with the updated state.
  - **Mark still accurate** rewrites `contentHash` (a human-owned action).
  - **Re-anchor** uses the current editor selection.
- The editor CodeLens shows the same state. When code reverts, staleness clears live (fade out 200 ms).

---

## 4. Motion, states, accessibility

### 4.1 Motion tokens

| Token | ms | Easing | Used for |
|---|---|---|---|
| `instant` | 80 | linear | hover, press |
| `quick` | 150 | ease-out | fades, reply in, banner in/out |
| `move` | 200 | cubic-bezier(.2,0,0,1) | pane smooth scroll, FLIP reorders, rail thumb |
| `shimmer` | 1200 | ease-in-out | updated sweep (gradient using `--vscode-editorInfo-foreground` at 15% alpha) |
| `pulse` | 2000 | ease-in-out ∞ | Claude-working bar |
| `flash` | 600 | ease-out | editor ref flash |

Don't animate layout properties (height/top); use transform/opacity and FLIP.

**Reduced motion.** The webview honours `prefers-reduced-motion`, *and* the extension forwards VS Code's `workbench.reduceMotion` *(verify setting name)* as a body class `ce-reduce-motion`. In that mode: scroll is instant; the shimmer is replaced by a static 2 px info-colored outline for 3 s; the pulse becomes a static dotted bar; spinners stay (they're informational) but codicon spin is limited to the status line.

### 4.2 Empty, loading and error states

- **No explainer in the repo:** a centered card, "No explainers yet", with `Ask Claude to explain this file` (primary) and `Create blank explainer`. No wizard (per guideline).
- **Explainer for another file:** a list of explainers touching the active file.
- **Loading:** skeleton blocks (3 gray bars per section, `--vscode-editorWidget-background`) for at most 300 ms. Content renders progressively per section, never all-or-nothing.
- **Anchors resolving** (language server warming up remotely): sections render immediately, the linked chip shows `$(sync~spin) Resolving…`, snippet resolution is used first, then upgraded silently.
- **Parse error in human-edited HTML:** keep the last good render, with a top banner `Showing last valid version · explainer.html:120 unclosed <section> → Go to error`. It clears live when fixed.
- **Malformed manifest / missing file / channel down:** inline, scoped banners, never a modal; each has one action.
- **Claude error:** a story strip `$(error)` line with the message and `Copy details`.

### 4.3 Accessibility

- **Landmarks:** `header` (banner), `nav` (rail, `aria-label="Steps"`, `aria-current="step"` on the active item), `main > article`, `aside role="log"` (story strip).
- **Focus order:** header controls → rail → article (sections are `tabindex="-1"` targets for j/k; the action bar is reachable with Tab inside the active section) → story strip → pills (pills are also reachable via `]`).
- **Focus is never moved by remote events:** not by patches, replies or follow. Only explicit user commands move focus.
- **Live regions:**
  - The story strip uses `aria-live="polite"` and `aria-relevant="additions"`. It announces `status` changes (throttled to one per 5 s, latest wins) and `done` entries; plan ticks are not announced.
  - A separate visually-hidden polite region announces "Step 3 updated by Claude", "Claude replied in Step 3" and "Step 5 is out of date".
  - Claude asking a question uses `assertive`, once.
- **High contrast** (`vscode-high-contrast`, `vscode-high-contrast-light`): every state gets a border channel using `--vscode-contrastBorder` / `--vscode-contrastActiveBorder`. Tints are not relied on (the shimmer becomes an outline; the dimmed editor uses no opacity in HC: decoration `opacity` is disabled when the theme kind is HighContrast). Stale/updated also carry text labels, never color alone.
- **Targets:** at least 24 px hit areas in the pane. Every icon button has `aria-label` and a title. Codicons are `aria-hidden`.
- **Screen-reader mode** (`editor.accessibilitySupport`): CodeLens and hover carry the full text; the status bar item `accessibilityInformation` reads "Step 3 of 5, Handshakes".

---

## 5. Wireframes

### 5.1 Default pane (wide, ~760 px)

```
┌─ A backward bit reader in five moves ── ⛓ bit_reader.sv  👁  … ┐
│ ┌ Steps ──────────┐  ┌──────────────────────────────────────┐ │
│ │ ● 1 Interface  ✓│  │▌3 · Handshakes          💬 2  ⋯      │ │
│ │ ● 2 State      ✓│  │▌ in_ready rises when at least 8 bits │ │
│ │▐● 3 Handshakes ✎│  │▌ of room remain; [avail] compares... │ │
│ │ ● 4 Consume  •  │  │▌ ┌ rule card ───────────────────────┐ │ │
│ │ ● 5 Refill   ⚠  │  │▌ │ cnt_q ≤ W-8  →  in_ready         │ │ │
│ │   ░ viewport ░  │  │▌ └──────────────────────────────────┘ │ │
│ └─────────────────┘  │  4 · Consume   ✦ Updated by Claude 2m│ │
│                      │   b = b << rd_bits ...               │ │
│                      └──────────────────────────────────────┘ │
├───────────────────────────────────────────────────────────────┤
│ ✓ Claude · idle · last: Refill handles 16-bit input  (Step 5) │
└───────────────────────────────────────────────────────────────┘
 ▌ = active bar   ✓ visited   • updated   ⚠ stale   💬 threads
```

### 5.2 Narrow pane (~320 px)

```
┌ Bit reader ───── ⛓ 👁 … ┐
│ ● 3/5 Handshakes     ▾  │
│ ▬▬ ▬▬ ██ ▬▬ ▬▬  (⚠ on 5)│
├─────────────────────────┤
│▌3 · Handshakes   💬2  ⋯ │
│▌ in_ready rises when at │
│▌ least 8 bits of room   │
│▌ remain...              │
│▌ ┌ cnt_q ≤ W-8 ───────┐ │
│▌ └→ in_ready ─────────┘ │
│        ┌──────────────┐ │
│        │ Cursor: Step4→│ │
│        └──────────────┘ │
├─────────────────────────┤
│ ◐ Claude · Refactor… 2/5│
└─────────────────────────┘
```

### 5.3 Claude-working state (story expanded)

```
┌─ Bit reader ──────────── ⛓ bit_reader.sv   👁 Following  … ┐
│ ...                                                          │
│ ▚ 5 · Refill   ⟳ Claude is editing this                      │
│ ▚  The new byte is OR-ed in below the valid bits...          │
│ ▚  [shimmer ░░░▒▒▓▓▒▒░░░ over changed paragraph]             │
├──────────────────────────────────────────────────────────────┤
│ ⟳ Claude · Widening refill to 16-bit input · 2/4 · 41s    ⌄ │
│  Now   rtl/bit_reader.sv:35–40 →                             │
│  Plan  ✔ Read refill path                                    │
│        ⟳ Widen in_byte to 16 bits                            │
│        ○ Update cnt_q arithmetic                             │
│        ○ Refresh Step 5 explanation                          │
│  Done  ✔ Added test for 16-bit refill   → Step 5             │
├──────────────────────────────────────────────────────────────┤
│   [ Claude is at bit_reader.sv:35–40 → Jump ]  (held: typing)│
└──────────────────────────────────────────────────────────────┘
```

### 5.4 Thread open on a section

```
│▌3 · Handshakes                               💬 2  ⋯      │
│▌ in_ready rises when at least 8 bits of room remain...    │
│ ┌ Thread · Step 3 ─────────────────────────── Resolve ⋯ ┐ │
│ │ moshe · 3m   Why not a FIFO here?                      │ │
│ │ Claude · 1m  A FIFO would add a cycle of latency...    │ │
│ │              ✎ Edited Step 3 → View changes            │ │
│ │ moshe · now  Fair. What about W=32?                    │ │
│ │              ✓ Delivered to Claude                     │ │
│ │ Claude       ⟳ replying…                               │ │
│ │ ┌───────────────────────────────────────────────────┐  │ │
│ │ │ [Step 3] [bit_reader.sv:19–21 ×]                   │  │ │
│ │ │ Reply…                                  ⌘⏎ Send   │  │ │
│ │ └───────────────────────────────────────────────────┘  │ │
│ └────────────────────────────────────────────────────────┘ │
│  4 · Consume ...                                           │
```

### 5.5 Stale section

```
│┆5 · Refill                                     ⚠ 💬1  ⋯   │
│┆┌ ⚠ Code changed since this was written · L35–40 ───────┐ │
│┆│ [Show code diff] [Refresh with Claude] [Still accurate]│ │
│┆│ [Re-anchor to selection]                               │ │
│┆└────────────────────────────────────────────────────────┘ │
│┆ The new byte is OR-ed in below the valid bits:          │
│┆   b | (W'(in_byte) << (W - 8 - c))   ← ref dotted ⚠     │
 ┆ = dashed warning bar (content stays full opacity)
Editor:  ⚠ │ $(warning) Explainer out of date · Refresh with Claude
         35│   if (in_valid && in_ready) begin
```

### 5.6 PR web viewer (static page, same webview bundle)

```
┌ PR #142 · Widen bit_reader refill · head f00ba4 ✓  [Open in VS Code ▾] ┐
│ Explainer: "Refill, now 16-bit" ▾     Diff ◉ Changed ○ Full file       │
├───────────────────────────────────┬────────────────────────────────────┤
│ rtl/bit_reader.sv          ▾      │ ● 1 What changed  ● 2 Refill  ●3… │
│  34 │                             │ ▌2 · Refill (before → after)       │
│▌ 35 │-  if (in_valid && in_ready) │ ▌ ┌ before ──────┬ after ────────┐ │
│▌ 35 │+  if (in_valid && in_ready  │ ▌ │ 8b window    │ 16b window    │ │
│▌ 36 │+      && !hold) begin       │ ▌ └──────────────┴───────────────┘ │
│  37 │     b = b | ...  [in_byte]  │ ▌ 💬 1 · mirrored from GitHub ↗    │
│ ░░░ dimmed context ░░░            │                                     │
├───────────────────────────────────┴────────────────────────────────────┤
│ ↻ Updated to f00ba4 · 2 sections changed  [Show]   (pin to a1b2c3 ▾)  │
└────────────────────────────────────────────────────────────────────────┘
```

Web viewer specifics: the code pane is a read-only highlighted view (diff or full file) with the same decorations rendered as CSS. Scroll sync uses the same §3 rules, but the code pane *is* allowed to drive the explainer on scroll, because there is no cursor. Under 900 px, the layout stacks (explainer on top, code in a sticky bottom sheet at 40% height, Code Hike-style). The page polls `version.json` (60 s, plus on `visibilitychange`); a new push is **patched in place** through the same `explainerPatch` path, with a pill, and a "pin to commit" option for reviewers who want a frozen view. Threads are read-only mirrors with `Reply on GitHub ↗`. "Open in VS Code" offers Codespace / clone deep links.

---

## 6. Decisions to revisit

1. Inline-only threads vs margin threads at ≥ 960 px.
2. Dimming on by default in reading mode.
3. Auto-apply of staged updates after 20 s idle (the alternative is waiting for Apply).
4. A setting for editor-viewport → pane sync.
