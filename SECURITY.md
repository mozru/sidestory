# Security

## Reporting a vulnerability

Please report security problems privately to the maintainer ([email removed]) rather than in a public issue. Include a minimal explainer or repository that reproduces the problem. You'll get an acknowledgement within a few days.

## Threat model

Code Explainer renders files from the repository you open. Those files may come from anyone: a cloned project, a pull request branch, a teammate. The extension treats everything under `.explain/`, every file an anchor points at, and every asset an explainer references as **untrusted input**. It runs in Restricted Mode (untrusted workspaces) because, there, it never executes anything from the repository. The one exception, interactive widgets, is opt-in and described in its own section below.

What an explainer can do: show HTML and CSS in the panel, with images, fonts and stylesheets from its own folder; ask the editor to show and highlight lines of files inside the repository; offer links that you click.

What it can't do, and how that is enforced:

| Concern | Protection |
|---|---|
| Running script | Explainer content renders in an iframe sandboxed without `allow-scripts`, under a CSP that allows only the panel's own script (by nonce). Event handlers, `<script>`, `javascript:` URLs, SVG script and animation are also stripped. |
| Covering or faking the panel's controls | Content is confined to the iframe's box, including the browser top layer (dialogs, popovers, select pickers). |
| Reaching the network | CSP `default-src 'none'`; no `connect-src`; remote images, fonts, stylesheets and `@import` are dropped. |
| Reading files outside the repo | Manifest paths must be canonical repo-relative paths (no `..`, absolute, drive, UNC, URL, glob or control characters; no `.git`). Files are read only after following symlinks and confirming the real path is inside the repo; assets only inside the explainer's own folder, of allowed types and sizes. |
| Leaking local paths or reaching local services through links | External links open only for public `http(s)`/`mailto` URLs without credentials; `localhost`, `*.local`, private, loopback and link-local addresses are refused (on a remote host VS Code would tunnel them). Links to other explainer files open inside VS Code. |
| Exhausting CPU or memory | Size limits on manifests (1 MB), HTML (5 MB), code files (10 MB), assets (5 MB each, 20 MB per panel); limits on anchor counts, quote sizes and identifier lists; anchor resolution runs with a per-anchor work budget and yields between anchors. |
| Abusing the webview ↔ extension channel | Every message from the panel is validated against a schema; anchor ids, paths and URLs are re-checked by the extension. |

## Known limits

- `localResourceRoots` includes the `.explain/` folder (a panel can move between the explainers in it). VS Code checks resource paths by prefix, not by real path, so a symlink inside `.explain/` could in principle expose another readable file to the panel's own resource loader. Explainer content itself can't load such URLs (assets go through the extension, which checks real paths), and the panel can't send data anywhere.
- Explainer HTML can't run script. Code from the repository runs only as widgets, below.

## Interactive widgets

Widgets are React components in an explainer's folder (`<explain-widget src="widgets/x.tsx">`). Unlike the rest of an explainer, **they are code from the repository, and they run.** The boundary is your informed consent plus limits on what a widget can see; the sandbox makes misuse harder but is not treated as containment.

### When widgets run

- Never in Restricted Mode (an untrusted workspace), and never while the `codeExplainer.widgets.enabled` setting is off. The setting is application-scoped: a repository's `.vscode/settings.json` can't turn it on.
- Only after you agree in a **native VS Code dialog** (not in the panel, whose content the explainer controls). It names the explainer and its changed files, and says that widgets can read the code the explainer points at, including unsaved edits, and may be able to reach the network.
- Consent is kept per workspace, with a hash of every file each explainer's widgets load (code, JSON, images). You're asked again when changed widget code arrives through git (a checkout, pull, merge or rebase moves HEAD, or the first open after a clone), and always when the folder is in a git repository VS Code's git extension doesn't know. Edits in the working tree, by you or by any tool, are treated as yours and don't re-ask. **Code Explainer: Revoke Widget Consent** clears it.
- All of this is enforced by the extension host: the panel gets no compiled code, libraries or file contents for widgets without trust, the setting and consent.

### What a widget can reach

