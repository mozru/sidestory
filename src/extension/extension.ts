// The whole extension (dist/full.cjs), loaded by the bootstrap (src/extension/bootstrap.ts → dist/extension.cjs)
// once a workspace has sidestories or a command runs (docs/NAVIGATION-PLAN.md §8.1). The bootstrap registers
// every command and the panel serializer; this module answers them.
import * as vscode from 'vscode';
import { escapeIcons, plainForMessage } from '../core/display-text.ts';
import { explainerNameSchema } from '../core/manifest.ts';
import { Decorations } from './decorations.ts';
import type { ExplainerRef } from './explainers.ts';
import { refFromDir, trailTo, uriKey } from './explainers.ts';
import { log } from './log.ts';
import { shellQuote, shellSafePath } from './shell.ts';
import { DriftQueue } from './nav/drift.ts';
import { ExplainedHere, NO_SIDESTORY_HERE } from './nav/explained-here.ts';
import { SidestoryIndex } from './nav/index.ts';
import { Navigator } from './nav/open-at.ts';
import { goToStep, pickSidestory } from './nav/pickers.ts';
import { SidestoryTree } from './nav/tree.ts';
import { SidestoryWatcher } from './nav/watcher.ts';
import { GIT_SCHEME, gitUri } from './changes/git-fs.ts';
import { pickVersion } from './compare.ts';
import { createPanel, panelOptions } from './panel.ts';
import { pickAnchor, pinAnchors, reanchorToSelection, repinAnchor, type SelectionSide } from './pin.ts';
import { ThisFileView } from './this-file.ts';
import { PreparedTextCache } from './prepared-cache.ts';
import type { SessionHost, SessionOptions } from './session.ts';
import { SymbolTables } from './code-links.ts';
import { ExplainerSession } from './session.ts';
import { disposeWidgetCompiler } from './widgets/compile.ts';
import { WidgetHost } from './widgets/host.ts';
import { ourModal } from './widgets/watchdog.ts';
import { TYPECHECK_COMMAND, writeWidgetTypes } from '../widget-types/index.ts';
import { HighlightService } from './highlight/service.ts';
import { AVAILABLE_KEY } from './bootstrap-shared.ts';
import { isSafeFsPath } from '../core/repo-path.ts';
import { ChangesService, CoverageDecorations } from './changes/service.ts';
import { activateComments } from './comments/index.ts';
import { localPath } from './local-path.ts';
import { realPathInside } from './paths.ts';

/** State the webview panel serializer keeps across restarts (written by the webview). */
interface PanelState {
  /** The explainer shown (its folder URI). */
  dir?: unknown;
  /** The trail's explainer names, root first; the last is the one shown. */
  trail?: unknown;
}

/** What the bootstrap calls. */
export interface FullApi {
  commands: Record<string, (...args: unknown[]) => unknown>;
  deserialize(panel: vscode.WebviewPanel, state: unknown): Promise<void>;
  deactivate(): void;
}

/** One session per open panel. Several panels may show the same explainer (say, after a dive). */
const sessions = new Set<ExplainerSession>();
/** The explainer the step commands act on: the one whose panel was active most recently. */
let current: ExplainerSession | undefined;
/** The text editor used last: a panel button needs its selection, but the panel has focus then. */
let lastTextEditor: vscode.TextEditor | undefined;

/** The text a reader can paste to their coding agent (the README's "Ask your agent"). */
export const AGENT_PROMPT =
  'Write a sidestory for `<the code to explain>` in `.sidestory/<name>/`: a section per part, a diagram where it helps, and a widget only where ' +
  'interaction makes it clearer. Follow the repository\'s guidance in `.sidestory/GUIDELINES.md` if it has one, ' +
  'https://github.com/mozru/sidestory/blob/main/docs/GUIDE.md and ' +
  'https://github.com/mozru/sidestory/blob/main/docs/WIDGETS.md, then run the checker until it reports no errors.';

