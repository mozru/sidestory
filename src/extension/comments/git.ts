// The few things comments need from git, through the vscode.git API only (the extension never runs git), and
// only in trusted workspaces (docs/COMMENTS-PLAN.md §5.1, §12.7).
import * as vscode from 'vscode';
import { gitApi, type GitRepo } from '../changes/git-api.ts';
import { localPath } from '../local-path.ts';

export async function repoAt(uri: vscode.Uri): Promise<GitRepo | undefined> {
  const api = await gitApi();
  return (api.kind === 'ok' && api.api.getRepository(uri)) || undefined;
}

export async function gitUserName(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return (await (await repoAt(uri))?.getConfig('user.name'))?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function gitHead(uri: vscode.Uri): Promise<{ branch?: string; commit?: string }> {
  const r = await repoAt(uri);
  return { branch: r?.state.HEAD?.name, commit: r?.state.HEAD?.commit };
}

/** Whether git ignores this path; undefined when the API can't say (Restricted Mode, no repository). */
export async function gitIgnores(uri: vscode.Uri): Promise<boolean | undefined> {
  const r = await repoAt(uri);
  if (!r) return undefined;
  try {
    return (await r.checkIgnore([localPath(uri)])).size > 0;
  } catch {
    return undefined;
  }
}

/** Whether git tracks any file under this folder (Make Local warns: a committed thread stays in history). */
export async function gitTracks(uri: vscode.Uri): Promise<boolean | undefined> {
  const r = await repoAt(uri);
  if (!r) return undefined;
  try {
    return (await r.log({ maxEntries: 1, path: localPath(uri) })).length > 0;
  } catch {
    return undefined;
  }
}
