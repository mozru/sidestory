# Driving VS Code's native diff editor from a third-party extension

Checked 2026-10-21 against `main` of microsoft/vscode and microsoft/vscode-pull-request-github.
Status key: **Stable** = in `vscode.d.ts` or documented built-in command. **Proposed** = `vscode.proposed.*.d.ts`, so it needs `enabledApiProposals` and cannot ship on the Marketplace. **Internal** = a workbench/editor command id that works through `executeCommand` but is undocumented and can be renamed. **Git-ext** = the built-in Git extension's exported API (versioned contract `getAPI(1)`, not core).

Sources:
- S1 `vscode.d.ts`: https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.d.ts
- S2 Built-in commands doc: https://code.visualstudio.com/api/references/commands
- S3 Command registrations: https://github.com/microsoft/vscode/blob/main/src/vs/workbench/api/common/extHostApiCommands.ts
- S4 `git.d.ts`: https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts
- S5 git URI helper: https://github.com/microsoft/vscode/blob/main/extensions/git/src/uri.ts
- S6 Proposed APIs: https://github.com/microsoft/vscode/tree/main/src/vscode-dts (`diffCommand`, `documentDiff`, `quickDiffProvider`, `tabInputMultiDiff`, `textEditorDiffInformation`, `scmMultiDiffEditor`, `contribDiffEditorGutterToolBarMenus`, `contribMultiDiffEditorMenus`, `commentReveal`)
- S7 Diff editor commands: https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/parts/editor/diffEditorCommands.ts and https://github.com/microsoft/vscode/blob/main/src/vs/editor/browser/widget/diffEditor/commands.ts
- S8 Diff settings schema: https://github.com/microsoft/vscode/blob/main/src/vs/editor/common/config/editorConfigurationSchema.ts
- S9 PR extension: https://github.com/microsoft/vscode-pull-request-github (`package.json`, `src/common/uri.ts`, `src/view/reviewManager.ts`, `src/view/reviewCommentController.ts`)

## 1. Opening diffs

| Capability | API | Status | Notes |
|---|---|---|---|
| Open a 2-way diff | `commands.executeCommand('vscode.diff', left: Uri, right: Uri, title?: string, options?: TextDocumentShowOptions)` | Stable (S2, S3) | `options` = `{ viewColumn?, preserveFocus?, preview?, selection?: Range }`. In the registration the 4th arg must be an object (a bare ViewColumn number is rejected for `vscode.diff`, unlike `vscode.open`). `selection` applies to the **modified (right)** side and reveals it, which is how you open a diff scrolled to a line range. The command returns `void`, not the editor. |
| Open the multi-file "changes" editor | `executeCommand('vscode.changes', title: string, resources: [labelUri: Uri, left?: Uri, right?: Uri][])` | Stable, documented (S2, S3) | Each entry must be a 3-tuple. Use `undefined` for left on added files and `undefined` for right on deleted files. There are no options: no viewColumn, no selection, and no way to scroll to one file. |
| Detect the multi-diff tab | `TabInputTextMultiDiff` | Proposed `tabInputMultiDiff` (S6) | On stable, `tab.input` for a multi-diff tab is `unknown`. |
| Scroll an already open diff | Re-run `vscode.diff` with the same URIs and a new `selection`, or call `TextEditor.revealRange` on the side's editor (see §3) | Stable | Re-running with the same pair focuses the existing tab. |

## 2. Producing left/right content at arbitrary commits