export function activateFull(context: vscode.ExtensionContext): FullApi {
  lastTextEditor = vscode.window.activeTextEditor;
  context.subscriptions.push(log, { dispose: () => [...sessions].forEach((s) => s.dispose()) });

  const updateContext = () => {
    void vscode.commands.executeCommand('setContext', 'sidestory.active', [...sessions].some((s) => s.panel.visible));
    void vscode.commands.executeCommand('setContext', 'sidestory.versionPanel', !!current?.version && current.panel.active);
  };
  // VS Code's own navigate keys run Sidestory: Back / Forward only while the active panel has somewhere to go.
  const canNavigate = { back: false, forward: false };
  const updateNavContext = () => {
    const s = [...sessions].find((x) => x.panel.active);
    for (const way of ['back', 'forward'] as const) {
      const on = !!s?.canNavigate[way];
      if (on === canNavigate[way]) continue;
      canNavigate[way] = on;
      void vscode.commands.executeCommand('setContext', way === 'back' ? 'sidestory.canNavigateBack' : 'sidestory.canNavigateForward', on);
    }
  };

  /** The text editor whose selection "re-anchor" uses: the active one, else the last one still visible. */
  const selectionEditor = () =>
    vscode.window.activeTextEditor ?? (lastTextEditor && vscode.window.visibleTextEditors.includes(lastTextEditor) ? lastTextEditor : undefined);

  /** Where a selection in a diff's virtual side is (set once the changes layer is up, §7.6). */
  let selectionSides: SelectionSide | undefined;
  const reanchor = async (ref: ExplainerRef, anchorId: string, confirm: boolean) => {
    try {
      await reanchorToSelection(ref, anchorId, selectionEditor(), confirm, selectionSides);
    } catch (e) {
      log.error(`Re-anchor failed for ${ref.name}: ${(e as Error).message}`);
      void vscode.window.showErrorMessage(`Couldn't re-anchor: ${plainForMessage((e as Error).message)}`);
    }
  };

  // ---- navigation (docs/NAVIGATION-PLAN.md) ----
  const watcher = new SidestoryWatcher();
  const index = new SidestoryIndex(watcher);
  const prepared = new PreparedTextCache();
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((d) => prepared.drop(uriKey(d.uri))));
  context.subscriptions.push(watcher, index, prepared);

  const widgets = new WidgetHost(context, watcher);
  context.subscriptions.push(widgets);

  // Code block colors (docs/HIGHLIGHT-PLAN.md): one worker and theme for every panel.
  const highlight = new HighlightService(context.extensionUri);
  context.subscriptions.push(highlight, highlight.onDidChangeTheme((key) => [...sessions].forEach((s) => s.highlightThemeChanged(key))));

  // SV symbol tables for code links and cursor lighting (docs/AUTHORING-PLAN.md §8): one per document version, for every panel.
  const symbols = new SymbolTables();
  context.subscriptions.push(symbols);

  // Assigned below; the session host only calls it after a panel exists.
  let navigator: Navigator | undefined;
  const host: SessionHost = {
    memento: context.workspaceState,
    reanchor: (ref, anchorId) => void reanchor(ref, anchorId, true),
    widgets,
    highlight,
    prepared,
    stepCount: (dir) => index.stepCount(dir),
    stepOf: (dir, anchorId) => index.stepOf(dir, anchorId),
    titleOf: (dir) => index.entry(dir)?.title || undefined,
    opened: (ref) => navigator?.noteOpened(ref),
    historyChanged: () => updateNavContext(),
    symbols,
  };

  const drift = new DriftQueue(index);
  const tree = new SidestoryTree(index, drift, context.workspaceState);
  const here = new ExplainedHere(index, { sessions: () => [...sessions], prepared }, context.extensionUri);
  context.subscriptions.push(drift, tree, here);
  drift.live = (key) => {
    const s = [...sessions].find((x) => uriKey(x.ref.dir) === key);
    if (!s) return undefined;
    const states = [...s.anchorStates().states.values()];
    if (states.some((st) => st === 'pending')) return undefined;
    return { outOfDate: states.filter((st) => st === 'changed' || st === 'stale').length, lost: states.filter((st) => st === 'lost').length, unchecked: 0 };
  };

  const setPreviewIcon = (s: ExplainerSession) => {
    s.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', s.preview ? 'icon-preview.svg' : 'icon.png');
  };

  const start = async (trail: readonly [ExplainerRef, ...ExplainerRef[]], panel: vscode.WebviewPanel, opts: SessionOptions = {}): Promise<ExplainerSession> => {
    const decorations = new Decorations();
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png'); // marks the tab, so its title is just the sidestory's
    const s = new ExplainerSession(trail, panel, context.extensionUri, decorations, host, opts);
    sessions.add(s);
    // A version from git (Compare with…) is for reading beside the current one: no comments, and no panel reuse.
    const commentsAttached = host.comments && !opts.version ? comments.attach(s) : undefined;
    s.onDidDispose(() => commentsAttached?.dispose());
    current = s;
    if (!opts.version) {
      navigator?.attach(s);
      here.attach(s);
    }
    s.onDidDispose(() => {
      decorations.dispose();
      sessions.delete(s);
      if (current === s) current = [...sessions].at(-1);
      updateContext();
      updateNavContext();
    });
    s.onDidSwitch(() => setTimeout(() => tree.follow(s), 0));
    panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) {
        current = s;
        // Focus may have been pulled in from the editor by a widget (docs/WIDGETS-PLAN.md §5.3).
        s.queryFocus();
        tree.follow(s);
      }
      updateContext();
      updateNavContext();
    });
    // A preview panel has its own tab icon (tab titles can't be italic); it goes when the reader navigates.
    s.onDidNavigate(() => setPreviewIcon(s));
    updateContext();
    tree.follow(s);
    await s.load();
    return s;
  };

  const nav = new Navigator({
    sessions: () => [...sessions],
    current: () => current,
    start: async (trail, active) => {
      const s = await start(trail, createPanel(context.extensionUri, trail.at(-1)!), { active });
      return s;
    },
    memento: context.workspaceState,
    previewChanged: (s) => setPreviewIcon(s),
  });
  navigator = nav;

  // ---- comments (docs/COMMENTS-PLAN.md) ----
  const comments = activateComments(context, {
    index,
    sessions: () => [...sessions],
    current: () => current,
    openAt: (args) => nav.openAt(args),
    openCode: async (root, file, lines) => {
      const uri = vscode.Uri.joinPath(root, ...file.split('/'));
      if (uri.scheme !== 'file' || !(await realPathInside(localPath(uri), localPath(root)))) return;
      await vscode.window.showTextDocument(uri, { preview: true, ...(lines ? { selection: new vscode.Range(lines[0] - 1, 0, lines[1] - 1, 0) } : {}) });
    },
  });
  host.comments = comments;
  tree.setComments(comments.comments);
  // Sidestories in use first: open panels, then recently opened (§6.1, §6.5).
  // Cheap: the index calls it once per key per sort (open panels are few; recent ranks are cached).
  index.priority = (key) => {
    for (const s of sessions) if (uriKey(s.ref.dir) === key) return 0;
    return nav.recentRank(key) ?? Number.MAX_SAFE_INTEGER;
  };

  // ---- the sidebar ----
  // The branch's comparison (docs/CHANGES-PLAN.md §4, §6, §7, §9.6): no view of its own (Git Tree Compare, GitLens and
  // Source Control browse the branch); coverage shows as decorations on the files, the "This branch" group and This File.
  const changes = new ChangesService(context, {
    sidestoryDirs: () => [...index.all()].map((e) => e.ref.dir),
    sidestoryBases: () => [...index.all()].flatMap((e) => (e.base !== undefined ? [{ dir: e.ref.dir, title: e.title, base: e.base }] : [])),
    repin: async (dir, anchor) => {
      const ref = await explainerFor(dir.toString());
      if (!ref) return;
      try {
        await repinAnchor(ref, anchor, (id) => showing(ref)?.liveHint(id), widgets.pinHooks(ref));
      } catch (e) {
        void vscode.window.showErrorMessage(`Couldn't re-pin: ${plainForMessage((e as Error).message)}`);
      }
    },
  });
  context.subscriptions.push(changes);
  // Sessions with a base use the comparison (§7, §8, §11.4); coverage reads the index's sidestories (§6.1). Nothing is
  // computed until some sidestory in the workspace has a base (§4.6).
  host.diffs = changes.sessionDiffs;
  const syncWants = () => changes.setWorkspaceWants([...index.all()].some((e) => e.base !== undefined));
  context.subscriptions.push(
    index.onDidChange(() => {
      syncWants();
      changes.indexChanged();
    }),
    // A prose edit of a page isn't an index change, but the anchors the page uses may be different.
    index.onDidRereadPages(() => changes.pagesChanged()),
  );
  syncWants();
  selectionSides = async (uri, ref) => {
    if (uri.scheme !== 'sidestory-git') return undefined;
    // Only the diff of this sidestory's own comparison: its base must give the diff's merge-base (§7.6).
    const s = await changes.sameMergeBase(index.entry(ref.dir)?.base);
    const k = s ? changes.keyOf(s, uri) : undefined;
    if (!s || !k) return 'refuse';
    const full = vscode.Uri.joinPath(s.repo.rootUri, ...k.path.split('/'));
    const prefix = ref.root.path.replace(/\/?$/, '/');
    // The git extension's root and the workspace's may differ in a drive letter's case on Windows (as relPath allows).
    const head = full.path.slice(0, prefix.length);
    const inside = process.platform === 'win32' ? head.toLowerCase() === prefix.toLowerCase() : head === prefix;
    return inside ? { file: full.path.slice(prefix.length), side: k.side } : 'refuse';
  };
  // This File (§9.10), after Sidestories.
  const thisFile = new ThisFileView(index, here, {
    fileOf: (uri) => {
      const p = changes.pathOf(uri);
      const s = changes.snapshot;
      // Only a path the file system rule passes: This File reads the file it follows.
      return p && s && isSafeFsPath(p) ? vscode.Uri.joinPath(s.repo.rootUri, ...p.split('/')) : undefined;
    },
    baseOf: (dir) => changes.result()?.belonging.find((b) => uriKey(b.dir) === uriKey(dir))?.manifest.base,
    changesOf: (file) => changes.changesOf(file),
  });
  context.subscriptions.push(thisFile, changes.coverage.onDidChange(() => thisFile.refresh()));
  // "This branch" at the top of Sidestories (§9.6): repainted only when its rows change.
  tree.branch = changes;
  let branchSig = '';
  context.subscriptions.push(
    changes.onDidChange(() => {
      const sig = JSON.stringify(changes.branchGroup());
      if (sig === branchSig) return;
      branchSig = sig;
      tree.refresh();
    }),
  );
  const view = vscode.window.createTreeView('sidestory.tree', { treeDataProvider: tree, showCollapseAll: true });
  tree.attachView(view);
  // This File starts collapsed; the first time a sidestory explains a branch in this workspace, it opens once (no
  // focus taken), so its "Not explained yet" list is found. Never again in this workspace: the user's layout wins.
  // Tried only when This File would have rows for the active file: no rebuild on every changes event before that.
  const THIS_FILE_OPENED_HERE = 'sidestory.thisFile.openedInWorkspace';
  let revealing = false;
  context.subscriptions.push(
    changes.onDidChange(() => {
      if (revealing || context.workspaceState.get(THIS_FILE_OPENED_HERE) || !view.visible || !changes.result()?.belonging.length || !thisFile.wouldHaveRows()) return;
      revealing = true;
      void thisFile.revealQuietly().then((done) => {
        revealing = false;
        if (done) void context.workspaceState.update(THIS_FILE_OPENED_HERE, true);
      });
    }),
  );
  context.subscriptions.push(view);
  void vscode.commands.executeCommand('setContext', 'sidestory.treeFiltered', !!tree.filter);
  const setAvailable = (on: boolean) => {
    void vscode.commands.executeCommand('setContext', 'sidestory.available', on);
  };
  const onState = (s: 'loading' | 'empty' | 'ready') => {
    void vscode.commands.executeCommand('setContext', 'sidestory.indexState', s);
    if (s === 'ready') {
      setAvailable(true);
      void context.workspaceState.update(AVAILABLE_KEY, true);
    } else if (s === 'empty' && context.workspaceState.get(AVAILABLE_KEY) !== 'shown') {
      // Cleared when a rebuild finds none, unless "Show Sidestories" asked for the view, or the branch has changes for
      // the "This branch" group's prompt (docs/CHANGES-PLAN.md §9.1), which takes git a moment to answer.
      void changes.probe().then(() => {
        if (index.state !== 'empty' || context.workspaceState.get(AVAILABLE_KEY) === 'shown') return;
        if (changes.branchHasWork) {
          void context.workspaceState.update(AVAILABLE_KEY, 'shown');
          return;
        }
        setAvailable(false);
        void context.workspaceState.update(AVAILABLE_KEY, undefined);
      });
    }
  };
  context.subscriptions.push(index.onDidChangeState(onState));
  // The probe says yes later (a new branch, a first commit after startup): the container shows, with the group's
  // "Copy Prompt: Explain This Branch" (docs/CHANGES-PLAN.md §9.1).
  context.subscriptions.push(
    changes.onDidChange(() => {
      if (!changes.branchHasWork || context.workspaceState.get(AVAILABLE_KEY)) return;
      setAvailable(true);
      void context.workspaceState.update(AVAILABLE_KEY, 'shown');
    }),
  );
  void vscode.commands.executeCommand('setContext', 'sidestory.indexState', 'loading');
  void index.refresh().then(() => onState(index.state));

  // Reconcile on a git HEAD change (deletes the watcher can't see), and mark drift dirty. (The changes service asks
  // its branch probe again on its own.)
  void watchHead(context, () => {
    void index.reconcile(true);
    drift.invalidateAll();
  });

  /** The panel showing this explainer now: the active one if it does, else any. */
  const showing = (ref: ExplainerRef) => {
    const same = (s: ExplainerSession) => uriKey(s.ref.dir) === uriKey(ref.dir);
    return current && same(current) ? current : [...sessions].find(same);
  };

  const pick = async () => {
    const e = await pickSidestory(index, nav.recent());
    return e;
  };

  /** The explainer a command acts on: the one given, else the active panel's, else one the user picks. */
  /** A version from git (Compare with…) → the panel it was opened beside. */
  const partners = new WeakMap<ExplainerSession, ExplainerSession>();

  const explainerFor = async (dir?: unknown) => {
    const given = asUri(dir);
    if (given) return refFromDir(given);
    // A version from git (Compare with…) is read-only: commands that write or compile act on the current one.
    const s = current?.version ? partners.get(current) : current;
    return s?.ref ?? (await pick())?.ref;
  };

  // Restricted Mode: panels left open aren't restored, but say so once and offer to reopen them.
  let skipped: ExplainerRef[] = [];
  let skippedTimer: ReturnType<typeof setTimeout> | undefined;
  let toldSkipped = false;
  const noteSkipped = (ref: ExplainerRef) => {
    if (toldSkipped) return;
    skipped.push(ref);
    clearTimeout(skippedTimer);
    // Panels are restored one call each at startup: gather them into one message.
    skippedTimer = setTimeout(() => {
      toldSkipped = true;
      const refs = skipped;
      skipped = [];
      const open = refs.length === 1 ? 'Open Sidestory' : 'Open Sidestories';
      const what = refs.length === 1 ? `The sidestory “${plainForMessage(refs[0]!.name, 64)}” was` : `${refs.length} sidestories were`;
      void vscode.window.showInformationMessage(`${what} open, but sidestories aren't reopened automatically in Restricted Mode.`, open).then(async (choice) => {
        // The click is the user's consent to show them.
        if (choice === open) for (const r of refs) await vscode.commands.executeCommand('sidestory.open', r.dir);
      });
    }, 500);
  };
  context.subscriptions.push({ dispose: () => clearTimeout(skippedTimer) });

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((e) => {
      if (e) lastTextEditor = e;
    }),
    // A selection made in an editor that was already active when the extension started counts too.
    vscode.window.onDidChangeTextEditorSelection((e) => {
      lastTextEditor = e.textEditor;
    }),
  );

  /** Where an entry opens from a list: its primary path as the trail, so Back leads to its top. */
  const openEntry = (dir: string, extra: { anchor?: string; newPanel?: boolean; source?: string } = {}) => {
    const e = index.entry(vscode.Uri.parse(dir));
    return nav.openAt({ dir, trail: e ? index.trail(e) : undefined, ...extra });
  };

  const commands: Record<string, (...args: unknown[]) => unknown> = {
    'sidestory.open': async (dir?: unknown) => {
      const given = asUri(dir);
      if (given) {
        // The Explorer's menu: just that sidestory, revealed if open, else a new panel (today's behaviour).
        const ref = refFromDir(given);
        if (!ref) {
          void vscode.window.showWarningMessage('Not a sidestory: expected a folder like .sidestory/<name> inside the workspace.');
          return;
        }
        const existing = showing(ref);
        if (existing) {
          existing.panel.reveal(undefined, true);
          return;
        }
        await start([ref], createPanel(context.extensionUri, ref));
        return;
      }
      const e = await pick();
      if (e) await openEntry(e.ref.dir.toString(), { source: 'pick' });
    },
    'sidestory.openAt': async (args?: unknown) => {
      await nav.openAt(args);
    },
    'sidestory.tree.open': async (node?: unknown) => {
      const dir = nodeDir(node);
      if (dir) await nav.openAt({ dir, trail: nodePath(node), source: 'tree' });
    },
    'sidestory.openInNewPanel': async (node?: unknown) => {
      const dir = nodeDir(node) ?? (await pick())?.ref.dir.toString();
      if (dir) await nav.openAt({ dir, trail: nodePath(node) ?? (index.entry(vscode.Uri.parse(dir)) ? index.trail(index.entry(vscode.Uri.parse(dir))!) : undefined), newPanel: true });
    },
    'sidestory.goToStep': async (node?: unknown) => {
      const only = nodeDir(node) ? index.entry(vscode.Uri.parse(nodeDir(node)!)) : undefined;
      const editor = vscode.window.activeTextEditor;
      const r = await goToStep(index, {
        current: current ? index.entry(current.ref.dir) : undefined,
        fileKey: editor && editor.document.uri.scheme === 'file' ? uriKey(editor.document.uri) : undefined,
        recent: nav.recent(),
        memento: context.workspaceState,
        only,
      });
      if (r) await nav.openAt({ dir: r.entry.ref.dir.toString(), anchor: r.step, trail: index.trail(r.entry), source: 'step' });
    },
    'sidestory.showHere': async (args?: unknown) => {
      const a = (args && typeof args === 'object' ? args : {}) as { uri?: unknown; line?: unknown; all?: unknown; keys?: unknown };
      const editor = vscode.window.activeTextEditor;
      let uri: vscode.Uri | undefined;
      try {
        uri = typeof a.uri === 'string' ? vscode.Uri.parse(a.uri) : editor?.document.uri;
      } catch {
        uri = undefined; // not a URI
      }
      if (!uri) {
        vscode.window.setStatusBarMessage(NO_SIDESTORY_HERE, 3000);
        return;
      }
      const line = typeof a.line === 'number' ? a.line : editor && editor.document.uri.toString() === uri.toString() ? editor.selection.active.line + 1 : 1;
      const keys = Array.isArray(a.keys) && a.keys.length <= 200 && a.keys.every((k) => typeof k === 'string') ? (a.keys as string[]) : undefined;
      // The lens's own steps; if they have moved on since (a resolve landed), whatever covers the line now.
      const counted = keys ? here.byKeys(uri, keys) : [];
      const items = counted.length ? counted : a.all === true ? here.all(uri) : here.covering(uri, line);
      if (!items.length) {
        vscode.window.setStatusBarMessage(NO_SIDESTORY_HERE, 3000);
        return;
      }
      // One item per (sidestory, step): nested anchors fold into their step.
      const seen = new Set<string>();
      const picks = items
        .map((it) => ({ it, args: here.openArgs(it, 'here') }))
        .filter((x) => {
          const k = `${x.it.entry.key}\u0000${x.args.anchor}`;
          return !seen.has(k) && !!seen.add(k);
        });
      if (picks.length === 1) {
        await nav.openAt(picks[0]!.args);
        return;
      }
      const chosen = await vscode.window.showQuickPick(
        picks.map((x) => ({
          label: escapeIcons(here.stepTitle(x.it)),
          description: escapeIcons(here.describe(x.it, false)),
          detail: x.it.state === 'exact' || x.it.state === 'moved' ? undefined : x.it.state === 'stale' ? 'The code changed a lot' : 'The code changed',
          args: x.args,
        })),
        { placeHolder: 'Open which sidestory step?', matchOnDescription: true },
      );
      if (chosen) await nav.openAt(chosen.args);
    },
    'sidestory.statusOpen': async () => {
      const a = here.statusOpenArgs();
      if (a) await nav.openAt(a);
    },
    'sidestory.showSidestories': async () => {
      await context.workspaceState.update(AVAILABLE_KEY, index.size ? true : 'shown');
      setAvailable(true);
      await vscode.commands.executeCommand('sidestory.tree.focus');
    },
    'sidestory.copyAgentPrompt': async () => {
      await vscode.env.clipboard.writeText(AGENT_PROMPT);
      void vscode.window.showInformationMessage('Copied a prompt for your agent. Paste it into your coding agent and say which code to explain.');
    },
    'sidestory.tree.filter': async () => {
      const text = await vscode.window.showInputBox({ title: 'Filter Sidestories', prompt: 'Matches titles, names, summaries and groups', value: tree.filter });
      if (text !== undefined) tree.setFilter(text);
    },
    'sidestory.tree.clearFilter': () => tree.setFilter(''),
    // Compare with…: another version of the panel's sidestory, read from git, beside it; the two move together.
    'sidestory.compare': async () => {
      const s = current;
      if (!s || s.version) {
        void vscode.window.showInformationMessage(s ? 'This is already an older version: compare from the current one.' : 'Open a sidestory first.');
        return;
      }
      const v = await pickVersion(s.ref.dir, changes.snapshot);
      if (!v) return;
      // The folder holding .sidestory/ at that commit (the repository's root, or a package's in a monorepo): the
      // code the version's anchors name is there.
      const rootRel = v.rel.split('/').slice(0, -2).join('/');
      let ref: ExplainerRef;
      try {
        ref = {
          name: s.ref.name,
          dir: gitUri(changes.ids, v.repo, v.commit, v.rel),
          root: rootRel ? gitUri(changes.ids, v.repo, v.commit, rootRel) : vscode.Uri.from({ scheme: GIT_SCHEME, authority: changes.ids.idOf(v.repo), path: '/', query: v.commit }),
        };
      } catch {
        void vscode.window.showWarningMessage("This sidestory's folder can't be read from git.");
        return;
      }
      const old = await start([ref], createPanel(context.extensionUri, ref, vscode.ViewColumn.Beside), { active: s.place().active, version: v.label });
      // The reader is still in their panel (the new one opened without taking focus), unless they closed it meanwhile.
      if (sessions.has(s)) current = s;
      updateContext();
      partners.set(old, s);
      // Together: a step picked in either is the step in both (the follower doesn't reveal code: one editor).
      const links = [s.onDidChangeStep((id) => old.followStep(id)), old.onDidChangeStep((id) => s.followStep(id))];
      const unlink = () => {
        links.splice(0).forEach((d) => d.dispose());
        partners.delete(old); // its diffs and the commands that act on "the current sidestory" no longer point there
      };
      // Until either closes, or the reader's panel moves to another sidestory.
      for (const d of [old.onDidDispose(unlink), s.onDidDispose(unlink), s.onDidSwitch(unlink)]) links.push(d);
      if (s.place().active && s.place().active !== old.place().active) old.followStep(s.place().active!);
    },
    // In the older version's panel: VS Code's diff of its step's code, or of the page's source, against now.
    'sidestory.compare.stepDiff': async () => {
      const s = current;
      const id = s?.place().active;
      const file = s?.version && id ? s.stepFile(id) : undefined;
      const now = s && partners.get(s);
      if (s?.version && !now) void vscode.window.showInformationMessage('The panel this version was opened beside shows another sidestory now: compare again from it.');
      if (!s || !file || !now) return;
      await vscode.commands.executeCommand('vscode.diff', vscode.Uri.joinPath(s.ref.root, file), vscode.Uri.joinPath(now.ref.root, ...file.split('/')), `${file.split('/').at(-1)} (${s.version} ↔ now)`);
    },
    'sidestory.compare.sourceDiff': async () => {
      const s = current;
      const now = s?.version ? partners.get(s) : undefined;
      if (s?.version && !now) void vscode.window.showInformationMessage('The panel this version was opened beside shows another sidestory now: compare again from it.');
      if (!s || !now) return;
      await vscode.commands.executeCommand('vscode.diff', vscode.Uri.joinPath(s.ref.dir, 'sidestory.html'), vscode.Uri.joinPath(now.ref.dir, 'sidestory.html'), `${s.ref.name}/sidestory.html (${s.version} ↔ now)`);
    },
    // The page's right-click menu (webview/context): for what was right-clicked in the panel the menu opened in.
    'sidestory.page.copy': () => current?.menu('copy'),
    'sidestory.page.comment': () => current?.menu('comment'),
    'sidestory.page.ask': () => current?.menu('ask'),
    'sidestory.page.goToStep': () => current?.menu('step'),
    'sidestory.page.openCode': () => current?.menu('open'),
    'sidestory.tree.refresh': async () => {
      drift.invalidateAll();
      await index.refresh();
    },
    'sidestory.tree.revealInExplorer': async (node?: unknown) => {
      const dir = nodeDir(node);
      if (dir) await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.parse(dir));
    },
    'sidestory.tree.copyPath': async (node?: unknown) => {
      const dir = nodeDir(node);
      if (dir) await vscode.env.clipboard.writeText(vscode.workspace.asRelativePath(vscode.Uri.parse(dir), false));
    },
    'sidestory.pin': async (dir?: unknown) => {
      const ref = await explainerFor(nodeDir(dir) ?? dir);
      if (!ref) return;
      const open = showing(ref);
      try {
        await pinAnchors(ref, (id) => open?.liveHint(id), widgets.pinHooks(ref), (base) => changes.baseSide(ref.root, base));
      } catch (e) {
        log.error(`Pin Anchors failed for ${ref.name}: ${(e as Error).message}`);
        void vscode.window.showErrorMessage(`Couldn't pin anchors: ${plainForMessage((e as Error).message)}`);
      }
    },
    'sidestory.reanchor': async (dir?: unknown) => {
      // Taken now: picking the section moves focus to the quick pick.
      const editor = selectionEditor();
      const ref = await explainerFor(dir);
      if (!ref) return;
      const anchorId = await pickAnchor(ref, showing(ref)?.anchorStates());
      if (!anchorId) return;
      try {
        // Run from the editor by the user, on the section they picked: no extra confirmation.
        await reanchorToSelection(ref, anchorId, editor, false, selectionSides);
      } catch (e) {
        log.error(`Re-anchor failed for ${ref.name}: ${(e as Error).message}`);
        void vscode.window.showErrorMessage(`Couldn't re-anchor: ${plainForMessage((e as Error).message)}`);
      }
    },
    'sidestory.revokeWidgetConsent': async () => {
      await widgets.revokeConsent();
      void vscode.window.showInformationMessage('Widget consent revoked: sidestories ask again before running widgets in this workspace.');
    },
    'sidestory.enableWidgets': async () => {
      if (!widgets.enabled()) {
        const on = 'Turn On';
        const choice = await ourModal(() => vscode.window.showInformationMessage('Widgets are turned off in settings (sidestory.widgets.enabled). Turn them on?', { modal: true, detail: 'Each workspace still asks before running its widgets.' }, on));
        if (choice !== on) return;
        await vscode.workspace.getConfiguration('sidestory').update('widgets.enabled', true, vscode.ConfigurationTarget.Global);
      }
      await widgets.enableAll();
    },
    'sidestory.checkWidgets': async (dir?: unknown) => {
      const ref = await explainerFor(nodeDir(dir) ?? dir);
      if (!ref) return;
      if (!vscode.workspace.isTrusted) {
        void vscode.window.showInformationMessage('Widgets are checked in trusted workspaces only.');
        return;
      }
      const results = await widgets.check(ref);
      const errors = results.reduce((n, r) => n + r.errors.length, 0);
      const warnings = results.reduce((n, r) => n + r.warnings.length, 0);
      void vscode.window.showInformationMessage(`${plainForMessage(ref.name, 64)}: ${results.length} widget source${results.length === 1 ? '' : 's'} checked, ${errors} error(s), ${warnings} warning(s)${errors + warnings ? ', in the Problems panel' : ''}.`);
      if (errors + warnings) void vscode.commands.executeCommand('workbench.actions.view.problems');
    },
    'sidestory.copyWidgetCheckCommand': async (dir?: unknown) => {
      const ref = await explainerFor(nodeDir(dir) ?? dir);
      const target = ref ? vscode.workspace.asRelativePath(ref.dir, false) : '.sidestory/<name>';
      // The command is pasted into a shell: only names and paths that can't carry shell syntax are copied.
      if (ref && (!explainerNameSchema.safeParse(ref.name).success || !shellSafePath(target))) {
        void vscode.window.showWarningMessage('This sidestory\'s folder path has characters the checker command can\'t quote safely. Use letters, digits, ".", "-" and "_".');
        return;
      }
      const cmd = `node ${shellQuote(vscode.Uri.joinPath(context.extensionUri, 'dist', 'check.cjs').fsPath)} ${shellQuote(target)}`;
      await vscode.env.clipboard.writeText(cmd);
      void vscode.window.showInformationMessage(`Copied: ${plainForMessage(cmd, 1000)}`);
    },
    'sidestory.addWidgetTypes': async (dir?: unknown) => {
      const ref = await explainerFor(dir);
      if (!ref) return;
      const explain = vscode.Uri.joinPath(ref.dir, '..');
      try {
        const written = await writeWidgetTypes(explain.fsPath, vscode.Uri.joinPath(context.extensionUri, 'dist', 'widget-types').fsPath);
        void vscode.window.showInformationMessage(`Wrote ${written.length} files to ${plainForMessage(vscode.workspace.asRelativePath(explain, false))} (tsconfig.json, .types/): IntelliSense and tsc now know the widget libraries. From a terminal: ${TYPECHECK_COMMAND}`);
      } catch (e) {
        void vscode.window.showErrorMessage(`Couldn't write the widget types: ${plainForMessage((e as Error).message)}`);
      }
    },
    'sidestory.explainFile': (arg?: unknown) => thisFile.explainFile(arg),
    'sidestory.nextStep': () => target()?.navigate(1),

    'sidestory.prevStep': () => target()?.navigate(-1),
    'sidestory.navigateBack': () => target()?.history(-1),
    'sidestory.navigateForward': () => target()?.history(1),
    ...changes.commands,
  };

  // Hidden, for tests and the perf smoke (docs/NAVIGATION-PLAN.md §12.4): only in test runs.
  if (context.extensionMode === vscode.ExtensionMode.Test) {
    context.subscriptions.push(
      vscode.commands.registerCommand('sidestory._indexStats', async () => {
        await index.ready;
        return { ...index.stats(), here: here.stats() };
      }),
      vscode.commands.registerCommand('sidestory._changes', () => ({
        branch: changes.branchGroup(),
        marks: Object.fromEntries(CoverageDecorations.marksOf(changes.result())),
        mergeBase: changes.snapshot?.mergeBase,
        comparable: changes.comparable,
      })),
      vscode.commands.registerCommand('sidestory._focus', () => [...sessions].map((s) => s.focusInfo())),
      vscode.commands.registerCommand('sidestory._thisFile', () => thisFile.stats()),
      // Code block colors from the installed grammars (docs/HIGHLIGHT-PLAN.md §10), as a panel would get them.
      vscode.commands.registerCommand('sidestory._highlight', async (lang: string, code: string) => {
        await highlight.whenReady();
        const r = await highlight.highlighter.request(highlight.highlighter.newRequester(), [{ id: 0, lang, code }]);
        return r && { theme: r.theme, palette: r.palette, runs: r.blocks[0]?.runs ?? null, engine: highlight.highlighter.engine };
      }),
      vscode.commands.registerCommand('sidestory._coverage', () => {
        const r = changes.coverage.result;
        return r && { totals: r.totals, belonging: r.belonging.map((b) => b.folder), files: [...r.files].map(([p, f]) => [p, f.coverage?.changes.map((c) => c.state)]) };
      }),
    );
  }

  Object.assign(commands, comments.commands);

  // The widget watchdog's recovery: a fresh panel in the same column, at the same place.
  widgets.recreate = (port) => {
    const old = [...sessions].find((s) => s.panel === port.panel);
    if (!old) return;
    const { trail, active } = old.place();
    const column = old.panel.viewColumn ?? vscode.ViewColumn.Beside;
    old.panel.dispose();
    void start(trail, createPanel(context.extensionUri, trail.at(-1)!, column), { active, recovered: true });
  };

  return {
    commands,
    async deserialize(panel: vscode.WebviewPanel, raw: unknown) {
      const state = raw as PanelState | undefined;
      const trail = restoredTrail(state);
      const shown = trail?.at(-1);
      if (!trail || !shown || [...sessions].some((s) => uriKey(s.ref.dir) === uriKey(shown.dir))) {
        panel.dispose();
        return;
      }
      // In Restricted Mode, an explainer is shown only when the user opens it, never automatically.
      if (!vscode.workspace.isTrusted) {
        panel.dispose();
        noteSkipped(shown);
        return;
      }
      panel.webview.options = panelOptions(context.extensionUri, shown);
      await start(trail, panel);
    },
    deactivate,
  };
}

