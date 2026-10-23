// The bootstrap (dist/extension.cjs, docs/NAVIGATION-PLAN.md §8.1): what runs in every workspace after startup.
// It is one small module and, in a workspace with no sidestories, one file watcher. Everything else (the index,
// the sidebar, CodeLens, zod, the resolver, the widget host) is in dist/full.cjs, loaded only once a sidestory
// exists or a command or the panel serializer needs it. It requires nothing but `vscode` and, lazily, full.cjs.
import * as vscode from 'vscode';
import { excludePatterns, globMatcher, joinGlobs } from '../core/glob.ts';
import { AVAILABLE_KEY, COMMANDS, PANEL_VIEW_TYPE } from './bootstrap-shared.ts';
import type { FullApi } from './extension.ts';

/** How full.cjs is loaded; tests replace it. */
export const loader = {
  // A path esbuild can't follow, so full.cjs stays its own file.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  load: (): { activateFull(c: vscode.ExtensionContext): FullApi } => require(['.', 'full.cjs'].join('/')),
};

let full: Promise<FullApi> | undefined;
let api: FullApi | undefined;

/** Loads dist/full.cjs once. */
function load(context: vscode.ExtensionContext): Promise<FullApi> {
  if (full) return full;
  let loaded = false;
  const loading = Promise.resolve().then(() => {
    void vscode.commands.executeCommand('setContext', 'sidestory.indexState', 'loading');
    const mod = loader.load();
    loaded = true;
    api = mod.activateFull(context);
    return api;
  });
  full = loading;
  // Said once, here. Only a failure to load the bundle is retried by the next caller: once activateFull has
  // run, part of it may be registered, and running it again would register everything twice.
  loading.catch((e: unknown) => {
    if (full === loading && !loaded) full = undefined;
    void vscode.window.showErrorMessage(`Sidestory couldn't start: ${e instanceof Error ? e.message : String(e)}`);
  });
  return loading;
}

/** The first command that needs full.cjs shows progress while it loads, so the click never looks dead. */
async function loadWithProgress(context: vscode.ExtensionContext): Promise<FullApi> {
  if (api) return api;
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Loading Sidestory…' }, () => load(context));
}

export function activate(context: vscode.ExtensionContext): void {
  for (const id of COMMANDS) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        let a: FullApi;
        try {
          a = await loadWithProgress(context);
        } catch {
          return undefined; // already reported by load(): one message, not a second from the command
        }
        return a.commands[id]?.(...args);
      }),
    );
  }
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(PANEL_VIEW_TYPE, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown) {
        await (await load(context)).deserialize(panel, state);
      },
    }),
  );

  const remembered = context.workspaceState.get(AVAILABLE_KEY);
  if (remembered) {
    void vscode.commands.executeCommand('setContext', 'sidestory.available', true);
    void load(context);
    return;
  }
  // No sidestory known here: one watcher for the first one (an agent writing .sidestory/x/ now), honouring the
  // merged exclusions so files under node_modules don't wake it, and one bounded search for any already there.
  const patterns = excludePatterns(vscode.workspace.getConfiguration('files').get('exclude'));
  const exclude = globMatcher(patterns);
  const watcher = vscode.workspace.createFileSystemWatcher('**/.sidestory/*/manifest.json', false, true, true);
  context.subscriptions.push(watcher);
  const wake = () => {
    watcher.dispose();
    void load(context);
  };
  watcher.onDidCreate((uri) => {
    if (full || !looksLikeSidestory(uri) || exclude(vscode.workspace.asRelativePath(uri, false))) return;
    void context.workspaceState.update(AVAILABLE_KEY, true);
    void vscode.commands.executeCommand('setContext', 'sidestory.available', true);
    wake();
  });
  void Promise.resolve(vscode.workspace.findFiles('**/.sidestory/*/manifest.json', joinGlobs(patterns), 1)).then(
    (found) => {
      if (!full && found.some(looksLikeSidestory)) wake();
    },
    () => {},
  );
}

/**
 * `<root>/.sidestory/<name>/manifest.json` inside a workspace folder, with no other `.sidestory` between the folder
 * and the root (the full extension's `refFromDir` rule, without its imports).
 */
export function looksLikeSidestory(manifest: vscode.Uri): boolean {
  const parts = manifest.path.split('/').filter(Boolean);
  if (parts.at(-1) !== 'manifest.json' || parts.at(-3) !== '.sidestory') return false;
  const folder = vscode.workspace.getWorkspaceFolder(manifest);
  if (!folder) return false;
  const depth = folder.uri.path.split('/').filter(Boolean).length;
  return !parts.slice(depth, -3).includes('.sidestory');
}

export function deactivate(): void {
  api?.deactivate();
}
