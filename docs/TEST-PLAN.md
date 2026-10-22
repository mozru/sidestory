# Test plan

## Automated

| Suite | Command | What it covers |
|---|---|---|
| Unit | `npm test` | Manifest parsing and limits, anchor resolution (moves, edits, duplicates, renames, huge files), live range tracking, quote pinning, symlink containment |
| Panel | `npm run build && npm run test:webview` | The explainer panel in Chromium with VS Code's theme variables and the panel's CSP: sync both ways, live updates keeping the reader's place and focus, the cursor pill, anchor states, sanitizing, containment, keyboard, accessibility scans (dark, light, high contrast), screenshots at 340/600/1000px |
| End to end | `npm run test:e2e` | The packaged extension in browser VS Code, with the server in a Linux container (the same split as Remote-SSH: extension on the remote host, panel in the client). Restricted Mode, step → code, cursor → step, live explainer and code edits, images in the content frame, theme screenshots. Needs Docker. |

## Manual: Remote-SSH (about 10 minutes)

1. `npm run package`, then copy `dist/code-explainer.vsix` somewhere reachable.
2. Connect to a Linux host with **Remote-SSH**, open a folder, and run **Extensions: Install from VSIX…**. Check the extension installs **in SSH: <host>** (not locally).
3. Copy `fixtures/sample-workspace` to the host and open it.
4. **Code Explainer: Open Explainer** → `bit-reader`. Check:
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
   - [ ] Rename `backoffDelay` in `src/retry.ts` and save, then **Code Explainer: Pin Anchors**: the result names each anchor it left and why, then offers a checklist; ticking one pins it, and `manifest.json` keeps its formatting.
   - [ ] Delete the body of `backoffDelay`: its section offers **Re-anchor to the selected code**; select other lines, click it, confirm: the section links to them.
   - [ ] Open a v1 manifest (no `quote`): a one-time notice offers **Pin Anchors**.
6. Repeat steps 4–5 in desktop VS Code locally (F5 in this repo opens an Extension Development Host).

## Manual: things to watch for

- The panel briefly blank or jumping when the host is slow (resolve runs on the host).
- File watching on network file systems (NFS, `/mnt/c` in WSL) may miss changes made outside VS Code.
