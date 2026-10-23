# Sidestory: Design Handoff

> **Status: design draft.** This describes the full vision, including features that are not built yet (threads, the Claude Code integration, the PR viewer, symbol and history-based anchors). For what the extension does today, see the README. Decisions taken during implementation are in §12.

Name: **Sidestory**.
Written: 2026-10-21.

> **For Claude Code:** this is the design brief. Read it fully before scaffolding.
> Facts about Claude Code and VS Code APIs were checked on 2026-10-21; re-verify anything marked *(verify)* against current docs before relying on it.

---

## 1. Vision

A side-by-side **code + explainer** experience:

- **Left:** the real code, in the real editor.
- **Right:** a beautiful, free-form HTML explainer that tells the story of the code: diagrams, tables, step-by-step walkthroughs.
- **The two are linked both ways.**
  - As you move through the explainer, the editor scrolls to and highlights the code being discussed.
  - As you move your cursor in the code, the explainer jumps to the section about it.
- **People and Claude talk in it.** Comment threads on explainer sections and on code lines, where Claude (via Claude Code) replies.
- **It becomes Claude's command center.** While Claude works, it narrates what it is doing, why, and what's next, and the editor can follow what it touches.

It must work for **any codebase** (software and hardware alike), in **local and remote** setups, and in **code review** (GitHub PRs).

---

## 2. Principles

1. **The explainer format is the product.** It is a portable set of files. The viewers (VS Code extension, standalone web page, future JetBrains plugin) are just ways to show it.
2. **Never force a style of explanation.** An explainer is free-form HTML. The only contract is that sections declare which code they are about. An optional component kit makes it easy to look good, but it is never required.
3. **Generic, not domain-specific.** Nothing in the core assumes a language. Domain extras (e.g. RTL waveforms) are optional plugins.
4. **Native to VS Code.** Inherit the user's color theme, fonts and icons, and use native UI (comments, tree views, CodeLens, status bar) wherever it exists.
5. **Remote-first.** Must work over Remote-SSH, `code tunnel`, WSL, Dev Containers, Codespaces, and vscode.dev connected to a tunnel.
6. **Files over servers.** State lives in files in the repo (`.explain/`). It is versioned with the code, travels with branches and PRs, and needs no network connection between machines.
7. **Claude is a participant, not the owner.** Humans can write and edit explainers by hand. Claude reads and writes the same files through the same tools.

---

## 3. Components

```
┌────────────────────────── repo ──────────────────────────┐
│  src/...               (the code)                         │
│  .explain/                                                │
│    <name>/explainer.html   free-form HTML with anchors    │
│    <name>/manifest.json    anchors, commit pin, metadata  │
│    <name>/threads/*.jsonl  comment threads                │
│    story.jsonl             Claude's live narration        │
└───────────────────────────────────────────────────────────┘
        ▲ read/write                ▲ read/write
        │                           │
┌───────┴──────────┐        ┌───────┴─────────────────────┐
│ VS Code extension│        │ Claude Code plugin          │
│ (workspace host) │◄──────►│  • MCP server (tools)       │
│  • Webview pane  │ files  │  • channel (push comments)  │
│  • decorations   │        └─────────────────────────────┘
│  • native APIs   │
└──────────────────┘
        ▲ same format
┌───────┴──────────────────────────────┐
│ Standalone web viewer + GitHub Action │
│  (two-pane page, linked from the PR)  │
└───────────────────────────────────────┘
```

1. **Explainer format**: spec in §4.
2. **VS Code extension**: the primary viewer for depth, live sync, and editing. §5.
3. **Standalone web viewer**: the same two-pane layout as a static page with code embedded at a commit. It is the primary viewer for reach (PR reviewers). §6.
4. **Claude Code plugin**: an MCP server plus a channel. It lets Claude write explainers, point at code, reply to comments, and narrate its work. §7.
5. **GitHub Action**: builds the web viewer per PR, posts a link, and mirrors threads. It can also have Claude generate an explainer for the change. §6.

---

## 4. The explainer format (draft spec)

### 4.1 Layout

