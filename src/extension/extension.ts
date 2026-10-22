import * as vscode from 'vscode';
import { Decorations } from './decorations.ts';
import type { ExplainerRef } from './explainers.ts';
import { findExplainers, refFromDir } from './explainers.ts';
import { log } from './log.ts';
import { createPanel, panelOptions, VIEW_TYPE } from './panel.ts';
import { pinAnchors } from './pin.ts';
import { ExplainerSession } from './session.ts';

/** State the webview panel serializer keeps across restarts. */
interface PanelState {
  dir?: string;
}

/** One session per open explainer, keyed by its folder. */
const sessions = new Map<string, ExplainerSession>();
/** The explainer the step commands act on: the one whose panel was active most recently. */
let current: ExplainerSession | undefined;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(log, { dispose: () => [...sessions.values()].forEach((s) => s.dispose()) });

  const updateContext = () =>
    void vscode.commands.executeCommand('setContext', 'codeExplainer.active', [...sessions.values()].some((s) => s.panel.visible));

  const start = async (ref: ExplainerRef, panel: vscode.WebviewPanel) => {
    const key = ref.dir.toString();
    const decorations = new Decorations();
    const s = new ExplainerSession(ref, panel, context.extensionUri, decorations);
    sessions.set(key, s);
    current = s;
    s.onDidDispose(() => {
      decorations.dispose();
      if (sessions.get(key) === s) sessions.delete(key);
      if (current === s) current = [...sessions.values()].at(-1);
      updateContext();
    });
    panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) current = s;
      updateContext();
    });
    updateContext();
    await s.load();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('codeExplainer.open', async (dir?: vscode.Uri | string) => {
      const ref = dir ? refFromDir(typeof dir === 'string' ? vscode.Uri.parse(dir) : dir) : await pickExplainer();
      if (!ref) {
        if (dir) void vscode.window.showWarningMessage('Not an explainer: expected a folder like .explain/<name> inside the workspace.');
        return;
      }
      const existing = sessions.get(ref.dir.toString());
      if (existing) {
        existing.panel.reveal(undefined, true);
        return;
      }
      await start(ref, createPanel(context.extensionUri, ref));
    }),
    vscode.commands.registerCommand('codeExplainer.pin', async () => {
      const ref = current?.ref ?? (await pickExplainer());
      if (!ref) return;
      const open = sessions.get(ref.dir.toString());
      try {
        await pinAnchors(ref, (id) => open?.liveHint(id));
      } catch (e) {
        log.error(`Pin Anchors failed for ${ref.name}: ${(e as Error).message}`);
        void vscode.window.showErrorMessage(`Couldn't pin anchors: ${(e as Error).message}`);
      }
    }),
    vscode.commands.registerCommand('codeExplainer.nextStep', () => current?.navigate(1)),
    vscode.commands.registerCommand('codeExplainer.prevStep', () => current?.navigate(-1)),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: PanelState | undefined) {
        const ref = typeof state?.dir === 'string' ? refFromDir(vscode.Uri.parse(state.dir)) : undefined;
        // In Restricted Mode, an explainer is shown only when the user opens it, never automatically.
        if (!ref || sessions.has(ref.dir.toString()) || !vscode.workspace.isTrusted) {
          panel.dispose();
          return;
        }
        panel.webview.options = panelOptions(context.extensionUri, ref);
        await start(ref, panel);
      },
    }),
  );
}

async function pickExplainer(): Promise<ExplainerRef | undefined> {
  // Skip dependency and build folders; search.exclude doesn't apply to findFiles with an explicit pattern.
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
  for (const s of sessions.values()) s.dispose();
}
