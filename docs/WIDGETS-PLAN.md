# Interactive widgets: plan

Status: plan, revision 4.5 (2026-10-22), reviewed to only nits by architecture, security and authoring reviewers over five rounds. Not built yet.

Explainers today are HTML and CSS without script: safe, but they can't hold the app-like visuals people expect from Claude artifacts (live charts, simulations, draggable diagrams). This plan adds **widgets**: React components, written the way Claude writes artifacts, that run in isolated frames inside the explainer. The prose stays plain HTML; only widgets run code.

## 1. Goals, non-goals, and the security boundary

Goals:
- **Artifact-compatible authoring.** A widget is a TSX/JSX file whose default export is a React component, using what artifacts use: React, Tailwind, shadcn/ui-style components, Recharts, D3, Motion, lucide-react, lodash. Claude should write one with no new syntax.
- **Linked to the code.** A widget knows its section and the current step, can read the code its explainer points at, can highlight lines in it, and can reveal code when clicked.
- **Native look** in every VS Code theme, including high contrast; reduced motion honored.
- **Live.** Editing a widget's source updates it in place; what the reader set (via `useWidgetState`) survives.

Non-goals (v1): network access; arbitrary npm packages; Three.js, Mermaid, KaTeX, WaveDrom (§12); widgets in Restricted Mode; inline widget code in `explainer.html` (§12).

**Security boundary: widgets are code from the repository, and run only with informed consent.**
- They never compile or run in an untrusted workspace, when `codeExplainer.widgets.enabled` is off (application scope: a repository's settings can't turn it on), or before the reader agrees in a **native VS Code modal** that names what widgets can do (§5.1).
- The sandbox (§5) keeps widgets away from VS Code, the panel, files, and the usual network APIs. It does **not** guarantee no network: review found WebRTC and `<link rel=prefetch>` reach the network despite CSP. So the boundary is consent plus **limiting what a widget can see** (§5.2), and SECURITY.md says so plainly. Hardening is described as reducing casual misuse, not as containment.

## 2. Authoring

In `explainer.html`:

```html
<section data-explain-anchor="refill">
  <h2>Refill</h2>
  <explain-widget src="widgets/ring.tsx" title="Ring buffer" height="320">
    <script type="application/json">{"depth": 8}</script>
    <img src="assets/ring.svg" alt="Ring buffer: the write pointer chases the read pointer">
  </explain-widget>
</section>
```

