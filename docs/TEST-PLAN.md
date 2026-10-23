# Test plan

## Test matrix

| Suite | Command | Linux | Windows | macOS | Notes |
|---|---|---|---|---|---|
| Unit (core, extension logic, compiler, line endings, leaks) | `npm test` | CI | VM, CI | local, CI | Windows checkouts are CRLF |
| Panel (webview in Chromium) | `npm run build && npm run test:webview` | CI | VM, CI | local, CI | |
| Widget frames | `npm run test:widgets` | CI | VM, CI | local, CI | |
| Desktop VS Code (Electron), 1.95.0 and stable, LF and CRLF | `npm run test:desktop` | CI (xvfb) | VM, CI | local, CI | A workspace path with a space and non-ASCII characters |
| Browser VS Code (openvscode-server in Docker) | `npm run test:e2e` | local, CI | — | — | Also with `CX_SITE_ISOLATION=1` |
| Manual: Remote-SSH, desktop widget isolation | below | — | yes | yes | |

CI (`.github/workflows/ci.yml`) runs once the repository is on GitHub. Until then Windows runs in a local VM.

### Windows VM (local)

A Windows 11 ARM64 VM under QEMU with Apple's hypervisor, kept in `~/VMs/windows` (outside the repo): `vm.sh start|stop|ssh|shot`, SSH on 127.0.0.1:2222 with a dedicated key, a local test account (credentials in `credentials.txt`, owner-only), Node 24 and Git for Windows. Installed unattended from Microsoft's ISO (checksum verified); Windows is unactivated, which doesn't affect testing.

`test/windows/run-in-vm.sh [unit|panel|desktop|all]` clones HEAD inside the VM with Git for Windows' defaults (a CRLF checkout), runs `npm ci`, then the unit, panel and widget-frame suites over SSH, and the desktop VS Code suite (1.95.0 and stable, LF and CRLF) as a task in the logged-in session, since Electron needs the interactive desktop.

### Disk

- e2e: the image is ~1 GB; setup warns below 5 GB free and removes this project's stale images after each rebuild (`docker image prune --filter label=org.sidestory.test=e2e`).
- Desktop VS Code downloads are cached in `.vscode-test/` (~200 MB per version); delete the folder to reclaim them.
- Windows VM: the disk grows to ~30 GB; the ISO and guest tools (5 GB) can be deleted once installed.

## Automated

| Suite | Command | What it covers |
|---|---|---|
| Unit | `npm test` | Manifest parsing and limits, anchor resolution (moves, edits, duplicates, renames, huge files), live range tracking, quote pinning, symlink containment; the widget compiler and loop guards; the standalone widget checker (`check-cli.test.ts`: HTML and CSS scanning, props, anchor ids, `--pin` and its consent rule); every widget in `docs/WIDGETS.md` compiling and typechecking against `src/widget-types` (`widgets-guide.test.ts`) |
| Widgets | `npm run build && npm run test:widgets` | The widget runtime and libraries in real sandboxed frames: SDK, shims, theme, height, loop guard, performance |
| Panel | `npm run build && npm run test:webview` | The explainer panel in Chromium with VS Code's theme variables and the panel's CSP: sync both ways, live updates keeping the reader's place and focus, the cursor pill, anchor states, sanitizing, containment, keyboard, accessibility scans (dark, light, high contrast), screenshots at 340/600/1000px |
| End to end | `npm run test:e2e` | The packaged extension in browser VS Code, with the server in a Linux container (the same split as Remote-SSH: extension on the remote host, panel in the client). Restricted Mode, step → code, cursor → step, live explainer and code edits, images in the content frame, theme screenshots. Needs Docker. |

## Manual: Remote-SSH (about 10 minutes)

1. `npm run package`, then copy `dist/sidestory.vsix` somewhere reachable.
2. Connect to a Linux host with **Remote-SSH**, open a folder, and run **Extensions: Install from VSIX…**. Check the extension installs **in SSH: <host>** (not locally).
3. Copy `fixtures/sample-workspace` to the host and open it.
4. **Sidestory: Open Explainer** → `bit-reader`. Check:
   - [ ] The panel opens beside the editor, in your theme's colors.
   - [ ] Clicking step 5 opens `rtl/bit_reader.sv` and highlights lines 35–38.
   - [ ] Putting the cursor on line 32 makes step 4 current.
   - [ ] Typing two lines at the top of `bit_reader.sv` (don't save): the status still says Linked; step 5 still highlights the refill block.
   - [ ] On the host, run `sed -i 's/Three one-line rules/Three tiny rules/' .explain/bit-reader/explainer.html`: the heading changes in the panel without a reload, and your place is kept.
   - [ ] `retry-backoff` shows its small diagram image.
   - [ ] Switch theme (dark → light → high contrast): the panel follows each time.
5. Navigation and Pin (the dialogs have no automated tests yet). Open `overview`:
   - [ ] Step 2, then **Retry with … in brief** opens a summary in place; **Dive into …** shows that explainer with a trail; **Back** (or <kbd>Esc</kbd>) returns to step 2.
   - [ ] Reload the window while dived: the panel comes back with its trail.
   - [ ] Rename `backoffDelay` in `src/retry.ts` and save, then **Sidestory: Pin Anchors**: the result names each anchor it left and why, then offers a checklist; ticking one pins it, and `manifest.json` keeps its formatting.
   - [ ] Delete the body of `backoffDelay`: its section offers **Re-anchor to the selected code**; select other lines, click it, confirm: the section links to them.
   - [ ] Open a v1 manifest (no `quote`): a one-time notice offers **Pin Anchors**.
6. Repeat steps 4–5 in desktop VS Code locally (F5 in this repo opens an Extension Development Host).

## Manual: widgets (about 20 minutes)

Use an explainer with a widget: the sample workspace's, or the minimal example from `docs/WIDGETS.md` §2 added to `bit-reader`. For the hang checks, add a second widget whose button runs a regular expression that never finishes (loop guards don't stop regex backtracking):

