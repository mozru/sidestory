import * as vscode from 'vscode';
import { assertSize, realPathInside } from './paths.ts';

/** One explainer folder: `<root>/.explain/<name>/`. */
export interface ExplainerRef {
  name: string;
  /** The folder holding the explainer's files. */
  dir: vscode.Uri;
  /** The folder that holds `.explain/`; anchor file paths are relative to it. */
  root: vscode.Uri;
}

export const MAX_MANIFEST_BYTES = 1_000_000;
export const MAX_HTML_BYTES = 5_000_000;
export const MAX_CODE_BYTES = 10_000_000;

/** Builds a ref for `<root>/.explain/<name>`, or undefined if the folder isn't laid out like that inside the workspace. */
export function refFromDir(dir: vscode.Uri): ExplainerRef | undefined {
  const parts = dir.path.split('/').filter(Boolean);
  const name = parts.at(-1);
  if (!name || parts.at(-2) !== '.explain') return undefined;
  const root = vscode.Uri.joinPath(dir, '..', '..');
  const folder = vscode.workspace.getWorkspaceFolder(dir);
  if (!folder || !(root.path + '/').startsWith(folder.uri.path.replace(/\/?$/, '/'))) return undefined;
  return { name, dir, root };
}

export async function findExplainers(): Promise<ExplainerRef[]> {
  const manifests = await vscode.workspace.findFiles('**/.explain/*/manifest.json', undefined, 200);
  return manifests
    .map((m) => refFromDir(vscode.Uri.joinPath(m, '..')))
    .filter((r): r is ExplainerRef => r !== undefined)
    .sort((a, b) => a.dir.path.localeCompare(b.dir.path));
}

export const manifestUri = (ref: ExplainerRef) => vscode.Uri.joinPath(ref.dir, 'manifest.json');
export const htmlUri = (ref: ExplainerRef) => vscode.Uri.joinPath(ref.dir, 'explainer.html');

/**
 * Text of a file under `root`, preferring an open editor's unsaved buffer so edits show without saving.
 * Refuses files outside `root` (after following symlinks) and files over `maxBytes`.
 * Returns undefined if the file is missing or refused.
 */
export async function readInside(uri: vscode.Uri, root: vscode.Uri, maxBytes: number): Promise<string | undefined> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (uri.scheme !== 'file' || root.scheme !== 'file') {
    // Virtual file systems: no symlinks to follow. On remote hosts the extension runs there, so paths are `file:`.
    if (open) return open.getText();
    const bytes = await vscode.workspace.fs.readFile(uri).then(undefined, () => undefined);
    return bytes && bytes.byteLength <= maxBytes ? new TextDecoder().decode(bytes) : undefined;
  }
  const real = await realPathInside(uri.fsPath, root.fsPath);
  if (!real) return undefined;
  if (open) return open.getText().length <= maxBytes ? open.getText() : undefined;
  try {
    await assertSize(real, maxBytes);
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(real)));
  } catch {
    return undefined;
  }
}
