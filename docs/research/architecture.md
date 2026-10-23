# Sidestory: System Architecture

> Written when the folder was `.explain/`, the page was `explainer.html` and sidestories were called explainers.

Status: proposal, 2026-10-21. Scope: the live data flow from end to end. The hard requirement is that **everything updates live**: the user never reloads a panel or reruns a command.

---

## 0. Verified facts (checked 2026-10-21)

| # | Fact | Source |
|---|---|---|
| F1 | Webviews only load local files under `localResourceRoots`, which defaults to the extension directory plus the workspace folders. Use `asWebviewUri`. The recommended CSP starts from `default-src 'none'` with `script-src ${webview.cspSource}`. Scripts stay off until `enableScripts: true`. | https://code.visualstudio.com/api/extension-guides/webview |
| F2 | `getState`/`setState` survive while the panel is hidden and are "much lower" overhead than `retainContextWhenHidden`. A `WebviewPanelSerializer` together with the `onWebviewPanel:<viewType>` activation event restores panels after a restart. | same |
| F3 | `retainContextWhenHidden` "has a high memory overhead". A hidden retained webview's scripts are suspended, and **"You cannot send messages to a hidden webview, even with `retainContextWhenHidden` enabled."** | vscode.d.ts, https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.d.ts |
| F4 | The Webview always runs on the client; `localhost` there is the client. Prefer message passing (`asExternalUri`/`portMapping` are escape hatches). `extensionKind: ["workspace"]` runs the extension where the files are. | https://code.visualstudio.com/api/advanced-topics/remote-extensions |
| F5 | `createFileSystemWatcher`: a simple pattern is non-recursive and ignores `files.watcherExclude`. Complex patterns are recursive and subject to the excludes. Missing paths are watched "with a delay until created"; bulk ops fold into a parent event. Recursive uses `@parcel/watcher`, non-recursive `fs.watch`. | vscode.d.ts; https://github.com/microsoft/vscode/wiki/File-Watcher-Internals |
| F6 | In WSL2, changes made to `/mnt/c` from the Windows side are not seen by inotify. VS Code has had a `remote.WSL.fileWatcher.polling` setting (community sources; official docs not found). | https://github.com/Microsoft/BashOnWindows/issues/51, https://forum.cursor.com/t/support-for-remote-wsl-filewatcher-polling/133140 |
| F7 | Comments API `CommentThread` has `canReply`, `contextValue`, `label`, `state` (Resolved/Unresolved), `collapsibleState`, and `range: Range \| undefined` (undefined means file-level). Comments have `CommentMode` and a reactions handler. | vscode.d.ts |
| F8 | The Git extension API (`vscode.git`, `getAPI(1)`) exposes `Repository.onDidCheckout`, `onDidCommit`, `state.onDidChange`, `state.HEAD`, and `state.rebaseCommit`. | https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts |
| F9 | The Webview UI Toolkit was deprecated on 2025-01-01. `@vscode-elements/elements` (Lit) is active but community-maintained. | https://ice-ice-bear.github.io/ko/posts/2026-02-26-vscode-ecosystem-2026/, https://github.com/vscode-elements/elements |
| F10 | **Channels** are still a research preview. A channel is a stdio MCP server that declares `capabilities.experimental['claude/channel']` and emits `notifications/claude/channel {content, meta}`. Meta keys must be identifiers. The model sees `<channel source=… k="v">`. Events that arrive while Claude is busy are batched into the next turn. **There is no delivery ack**, and events are silently dropped if the session didn't opt in. Opt-in is `--channels plugin:<name>@<marketplace>`. Custom channels aren't on the allowlist and need `--dangerously-load-development-channels`, which works **interactive only** (ignored with `-p` and the SDK) and shows a warning dialog. Team/Enterprise need `channelsEnabled`, and `allowedChannelPlugins` can list our plugin. Pro/Max skip the org checks. Neither flag appears in `--help`. Permission relay is `claude/channel/permission`. A plugin declares channels with a `channels: [{server}]` manifest key. | https://code.claude.com/docs/en/channels.md, https://code.claude.com/docs/en/channels-reference.md, https://code.claude.com/docs/en/plugins-reference.md |
| F11 | **MCP v2 runtime gotcha:** Claude Code doesn't register a channel server that negotiates protocol revision `2026-07-28`. Build the server on MCP TS SDK 1.x, or set `MCP_PROTOCOL_NEGOTIATION=legacy`. | https://code.claude.com/docs/en/mcp.md |
| F12 | Plugins bundle MCP servers in `.mcp.json`, with `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, and `${CLAUDE_PROJECT_DIR}`. Tools are named `mcp__plugin_<plugin>_<server>__<tool>`. Plugins can also ship `hooks/hooks.json`, `bin/`, and **monitors** (`monitors/monitors.json`): background commands whose stdout "reaches Claude as notifications". Monitors run in **interactive sessions only**, and not on Bedrock/Vertex/Foundry or with telemetry disabled. | https://code.claude.com/docs/en/plugins/components.md, https://code.claude.com/docs/en/tools-reference.md |
| F13 | **Hooks:** `asyncRewake: true` runs a hook in the background, and if it exits with code 2 it **"wakes Claude immediately even when the session is idle"**, delivering stderr as a reminder. Its timeout *is* enforced. A `Stop` hook can return `decision:"block"` + `reason`, capped at 8 consecutive continues. `SessionStart` can return `additionalContext` and `watchPaths`. `FileChanged` is side-effect only. Every hook receives `session_id`, `transcript_path`, and `cwd`. | https://code.claude.com/docs/en/hooks.md |
| F14 | **Headless:** `claude -p "…" --resume <session-id>` (or `--continue`), `--output-format json\|stream-json`, `--allowedTools`, `--permission-mode`, `--permission-prompts none`, `--bare`. Plugin monitors don't start under `-p`. | https://code.claude.com/docs/en/headless.md |
| F15 | **GitHub Action:** `anthropics/claude-code-action@v1`. Interactive mode runs when there's no `prompt` and `@claude` appears (`trigger_phrase`) in `issue_comment` or `pull_request_review_comment`. The author needs write access. Set up with `/install-github-app`. | https://code.claude.com/docs/en/github-actions.md |

Brief "(verify)" items: resolved by F9, F10, F11, F14, F15.

---

## 1. Components and modules

```
                     ┌─────────────── client (laptop / browser) ───────────────┐
                     │  Webview (host page, trusted)                           │
                     │   ├─ chrome/ (Lit): story strip, badges, composer        │
                     │   ├─ sync/: rev tracking, patch apply, setState          │
                     │   └─ <iframe sandbox="allow-scripts" srcdoc> (untrusted) │
                     │        └─ frame-runtime: idiomorph, scroll spy, refs     │
                     └──────────────▲──────────────────────────────────────────┘
                          postMessage (relayed by VS Code across remote)