```tsx
export default function Hang() {
  return <button onClick={() => /(a+)+$/.test('a'.repeat(40) + 'b')}>Hang</button>;
}
```

1. Consent and trust:
   - [ ] With `sidestory.widgets.enabled` off, the panel shows each widget's fallback and no consent bar.
   - [ ] Turn it on in User settings; then in the repository's `.vscode/settings.json` turn it off and on again: the workspace value is ignored.
   - [ ] The bar says how many widgets the explainer has; **Run widgets…** opens a native VS Code dialog naming the explainer and what widgets can do. **Cancel** keeps the fallbacks; agreeing mounts the widgets without reopening the panel.
   - [ ] Edit the widget file and save: it updates in place, and the slider/counter state set with `useWidgetState` survives. No dialog.
   - [ ] Commit, switch to a branch where the widget file differs, switch back with VS Code open: the panel asks again.
   - [ ] **Sidestory: Revoke Widget Consent**: the widgets go back to their fallbacks.
   - [ ] In Restricted Mode (**Workspaces: Manage Workspace Trust** → don't trust): fallbacks and a "Trust workspace…" bar; trusting mounts the widgets.
2. Linking:
   - [ ] Step through the explainer: the widget follows (`useStepValue`), and highlights its lines while its step is current.
   - [ ] A click on a `<Ref>` or a button calling `reveal` shows the code in the editor; the same call from a timer does nothing and is logged in **Output › Sidestory**.
   - [ ] `useAnchorCode` on an unpinned anchor gives the widget's empty state; the Problems panel says `not-pinned`. **Pin Anchors** lists the files and line ranges widgets would read and asks before pinning them.
3. Focus and keyboard:
   - [ ] Tab reaches the widget's placeholder; Enter moves into the widget; Esc leaves it; Tab past the last control leaves it.
   - [ ] Click a widget button, then press <kbd>Alt</kbd>+<kbd>]</kbd>: the shortcut works (focus went back to the panel).
   - [ ] Type in the editor while a widget that calls `focus()` on a timer is on screen: the editor keeps (or quickly gets back) focus.
4. Look:
   - [ ] Dark, light, high contrast dark and light: the widget uses the theme's colors and borders, and focus is visible.
   - [ ] Narrow the panel to about 340 px: the widget fits its column; no horizontal scrollbar.
   - [ ] Turn on **Reduce Motion** (`workbench.reduceMotion`): Motion animations stop.
5. Process isolation (VS Code desktop, Electron; the e2e suite can't model this, see `docs/WIDGETS-PLAN.md` §12). Open **Developer: Open Process Explorer** next to the panel:
   - [ ] With a widget mounted, note whether the widget frames run in a renderer process separate from the webview's (Process Explorer lists the webview and any out-of-process frames).
   - [ ] Click **Hang**. VS Code's window stays responsive (menus, editor typing).
   - [ ] Record whether the panel itself stays responsive (scrolling, step buttons) while the widget hangs: yes means Electron isolates sandboxed frames (the panel-side watchdog handles it); no means they share the panel's process (the extension-side watchdog handles it).
   - [ ] Within about 10 s the hung widget is disabled, the panel recovers (recreated if it had frozen) at the same step, and a notification names the widget file and offers **Enable widgets**. With the regex removed and the file saved, the widget runs again.
   - [ ] Repeat with two explainer panels open side by side: a hang in one panel's widget doesn't leave the other panel's widgets unrecoverable.
6. Standalone checker, from a terminal in the sample workspace:
   - [ ] `node "$(ls ~/.vscode*/extensions/*sidestory*/dist/check.cjs | tail -n 1)" .explain/bit-reader` lists problems as `file:line: severity code: message` and exits 1 when there are errors.
   - [ ] `--pin` pins anchors widgets don't read, lists the files and line ranges of those they do, and pins those only with `--yes-widgets-may-read`.

## Manual: things to watch for

- The panel briefly blank or jumping when the host is slow (resolve runs on the host).
- File watching on network file systems (NFS, `/mnt/c` in WSL) may miss changes made outside VS Code.