| Capability | API | Status | Notes |
|---|---|---|---|
| Get the Git API | `extensions.getExtension('vscode.git').exports.getAPI(1)` | Git-ext (S4) | Copy `git.d.ts` into your repo. Declare `extensionDependencies: ["vscode.git"]`. |
| Repo lookup | `api.getRepository(uri)`, `api.repositories`, `api.openRepository(root)` | Git-ext | |
| File at a commit | `repo.show(ref, path): Promise<string>`, `repo.buffer(ref, path): Promise<Buffer>` | Git-ext | `buffer` is the safe choice for binary or non-UTF8 files. |
| Merge-base | `repo.getMergeBase(ref1, ref2)` | Git-ext | Gives the "merge-base with main" base. |
| Changed files | `repo.diffBetween(ref1, ref2)` returns `Change[]`. Also `diffWith(ref)`, `diffWithHEAD()`, `diffIndexWith*`, `diffBetweenWithStats` | Git-ext | Use `Change.uri`, `originalUri` and `status` (renames included) to build `vscode.changes` tuples. |
| History / picker | `repo.log({ maxEntries, path, range?... })`, `getCommit(ref)`, `getRefs(query)` | Git-ext | Feeds "any chosen commit" and "last reviewed commit". |
| `git:` URIs | `api.toGitUri(fileUri, ref)` | Git-ext (function is stable). The URI shape is an **implementation detail** | Shape (S5): `scheme 'git'`, `path = file path`, `query = JSON.stringify({ path: fsPath, ref })`, where `ref` is `''`, `'~'`, `':1'`, `HEAD`, or a sha. Always build these with `toGitUri` and never hand-craft them. Diagnostics extensions sometimes lint `git:` docs (git uses `.git`-suffixed paths in some flows to avoid this). |
| Own content provider | `workspace.registerTextDocumentContentProvider('sidestory-rev', provider)` returning `repo.show()` output | Stable | Read-only. You control the URI (embed repo, ref, path), so you can match it in commentingRangeProvider, CodeLens and so on. Fire `onDidChange` to refresh. Alternative: `registerFileSystemProvider` with `isReadonly`, needed if you want `stat` or binary support. The PR extension uses custom `review:` and `pr:` schemes (S9). |
| Remote-SSH / WSL / Codespaces | Run as a **workspace** extension (`extensionKind: ["workspace"]`, the default for extensions with code) | Stable | The Git extension runs in the remote extension host. Both `git:` docs and your provider resolve remotely. Only the webview renders locally. A UI-kind extension cannot call the remote Git API. On vscode.dev/virtual workspaces there is no Git extension, so you need a fallback. |

**Recommendation:** use a custom read-only scheme whose provider calls `repo.show`. It keeps the URI contract yours, makes language features and comments filterable by scheme, and is not affected by changes to the `git:` query format.

## 3. Interacting with an open diff editor

