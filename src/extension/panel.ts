import * as vscode from 'vscode';
import type { ExplainerRef } from './explainers.ts';

export const VIEW_TYPE = 'codeExplainer.explainer';

export function panelOptions(extensionUri: vscode.Uri, ref: ExplainerRef): vscode.WebviewPanelOptions & vscode.WebviewOptions {
  return {
    enableScripts: true,
    enableFindWidget: true,
    // Hidden panels are rebuilt from `init` when shown again, so no need to keep them alive.
    retainContextWhenHidden: false,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview'), ref.dir],
  };
}

export function createPanel(extensionUri: vscode.Uri, ref: ExplainerRef): vscode.WebviewPanel {
  return vscode.window.createWebviewPanel(
    VIEW_TYPE,
    `Explainer: ${ref.name}`,
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    panelOptions(extensionUri, ref),
  );
}

/** The page shell. Explainer HTML arrives later by message and is rendered by the script. */
export function shellHtml(webview: vscode.Webview, extensionUri: vscode.Uri, ref: ExplainerRef): string {
  const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const asset = (...p: string[]) => attr(webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', ...p)).toString());
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  const csp = [
    "default-src 'none'",
    // Explainer assets reach the sandboxed content frame as blob: URLs (see src/webview/assets.ts).
    `img-src ${webview.cspSource} data: blob:`,
    `media-src ${webview.cspSource} blob:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource} blob:`,
    `script-src 'nonce-${nonce}'`,
    "form-action 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
  ].join('; ');
  const base = attr(webview.asWebviewUri(ref.dir).toString());
  const dir = attr(ref.dir.toString());
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${asset('codicons', 'codicon.css')}">
<link rel="stylesheet" href="${asset('main.css')}">
<title>Explainer</title>
</head>
<body>
<div id="app" data-base="${base}/" data-dir="${dir}"></div>
<script type="module" nonce="${nonce}" src="${asset('main.js')}"></script>
</body>
</html>`;
}
