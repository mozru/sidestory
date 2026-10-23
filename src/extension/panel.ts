import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { WIDGET_BOOTSTRAP } from '../shared/widget-bootstrap.ts';
import type { ExplainerRef } from './explainers.ts';

/** CSP source allowing exactly the widget bootstrap script. */
export const BOOTSTRAP_HASH = `sha256-${createHash('sha256').update(WIDGET_BOOTSTRAP, 'utf8').digest('base64')}`;

export const VIEW_TYPE = 'sidestory.explainer';

export function panelOptions(extensionUri: vscode.Uri, ref: ExplainerRef): vscode.WebviewPanelOptions & vscode.WebviewOptions {
  return {
    enableScripts: true,
    enableFindWidget: true,
    // Hidden panels are rebuilt from `init` when shown again, so no need to keep them alive.
    retainContextWhenHidden: false,
    // The whole `.explain/` folder, so it covers whichever explainer the panel dives into.
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview'), vscode.Uri.joinPath(ref.dir, '..')],
  };
}

export function createPanel(extensionUri: vscode.Uri, ref: ExplainerRef, column: vscode.ViewColumn = vscode.ViewColumn.Beside): vscode.WebviewPanel {
  return vscode.window.createWebviewPanel(
    VIEW_TYPE,
    `Explainer: ${ref.name}`,
    { viewColumn: column, preserveFocus: true },
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
    // Our script by nonce; the widget frame bootstrap by hash, and what it appends via 'strict-dynamic'
    // (docs/WIDGETS-PLAN.md §3). The nonce never reaches widget code.
    `script-src 'nonce-${nonce}' '${BOOTSTRAP_HASH}' 'strict-dynamic'`,
    // Strings become HTML only through our named policies (src/webview/trusted.ts). `default` is for
    // widget frames, which inherit this list; the panel itself never creates it.
    "require-trusted-types-for 'script'",
    'trusted-types cx-static cx-sanitize cx-widget default',
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