```
.explain/
  bit-reader/                 one folder per explainer
    explainer.html            the page (free-form)
    manifest.json             anchors + metadata
    assets/                   optional images, data
    threads/
      t_01J....jsonl          one file per thread
  story.jsonl                 Claude's narration log (optional)
```

### 4.2 Linking sections to code

Any element can declare that it is about some code:

```html
<section data-explain-anchor="refill">
  ...anything...
</section>

<!-- inline reference that jumps the editor when clicked -->
<a data-explain-ref="refill">the refill path</a>
```

`manifest.json` defines each anchor:

```json
{
  "version": 1,
  "title": "A backward bit reader in five moves",
  "commit": "a1b2c3d",
  "anchors": {
    "refill": {
      "file": "rtl/bit_reader.sv",
      "symbol": "bit_reader",
      "range": [35, 40],
      "snippet": "if (in_valid && in_ready) begin",
      "contentHash": "sha1:…",
      "highlight": ["in_byte"],
      "color": "charts.purple"
    }
  }
}
```

**How an anchor is resolved**, in order:

1. **`symbol`**, through the language server (`vscode.executeDocumentSymbolProvider`), with `range` taken as relative to it where useful.
2. **`snippet`**: a text search in the file, choosing the match nearest to `range`.
3. **`range`** at the pinned `commit`, mapped forward through `git diff` when possible.

`highlight` lists identifiers to mark everywhere in the file while the section is active. `color` is a theme color name (see §5.3), never a hex value.

**Staleness.** When the resolved code's hash no longer matches `contentHash`, the anchor is **stale**. The viewer shows that section as out of date and offers "Ask Claude to refresh."

### 4.3 Threads (`threads/<id>.jsonl`)

One JSON object per line, append-only:

```json
{"type":"open","id":"t_01J…","anchor":{"kind":"section","ref":"refill"},"by":"moshe","at":"2026-10-21T19:00:00Z"}
{"type":"comment","id":"c_…","by":"moshe","at":"…","body":"Why not a FIFO here?"}
{"type":"comment","id":"c_…","by":"claude","at":"…","body":"…","edits":["section:refill"]}
{"type":"resolve","by":"moshe","at":"…"}
```

**What a thread can be anchored to:**
- `{"kind":"section","ref":"<anchorId>"}`: an explainer section.
- `{"kind":"code","file":"…","range":[a,b],"snippet":"…"}`: lines of code, resolved like a section anchor.
- `{"kind":"explainer"}`: the explainer as a whole.

### 4.4 Story log (`story.jsonl`)

Claude's narration while it works:

```json
{"at":"…","kind":"status","text":"Refactoring the refill path","focus":{"file":"…","range":[35,40]}}
{"at":"…","kind":"plan","items":["…","…"]}
{"at":"…","kind":"done","text":"Refill now handles 16-bit input","links":["section:refill"]}
```

### 4.5 Optional component kit

A small library of theme-aware building blocks. Explainers may use these or ignore them entirely:

- **Diagrams:** block diagram / pipeline, state machine, sequence diagram.
- **Data and layouts:** bit-field / register map, table, before/after comparison.
- **Callouts:** rule card, callout, step header.
- **Optional plugin:** a waveform viewer for RTL (embeds a slice of a real VCD or FST trace from a test run).

Every component styles itself from theme variables only (§5.3).

---

## 5. VS Code extension

### 5.1 Structure

- `"extensionKind": ["workspace"]`, so the logic runs where the files are, on the remote host in remote setups.
- A **Webview panel** opened in `ViewColumn.Beside` shows the explainer.
- **Messaging** between the Webview and the extension uses `postMessage`, which VS Code relays across the remote connection automatically.
- **Libraries** (highlighting, diagrams) are bundled into the extension. No CDN loads, so it works offline and under the Webview's Content Security Policy.

### 5.2 Message protocol (draft)

Webview → extension:

| message | payload | effect |
|---|---|---|
| `ready` | — | extension sends the current state |
| `focusAnchor` | `{anchorId}` | reveal + decorate the code |
| `openRef` | `{anchorId}` | jump the editor, no dimming |
| `openThread` | `{threadId}` | open the native comment thread |
| `askClaude` | `{anchorId?, text}` | creates a thread, notifies Claude (§7) |