| Capability | API | Status | Notes |
|---|---|---|---|
| Detect a diff tab | `window.tabGroups.all[].tabs[].input instanceof TabInputTextDiff` gives `{original, modified}`, plus `onDidChangeTabs` | Stable (S1) | Tab-level information only, with no handle to the editor widget. |
| Get each side's `TextEditor` | `window.visibleTextEditors` includes **both** the original and modified editors of a side-by-side diff. Match them by `document.uri` against the tab input | Stable (observed behaviour, not documented in the `.d.ts`) | `activeTextEditor` is the focused side. In inline mode only the modified editor is a real editor. There is no stable `TextEditor` to `diff` link. Match by URI, and use `viewColumn` to disambiguate. |
| Decorations on either side | `editor.setDecorations(type, ranges)` on each side's TextEditor | Stable | Works on left and right, including on read-only custom-scheme docs. This is the main annotation channel (gutter icons, `after` text, background). In inline mode, decorations on the original side aren't shown for deleted lines. |
| Hover / CodeLens / inlay hints | Register providers with a selector that includes your scheme, e.g. `[{scheme:'file'},{scheme:'sidestory-rev'}]` | Stable | Hovers and inlay hints work on both sides. CodeLens in diff editors is off by default and only appears when the user sets `diffEditor.codeLens: true` (S8), so don't depend on it. |
| Comments on diff sides | `comments.createCommentController` + `commentingRangeProvider.provideCommentingRanges(doc)`. `createCommentThread(uri, range, comments)` with the uri of either side | Stable | Works on any scheme. The PR extension parses its `review:` URI query in `provideCommentingRanges` to decide the ranges (hunk ranges) and returns `{ ranges, enableFileComments }` (S9). Threads on the left side use the original-side URI. `thread.reveal()` is proposed (`commentReveal`). |
| Reveal a range | `editor.revealRange(range, TextEditorRevealType.InCenter)` + set `editor.selection` | Stable | Do this on the matched side editor. Alternatively reopen with `vscode.diff` and `selection` (right side only). |
| Selection / cursor per side | `editor.selections`, `window.onDidChangeTextEditorSelection`, `onDidChangeTextEditorVisibleRanges`, `onDidChangeActiveTextEditor` | Stable | Fires for whichever side the user acts in. You can sync the webview from it. |
| Changes list / "moved to next change" | No event. `textEditor.diffInformation` + `window.onDidChangeTextEditorDiffInformation` | Proposed `textEditorDiffInformation` (S6) | Stable workaround: compute hunks yourself (`git diff` via `diffBetween(r1, r2, path)` or a JS diff lib) and infer the "current change" from selection and visible ranges. |
| Navigate changes | `workbench.action.compareEditor.nextChange` / `previousChange`, `accessibleDiffViewer.next` / `prev` | Internal (S7) | Usable via `executeCommand`, but not documented. |
| Command receiving line changes | `commands.registerDiffInformationCommand` | Proposed `diffCommand` | |
| Core diff algorithm | `workspace.getTextDiff(orig, mod, {computeMoves})` | Proposed `documentDiff` | |
| Inline vs side-by-side | Setting `diffEditor.renderSideBySide` (global, via `getConfiguration().update`). Commands `toggle.diff.renderSideBySide`, `diffEditor.setViewMode.inline` / `.sideBySide` / `.automatic` | Setting = stable contract. Commands = Internal (S7) | No per-editor API. Writing user settings is intrusive, so prefer the internal toggle command with a guard, or leave it to the user. `diffEditor.useInlineViewWhenSpaceIsLimited` (default on) flips the view to inline in narrow layouts, which matters when your webview sits beside it. |
| Focus a side | `workbench.action.compareEditor.focusPrimarySide` / `focusSecondarySide` / `focusOtherSide`, `swapSides` | Internal | |

## 4. Other useful surfaces

