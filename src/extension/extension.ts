import * as vscode from 'vscode';
import { explainerNameSchema } from '../core/manifest.ts';
import { MAX_TRAIL } from '../shared/protocol.ts';
import { Decorations } from './decorations.ts';
import type { ExplainerRef } from './explainers.ts';
import { findExplainers, refFromDir } from './explainers.ts';
import { log } from './log.ts';
import { createPanel, panelOptions, VIEW_TYPE } from './panel.ts';
import { pickAnchor, pinAnchors, reanchorToSelection } from './pin.ts';
import type { SessionHost } from './session.ts';
import { ExplainerSession } from './session.ts';

/** State the webview panel serializer keeps across restarts (written by the webview). */
interface PanelState {
  /** The explainer shown (its folder URI). */
  dir?: unknown;
  /** The trail's explainer names, root first; the last is the one shown. */
  trail?: unknown;
}

/** One session per open panel. Several panels may show the same explainer (say, after a dive). */
const sessions = new Set<ExplainerSession>();
/** The explainer the step commands act on: the one whose panel was active most recently. */
let current: ExplainerSession | undefined;
/** The text editor used last: a panel button needs its selection, but the panel has focus then. */
let lastTextEditor: vscode.TextEditor | undefined;

export function activate(context: vscode.ExtensionContext): void {
  lastTextEditor = vscode.window.activeTextEditor;
  context.subscriptions.push(log, { dispose: () => [...sessions].forEach((s) => s.dispose()) });

  const updateContext = () => void vscode.commands.executeCommand('setContext', 'codeExplainer.active', [...sessions].some((s) => s.panel.visible));

  /** The text editor whose selection "re-anchor" uses: the active one, else the last one still visible. */
  const selectionEditor = () =>
    vscode.window.activeTextEditor ?? (lastTextEditor && vscode.window.visibleTextEditors.includes(lastTextEditor) ? lastTextEditor : undefined);

  const reanchor = async (ref: ExplainerRef, anchorId: string, confirm: boolean) => {
    try {
      await reanchorToSelection(ref, anchorId, selectionEditor(), confirm);
    } catch (e) {
      log.error(`Re-anchor failed for ${ref.name}: ${(e as Error).message}`);
      void vscode.window.showErrorMessage(`Couldn't re-anchor: ${(e as Error).message}`);
    }
  };

  const host: SessionHost = {
    memento: context.workspaceState,
    reanchor: (ref, anchorId) => void reanchor(ref, anchorId, true),
  };

  const start = async (trail: readonly [ExplainerRef, ...ExplainerRef[]], panel: vscode.WebviewPanel) => {
    const decorations = new Decorations();
    const s = new ExplainerSession(trail, panel, context.extensionUri, decorations, host);
    sessions.add(s);
    current = s;
    s.onDidDispose(() => {
      decorations.dispose();
      sessions.delete(s);
      if (current === s) current = [...sessions].at(-1);
      updateContext();
    });
    panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) current = s;
      updateContext();
    });
    updateContext();
    await s.load();
  };

  /** The panel showing this explainer now: the active one if it does, else any. */
  const showing = (ref: ExplainerRef) => {
    const same = (s: ExplainerSession) => s.ref.dir.toString() === ref.dir.toString();
    return current && same(current) ? current : [...sessions].find(same);
  };

  /** The explainer a command acts on: the one given, else the active panel's, else one the user picks. */
  const explainerFor = async (dir?: vscode.Uri | string) => {
    if (dir) return refFromDir(typeof dir === 'string' ? vscode.Uri.parse(dir) : dir);
    return current?.ref ?? (await pickExplainer());
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
      const open = refs.length === 1 ? 'Open Explainer' : 'Open Explainers';
      const what = refs.length === 1 ? `The explainer “${refs[0]!.name}” was` : `${refs.length} explainers were`;
      void vscode.window.showInformationMessage(`${what} open, but explainers aren't reopened automatically in Restricted Mode.`, open).then(async (choice) => {
        // The click is the user's consent to show them.
        if (choice === open) for (const r of refs) await vscode.commands.executeCommand('codeExplainer.open', r.dir);
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
    vscode.commands.registerCommand('codeExplainer.open', async (dir?: vscode.Uri | string) => {
      const ref = dir ? refFromDir(typeof dir === 'string' ? vscode.Uri.parse(dir) : dir) : await pickExplainer();
      if (!ref) {
        if (dir) void vscode.window.showWarningMessage('Not an explainer: expected a folder like .explain/<name> inside the workspace.');
        return;
      }
      const existing = showing(ref);
      if (existing) {
        existing.panel.reveal(undefined, true);
        return;
      }
      await start([ref], createPanel(context.extensionUri, ref));
    }),
    vscode.commands.registerCommand('codeExplainer.pin', async (dir?: vscode.Uri | string) => {
      const ref = await explainerFor(dir);
      if (!ref) return;
      const open = showing(ref);
      try {
        await pinAnchors(ref, (id) => open?.liveHint(id));
      } catch (e) {
        log.error(`Pin Anchors failed for ${ref.name}: ${(e as Error).message}`);
        void vscode.window.showErrorMessage(`Couldn't pin anchors: ${(e as Error).message}`);
      }
    }),
    vscode.commands.registerCommand('codeExplainer.reanchor', async (dir?: vscode.Uri | string) => {
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
        void vscode.window.showErrorMessage(`Couldn't re-anchor: ${(e as Error).message}`);
      }
    }),
    vscode.commands.registerCommand('codeExplainer.nextStep', () => target()?.navigate(1)),
    vscode.commands.registerCommand('codeExplainer.prevStep', () => target()?.navigate(-1)),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: PanelState | undefined) {
        const trail = restoredTrail(state);
        const shown = trail?.at(-1);
        if (!trail || !shown || [...sessions].some((s) => s.ref.dir.toString() === shown.dir.toString())) {
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
    }),
  );
}

/**
 * The trail a restored panel had: the explainer it showed, with the explainers it was dived into from
 * (siblings under the same `.explain/`). Just the one explainer if the saved trail doesn't fit.
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

async function pickExplainer(): Promise<ExplainerRef | undefined> {
  const all = await findExplainers();
  if (all.length === 0) {
    void vscode.window.showInformationMessage('No explainers found. An explainer is a folder like .explain/<name>/ with explainer.html and manifest.json.');
    return undefined;
  }
  if (all.length === 1) return all[0];
  const pick = await vscode.window.showQuickPick(
    all.map((ref) => ({ label: ref.name, description: vscode.workspace.asRelativePath(ref.dir), ref })),
    { placeHolder: 'Open which explainer?' },
  );
  return pick?.ref;
}

export function deactivate(): void {
  for (const s of sessions) s.dispose();
}