- `src`: a `.tsx`/`.jsx`/`.ts`/`.js` file in the explainer folder (exempt from the sanitizer's URL rewriting; resolved by the extension).
- Props: a child `<script type="application/json">` (never executed; extracted by the sanitizer before scripts are dropped; escape `</` as `<\/`) or a `props` attribute. If both are given, the JSON child wins and a warning is shown. ≤ 16 KB; parsed into a null-prototype object; errors reported with the line.
- `height` (initial px, default 240) or `aspect` (e.g. `16/9`). `title`: accessible name (default: file name). `id`: stable key (default: enclosing anchor + `src` + index in that section; duplicates without `id` warn).
- Other children: the **fallback**, shown when widgets can't run, while loading, and on error. With no fallback, a skeleton with the title shows. While the widget is live, the fallback is visually hidden and referenced from the placeholder with `aria-describedby`.
- A self-closing `<explain-widget …/>` (which in HTML swallows the rest of the section) is rewritten to an empty element, with a warning.

A widget (`widgets/ring.tsx`):

```tsx
import { motion } from 'motion/react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useWidgetState, useStepValue, useAnchorCode, highlight } from 'explainer';

export default function Ring({ depth = 8 }: { depth?: number }) {
  const [wr, setWr] = useWidgetState('wr', 0);         // what the reader sets: survives reloads
  const angle = useStepValue({ interface: 0, refill: 90, drain: 180 }, 0); // follows the steps
  const code = useAnchorCode('refill');                // the real code, live
  return (
    <Card>
      <CardContent>
        <motion.svg animate={{ rotate: angle }}>{/* ring, fill="var(--chart-1)" */}</motion.svg>
        <Button onClick={() => { setWr((wr + 1) % depth); highlight([2, 3]) /* lines 2–3 of this section's anchor, 'refill' */; }}>Write</Button>
        <pre className="text-xs text-muted-foreground">{code?.text.split('\n')[0]}</pre>
      </CardContent>
    </Card>
  );
}
```

**Imports** (anything else is a compile error with a suggestion):

| Import | Provides |
|---|---|
| `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client` | React 19 |
| `@/components/ui/*` | shadcn-compatible shims styled with VS Code tokens: Card*, Button, Badge, Input, Label, Slider, Switch, Checkbox, Tabs*, Select* (native-backed), Progress, Separator, Alert*, Tooltip*, ScrollArea. Popups (tooltips) flip or clamp to stay inside the widget's box. |
| `@/lib/utils` (`cn`), `clsx`, `tailwind-merge` | Class helpers |
| `recharts` | Charts (`ResponsiveContainer` shimmed: falls back to `aspect` or 300 px when the parent height doesn't resolve) |
| `d3` and the d3 modules it contains (`d3-scale`, `d3-shape`, … an explicit list) → `d3` | Scales, shapes, layouts. Non-d3 packages like `d3-sankey` get a specific message. |
| `motion/react`, `motion`, `framer-motion` → `motion/react` | Animation |
| `lucide-react` | Icons (names checked against lucide's own export list, aliases included; only the icons a widget imports are sent to it) |
| `lodash` | Utilities |
| `explainer` | The SDK (§6) |
| `./x.ts(x)`, `./data.json`, `./img.svg/png/webp` | Files in the explainer folder; JSON inlined, images as data URLs (same checks as assets, §5.2) |

Known-unavailable imports (`three`, `mathjs`, `papaparse`, `chart.js`, `tone`, `@radix-ui/*`) get a specific message naming the alternative. Top-level `await` is a clear compile error.

**Artifact habits that don't fit a content-sized frame**, handled at runtime and warned about by the checker:
- `h-screen`, `min-h-screen`, `h-dvh`, `100vh`: redefined so they don't stretch; `html, body { height: auto }`.
- `window.innerHeight`: returns the panel's viewport height.
- Height measured from the root element's box. A height that grows on 5+ consecutive reports within 1 s is frozen with a message ("this widget sizes itself to the window; give it a height").
- `localStorage`/`sessionStorage`: in-memory shims.
- `fetch`, remote images and fonts: a clear in-box message ("widgets can't use the network; import ./data.json").
- `autoFocus` is stripped (warning); programmatic `focus()` is a no-op unless the reader is interacting with the widget (§5.3).
- Tailwind v3 `*-opacity-*`: linted.

**Checking** (doesn't run anything, so it needs no consent; not in Restricted Mode):
- "Code Explainer: Check Widgets", plus diagnostics published on widget files and `explainer.html` whenever they change (VS Code's Problems panel; Claude Code reads IDE diagnostics).
- A standalone checker for Claude Code in the user's repository: `node <extension>/dist/check.cjs <explainer-dir>`. WIDGETS.md gives the exact command and a fallback to find it (`ls ~/.vscode*/extensions/*code-explainer*/dist/check.cjs`, which also covers `~/.vscode-server` on remotes); "Code Explainer: Copy Widget Check Command" prints it. When Claude Code is connected to the IDE, diagnostics are the primary channel. `check.cjs --pin` pins anchors from the files on disk (as Pin Anchors does), so Claude can pin without the UI.
- Checks: compile; imports and named exports against each library's real export list ("did you mean"); the habit list above; props JSON; anchor ids used in `reveal`/`goToStep`/`highlight`/`<Ref>`/`useAnchorCode` exist; each anchor used in `useAnchorCode` is pinned, tracked-or-unignored and not a secret file (§5.2); `highlight` in a widget with no enclosing step anchor; `reveal`/`goToStep`/`next`/`prev` called from effects, timers or after an `await` (they only work synchronously from a click); placement problems visible in the HTML/CSS (§3).
- "Code Explainer: Add Widget Types" writes `.explain/tsconfig.json` and bundled `.d.ts` files (React, the libraries, `explainer`), so `tsc` and IntelliSense work without installing packages.

## 3. Architecture

```
VS Code webview host (VS Code's)
└─ panel document (our script; CSP + Trusted Types; no network)
   ├─ content frame — srcdoc, sandbox="allow-same-origin", no script: the HTML explainer (as today)
   │    └─ <explain-widget> placeholders: reserved space, fallback, focus stop
   ├─ consent bar (panel chrome, outside the content): "This explainer has 3 interactive widgets…"
   └─ widget layer — inside .cx-scroll, overflow: clip, below the panel's controls
        └─ widget frame per mounted widget: srcdoc, sandbox="allow-scripts" (opaque origin)
             a fixed, hash-allowed bootstrap; everything else arrives by message
```

**Why overlays.** Sandbox flags are inherited, so a frame inside the script-free content frame can't run script. Widget frames are children of the panel, laid over their placeholders; the content frame doesn't scroll (the panel's scroller does), so a placeholder's rectangle maps to the layer, which scrolls with it.

**Scripts without sharing the nonce.** Panel CSP: `script-src 'nonce-N' 'sha256-<bootstrap>' 'strict-dynamic'; require-trusted-types-for 'script'; trusted-types cx-static cx-sanitize cx-widget default`. A widget frame's srcdoc holds its own stricter meta CSP and the bootstrap, nothing else.
- The bootstrap (verified: runs by hash, and scripts it appends run under `'strict-dynamic'`; ~1.1 MB delivered and run in ~60 ms) first applies the hardening (§5.4) to its own realm, creates a passthrough Trusted Types `default` policy for its realm, refuses to run unless `origin === 'null'`, posts `boot`, and accepts exactly one `load {scripts[]}` from `parent`.
- The panel sends `load` only after `boot` from that frame's `contentWindow`, never sends code or state to a frame after its second `load` event (attempted navigation; the frame is then reset), and sends each widget only its own props, state and code.
- Trusted Types is enforced in the panel and inherited by the content frame (verified: content-frame sinks check it too, and accept TrustedHTML made by the panel's policies). Policies: `cx-static` (constant template strings only, also used for the panel's writes into content-frame nodes), `cx-sanitize` (only `sanitize.ts`, for `DOMParser.parseFromString` of author HTML, whose output is inert and then sanitized), `cx-widget` (the constant srcdoc). Idiomorph only ever receives nodes, never strings. `default` is listed in the panel's `trusted-types` because widget frames inherit the list and the bootstrap creates its own passthrough `default` there; the panel must never create a `default` policy (a comment and a lint say so). A lint also bans non-constant HTML sinks, `import()`, script creation and script/link `src` in `src/webview` outside the frame host. A test sends forged host messages carrying `<script>` and `<iframe srcdoc>` payloads and checks nothing runs.

**Placement contract.**
- Allowed: normal flow, including sections, `<details>`, CSS tabs and radio steppers; clip-only ancestors (`overflow: hidden`/`clip`; the frame is clipped to the ancestor's padding box, without its rounded corners); scrolling ancestors (`overflow: auto`/`scroll`, e.g. wide tables) only while they don't actually overflow on that axis, re-checked on resize — otherwise the fallback (state saved first) with "This widget can't be shown at this width" for readers, and the ancestor and property in Output and diagnostics (wheel over a widget would scroll the panel, never that inner box).
- Not rendered (`checkVisibility()` false, closed `<details>`, an unselected CSS tab): simply unmounted, no error; mounted when it becomes rendered.
- Not supported (fallback plus an error naming the ancestor and property, e.g. "`div.card`: transform"): ancestors with a persistent geometry transform, `clip-path`/`mask`/`filter`, `content-visibility`, `position: fixed/sticky`; geometry animations (checked via `getAnimations()` keyframes and `transition-property`; the panel's own `cx-*` animations and transitions that apply only on `:hover` are ignored — the frame may be a few px off during a hover lift).
- `explain-widget { display: block !important }` from the panel's content CSS; its height is set by the panel.
- Re-measure on: a ResizeObserver on the content body and each placeholder; `scroll`/`load`/`toggle`/`transitionend`/`animationend` (capture) and `document.fonts` in the content frame; panel resize; every render/morph; a 500 ms check while any widget is mounted. One `requestAnimationFrame` batch.
- Each frame's rectangle is the measured placeholder rectangle, clamped to the content frame and to clipping ancestors. Height changes from a widget are throttled and ignored while a pointer is down. Height changes above the reading line are compensated in `scrollTop`, and those scrolls never pick the step. Last heights are cached by key (webview state and the extension), so remounts don't shift the page.

**Lifecycle.** Mounting is computed from `scrollTop` in the existing scroll handler: within one viewport, at most 8 mounted, at most 24 per explainer. Unmounting first asks for state. Dive/back unmounts all. With `retainContextWhenHidden: false`, hiding the tab destroys all frames; they remount from state when shown (library texts are cached in the extension host, so re-sending is cheap).

**Compile (extension host).** In a warm `worker_thread` with a time limit (2 s per compile) and `resourceLimits`:
- Resolve relative imports inside the explainer folder: reject absolute, `file:`, `?`/`#`, backslash or NUL specifiers and disallowed extensions; open via realpath inside the folder; ≤ 1 MB total, ≤ 50 files.
- **Sucrase** (TypeScript, JSX automatic runtime `production: true`, imports → CommonJS), exact version, core transform only. Line numbers preserved.
- **Loop guards** (acorn pass on Sucrase output; prototype verified: line count preserved, a guarded infinite loop broken after ~1 s, a tight 50M-iteration loop 26 → 115 ms). One global iteration counter plus a "last yielded" timestamp refreshed by a `MessageChannel` tick, so any guarded loop sees a stall; inserted as `{ guardSetup; loop }` with labels kept outside, so unbraced bodies keep their meaning. The error says "spread heavy work over frames (requestAnimationFrame, d3.timer)". Guards catch accidental hangs only; regex blowups, huge allocations and recursion are the watchdog's job (§4).
- Aliases, allow-list, lucide per-widget icon module; output `{ modules, libraries, warnings, errors }`, cached by SHA-256; errors carry relative paths only.
- Watchers on the files trigger recompile and a `widget` update.

**Libraries.** Built at extension build time with esbuild into IIFEs (`dist/widget-libs/*.js`) registering on `globalThis.__cxLibs`, with a resolve plugin mapping `react*` to the registry. Production builds; checked free of `eval`/`new Function`. Measured minified: react+react-dom 224 KB, recharts 610 KB, d3 300 KB, motion 229 KB, @tailwindcss/browser 282 KB, lucide icon data 510 KB (sent per icon), lodash 74 KB, plus the shims.

## 4. Watchdog and hangs

Where a hung widget ends up depends on the process model (§12): with isolated sandboxed frames, all of a panel's widget frames share **one** widget process — a hung widget freezes the other widgets but not the panel; without that isolation (some browsers) widgets share the panel's thread and freeze it. So there are two watchdogs.

**Panel-side** (isolated case): the panel pings each mounted widget about once a second (`ping`/`pong`). When pongs stop for 3 s while the panel is visible, it unmounts **every** widget frame in that panel (removing only the stuck frame doesn't free the shared process; with none left, Chromium replaces it), disables the suspect (from breadcrumbs: the widget that was mounting, else the one with the most recent message or work), remounts the others, and reports to the extension, which shows the notification below.

**Extension-side** (shared-process case):
- The panel sends a heartbeat every second while visible, carrying its event-loop delay (how late its own timer fired), `document.visibilityState`, and breadcrumbs (which widgets are mounted, which one is mounting).
- **Armed** only while the panel last reported visible and beats were flowing. A gap is **ignored** when the extension's own timer also drifted (sleep, debugger, busy extension host) or the remote connection dropped.
- **Trips** when beats stop for 10 s, or when 3 beats within 60 s report more than 2 s of delay (catches "hang 9 s, yield, repeat").
- **Escalation:** first trip disables the suspect widget (from breadcrumbs: the one mounting, else the one with the most recent work); a second trip for the same explainer within 5 minutes disables all its widgets; a third stops acting and shows a notification.
- **Recovery:** the extension disposes the panel (removing the frame from the workbench side, since setting `webview.html` would queue behind the hung renderer) and recreates it in the same column, restoring place from the extension's copy. The suspect widget (from breadcrumbs; else all of that explainer's widgets) is disabled until its source changes, remembered in `workspaceState`. A notification names the file and offers "Enable widgets".
- No reset loop: if the recreated panel still misses beats with widgets disabled, the watchdog stops acting for that panel.
- Legitimately heavy synchronous work (a big d3 force layout computed in one go) can trip it; the guide says to spread such work over frames, next to the loop-guard advice.
- Phase 1 verifies dispose tears down a hung webview and that the webview runs out of the workbench's process.

## 5. Security

### 5.1 Consent
- A consent bar in the panel's own chrome (not in the content, which the author's CSS controls) says how many widgets the explainer has, with "Run widgets…". That button only asks; the extension then shows a **native modal**: "Widgets are code from this repository. They can read the code this explainer points at (including unsaved edits) and may be able to reach the network. Run widgets in this workspace?" Consent is granted only by the modal's answer.
- Consent is stored per workspace with a hash of each explainer's widget code: the full import closure (relative modules, JSON, images), hashed from the exact bytes the compile worker read. Working-tree edits by anyone (VS Code, Claude Code, other tools or extensions) are treated as the user's own and update the hash. Consent compares content hashes: the panel asks again only when the current bytes differ from the last consented-or-observed hash **and** that change arrived through git. Attribution first forces a refresh (`await repository.status()` via the `vscode.git` API) and compares against `repository.show('HEAD', path)`: bytes equal to the blob at a newly moved HEAD count as git arrivals; only bytes that differ from HEAD at that settled point are recorded as observed edits. Arrivals through git: HEAD moved (checkout, pull, merge, rebase — from the git extension's repository state) or the first open after a clone; and for widget files that arrived that way. Committing already-observed edits moves HEAD without changing bytes and doesn't re-ask. The extension observes widget files in every explainer whenever the workspace contains `.explain/` (activation `workspaceContains`), not only while a panel is open; edits made while VS Code was closed may re-ask once (the guide says so). If a `.git` directory or file exists at or above the explainer (a filesystem walk; git is never spawned) but the git extension has no repository for that path — disabled, repository above the workspace folder, auto-detection off, a nested repository or submodule it hasn't opened — changed widget code always needs consent (never recorded as observed edits). Without git, consent is per workspace. The modal names the explainer and the changed files. Consent covers code, not the data and props it reads. "Code Explainer: Revoke Widget Consent" clears it.
- In Restricted Mode the bar offers VS Code's own "Trust workspace…" flow. Widgets mount when trust and consent are granted, without reopening the panel.
- All of this is enforced in the extension: compile, library and code requests are refused without trust, setting and consent.

### 5.2 What widgets can see
- `code {anchor}` / `useAnchorCode` is served only when the author demonstrably knew the text (anchor matching is fuzzy, and range-only or v1-snippet anchors resolve without the full text, so "resolved" alone doesn't prove that). Decided by **how** the anchor matched, not its state:
  - **The quote must be author knowledge:** a v2 `quote` with `norm: 'ws'` (not case-insensitive) that is either identical in the manifest committed at HEAD, or was written by Pin in this workspace after the confirmation below. Range-only and v1 `snippet` anchors are `not-pinned`.
  - **Matched in full, current text:** method `exact`, the hint fast path with a full-text comparison, or `fuzzy` with similarity 1 — in files tracked by git, or untracked but not ignored;
  - **Matched approximately (changed or stale):** only in git-tracked files, and only when the quote matches the file's HEAD version exactly (so the author knew the committed text; the differences are the user's own working-tree edits, which the consent modal discloses);
  - git state via the `vscode.git` API, only in trusted workspaces — never by spawning git ourselves, since repository config can run commands;
  - never for secret-looking files, matched case-insensitively against both the anchor path and the real path's name: `.env*`, `*secret*`, `*token*`, `*credential*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keystore`, `*.jks`, `*.tfvars`, `*.local.*`, `appsettings.*.json`, `*kubeconfig*`, `.npmrc`, `.netrc`, `.pypirc`, `.git-credentials`, `.dockercfg`, `.htpasswd`, `id_*`;
  - ≤ 2,000 lines. Otherwise `useAnchorCode` returns `{status: 'unavailable', reason: 'not-pinned' | 'unconfirmed' | 'ignored' | 'secret-file' | 'lost' | 'changed-untracked' | 'changed-since-commit' | 'too-large'}` and the widget can render its own empty state. The reason and the fix ("pin this anchor") go to authors only — the checker, diagnostics and Output — never into the box readers see, so a hostile explainer can't use the panel to ask readers to pin. `check.cjs --pin` reads files from disk; the Pin command pins what editors show, unsaved edits included.
- **Pin and widgets.** When an explainer has widgets that use `useAnchorCode`, Pin (command and `check.cjs --pin`) first lists the files and line counts widgets would then be able to read, and pins those anchors only after the user confirms (a native modal; `--pin` requires `--yes-widgets-may-read` to include them). Pin never quotes denylisted files. Quotes written this way are recorded as confirmed in `workspaceState`, keyed on (file, hash of the quote's text, range), so any later change to the quote makes it unconfirmed again. The modal lists exact line ranges per file. Quotes the extension didn't write itself (from `check.cjs --pin`, or edited by hand) on anchors that widgets read are `unconfirmed` until the reader confirms them: the consent bar offers "Let widgets read N anchors (files, line counts)…", which opens the same native modal and records the confirmation. The checker and diagnostics report `not-pinned` (pin it), `unconfirmed` (confirm in VS Code, or commit) and the other reasons separately. The guide tells Claude never to pass `--yes-widgets-may-read` on its own: it shows the user the files and line counts and passes the flag only with their go-ahead.
- Images imported by widgets and `asset(path)` go through the asset checks (realpath inside the explainer folder, size caps, the panel's 20 MB budget) and the same secret-file exclusions.
- Each widget receives only its own props, state and code. The panel holds no secrets (no tokens; no file contents beyond what it shows).

### 5.3 The panel and the bridge
- Host messages are accepted only on the panel's own origin (done, a164ffa/02feab6: the origin is shared only by this extension's panels, which run only our script; widgets have the opaque origin "null"). Widget messages go to a separate handler keyed by known widget windows; the widget runtime accepts messages only from `parent`.
- Messages are schema-validated, size-capped and rate-limited with trailing coalescing (the latest call is delivered, not dropped).
- **Decoration needs no click; navigation does.** `highlight(lines, {anchor?, identifiers?})` decorates lines inside an anchor — by default the widget's nearest enclosing anchor; any named anchor is accepted if it is the current step or nested inside it — while that step is current (the editor already shows it); it never scrolls, opens files or takes focus; ≤ 10/s; identifiers validated with the manifest's identifier rule; lines clamped to the anchor. On a step change the panel clears highlights **before** sending `step` to widgets, so an effect that highlights in response sticks. Dropped calls are logged once per widget to Output. `reveal`, `goToStep`, `<Ref>`, `next`/`prev` and `key {action: next|prev|back}` require, at the moment the message arrives, that the panel sees user activation (`navigator.userActivation.isActive`) **and** that `document.activeElement` is that widget's frame. (Verified: focus moves on mousedown, before `click`, so a `reveal` posted from `onClick` arrives while the frame is active — including when focus moves directly from one widget to another, which fires no event in the panel; messages from one window arrive in order, so it also precedes the `focusExit` posted after the click.) So these work from a click or key handler, synchronously; not after an `await` or from a timer. And the activation must be the reader's interaction **with that widget**. With site isolation the panel can't see input inside a widget at all (no pointer events on its `<iframe>`; touch and hover-less pen taps give the panel nothing; wheel over a widget shows only the panel's own `scroll`), so the rule refuses only on evidence the panel has: a call or focus arrival is refused if, during the current activation window, the panel saw its **own** gesture (`pointerdown`, touch, or `keydown` in the panel or content frame) that wasn't followed by pointer travel toward this widget (the ray through the panel's last two pointer samples hits the widget's rectangle, which also covers fast moves that skip any band). If the panel saw no gesture of its own in the window, the activating gesture happened in a frame it can't see — the one that now holds focus — and it's accepted. A last pointer sample within ~24 px of the panel viewport's edge (the pointer left the webview) never counts as travel toward a widget. Focus the panel moved itself (Enter on the placeholder) always counts. This passes touch, pen, wheel-then-click and fast moves, and refuses a widget that grabs focus or navigates right after a click in the prose, a step button or the editor (the editor case is handled by the extension, below). ≤ 2/s. They return `Promise<boolean>`; dropped calls are logged to Output ("reveal() only works from a click in the widget").
- Key events from widgets are never re-dispatched as DOM events in the panel (VS Code's host turns synthetic keydowns into keybindings); only the validated `key` actions above.
- **Focus.** The runtime makes `focus()` a no-op unless the reader is interacting with the widget (best effort: a scriptless child frame has an unpatched `focus`, so the panel-side check is the real control). The panel detects theft without relying on the frame element's `focus` event (Chromium doesn't fire it for a frame gaining focus): focus is judged **once, when it arrives**, not continuously (activation lasts only ~5 s, and a reader may pause inside a widget). The panel keeps a record of which widget frame holds focus and whether it entered legitimately. Whenever a check (the panel window's `blur`, any widget message, each 1 s heartbeat) finds `activeElement` is a widget frame other than the recorded owner, it decides then: legitimate only under the same pointer rule as navigation, or if the panel moved focus there itself; otherwise theft — focus goes back to the placeholder, the attempt is counted, and repeated attempts unmount the widget. The record lasts until `activeElement` stops being that frame; a legitimate owner is never re-judged. (A click moving focus from widget A to B is caught within the activation window by the next heartbeat or message.) For focus pulled from outside the webview (the editor), the extension watches `onDidChangeViewState`; when the panel becomes active it asks the panel, which answers with the same test (a click inside a widget sets it, since activation propagates to ancestors; the panel itself sees no event for a click straight from the editor into a widget). Only if it's false does the extension refocus the previous editor group (`workbench.action.focusActiveEditorGroup`); if focus came from the terminal or sidebar that target is imperfect, which SECURITY.md accepts. While widgets are mounted and no widget holds focus legitimately, the panel also polls `document.hasFocus()` and `activeElement` every 200 ms (VS Code's host polls focus at 250 ms), bounding how long a theft from the editor goes unnoticed; SECURITY.md states that window. Phase 1 confirms in real VS Code which of these signals fire.
- **State:** ≤ 64 KB per widget, ≤ 256 KB per panel (least recently used dropped), writes coalesced to ≤ 1/s plus on hide/unmount.

### 5.4 Hardening inside widget frames (best effort)
- Applied by the bootstrap before anything else, so nested srcdoc frames running the same bootstrap are hardened too. **Not covered:** a scriptless child frame (`<iframe>` with no src, which has the widget's own opaque origin) exposes fresh, unpatched constructors and prototypes to the widget; this is why the hardening is best effort. Applied: `RTCPeerConnection`, `webkitRTCPeerConnection`, `RTCDataChannel` and related constructors removed (verified: 0 STUN packets with removal in the bootstrap); `<link>` creation for `prefetch`/`preconnect`/`dns-prefetch`/`prerender`/`modulepreload` refused at the `rel`/`href` setters and on insertion. Known to be incomplete (the parser and other paths remain), which is why §1 doesn't rely on it.
- Meta CSP in widget frames, enforced together with the inherited one: `default-src 'none'; script-src 'sha256-<bootstrap>' 'strict-dynamic'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; require-trusted-types-for 'script'; trusted-types default` — so widgets can't request `vscode-resource` URLs. `x-dns-prefetch-control: off` first.
- Sandbox: `allow-scripts` only; no `allow=` delegation (no camera, mic, clipboard API, fullscreen, `crossOriginIsolated`).

### 5.5 Supply chain and the compiler
- Exact pins with lockfile integrity for Sucrase, acorn and every widget library; updates reviewed.
- The compiler runs untrusted input in a worker with limits (§3).

### 5.6 Accepted and documented in SECURITY.md
- Widgets may reach the network (WebRTC, prefetch, future browser features): hence consent and the data limits.
- Deceptive UI inside the widget's box (framed and labeled "Interactive"), including a fake cursor drawn while the real pointer is inside the widget.
- Clipboard writes after a click, drag-out data (pastejacking).
- A widget that steals focus from the editor can receive up to ~200 ms of keystrokes before the panel notices.
- A widget the reader moves the pointer toward (or across, on the way out of the panel) within ~5 s of pressing J or clicking a panel control can navigate or take focus; stopping this would break "press J, then click the widget that came up".
- A widget can take focus within ~5 s of a click inside another widget (the panel can't see either click). A very fast pointer movement into a widget can skip past the 24 px edge band and be refused; the reader clicks again.
- Refocusing after a focus theft targets the active editor group, even if focus came from the terminal or sidebar.
- Escape and Tab are seen by widget code first; a widget can hold keyboard focus until the reader clicks elsewhere. VS Code shortcuts don't work while focus is in a widget.
- Side channels within the shared process.
- `useAnchorCode` exposes unsaved edits inside resolved anchors (the modal says so).
- Consent is updated by working-tree edits from any tool, including other extensions or agents writing files. Code that arrives without HEAD moving (`git checkout <rev> -- path`, `git restore --source`, `git apply` of a PR diff, `stash pop`, copying or unzipping an explainer in) is treated like the user's own edit and doesn't re-ask; without git, consent lasts for the workspace. The data limits (§5.2) apply regardless.
- The host-message origin check relies on the panel origin being shared only by this extension's panels, which run only our script.

## 6. Bridge and SDK

Widget → panel: `boot`, `ready`, `height {px ≤ 20000}`, `highlight {lines, anchor?, identifiers?}`, `reveal {anchor, lines?, highlight?}`, `step {anchor}`, `key {action}`, `state {json}`, `error {message ≤ 2 KB}`, `activity` (wheel/touch), `focusExit {dir}`, `requestCode {anchor}`.

Panel → widget: `load {scripts}`, `init {props, state, theme, viewportHeight, activeStep, myAnchor, anchors[], reducedMotion}`, `step`, `anchors`, `code {anchor, text, startLine, language, state}`, `theme`, `visible`, `viewport`, `saveState`.

SDK (`import … from 'explainer'`):
- **Steps:** `useActiveStep()`, `useMyAnchor()`, `useIsMyStepActive()`, `useIsActive(id)`, `useStep(): {id, index, count, next(), prev()}`, `useStepValue({refill: 0, drain: 1}, fallback)`.
- **Code:** `useAnchors()` (id, title, step index, file, current range, state, color), `useAnchorCode(id)` (text, startLine, language, state; live, including unsaved edits; §5.2 limits).
- **Editor:** `highlight(lines, {anchor?, identifiers?})` (lines are 1-based, relative to that anchor's current first line; pair with `useAnchorCode().startLine`), `reveal(id, {lines?, highlight?}): Promise<boolean>`, `goToStep(id): Promise<boolean>`, `<Ref anchor="id">text</Ref>`.
- **State:** `useWidgetState(key, initial)` — persisted across reloads, live edits, scrolling away and tab switches. Plain `useState` resets whenever the widget remounts (scrolling far away, switching editor tabs, live edits).
- **Environment:** `useTheme()` (kind, `color(name)`), `useVisible()`, `useReducedMotion()` (OS or VS Code's `workbench.reduceMotion`; the runtime also wraps widgets in Motion's `<MotionConfig reducedMotion>`), `asset(path)`.

What needs a click, for the guide:

| Works automatically | Needs a click in the widget |
|---|---|
| Reading steps, anchors, code, theme, visibility; step-driven animation; `useWidgetState`; `highlight` within the current step's anchor | `reveal`, `goToStep`, `<Ref>`, `next`/`prev` — called synchronously in the click handler (`onClick={async () => { await x; reveal(…) }}` fails: call it before any `await`). The panel already reveals each step's code, so widgets rarely need these. |

## 7. Theme

- shadcn token names mapped to VS Code variables: `background`, `foreground`, `card`, `popover`, `muted`, `muted-foreground`, `border`, `input`, `ring`, `primary`/`primary-foreground`, `secondary`, `accent`, `destructive`; `--chart-1…6` as complete colors. `hsl(var(--…))` is linted.
- `<html>` gets `.dark`/`.light`/`.hc` from the VS Code theme kind, with `@custom-variant dark (&:where(.dark, .dark *))`; `color-scheme` matches; background transparent; default font = the explainer body font.
- Phase 3 experiment: remap Tailwind's neutral scales to a ramp between editor background and foreground, judged by screenshots of ~20 typical artifacts in four themes. `white`/`black` unchanged; `bg-white` on the root linted.
- High contrast: shims draw `contrastBorder` and `focusBorder`; the guide requires visible focus and nothing conveyed by color alone.

## 8. Panel integration

- **Placeholders** decorated in `decorateTree`: reserved height, `tabindex="0"`, `role="group"`, `aria-label`, `aria-describedby` → fallback, an "Interactive" label.
- **Keyboard.** Tab reaches the placeholder in reading order; Enter or click focuses the widget (the panel writes the owner record, marked legitimate, synchronously before its own `frame.focus()` call — only panel-initiated moves are exempt from the activation rule). The runtime posts `focusExit {dir}` on Tab/Shift+Tab at its edges, on an unhandled Escape, on an unhandled modifier keydown (so the next shortcut works), and after a **pointer** click (`detail > 0`, or a preceding `pointerdown`) that didn't land in a text input, select or range — posted in a task after the `click` event, so the button's handler and any `reveal` it calls run first; shortcuts then keep working. Keyboard activation (Enter/Space, `detail === 0`) keeps focus in the widget. The panel focuses the placeholder with `preventScroll`, flagged as its own focus move so it doesn't pick a step. A one-time hint: "Esc leaves the widget".
- **Clicking or focusing inside a widget** makes its section current without scrolling; an explicit `goToStep` from the same click wins.
- **Live edits.** HTML morphs keep a widget mounted when key, `src` and props are unchanged. A changed source recompiles and remounts with saved state; a compile error keeps the last good version running, with an error badge.
- **Errors** in the box (message, file:line) with "Show fallback", and in Output (truncated, rate-limited).

## 9. Packaging

- Extension bundle: Sucrase (~300 KB) and acorn (~130 KB), in a worker; the standalone checker as `dist/check.cjs`.
- Widget libraries ≈ 2.3 MB minified including lucide's icon data; the `.vsix` ≈ 1.1 MB. CI size gate raised from 1 MB to 2 MB.
- `ThirdPartyNotices.txt` with every bundled library's license.
- Types for "Add Widget Types": lucide's generated (one `LucideIcon` declaration per exported name, ~100 KB) and the others bundled and trimmed (React, Recharts, d3, motion, lodash); counted against the size gate.

## 10. Phases

1. **Spike in real VS Code (go/no-go):** bootstrap + `'strict-dynamic'` + Trusted Types in the webview, with the sanitizer and morph working under enforced Trusted Types in the panel and content frame; process model (does a busy widget freeze the panel? VS Code?) and whether `panel.dispose()` tears down a hung webview; keyboard (shortcuts, copy/paste in widget inputs, Escape) and focus (can a widget take focus from the editor?); `vscode-resource` loads blocked; WebRTC removal; prefetch/preconnect; nested bootstrap; self-navigation.
2. **Core:** consent (bar + modal + hash), compile worker, libraries, frame host + bootstrap, placement contract, bridge with activation rules, data limits, the sample widget (FIFO ring buffer) in `fixtures/sample-workspace`.
3. **SDK, theme, shims, state, live reload, errors, keyboard/focus, watchdog, caps, neutral-ramp experiment.**
4. **Checker (command, diagnostics, standalone), types command, docs:** README, `docs/WIDGETS.md` (the guide for Claude: when a widget vs CSS-only; minimal example; the contract; imports and aliases; theming; linking to code — steps, `useAnchorCode`, `highlight`, the click table; placement rules; size to the container's width, not fixed pixels; focus rules; state; motion and performance; what doesn't work; accessibility; checking with the exact command; consent; a gallery of five examples), SECURITY.md.
5. **Tests and review** (§11); user agents build widgets; review agents until only nits.

## 11. Tests

- **Unit:** compile (TSX, aliases, JSON/images, errors, caps, path escapes, symlinks, worker timeout on pathological input), loop guards (unbraced bodies, labels, slow iterations), allow-list and named-export checks, message schemas, state caps, secret-file and tracked/ignored rules for `code` (including symlinked names), `useAnchorCode` reasons (a shape-only quote over a file holding a secret value, a range-only anchor, a v1 snippet anchor, a `ws-ci` quote, and a range-only anchor after Pin without confirmation all return `unavailable`; changed/stale served only when the quote matches HEAD exactly), consent hashing over the import closure and the git-HEAD re-ask rule, watchdog escalation.
- **Panel (Playwright harness):** mount/render; a Button `onClick` calling `reveal` returns true, including when focus moves directly from widget A to a button in widget B, while A's call during B's activation returns false, a `reveal` after an `await` returns false, and a widget that grabs focus (via a scriptless child frame) right after a click on a panel step button, with the pointer elsewhere, gets `false` and loses focus back to the placeholder (and, from the editor, focus returns to the editor), including two attempts in a row; pressing J then clicking the widget that came up works at once; clicking prose under a widget that then grows under the resting pointer and calls `reveal` or takes focus gets `false` and is refused; clicking prose 10 px below a widget, after which the widget steals focus and calls `reveal`, is refused; a touch tap, a fast pointer jump into a widget, and wheel-scrolling over a widget then clicking it all work; clicking a step button then leaving through the gutter beside a widget into the editor, after which the widget calls `focus()`, refocuses the editor; keyboard Enter on a widget button keeps focus in the widget; height sync and throttling; placement (allowed, unmounted-when-hidden, unsupported ancestors with named errors, clipping); `highlight` without a click, `reveal` only with a click in that widget; state across source edit, HTML edit, unmount/remount; caps; consent bar; keyboard and focus exits; theme and `dark:`; `h-screen`/`innerHeight`/`ResponsiveContainer`.
- **Isolation (Playwright, oracle style):** a hostile widget tries `parent.document`, `top`, `fetch`, XHR, WebSocket, `sendBeacon`, WebRTC (local STUN listener), prefetch/preconnect/dns-prefetch (local HTTP listener), `vscode-resource`/`blob:` URLs, `location`, `window.open`, form submit, meta refresh, nested srcdoc and about:blank frames (including a nested copy of the bootstrap, and a scriptless child frame used to reach unpatched constructors), `eval`/`new Function`, focus stealing, forged host messages to the panel (`init`, `content`, `error`, `navigate`; with `<script>`/`<iframe srcdoc>` payloads), messages to sibling widgets, floods, oversize messages, `__proto__` props. Each must fail, be ignored, or (for the network items the plan accepts) be documented by the test as current behavior.
- **End to end (real VS Code):** consent modal; a checkout of a branch that changes widget code with VS Code open makes the panel ask again; the sample widget renders; Step → widget updates; a click in the widget reveals code; `highlight` decorates; Restricted Mode shows the fallback and the trust bar; editing the widget file updates it live; a hanging widget is disabled by the watchdog and the panel recovers.

## 12. Phase 1 results (real VS Code, 2026-10-22)

`test/e2e/widgets-spike.e2e.ts` (run with `CX_SPIKE=1`, and `CX_SITE_ISOLATION=1` to model desktop process isolation):
- **Go.** The bootstrap runs by hash under the panel's CSP and Trusted Types, and appends scripts; the widget's origin is `null`; `parent.document` is blocked; WebRTC constructors are gone; `fetch` and a `vscode-resource` image are blocked; a `prefetch` link's `rel` is neutralized; the widget's `default` Trusted Types policy works. Phase 1a (Trusted Types + hash + `'strict-dynamic'` in the panel) passes every existing suite in real VS Code.
- **Pointer events:** without site isolation the panel sees `pointerover`/`pointerout` on the widget's `<iframe>`; with it (the real case) it sees none. Hence the pointer rule in §5.3 based on the panel's last pointer event.
- **Keyboard:** typing into a widget's input works; VS Code shortcuts (Quick Open) don't fire while focus is in the widget, as expected.
- **Focus theft:** a widget calling `focus()` without a click takes focus from the code editor (the workbench's active element becomes the webview). The extension-side refocus in §5.3 is required.
- **Busy and hung widgets:** headless Chromium (site isolation off) shares one process, so a busy widget stalls the panel *and* the workbench (11 of 40 timer ticks; an infinite loop made the workbench unresponsive). With site isolation and isolated sandboxed frames, neither stalls (40 of 40), the panel stays alive during an infinite loop, closing the editors removes the webview, and a new panel opens normally. VS Code desktop doesn't disable Electron's site isolation (its switches don't touch it), so a runaway widget can at worst freeze its own webview, not the window; whether Electron also isolates sandboxed frames (keeping the panel alive) is checked manually on desktop (TEST-PLAN.md).

## 13. Performance and memory

Budgets, measured by tests (Playwright harness with CDP metrics, and e2e):
- No growth after GC across 200 content updates, 50 explainer switches, 50 frame rebuilds, and 50 widget mount/unmount cycles (JS heap, DOM nodes, event listeners, blob URLs, widget frames back to baseline).
- Unmounted widgets release their frame, listeners, timers and cached state beyond `useWidgetState`; library texts are shared per panel, not copied per widget.
- Measured at the browser level, since under isolation widget memory and DOM live in the shared widget process, not the panel: `SystemInfo.getProcessInfo`/`Target.getTargets` show the widget process and iframe targets back to baseline after unmounting everything; each widget target's heap is measured where the harness can attach.
- Off-screen widgets: Chromium throttles rendering and `requestAnimationFrame` in off-screen cross-origin frames but not timers, so the runtime itself suspends the timers, intervals and animation frames it wraps, and pauses CSS animations, while `visible` is false.
- Mounting a widget with React + Recharts: < 150 ms to first paint, for one widget and for each of 8 mounted at once (measured under isolation: 55 ms for one, 68–148 ms for 8); at most 8 mounted.
- Extension host: compile worker reused; compile cache bounded (LRU by size); watchers per explainer disposed on switch and panel close; the extension host's memory flat across open/close cycles.

## 14. Later

Three.js, Mermaid, KaTeX, WaveDrom as on-demand libraries; inline widgets in `explainer.html` for one-file explainers; precompiled Tailwind instead of the browser runtime; React Fast Refresh to keep plain `useState` across edits.