Extension → Webview:

| message | payload | effect |
|---|---|---|
| `cursorMoved` | `{file, line, symbol?}` | page scrolls to the matching section |
| `explainerUpdated` | `{name}` | page reloads its content |
| `threadsUpdated` | `{anchorIds}` | badges and counters refresh |
| `staleAnchors` | `{anchorIds}` | stale sections are marked |
| `story` | `{entry}` | the story strip updates |
| `followMode` | `{on}` | the page reflects the toggle |

### 5.3 Theming (inherit everything)

- **In the Webview, use only VS Code's CSS variables**: `--vscode-editor-background`, `--vscode-editor-foreground`, `--vscode-font-family`, `--vscode-editor-font-family`, `--vscode-textLink-foreground`, `--vscode-charts-blue|red|yellow|orange|green|purple`, and so on.
- **Body classes** `vscode-light`, `vscode-dark`, and `vscode-high-contrast` are available for anything the variables don't cover.
- **Code highlights are editor decorations** using `ThemeColor`, e.g. `editor.rangeHighlightBackground`, plus an overview-ruler (scrollbar) marker. Never hex values.
- **Our own colors** are declared in `contributes.colors` with light, dark, and high-contrast defaults, so themes and users can override them. For example:
  - `sidestory.focusBackground`
  - `sidestory.focusBorder`
  - `sidestory.staleForeground`
- **Per-section accent colors** come from the `charts.*` family, so a "colorful steps" look still follows the theme.
- **Icons** are codicons (`@vscode/codicons`). Don't build on the Webview UI Toolkit, which Microsoft deprecated. Use plain CSS on theme variables, or `vscode-elements` if components are needed *(verify current status)*.

### 5.4 Native UI to use

| Need | Native API |
|---|---|
| Comment threads on code lines | **Comments API** (`vscode.comments.createCommentController`) |
| List of explainers / steps / open threads | **TreeView** in a sidebar container |
| "Explained in step 3 · 2 comments" above code | **CodeLens** |
| Step summary on mouse-over | **HoverProvider** |
| Current step + Claude status | **StatusBarItem** |
| Next/prev step, toggle follow mode, open explainer | **Commands + keybindings** |
| "Every use of this signal" | `vscode.executeReferenceProvider` |
| Stale detection | `workspace.onDidChangeTextDocument` + file watchers |

### 5.5 Follow mode

- When on, the editor and explainer track `story.jsonl` focus events: Claude's edits and pointers move the view.
- It must never move the cursor or focus while the user is typing. Hold events while the editor is active and dirty, then show a "Claude is at L35–40 → jump" chip instead.
- It is off by default; toggle from the status bar.

### 5.6 Remote gotchas (must-handle)

- **`localhost` inside the Webview is the *client* machine**, not the remote host. Load files with `asWebviewUri` and `localResourceRoots`. If a server is ever needed, expose it with `asExternalUri` or the Webview's `portMapping`.
- **Claude Code usually runs on the remote host too.** All coordination goes through files there, plus the MCP server running there. Nothing needs a direct connection to the laptop.
- **Symbol anchors need a language server on the remote host.** Text-snippet anchors are the fallback.
- **Pure vscode.dev on a GitHub repo, with no server behind it**, would need a separate browser build of the extension. That's out of scope for v1; tunnels and Codespaces work without it.

---

## 6. Code review / GitHub PRs

GitHub's PR page can't host a custom side panel, so in review:

1. **Commit `.explain/` in the PR.** Reviewers who check out the branch in VS Code (local, SSH, or Codespace) get the full experience.
2. **Standalone web viewer via a GitHub Action.**
   - Builds a self-contained two-pane page with the code embedded at the PR's head commit.
   - Deploys it as a per-PR preview (e.g. GitHub Pages) and posts the link as a PR comment, updating that comment on new pushes.
   - Each section links to the matching lines in the PR diff or a permalink.
3. **Change-focused explainers.** Claude generates an explainer for *the change*: before/after views, with steps that follow the diff. This can run from the Claude Code GitHub Action when a PR opens.
4. **Thread mirroring.** `.explain` threads anchored to code can mirror to GitHub PR review comments and back. `@claude` mentions can be answered by the Claude Code GitHub Action *(verify trigger setup)*.

