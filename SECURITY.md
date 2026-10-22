# Security

## Reporting a vulnerability

Please report security problems privately to the maintainer ([email removed]) rather than in a public issue. Include a minimal explainer or repository that reproduces the problem. You'll get an acknowledgement within a few days.

## Threat model

Code Explainer renders files from the repository you open. Those files may come from anyone: a cloned project, a pull request branch, a teammate. The extension treats everything under `.explain/`, every file an anchor points at, and every asset an explainer references as **untrusted input**. It runs in Restricted Mode (untrusted workspaces) because it never executes anything from the repository.

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
- Explainer authors can't run their own scripts. That's deliberate; interactive explainers would need a separate, opt-in design.