| Capability | API | Status | Notes |
|---|---|---|---|
| Diff settings | `diffEditor.hideUnchangedRegions.enabled` / `contextLineCount` / `minimumLineCount` / `revealLineCount`, `diffEditor.experimental.showMoves`, `diffEditor.ignoreTrimWhitespace`, `diffEditor.diffAlgorithm`, `diffEditor.wordWrap`, `diffEditor.renderGutterMenu`, `diffEditor.experimental.useTrueInlineView` (S8) | Settings, which are global only. `experimental.*` can change | Commands: `diffEditor.toggleCollapseUnchangedRegions`, `diffEditor.toggleShowMovedCodeBlocks`, `diffEditor.collapseAllUnchangedRegions`, `diffEditor.showAllUnchangedRegions` are Internal (S7). Can be set as language- or workspace-scoped config, but not per editor. |
| Gutter quick-diff base (file editor shows diff vs our chosen base) | `scm.createSourceControl(...)` and set `sourceControl.quickDiffProvider = { provideOriginalResource(uri) }` | Stable (S1) | Side effect: adds an SCM provider entry to the Source Control view. VS Code supports multiple quick diffs (the primary is git). |
| Same, without an SCM provider | `window.registerQuickDiffProvider(selector, provider, id, label, rootUri)`, `SourceControl.secondaryQuickDiffProvider` | Proposed `quickDiffProvider` (S6) | This is what the PR extension uses (S9, `reviewManager.ts`). |
| SCM view to multi-diff | `SourceControlResourceState.multiDiffEditorOriginalUri`, `createResourceGroup(..., {multiDiffEditorEnableViewChanges})` | Proposed `scmMultiDiffEditor` | |
| Diff toolbar/gutter menus | `diffEditor/gutter/*`, `multiDiffEditor/*` contribution menus | Proposed (S6) | The stable `editor/title` menu with `when: isInDiffEditor` / `resourceScheme == sidestory-rev` works, so you can add a title-bar "Explain this diff" button. |
| Timeline | `workspace.registerTimelineProvider` | Proposed (`timeline`) | Not usable on the Marketplace. Use your own TreeView or webview for history. |
| Accessible diff viewer | `accessibleDiffViewer.next` / `prev` (F7 / Shift+F7) | Internal | Built in, so you get it for free. Mention it in your docs. |
| GitHub PR review mode (S9) | Stable: custom `review:`/`pr:` content providers, `vscode.diff` / `vscode.changes`, Comments API with `commentingRangeProvider`, TreeView of changed files, `FileDecorationProvider` | Uses **proposals** (from `enabledApiProposals`): `quickDiffProvider`, `diffCommand`, `tabInputMultiDiff`, `commentReveal`, `commentThreadApplicability`, `commentingRangeHint`, `commentsDraftState`, `activeComment`, `commentReactor`, `contribComment*Menu`, `contribEditorContentMenu`, among others | It is allowed proposals because it is a Microsoft first-party extension. We can copy its stable architecture: content-provider schemes + vscode.diff/changes + Comments. Proposal-backed polish (gutter base without an SCM entry, thread reveal, outdated-thread applicability, diff line-change commands) is not available to us. |

## 5. Limitations and gotchas

- **No webview inside the diff editor.** No API embeds a webview, view zone or custom widget in a text or diff editor. Annotations are limited to decorations (including `before`/`after` text), hovers, inlay hints, comment threads, and CodeLens (off by default in diffs). Rich explanations belong in your side webview or in Comment thread bodies (Markdown).
- **No `DiffEditor` object.** You get two `TextEditor`s matched by URI plus a `TabInputTextDiff`. You get no hunk list, current-change event or view-mode state without proposed APIs.
- **Diff colors** come from theme only (`diffEditor.insertedTextBackground`, `removedLineBackground`, `diffEditorGutter.*`, `diffEditorOverview.*`, `multiDiffEditor.*`). An extension can contribute defaults for its **own** color ids, not override these. Use decorations for your own highlights.
- **Left side is read-only** when it comes from a content provider (custom scheme or `git:`). Right side is editable only if it is the real `file:` URI. Use the working-tree file for "review up to now" so edits and language servers work. Use a content-provider URI for historic right sides.
- **Language features on virtual docs:** many language servers ignore non-`file` schemes, so hovers and go-to-definition on the left side may be sparse. Your own providers must list your scheme in their selectors.
- **`vscode.changes`:** no selection or column, no stable tab detection, and you can't target a single file's editor inside it reliably. Use it as an overview, then open individual `vscode.diff` tabs for annotated review.
- **Settings are global.** Toggling `renderSideBySide` or `hideUnchangedRegions` affects all diff editors and persists, so prefer to ask the user or use the internal toggles.
- **Inline mode:** the original side has no visible `TextEditor`, so left-side decorations and comments on deleted lines don't render the same way.
- **Notebooks:** `vscode.diff` on two `.ipynb` URIs opens the notebook diff editor (`TabInputNotebookDiff`). Text decorations, comment ranges and the git helpers above don't apply cell-wise.
- **Large or binary files:** `diffEditor.maxFileSize` and `maxComputationTime` can make the diff fall back or stop computing. Use `repo.buffer` for binaries.
- **Internal commands** (`workbench.action.compareEditor.*`, `toggle.diff.renderSideBySide`, `diffEditor.setViewMode.*`) have no compatibility guarantee. Wrap them in try/catch and feature-detect with `commands.getCommands(true)`.