GitHub is the first target, since it is by far the most common review platform. GitLab merge requests are next, with the same approach as a CI job.

---

## 7. Claude Code integration

### 7.1 Not the built-in IDE integration

Claude Code's own VS Code extension runs a private local MCP server that the CLI connects to. That's how it shows diffs, reads your selection, and reads diagnostics. Only a couple of its tools are visible to the model, and there is no documented way for a third-party extension to add tools to it. **Don't piggyback on it.** Ship our own.

### 7.2 Claude → explainer: our MCP server

Ship it as a **Claude Code plugin** that bundles an MCP server. Users can also register it with `claude mcp add`. It runs next to Claude Code, on the remote host when remote.

Draft tools:

| tool | purpose |
|---|---|
| `explain_list` | list explainers, anchors, stale anchors |
| `explain_read` | read an explainer + manifest |
| `explain_write_section` | create/replace a section by anchor id |
| `explain_set_anchor` | add/update an anchor (file, symbol, range, snippet, highlight, color) |
| `explain_focus` | point the viewer + editor at an anchor or file range (respects follow mode) |
| `threads_list` | open threads, optionally since a cursor |
| `thread_reply` | append a comment; may list sections it edited |
| `thread_open` | open a new thread (e.g., Claude asking the human a question) |
| `story_post` | append status/plan/done entries to `story.jsonl` |

Writes go to files. The VS Code extension watches `.explain/` and updates the view, so the MCP server and the extension never need a direct connection.

### 7.3 Human → Claude: getting comments into a running session

**Primary: Claude Code *channels* (research preview).**
- A channel is an MCP server that pushes events into a running Claude Code session. It can be two-way: Claude replies back through the same channel.
- Users opt in per session: `claude --channels plugin:<name>@<marketplace>`.
- **Preview constraints:**
  - Only plugins on Anthropic's allowlist, or the organization's `allowedChannelPlugins` list, can register.
  - For local development, use `--dangerously-load-development-channels`.
  - claude.ai Team and Enterprise need `channelsEnabled` turned on by an admin.
  - The flag syntax and protocol may change *(verify)*.
- **The plan:** our MCP server also acts as a channel. A new human comment becomes a channel event; Claude answers with `thread_reply`.

**Fallbacks (no preview features needed):**
- **Hook:** a Claude Code hook checks for unread threads after each step or turn and feeds them in.
- **Headless:** when no session is open, the extension resumes the last session in headless mode (`claude -p` with resume), answers, and exits *(verify exact flags)*.
- **Manual:** a "Send to Claude" command copies the thread as a prompt.

### 7.4 Security

- **Comment text is untrusted input.** This matters especially when threads are mirrored from GitHub or written by other people. Claude treats it as data, not instructions. Edits requested in threads by anyone other than the session owner need the owner's approval.
- **Channel sender allowlists apply.** Anyone who can push through a channel may be able to answer permission prompts, so the allowlist should be tight.
- **The explainer HTML is rendered in a sandboxed Webview** with a strict Content Security Policy and no remote scripts.

---

## 8. Roadmap

**v0: prove the loop** (local + SSH)
- Format: `explainer.html` + `manifest.json` with section anchors.
- Webview beside the editor, theme variables only.
- Explainer → editor: reveal and decorations. Editor → explainer: cursor sync.
- Snippet- and range-based anchors.
- A sample explainer for a small module, as a fixture.

**v1: native + Claude**
- Comments API threads plus `.explain/threads/`.
- MCP server with the tools in §7.2.
- Channel prototype, with the hook fallback.
- Story strip and follow mode.
- Staleness detection.
- TreeView, CodeLens, status bar.
- Symbol anchors.

**v2: review + reach**
- Standalone web viewer builder.
- GitHub Action (per-PR preview, link comment).
- Change-focused explainers.
- Thread mirroring with PR review comments.

**Later**
- Optional component kit.
- Presentation mode.
- PDF export.
- Searchable index of all explainers in a repo.
- JetBrains viewer.
- RTL waveform plugin (VCD/FST embed, "run this test" button).

