// Packages (docs/NAVIGATION-PLAN.md §5.1): one Sidestory folder and the sidestories in it. Labels and the
// packages that count for a file.
import * as vscode from 'vscode';
import { displayText } from '../../core/display-text.ts';
import { uriKey } from '../explainers.ts';

/**
 * A package's label: its root's path relative to its workspace folder, prefixed with the folder's name in
 * multi-root workspaces (`api › services/auth`). A root that is the workspace folder itself gets the folder's name.
 */
export function packageLabel(root: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(root);
  if (!folder) return displayText(root.path.split('/').filter(Boolean).at(-1) ?? root.path, 200);
  const base = folder.uri.path.replace(/\/+$/, '');
  const rel = root.path.length > base.length ? root.path.slice(base.length + 1).replace(/\/+$/, '') : '';
  const multi = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  if (!rel) return displayText(folder.name, 200);
  return displayText(multi ? `${folder.name} › ${rel}` : rel, 200);
}

/** The key of the Sidestory folder a sidestory folder is in. */
export const packageKeyOf = (dir: vscode.Uri) => uriKey(vscode.Uri.joinPath(dir, '..'));

/**
 * The package whose root is the longest path prefix of `fileKey` (keys are `uriKey`s), among `roots`
 * (package key → root key). Undefined when no root contains the file.
 */
export function longestPrefixPackage(fileKey: string, roots: ReadonlyMap<string, string>): string | undefined {
  let best: { pkg: string; len: number } | undefined;
  for (const [pkg, root] of roots) {
    const prefix = root.endsWith('/') ? root : `${root}/`;
    if (fileKey.startsWith(prefix) && (!best || prefix.length > best.len)) best = { pkg, len: prefix.length };
  }
  return best?.pkg;
}
