// The whole extension (dist/full.cjs), loaded by the bootstrap (src/extension/bootstrap.ts → dist/extension.cjs)
// once a workspace has sidestories or a command runs (docs/NAVIGATION-PLAN.md §8.1). The bootstrap registers
// every command and the panel serializer; this module answers them.
import * as vscode from 'vscode';
import { escapeIcons, plainForMessage } from '../core/display-text.ts';
import { explainerNameSchema } from '../core/manifest.ts';
import { MAX_TRAIL } from '../shared/protocol.ts';
import { Decorations } from './decorations.ts';
import type { ExplainerRef } from './explainers.ts';
import { refFromDir, uriKey } from './explainers.ts';
import { log } from './log.ts';
import { shellQuote, shellSafePath } from './shell.ts';
import { DriftQueue } from './nav/drift.ts';
import { ExplainedHere, NO_SIDESTORY_HERE } from './nav/explained-here.ts';
import { SidestoryIndex } from './nav/index.ts';
import { Navigator } from './nav/open-at.ts';
import { goToStep, pickSidestory } from './nav/pickers.ts';
import { SidestoryTree } from './nav/tree.ts';
import { SidestoryWatcher } from './nav/watcher.ts';
import { createPanel, panelOptions, VIEW_TYPE } from './panel.ts';
import { pickAnchor, pinAnchors, reanchorToSelection } from './pin.ts';
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
import { ChangesView } from './changes/view.ts';

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
  'interaction makes it clearer. Follow https://github.com/mozru/sidestory/blob/main/docs/GUIDE.md and ' +
  'https://github.com/mozru/sidestory/blob/main/docs/WIDGETS.md, then run the checker until it reports no errors.';

export function activateFull(context: vscode.ExtensionContext): FullApi {
  lastTextEditor = vscode.window.activeTextEditor;
  context.subscriptions.push(log, { dispose: () => [...sessions].forEach((s) => s.dispose()) });

  const updateContext = () => void vscode.commands.executeCommand('setContext', 'sidestory.active', [...sessions].some((s) => s.panel.visible));

  /** The text editor whose selection "re-anchor" uses: the active one, else the last one still visible. */
  const selectionEditor = () =>
    vscode.window.activeTextEditor ?? (lastTextEditor && vscode.window.visibleTextEditors.includes(lastTextEditor) ? lastTextEditor : undefined);

  const reanchor = async (ref: ExplainerRef, anchorId: string, confirm: boolean) => {
    try {
      await reanchorToSelection(ref, anchorId, selectionEditor(), confirm);
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
    titleOf: (dir) => index.entry(dir)?.title || undefined,
    opened: (ref) => navigator?.noteOpened(ref),
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
    current = s;
    navigator?.attach(s);
    here.attach(s);
    s.onDidDispose(() => {
      decorations.dispose();
      sessions.delete(s);
      if (current === s) current = [...sessions].at(-1);
      updateContext();
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
  // Sidestories in use first: open panels, then recently opened (§6.1, §6.5).
  // Cheap: the index calls it once per key per sort (open panels are few; recent ranks are cached).
  index.priority = (key) => {
    for (const s of sessions) if (uriKey(s.ref.dir) === key) return 0;
    return nav.recentRank(key) ?? Number.MAX_SAFE_INTEGER;
  };

  // ---- the sidebar ----
  // The Changes view (docs/CHANGES-PLAN.md §9, release 1a): the merge diff as a file navigator, no sidestory needed.
  const changes = new ChangesView(context);
  context.subscriptions.push(changes);
  const view = vscode.window.createTreeView('sidestory.tree', { treeDataProvider: tree, showCollapseAll: true });
  tree.view = view;
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
      // the Changes view (docs/CHANGES-PLAN.md §9.1), which takes git a moment to answer.
      void changes.relevantSoon().then((branch) => {
        if (index.state !== 'empty' || context.workspaceState.get(AVAILABLE_KEY) === 'shown') return;
        if (branch) {
          void context.workspaceState.update(AVAILABLE_KEY, 'shown');
          return;
        }
        setAvailable(false);
        void context.workspaceState.update(AVAILABLE_KEY, undefined);
      });
    }
  };
  context.subscriptions.push(index.onDidChangeState(onState));
  void vscode.commands.executeCommand('setContext', 'sidestory.indexState', 'loading');
  void index.refresh().then(() => onState(index.state));

  // Reconcile on a git HEAD change (deletes the watcher can't see), and mark drift dirty.
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
  const explainerFor = async (dir?: unknown) => {
    const given = asUri(dir);
    if (given) return refFromDir(given);
    return current?.ref ?? (await pick())?.ref;
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
        await pinAnchors(ref, (id) => open?.liveHint(id), widgets.pinHooks(ref));
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
        await reanchorToSelection(ref, anchorId, editor, false);
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
    'sidestory.nextStep': () => target()?.navigate(1),
    'sidestory.prevStep': () => target()?.navigate(-1),
    ...changes.commands,
  };

  // Hidden, for tests and the perf smoke (docs/NAVIGATION-PLAN.md §12.4): only in test runs.
  if (context.extensionMode === vscode.ExtensionMode.Test) {
    context.subscriptions.push(
      vscode.commands.registerCommand('sidestory._indexStats', async () => {
        await index.ready;
        return { ...index.stats(), here: here.stats() };
      }),
      vscode.commands.registerCommand('sidestory._changesStats', () => ({ ...changes.stats, description: changes.view.description, message: changes.view.message })),
    );
  }

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
    const heads = new Map<unknown, string | undefined>();
    const watch = (repo: GitRepoLike) => {
      heads.set(repo, repo.state.HEAD?.commit);
      context.subscriptions.push(
        repo.state.onDidChange(() => {
          const head = repo.state.HEAD?.commit;
          if (head !== heads.get(repo)) {
            heads.set(repo, head);
            onChange();
          }
        }),
      );
    };
    api.repositories.forEach(watch);
    context.subscriptions.push(api.onDidOpenRepository(watch));
  } catch {
    // No git extension (or disabled): focus reconciliation still runs.
  }
}

interface GitRepoLike {
  state: { HEAD?: { commit?: string }; onDidChange: vscode.Event<void> };
}
interface GitLike {
  repositories: GitRepoLike[];
  onDidOpenRepository: vscode.Event<GitRepoLike>;
}

/**
 * The trail a restored panel had: the explainer it showed, with the explainers it was dived into from
 * (siblings under the same `.sidestory/`). Just the one explainer if the saved trail doesn't fit.
 */
export function restoredTrail(state: PanelState | undefined): [ExplainerRef, ...ExplainerRef[]] | undefined {
  const shown = typeof state?.dir === 'string' ? refFromDir(vscode.Uri.parse(state.dir)) : undefined;
  if (!shown) return undefined;
  const names = state?.trail;
  if (
    !Array.isArray(names) ||
    names.length === 0 ||
    names.length > MAX_TRAIL ||
    names.at(-1) !== shown.name ||
    !names.every((n) => explainerNameSchema.safeParse(n).success) ||
    new Set(names).size !== names.length
  ) {
    return [shown];
  }
  const refs = (names as string[]).map((n, i) => (i === names.length - 1 ? shown : refFromDir(vscode.Uri.joinPath(shown.dir, '..', n))));
  const [first, ...rest] = refs;
  if (!first || rest.some((r) => !r)) return [shown];
  return [first, ...(rest as ExplainerRef[])];
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
