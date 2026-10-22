import * as vscode from 'vscode';
import { Decorations } from './decorations.ts';
import type { ExplainerRef } from './explainers.ts';
import { findExplainers, refFromDir } from './explainers.ts';
import { createPanel, panelOptions, VIEW_TYPE } from './panel.ts';
import { ExplainerSession } from './session.ts';

/** State the webview panel serializer keeps across restarts. */
interface PanelState {
  dir?: string;
}

let session: ExplainerSession | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const decorations = new Decorations();
  context.subscriptions.push(decorations, { dispose: () => session?.dispose() });

  const start = async (ref: ExplainerRef, panel: vscode.WebviewPanel) => {
    session?.dispose();
    const s = new ExplainerSession(ref, panel, context.extensionUri, decorations);
    session = s;
    s.onDidDispose(() => {
      if (session === s) session = undefined;
    });
    await s.load();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('codeExplainer.open', async (dir?: vscode.Uri | string) => {
      const ref = dir ? refFromDir(typeof dir === 'string' ? vscode.Uri.parse(dir) : dir) : await pickExplainer();
      if (!ref) {
        if (dir) void vscode.window.showWarningMessage('Not an explainer: expected a folder like .explain/<name> inside the workspace.');
        return;
      }
      if (session && session.ref.dir.toString() === ref.dir.toString()) {
        session.panel.reveal(undefined, true);
        return;
      }
      const panel = createPanel(context.extensionUri, ref);
      await start(ref, panel);
    }),
    vscode.commands.registerCommand('codeExplainer.nextStep', () => session?.navigate(1)),
    vscode.commands.registerCommand('codeExplainer.prevStep', () => session?.navigate(-1)),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: PanelState | undefined) {
        if (typeof state?.dir !== 'string') {
          panel.dispose();
          return;
        }
        const ref = refFromDir(vscode.Uri.parse(state.dir));
        if (!ref) {
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
  session?.dispose();
}