┌─────────────────────────────── workspace host (local / SSH / WSL / container) ─────────────────────────┐
│ VS Code extension (extensionKind: workspace)                                                            │
│  sources/  fsWatch · bufferOverlay · gitWatch · editorEvents · webviewInbox · poller                    │
│  store/    actions → reducer → state (single tree) → selectors                                          │
│  sinks/    webviewSync · decorations · comments · tree · codelens · hover · statusbar · followMode     │
│  services/ anchorEngine(core + LSP) · writer(core) · inboxRouter · sessionRegistry · fallbackLauncher   │
│                                     ▲ files (.explain/)  ▲                                              │
│ Claude Code (CLI) ── stdio ── explain MCP server (plugin; Node, MCP SDK 1.x)                            │
│                                ├─ tools: explain_*, threads_*, story_post                              │
│                                ├─ channel: inbox watch → notifications/claude/channel                  │
│                                └─ uses @explain/core                                                   │
│  plugin also ships: monitors/inbox-monitor (bin) · hooks (SessionStart registry, Stop asyncRewake)     │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
  CI: @explain/web builder (core + static runtime) → per-PR page; GitHub Action mirrors threads
```

**Packages** (pnpm monorepo, TypeScript strict):

| package | runs in | contents |
|---|---|---|
| `@explain/core` | Node + browser (I/O behind an `Fs` interface) | schemas, migrations, codecs, HTML sectionizer and section splice, anchor resolver, hashing, JSONL tail reader, atomic write, locks, CAS, inbox claim |
| `@explain/vscode` | extension host | sources/store/sinks above, plus LSP-backed symbol resolution and the Comments API bridge |
| `@explain/webview` | Webview host page | chrome UI, sync engine, iframe broker |
| `@explain/frame-runtime` | inside the sandboxed iframe | morphing, scroll spy, `data-explain-ref` clicks, kit loader. About 10 KB. |
| `@explain/mcp` | next to Claude Code | MCP tools, channel, inbox router, the `explain-inbox` CLI used by the monitor and hooks |
| `@explain/kit` | iframe and web viewer | optional theme-variable web components |
| `@explain/web` | CI / CLI | static two-pane builder (code embedded at a commit) that reuses `frame-runtime` |

The key rule: **every writer** (extension, MCP server, CI mirror) goes through `@explain/core`'s writer. That one module owns atomicity, locking, schema validation, and the formatting that keeps git diffs small.

---

## 2. State model and live event flow

### 2.1 Single store

```ts
State = {
  repo:      { head: {branch, commit}, op: 'idle'|'checkout'|'rebase'|'merge', trust: boolean },
  explainers: Map<name, {
    manifest, manifestHash,
    doc: { source: 'disk'|'buffer', rev, head: {styles, hash}, order: SectionId[],
           sections: Map<SectionId, {html, hash}> },
    diskBase?: string            // last disk text, used as merge base when a buffer is dirty
  }>,
  anchors:   Map<`${name}#${id}`, { resolved?: {uri, range, via:'symbol'|'quote'|'git'|'range', score},
                                    liveHash, status:'fresh'|'stale'|'missing'|'pending'|'paused' }>,
  threads:   Map<threadId, { anchor, storage:'shared'|'local', comments, state, unreadFor: Set<who>,
                             routedTo?: sessionId, deliveredVia?: Channel }>,
  story:     Map<sessionId, { entries: Ring<200>, lastFocus?, alive: boolean }>,
  sessions:  Map<sessionId, { cwd, branch, heartbeatAt, capabilities: Channel[] }>,
  ui:        { active?: {name, anchorId}, follow: boolean, typingUntil: number, pendingFocus? },
  views:     Map<panelId, { ackedRev, visible }>
}
```

**Sources** produce `Action`s. A **pure reducer** applies them. **Sinks** subscribe to memoized selectors and diff each new output against the last one they emitted, so each sink pushes only what changed. Every action carries `origin` (`disk | buffer | mcp | user | git`), which is used for loop suppression and follow-mode rules.

### 2.2 Inputs, debouncing, coalescing

| source | mechanism | coalescing |
|---|---|---|
| `.explain/**` on disk | one recursive `createFileSystemWatcher(RelativePattern(folder, '.explain/**'))` per workspace folder, plus non-recursive watchers on `.explain/` and `.explain/.local/inbox/` (immune to user excludes, F5) | per-path trailing 75 ms with a 300 ms max wait. Temp files (`*.tmp-*`) are ignored. After a burst, each path is **read and content-hashed**; an unchanged hash is a no-op, which absorbs our own writes and editor "touch" saves |
| watchdog poller | `stat` on `.explain/**/*` (dozens of files) every 2 s; every 500 ms when `remote.WSL`, `/mnt/*`, NFS/9p/fuse is detected, or after the watcher misses a self-write probe | the same hash gate |
| unsaved buffers | `onDidChangeTextDocument` for `explainer.html` and `manifest.json` → overlay (buffer beats disk while dirty) | 150 ms trailing |
| code edits | `onDidChangeTextDocument.contentChanges` | **synchronous** range shifting of resolved anchors (cheap, keeps decorations glued). Hash re-check after 120 ms; quote re-resolve after 400 ms idle; LSP symbol re-resolve after 1 s idle, visible files only |
| git | `vscode.git` `onDidCheckout` / `state.onDidChange` / `rebaseCommit` (F8). Fallback: non-recursive watch of `.git/HEAD` and `.git/` for `rebase-merge` / `index.lock` | enters `repo.op=checkout\|rebase`. All anchor recomputation **pauses**; one full reconcile runs 300 ms after the last event of the op |
| editor | `onDidChangeTextEditorSelection`, `onDidChangeActiveTextEditor`, `onDidChangeVisibleTextEditorRanges` | 50 ms. Sets `ui.typingUntil = now+1.5 s` on text changes |
| webview | `onDidReceiveMessage` | immediate |

The reducer runs once per **tick**: actions are queued and flushed in a microtask, so one burst produces one state transition.

### 2.3 Webview sync protocol (replaces §5.2's `explainerUpdated`)

Extension → webview:
- `snapshot {rev, explainer:{head, order, sections[]}, anchors, threads, story, ui}`
- `patch {base, rev, ops[]}` with these ops: `section.upsert {id, html, hash, after}`, `section.remove {id}`, `order.set {order}`, `head.set {styles}`, `anchor.status {id, status}`, `threads.summary {byAnchor}`, `thread.upsert`, `story.append {entries}`, `ui.set {…}`, `banner {kind,…}`.
- Patches are batched to at most one every 32 ms.

Webview → extension: `ready {rev?, name?}`, `ack {rev}`, `resync`, plus the intents in §5.2 (`focusAnchor`, `openRef`, `openThread`, `askClaude`, `reply`, `resolve`).

Rules:
1. If `base !== view.rev`, the webview sends `resync` and gets a `snapshot`.
2. When a panel turns visible (`onDidChangeViewState`), the extension sends a patch from `ackedRev` (it keeps 64 revs of op history) or a snapshot. Messages to hidden views are never relied on (F3).
3. The host page forwards `section.*` ops into the iframe. `frame-runtime` applies them with **idiomorph** on the single `[data-explain-anchor=id]` element. idiomorph's id-set matching preserves focus, `<details>` open state, media playback, and kit component instances. Before morphing, the runtime records the top-visible section and its offset ratio, and restores them afterwards, so the user's reading position never jumps.
4. A section the user is reading that changes gets a transient "updated by Claude · diff" pill. Morphing never scrolls.

### 2.4 Persistence

- `setState` is small: `{name, rev, scroll:{sectionId, ratio}, openThreads, drafts}`. No content is stored in it.
- `WebviewPanelSerializer` is registered for viewType `sidestory.view` with activation event `onWebviewPanel:sidestory.view`. `deserializeWebviewPanel(panel, state)` re-binds the panel to the store and sends a `snapshot`. The page restores scroll from `state.scroll`.
- `retainContextWhenHidden`: **off by default**. Snapshots are cheap and scroll is restored by section, so it's rarely needed. An opt-in setting `sidestory.keepAlive` exists for heavy explainers such as big waveforms. Even with it on, the extension still resyncs on show (F3).

### 2.5 Writes and concurrency (core writer)

Three writer kinds touch the same files: MCP server, extension, human.

- **Whole-file documents** (`explainer.html`, `manifest.json`) use `updateFile(path, fn)`:
  1. lock: `proper-lockfile` style, an `mkdir` lock in `.explain/.local/locks/` with a stale timeout of 10 s;
  2. read and hash the file;
  3. apply `fn`;
  4. write `name.tmp-<pid>-<rand>`, fsync, `rename` over the target. On Windows, retry EPERM/EBUSY with backoff, as `write-file-atomic` and `graceful-fs` do;
  5. unlock.
  Human editors don't take locks, so before the rename the writer re-hashes the target. If it changed, the writer retries `fn` (CAS, three attempts).
- **Section-granular edits:** `explain_write_section` splices the new element at parse5 source offsets. Every byte outside that element is kept, which keeps human formatting and git diffs minimal.
- **Presence-aware writes:** the extension maintains `.explain/.local/presence.json` (`{file, dirty, by:'vscode', at}`). If the target is open **and dirty**, the MCP server writes a proposal to `.explain/.local/proposals/<ulid>.json` instead of the file. The extension applies it to the buffer as a `WorkspaceEdit`, so it lands in the user's undo stack and causes no "file changed on disk" conflict. The tool reports `applied-to-buffer`. If no extension consumes the proposal within 3 s, the server falls back to a disk write.
- **Disk changed while the buffer is dirty** (another writer): the webview shows a banner offering *"Merge by section"*, a 3-way merge using `diskBase` as the base. Sections changed on only one side merge automatically.
- **Append-only JSONL** (threads, story, inbox journal):
  - Each event is **one `write()` of one complete line** on an `O_APPEND` fd, under the same lock. O_APPEND is atomic per write on local POSIX filesystems; the lock covers NFS and Windows.
  - Readers keep `{offset, prefixHash}` per file and consume only up to the last `\n`, so a partial trailing line waits for its newline.
  - If `size < offset`, or the hash of the first 4 KB changed (a human rewrote the file in an editor), the reader does a full re-read.
  - Events have ULID `id`s and reducers are idempotent, so duplicates from re-reads or git merges are harmless. Git merges of two branches' appends just concatenate; the recommended `.gitattributes` is `*.jsonl merge=union`.
  - A malformed line becomes a diagnostic (Problems panel) and is skipped. The rest of the file still loads.

---

## 3. Sequence diagrams

### 3.1 Claude edits a section while the user reads it

```
Claude      MCP server(core)        disk/.explain     Ext: fsWatch→store→webviewSync     Webview host → iframe
  │ explain_write_section(refill)        │                       │                              │
  │──────────►│ presence? (not dirty)    │                       │                              │
  │           │ lock→read→splice→CAS     │                       │                              │
  │           │ tmp+fsync+rename ───────►│ change event          │                              │
  │           │ story_post(status)──────►│ (append)              │                              │
  │◄── ok ────│                          │──────────────────────►│ 75ms coalesce, hash≠         │
  │           │                          │                       │ sectionize → only 'refill' ≠ │
  │           │                          │                       │ re-resolve anchor 'refill'   │
  │           │                          │                       │ patch{rev 42: section.upsert │
  │           │                          │                       │  refill, story.append}──────►│ base ok → forward
  │           │                          │                       │                              │ record scroll anchor
  │           │                          │                       │                              │ idiomorph(#refill)
  │           │                          │                       │◄────────── ack{42} ──────────│ restore offset, pill
```

### 3.2 User comments → Claude replies live

```
User(webview/Comments UI)  Ext                     .explain files            MCP srv / monitor / hook      Claude session
 │ askClaude{anchor,text}──►│ core.append thread    │                         │                             │
 │                          │ open+comment ────────►│ threads/t_X.jsonl       │                             │
 │                          │ inboxRouter: pick sess│                         │                             │
 │                          │ write inbox/<id>.json►│ .local/inbox            │                             │
 │◄ thread.upsert (pending)─│                       │──── watch ─────────────►│ claim (rename→claimed/S)    │
 │                          │                       │                         │ deliver via best channel:   │
 │                          │                       │                         │  channel notif │ monitor line│
 │                          │                       │                         │  │ asyncRewake exit 2 ─────►│ wakes / next turn
 │                          │                       │                         │◄── thread_reply(t_X, body) ─│
 │                          │                       │◄─ append comment ───────│ mark delivered               │
 │                          │◄── fs event (tail) ───│                         │                             │
 │◄ thread.upsert + badge ──│ Comments API update   │                         │                             │
```

If the reply doesn't arrive within N seconds (configurable, 20 s default), the extension marks the thread "waiting for Claude" and offers *Wake via headless* or *Copy prompt* (§4.3).

### 3.3 User types in code → anchors re-resolve and staleness updates

```
User types     Ext: editorEvents        anchorEngine                     sinks
 │ keystroke ──►│ contentChanges         │                                │
 │              │ shift ranges (sync) ──►│ decorations moved (same frame) ►│ editor
 │              │ typingUntil=+1.5s      │                                │
 │              │ … 120ms idle ─────────►│ hash(range) vs contentHash     │
 │              │                        │ status fresh→stale ───────────►│ patch anchor.status → webview badge
 │              │                        │                                │ CodeLens/Tree refresh (debounced)
 │              │ … 400ms idle ─────────►│ quote re-resolve (fuzzy)       │
 │              │                        │ range moved? update resolved ─►│ decorations
 │              │ … 1s idle (visible) ──►│ LSP symbol check (optional)    │
```

Follow-mode rule: while `now < typingUntil` or the editor is dirty and focused, incoming Claude focus events are parked in `ui.pendingFocus` and shown as a "Claude is at L35–40 → jump" chip.

### 3.4 Branch switch

```
git checkout   vscode.git           Ext store                  fsWatch flood            Webview
 │────────────►│ onDidCheckout ────►│ repo.op=checkout          │                        │
 │             │                    │ pause anchors/patches ◄───│ 100s of events (queued) │
 │             │ state.onDidChange─►│ head={feat, abc}          │                        │
 │             │                    │ 300ms quiet → reconcile:  │                        │
 │             │                    │  rescan .explain (hash-gated; unchanged explainers no-op)
 │             │                    │  re-resolve anchors, re-read threads (shared: per-branch; local: all, tagged)
 │             │                    │ op=idle → one patch ─────────────────────────────►│ morph changed sections
 │             │                    │ active explainer missing? → banner "not on this branch" + list
```

A rebase uses the same flow with `op=rebase`, held until `rebaseCommit` clears. During the rebase, statuses show `paused`, not a storm of stale/fresh flips.

---

## 4. Open questions 1–5

### 4.1 Anchors (Q1)

Use layered resolution, implemented mostly in `@explain/core` so the MCP server and web builder resolve anchors identically without VS Code:
1. **Live tracking:** inside VS Code, a resolved anchor follows edits by range shifting (§3.3). Most of the time no re-resolution is needed.
2. **Quote selector** (primary persisted locator): `{exact, prefix, suffix}` in the W3C TextQuoteSelector style. Exact search first, then fuzzy (diff-match-patch bitap, score ≥ 0.8), nearest to the hinted range.
3. **Git mapping:** `git diff -U0 <pinnedAt>..HEAD -M -- file` hunks map the line range forward, and rename detection follows moved files. This handles "the snippet changed but the block is still here" and gives the "what changed since pinned" diff for stale sections.
4. **Symbol:** LSP `executeDocumentSymbolProvider` in VS Code, used as a disambiguator and container (`symbolPath: ["bit_reader"]`), never alone. An optional web-tree-sitter (WASM) fallback lives in core for hosts without a language server.
5. **Range:** last resort, flagged `via: 'range'` with low confidence.

Staleness is `hash(normalize(resolvedText)) ≠ contentHash`, where normalize means LF line endings, trimmed trailing whitespace, and a sha256 hash. A "refresh" (by Claude or a human) rewrites the `quote`, `contentHash`, and `pinnedAt` together.

### 4.2 Thread storage (Q2)

Use two tiers selected by `.explain/config.json`:
- `threads/` is **shared** and committed. It's for review discussions and decisions worth keeping. This is the default for threads opened by *other humans* or mirrored from GitHub.
- `.explain/.local/threads/` is **local** and gitignored (the extension adds `.explain/.local/` to `.gitignore`). It's the default for user↔Claude working chatter.
- A *Share thread* action moves a thread from local to shared, an atomic rename. `config.threads.default` can flip the default per team.

Git notes or a custom ref were rejected: invisible in PR diffs, poor tooling.

### 4.3 Channel availability and fallback (Q3)

**Decision: v1 must work without channels.** F10/F11 mean a third-party channel needs either `--dangerously-load-development-channels` (interactive only, with a scary dialog) or an org `allowedChannelPlugins` entry, which isn't available to Pro/Max users. Delivery runs down a ladder. The first rung available for the routed session wins:

| rung | needs | wakes an idle session? |
|---|---|---|
| 1. Channel (`notifications/claude/channel`, meta `thread_id`, `anchor`, `explainer`, `author`) | session opted in; server on SDK 1.x / legacy negotiation | yes |
| 2. **Plugin monitor** `explain-inbox --session $S --follow` prints one line per routed comment | interactive, first-party API, telemetry on (F12) | documented as "notifications" that Claude reacts to; *confirm idle-wake in spike* |
| 3. **`Stop` hook with `asyncRewake: true`** runs `explain-inbox --wait --timeout 590` and exits 2 with the comment on stderr | any interactive session | **yes** (F13). It re-arms on every Stop; the gap after a timeout is closed by rung 4 |
| 4. `UserPromptSubmit` / `PostToolBatch` hooks inject unread items as `additionalContext` | always | no, but the item arrives on the next turn |
| 5. Headless: `claude -p "<thread prompt>" --resume <id> --output-format stream-json --permission-mode acceptEdits --allowedTools mcp__plugin_explain_*` | only if **no live session** holds the id (heartbeat stale) | n/a. It spawns a run; it never resumes a session that is open |
| 6. Manual: *Copy as prompt* | none | n/a |

Since there is no delivery ack (F10), "delivered" means *claimed* by a session (inbox rename). "Answered" means `thread_reply` was called. The `instructions` string of the MCP server tells Claude that channel and monitor content is **untrusted data**.

### 4.4 Multi-session routing (Q4)

- **Session registry:** the plugin's `SessionStart` hook writes `.explain/.local/sessions/<session_id>.json` (`cwd`, branch, worktree, pid of the hook's parent claude process). The MCP server matches itself to that record by parent pid, falling back to a nonce exchanged by an `explain_hello` call. It then heartbeats every 10 s and lists its capabilities (channel / monitor / rewake).
- **Routing order** (`inboxRouter` in core, run by the extension; the MCP server re-validates):
  1. an explicit session picked in the composer (`@session` chip);
  2. thread affinity (the last session that replied);
  3. worktree/cwd containing the anchored file, with a branch match;
  4. the most recently active live session;
  5. none → queue and offer headless.
- **Exactly-once claim:** the inbox item is atomically renamed `inbox/<id>.json → claimed/<session>/<id>.json`, so a broadcast race can't make two sessions answer. Unclaimed items go back to routing after 30 s.

### 4.5 Webview script sandboxing (Q5)

- The **host page** is ours: strict CSP with a nonce, `default-src 'none'`, `script-src 'nonce-…'`, `style-src ${cspSource} 'nonce-…'`, `img-src ${cspSource} data:`, `frame-src ${cspSource}`. It is the only context with `acquireVsCodeApi()`.
- The **explainer** renders in `<iframe sandbox="allow-scripts" srcdoc=…>`, with no `allow-same-origin`, so it gets an opaque origin and can't reach the host DOM or the VS Code API. The extension builds the `srcdoc` by:
  1. injecting a `<meta http-equiv=CSP>` with `connect-src 'none'`, `img-src`/`font-src` limited to `asWebviewUri(explainerDir)` and `data:`, and `script-src 'nonce-RUNTIME' <kit uri>`;
  2. adding `<base href=asWebviewUri(dir)/>`;
  3. inlining theme variables, because CSS variables don't cross the iframe boundary: the host copies the computed `--vscode-*` values and the body classes on every theme change.
- **Explainer JS policy:**
  - Default **off**. Inline and author scripts are blocked by the CSP. The kit's web components (trusted, bundled) give interactivity.
  - `config.scripts: "trusted"` *and* VS Code Workspace Trust → `script-src` also allows `asWebviewUri(dir)/*.js` (still sandboxed, still `connect-src 'none'`).
- **Broker:** iframe → host messages form an allowlist (`focusAnchor`, `openRef`, `scrollSpy`, `height`). They are rate-limited, and their schemas are validated. *Composer, replies, and askClaude live only in the host chrome*, so explainer script can't post as the user.

---

## 5. Recommended tech stack

| concern | choice | why |
|---|---|---|
| language/monorepo | TypeScript, pnpm workspaces, Turborepo cache | shared core across 4 runtimes |
| bundling | **esbuild** for the extension (cjs, `external: vscode`), webview, frame-runtime, and MCP server (single-file Node bundle, no native deps); Vite only for the web viewer dev server | fast, simple; a single-file MCP server makes plugin install trivial |
| webview chrome | **Lit** + selected `@vscode-elements/elements` (F9) + `@vscode/codicons` | small, web-component native, matches the kit, no VDOM fighting the morpher |
| explainer content | no framework; **idiomorph** | id-set matching keeps moved sections intact; Turbo uses it in production |
| HTML parsing (host side) | **parse5** with `sourceCodeLocationInfo` | spec-correct; offsets enable byte-preserving section splices |
| schema/validation | **zod v4**, generating JSON Schema (`z.toJSONSchema`) for `$schema` files and MCP tool input schemas | one source of truth |
| files | `write-file-atomic` semantics, `proper-lockfile`-style mkdir locks, chokidar v4 in the MCP server (polling switch for WSL/NFS), `ulidx` | pure JS, cross-platform |
| anchors | `diff-match-patch`, git CLI via `execa`, `web-tree-sitter` (later) | language-agnostic, works without LSP |
| comments markdown | `markdown-it` + DOMPurify in the host chrome | comment bodies are untrusted |
| MCP | `@modelcontextprotocol/sdk` **1.x** (F11) on Node ≥ 20 | channels require the legacy revision |
| unit/property tests | **vitest** + **fast-check** (JSONL interleavings, CAS retries, range-shift vs. re-resolve equivalence) | core is pure |
| concurrency torture | N processes (MCP, extension, `sed -i` "human") on tmpfs, NFS, Windows | proves §2.5 |
| extension integration | **@vscode/test-cli + @vscode/test-electron** (stable + insiders); remote matrix via Dev Container CI job | real watcher, Comments API, serializer |
| webview and web viewer | **Playwright**: frame-runtime in a harness page with a mocked `acquireVsCodeApi`, plus the built static viewer; visual snapshots in light/dark/HC | morph and scroll-preservation assertions |
| MCP | SDK in-memory transport tests; golden channel-notification tests | |

---

## 6. Format changes to the spec

**Versioning (all files):**
- Field `"spec": "explain/1.0"` (major.minor). Readers accept the same major, **ignore and preserve unknown fields** (round-tripped on rewrite), and refuse a newer major read-only with a banner.
- `"$schema": "https://…/schema/1/manifest.json"` for editor IntelliSense.
- Migrations live in core (`migrate(doc, from, to)`). Writers never downgrade.

**`.explain/config.json`** (new, committed): `{ spec, threads:{default:'local'|'shared'}, scripts:'off'|'trusted', anchors:{fuzzyThreshold}, mirror:{github:true} }`.

**manifest.json:**
```json
{ "spec":"explain/1.0", "title":"…", "order":["iface","state","refill"],
  "anchors": { "refill": {
     "file":"rtl/bit_reader.sv", "symbolPath":["bit_reader"],
     "lines":[35,40],                      // 1-based inclusive, explicit
     "quote":{"exact":"if (in_valid && in_ready) begin","prefix":"…","suffix":"…"},
     "contentHash":"sha256:…", "pinnedAt":"a1b2c3d4…",   // per anchor, full SHA
     "highlight":["in_byte"], "color":"charts.purple", "title":"Refill" } } }
```
- `commit` moves from the top level to a per-anchor `pinnedAt`, because anchors are refreshed independently.
- `snippet` becomes `quote` with context.
- `order` and `title` let the TreeView and CodeLens work without parsing HTML.
- The hash algorithm is fixed by the spec.
- Keys are written sorted with 2-space indent, so diffs stay stable.

**threads/<id>.jsonl** (every line):
```json
{"v":1,"id":"01J…","t":"open","thread":"t_01J…","at":"…","by":{"id":"alex","kind":"human"},
 "anchor":{"kind":"section","explainer":"bit-reader","ref":"refill"},
 "snapshot":{"file":"…","lines":[35,40],"commit":"…"},"source":{"via":"vscode"}}
```
- Event types: `open | comment | edit(target) | retract(target) | react | resolve | reopen | route(session)`. Edits are appended events; nothing is rewritten.
- `by.kind` is `human | claude | bot`, and `source.via` is `vscode | mcp | github:<commentId>` (for idempotent mirroring).
- `snapshot` keeps orphaned threads meaningful.
- Read-state and routing claims never go in committed files; they live in `.local/`.

**story** moves to `.explain/.local/story/<sessionId>.jsonl` (gitignored, rotated at 1 MB). Each line carries `seq` and `session`, and `kind` is one of `status | plan | focus | done | question | error`. A committed `story.jsonl` remains optional for "change narratives" in PRs.

**`.explain/.local/`** (gitignored): `sessions/`, `inbox/`, `claimed/`, `proposals/`, `presence.json`, `locks/`, `cursors.json`.

**explainer.html:**
- Requires a unique `data-explain-anchor` per top-level section, which must also be its `id`, so idiomorph matches it.
- Kit components are pulled in with `<script type="module" src="explain-kit:…">`, resolved by the viewer.
- No external URLs.

---

## 7. Risks

1. **Channels stay gated, or their protocol changes.** Mitigation: the delivery ladder (§4.3); the channel is an adapter, not a dependency.
2. **The monitor's idle-wake behavior is undocumented**, and monitors are unavailable on Bedrock/Vertex/Foundry or with telemetry off. Mitigation: the asyncRewake rung, and a spike in week 1.
3. **Missed watcher events** on WSL `/mnt/*`, NFS/9p, Docker bind mounts, or with `files.watcherExclude` user globs. Mitigation: non-recursive watchers plus a hash-gated poller, and a self-write probe that auto-enables fast polling.
4. **srcdoc iframe limits:** theme vars must be copied in; find-in-page doesn't reach the iframe. Mitigation: host-side search.
5. **Write races with human editors** that don't lock. Mitigation: CAS re-hash before rename, presence-aware buffer proposals, section merge UI. Residual: a save landing between re-hash and rename (surfaced by the merge banner).
6. **Session identity:** matching the MCP server to its `session_id` by parent pid is a heuristic. Mitigation: the `explain_hello` nonce fallback and a UI session picker.
7. **Headless resume of a live session** forks its transcript. Mitigation: resume only on stale heartbeat.
8. **Prompt injection** via comments or mirrored PR comments. Mitigation: `instructions` mark content as data; non-owner edits need approval; permission relay is **not** declared.
9. **LSP cost on remote hosts.** Mitigation: visible-files-only, idle scheduling, caches keyed on document version.
10. **manifest.json merge conflicts.** Mitigation: sorted keys; a future merge driver.
11. **Spec churn.** Mitigation: unknown-field preservation, major gating, migration tests.
12. **vscode-elements is community-maintained** (F9). Mitigation: wrap it thinly.