/** A URI from a command argument (Explorer passes a Uri, other callers a string), else undefined. */
function asUri(dir: unknown): vscode.Uri | undefined {
  if (dir instanceof vscode.Uri) return dir;
  if (typeof dir === 'string' && dir.length <= 4096) {
    try {
      return vscode.Uri.parse(dir, true);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** The folder of a tree node passed to a context-menu command. */
function nodeDir(node: unknown): string | undefined {
  const n = node as { entry?: { ref?: { dir?: vscode.Uri } } } | undefined;
  const d = n?.entry?.ref?.dir;
  return d instanceof vscode.Uri ? d.toString() : undefined;
}

function nodePath(node: unknown): string[] | undefined {
  const p = (node as { path?: unknown } | undefined)?.path;
  return Array.isArray(p) && p.every((x) => typeof x === 'string') ? (p as string[]) : undefined;
}

/** Calls `onChange` when any repository's HEAD moves (the git extension's API, read-only). */
async function watchHead(context: vscode.ExtensionContext, onChange: () => void): Promise<void> {
  try {
    const ext = vscode.extensions.getExtension<{ getAPI(v: 1): GitLike }>('vscode.git');
    if (!ext) return;
    const api = (ext.isActive ? ext.exports : await ext.activate()).getAPI(1);
    // By root: the git API hands out a new wrapper object for the same repository on every call and event, so a
    // repository is subscribed to once, and again only after it closed.
    const heads = new Map<string, string | undefined>();
    const subs = new Map<string, vscode.Disposable>();
    const watch = (repo: GitRepoLike) => {
      const root = repo.rootUri.toString();
      if (subs.has(root)) return;
      heads.set(root, repo.state.HEAD?.commit);
      subs.set(
        root,
        repo.state.onDidChange(() => {
          const head = repo.state.HEAD?.commit;
          if (head !== heads.get(root)) {
            heads.set(root, head);
            onChange();
          }
        }),
      );
    };
    api.repositories.forEach(watch);
    context.subscriptions.push(
      api.onDidOpenRepository(watch),
      api.onDidCloseRepository((repo) => {
        const root = repo.rootUri.toString();
        subs.get(root)?.dispose();
        subs.delete(root);
        heads.delete(root);
      }),
      { dispose: () => subs.forEach((d) => d.dispose()) },
    );
  } catch {
    // No git extension (or disabled): focus reconciliation still runs.
  }
}

interface GitRepoLike {
  rootUri: vscode.Uri;
  state: { HEAD?: { commit?: string }; onDidChange: vscode.Event<void> };
}
interface GitLike {
  repositories: GitRepoLike[];
  onDidOpenRepository: vscode.Event<GitRepoLike>;
  onDidCloseRepository: vscode.Event<GitRepoLike>;
}

/**
 * The trail a restored panel had: the explainer it showed, with the explainers it was dived into from
 * (siblings under the same `.sidestory/`). Just the one explainer if the saved trail doesn't fit.
 */
export function restoredTrail(state: PanelState | undefined): [ExplainerRef, ...ExplainerRef[]] | undefined {
  const shown = typeof state?.dir === 'string' ? refFromDir(vscode.Uri.parse(state.dir)) : undefined;
  if (!shown) return undefined;
  return trailTo(shown, state?.trail) ?? [shown];
}

/** The explainer step commands act on: the last active one if it's visible, else any visible one. */
function target(): ExplainerSession | undefined {
  if (current?.panel.visible) return current;
  return [...sessions].find((s) => s.panel.visible) ?? current;
}

export function deactivate(): void {
  for (const s of sessions) s.dispose();
  disposeWidgetCompiler();
}