- **Its own frame.** Each widget runs in an `<iframe sandbox="allow-scripts">` with an opaque origin, created by the panel and laid over the explainer. It can't reach the panel's document, VS Code, other widgets, the file system or VS Code's resource URLs. The frame's CSP allows only the bootstrap script (by hash) and what it loads, inline styles, and `data:`/`blob:` images, fonts and media; `eval`, popups, dialogs, form submission and navigation of other frames are blocked. `fetch`, XHR, WebSocket, EventSource and `sendBeacon` are replaced with stubs that refuse, and WebRTC constructors and `<link rel=prefetch|preconnect|dns-prefetch|prerender|modulepreload>` are removed inside the frame. That last hardening is best effort: a widget can create a scriptless child frame whose constructors are unpatched.
- **Code, only when its author demonstrably knew it.** `useAnchorCode` returns an anchor's code only when the anchor's pinned quote (whitespace-normalized, case-sensitive) is committed in git or was confirmed by you in VS Code, the code matches it in full (or, for files tracked by git, the quote matches the committed version and the differences are working-tree edits), the file isn't ignored by git, isn't secret-looking (`.env*`, `*secret*`, `*token*`, `*credential*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keystore`, `*.jks`, `*.tfvars`, `*.local.*`, `appsettings.*.json`, `*kubeconfig*`, `.npmrc`, `.netrc`, `.pypirc`, `.git-credentials`, `.dockercfg`, `.htpasswd`, `id_*`, matched against the anchor's path and the real file name), and is at most 2,000 lines. Git state comes from VS Code's git extension; the extension never runs git itself. Pinning anchors that widgets read asks you first (a native dialog listing the files and line ranges); the standalone checker refuses to pin them unless given `--yes-widgets-may-read`.
- **Files it imports** from the explainer folder only (real paths checked, sizes capped, the same secret-file names refused). Each widget gets only its own props, state and code.
- **The editor, within limits.** A widget can highlight lines inside the current step's code without a click. Showing code, changing steps and moving focus need a click or key press in that widget, checked by the panel when the request arrives (user activation, the widget's frame holding focus, and no gesture of the panel's own that pointed elsewhere). Requests are schema-checked, size-capped and rate-limited.
- **Resources.** Widget code is compiled in a worker thread with time and memory limits. In the frame, loops are guarded (stopped after about 1 s without yielding), a watchdog unmounts and disables a widget that stops answering, and at most 8 widgets are mounted at once (24 per explainer).

### Accepted risks

These are known and accepted; they are why running widgets needs your consent.

- **Widgets may reach the network.** WebRTC, prefetch-style links and future browser features can get past the frame's CSP; the hardening above reduces casual misuse but isn't complete. Treat anything a widget can see (its props, its state, the code `useAnchorCode` gives it) as something it could send out.
- **Deceptive UI inside the widget's box.** A widget can draw anything in its box, which the panel frames and labels "Interactive", including a fake cursor drawn while the real pointer is inside it.
- **Clipboard writes and drag-out data** after a click in the widget (pastejacking): check what you paste.
- **Focus theft from the editor.** A widget that takes focus without a click can receive up to about 200 ms of keystrokes before the panel notices and gives focus back.
- **Pointer-based allowances.** Within about 5 s of pressing J or clicking a panel control, a widget the pointer moves toward (or across, on the way out of the panel) can navigate or take focus; refusing it would break "press J, then click the widget that came up".
- **Between widgets.** A widget can take focus within about 5 s of a click inside another widget: the panel sees neither click.
- **Touch.** With no pointer samples, a tap on the prose followed within about 5 s by a tap on a widget is refused; tap again.
- **Refocus target.** After a focus theft, focus returns to the active editor group, even if it was taken from the terminal or the sidebar.
- **Keyboard.** Escape and Tab are seen by widget code first, so a widget can hold keyboard focus until you click elsewhere. VS Code shortcuts don't work while focus is in a widget.
- **Side channels** between widgets and the panel in the shared renderer process (timing, memory pressure).
- **Unsaved edits.** `useAnchorCode` serves the live text of a resolved anchor, unsaved edits included (the consent dialog says so).
- **Consent follows the working tree.** Widget code changed by any tool, including other extensions or agents writing files, counts as your own edit and doesn't re-ask. Code that arrives without HEAD moving (`git checkout <rev> -- path`, `git restore --source`, `git apply` of a pull request's diff, `git stash pop`, copying or unzipping an explainer in) doesn't re-ask either; without git, consent lasts for the workspace. The limits on what widgets can see apply regardless.
- **Panel origin.** The panel accepts host messages only from its own origin, which relies on that origin being shared only by this extension's panels, which run only its own script.
- **Hangs.** A widget that hangs freezes the other widgets (they share one process). Where sandboxed frames aren't isolated in their own process, it also freezes the panel, and in a browser without site isolation (possible when VS Code runs in a browser) the whole VS Code tab, until the watchdog disposes the panel and recreates it with that widget disabled. VS Code desktop keeps site isolation on, so there a runaway widget can't freeze the window.