---

## 9. Open questions

1. **Anchor robustness.** How far to lean on language servers vs. snippets? What is the best way to map ranges forward through history?
2. **Thread storage.** Should threads be committed by default, or kept on a local-only branch or gitignored? Teams may not want chatter in history.
3. **Channel availability.** The preview allowlist may block a third-party channel. Decide early whether v1 relies on the hook fallback.
4. **Which session gets comments** when several Claude Code sessions run in one repo.
5. **Webview sandboxing vs. explainer freedom.** Which scripts are allowed? Should explainers be allowed to run their own JS?
6. **Standalone viewer hosting** for private repos (Pages visibility, internal hosting).
7. **Naming.**

---

## 10. Facts checked on 2026-10-21 (re-verify before use)

- **Claude Code's VS Code extension** runs a built-in local MCP server the CLI auto-connects to. It is used for diffs, selection context, and diagnostics; only a couple of its tools are model-visible. Source: <https://code.claude.com/docs/en/vs-code.md>
- **Channels.** An MCP server can push events into a running Claude Code session; this is two-way and a research preview. Opt-in uses `--channels`. During the preview there is a plugin allowlist (overridable via org `allowedChannelPlugins`), `--dangerously-load-development-channels` for testing, and claude.ai Team/Enterprise need `channelsEnabled`. Source: <https://code.claude.com/docs/en/channels.md>, build guide: <https://code.claude.com/docs/en/channels-reference.md>
- **Other relevant Claude Code docs:** MCP <https://code.claude.com/docs/en/mcp.md>, Hooks <https://code.claude.com/docs/en/hooks-guide.md>, Headless <https://code.claude.com/docs/en/headless.md>, Sessions <https://code.claude.com/docs/en/sessions.md>, index <https://code.claude.com/docs/llms.txt>
- **VS Code (from general knowledge; verify):** the Webview renders on the client while workspace extensions run on the remote host, and `postMessage` is relayed between them; theme CSS variables and body classes are injected into Webviews; `contributes.colors` and `ThemeColor` are the way to add theme-overridable colors; the Webview UI Toolkit is deprecated.
- **CodeTour** (Microsoft) is the closest prior art: step-by-step tours with markdown steps. Our difference is rich HTML, two-way sync, threads, and Claude participation.

---

## 11. Appendix

### 11.1 Mockup

An interactive mockup exists in the user's Claude artifacts ("Sidestory Mockup"):
- **Left:** a dark editor with the module below. The active step's lines are tinted with a left bar, related identifiers are chip-highlighted across the file, other lines are dimmed, and clicking a line jumps to its step.
- **Right:** a light walkthrough with a title, a five-step Prev/Next stepper, and a "Synced" indicator. Each step uses a *different* style of explanation: (1) block diagram, (2) bit-window bar, (3) rule cards, (4) before/after shift bars, (5) a cycle trace table.
- **Bottom:** a status bar tinted with the active step's color.
The mockup hard-codes colors and fonts for demo purposes; the real extension must take them from the theme (§5.3).

### 11.2 Sample fixture: `bit_reader.sv`

Steps: 1 = L1–15 (interface), 2 = L16–17 (state), 3 = L19–21 (handshakes), 4 = L31–34 (consume), 5 = L35–40 (refill).

```systemverilog
module bit_reader #(
  parameter int W = 64
) (
  input  logic         clk,
  input  logic         rst_n,
  // bytes arrive last-first (backward stream)
  input  logic [7:0]   in_byte,
  input  logic         in_valid,
  output logic         in_ready,
  // consumer side
  input  logic [5:0]   rd_bits,
  input  logic         rd_en,
  output logic [W-1:0] peek,
  output logic         avail
);
  logic [W-1:0] buf_q;   // MSB-aligned bit window
  logic [6:0]   cnt_q;   // valid bits in buf_q

  assign in_ready = (cnt_q <= 7'(W - 8));
  assign avail    = (cnt_q >= 7'(rd_bits));
  assign peek     = buf_q;

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      buf_q <= '0;
      cnt_q <= '0;
    end else begin
      logic [W-1:0] b;
      logic [6:0]   c;
      b = buf_q;  c = cnt_q;
      if (rd_en && avail) begin        // consume from the top
        b = b << rd_bits;
        c = c - 7'(rd_bits);
      end
      if (in_valid && in_ready) begin  // refill below valid bits
        b = b | (W'(in_byte) << (W - 8 - c));
        c = c + 7'd8;
      end
      buf_q <= b;
      cnt_q <= c;
    end
  end
endmodule
```

Add a small software fixture too (e.g. a TypeScript or Python function), so v0 is proven on both.

---

## 12. Decisions log

- **2026-10-21: Review uses VS Code's native diff editor for now.** The extension does not render its own diffs. It chooses the diff base and opens the native diff editor (side-by-side or inline, the user's choice), then adds step markers, CodeLens and comment threads on top. Claude picks the base from context, and the user can override it:
  - first visit to a PR: the whole PR against the merge base with main;
  - returning reviewer: since the commit they last reviewed;
  - opening a thread: the commit the comment was written on;
  - while Claude works: since the commit before it started.
  The standalone web viewer (§6.2) moves to "later". API details: `docs/research/native-diff-api.md`.
- **2026-10-21: Diff is optional.** In review, the user chooses **Diff** (the native diff editor) or **Code only** (the plain editor, with gutter bars and step colors marking what changed since the chosen base, via a quick diff provider). The choice is remembered per user. The base picker applies in both views.
- **2026-10-21: Manifest format for v0.** `version: 1` (the brief's format, with `snippet`) and `version: 2` (the anchors research format, `docs/research/anchors.md` §3) are both read. The `spec: "explain/1.0"` shape sketched in `docs/research/architecture.md` §6 is not adopted. In v2, `quote` (exact text plus up to 3 lines / ~160 characters of context) is the source of truth and `range` is a hint. A v1 `snippet` is resolved as "text near the start of the range", not as a full quote. Anchors are line-granular for now; columns, `symbol`, `pin`, `fp` and other fields are preserved in the raw manifest for lossless rewrites but not used yet. A bad anchor is reported and skipped; only a bad top level (or an unknown future `version`) fails the whole manifest. `file` must be a canonical repo-relative POSIX path, and files are read only if they resolve inside the repo after following symlinks.
- **2026-10-21: Explainer isolation for v0.** *(Superseded the same day: explainer HTML now renders in a sandboxed iframe without `allow-scripts`, driven from the panel; its assets come from the extension as blob: URLs. Never add `allow-scripts` alongside `allow-same-origin`. See SECURITY.md.)* Originally: explainer HTML rendered in a shadow root inside the webview, not in a sandboxed iframe. Safety rests on the CSP (no script but the extension's own, no network, `base-uri`/`object-src`/`frame-src` none) plus a sanitizer that drops active elements, event handlers and URLs leaving the explainer folder, and hands over parsed nodes (never re-parsed strings). Author layout is contained (`contain: paint`, own stacking context) so it can't cover the panel's controls. Explainers can't run their own scripts. Before allowing author scripts or adding trusted UI such as a comment composer, move explainer content to a sandboxed iframe (`docs/research/architecture.md` §4.5).
- **2026-10-21: Anchor scoring weights.** L = 0.45·S + 0.35·C + 0.10·T + 0.10·P (the research suggested 0.55/0.25). Context weighs more so that an edited copy in the right place beats an untouched duplicate elsewhere. A live-tracked or confidently resolved position is trusted: a close rival elsewhere doesn't make it ambiguous. Guesses (ambiguous or stale results) are never fed back as trusted positions.
- **2026-10-21: Known v0 limits to address before v1.** Section state badges are CSS (`::after`) on the author's own elements, so they can't hold actions ("Still accurate", "Re-link here") or thread badges. v1 adds per-section chrome kept outside the morphed content (`docs/research/ux-design.md` §0.5), including the mockup's file/lines chip on the active section. `localResourceRoots` includes the explainer folder; VS Code checks resource paths by prefix, not realpath, so a symlink inside `.explain/<name>/` could expose another readable file to the page. With no script or network access in the page this can't leak anywhere, but the iframe move should also resolve symlinks.
