// The few things comments need from git, through the vscode.git API only (the extension never runs git), and
// only in trusted workspaces (docs/COMMENTS-PLAN.md §5.1, §12.7).
import * as vscode from 'vscode';
import { localPath } from '../local-path.ts';

interface Repo {
  readonly rootUri: vscode.Uri;
  readonly state: { readonly HEAD?: { readonly name?: string; readonly commit?: string } };
  getConfig?(key: string): Promise<string>;
  checkIgnore?(paths: string[]): Promise<Set<string>>;
  log?(options: { maxEntries?: number; path?: string }): Promise<{ authorName?: string }[]>;
}
interface Api {
  getRepository(uri: vscode.Uri): Repo | null;
}

let api: Promise<Api | undefined> | undefined;

function getApi(): Promise<Api | undefined> {
  if (!vscode.workspace.isTrusted) return Promise.resolve(undefined);
  api ??= (async () => {
    try {
      const ext = vscode.extensions.getExtension<{ getAPI(v: 1): Api }>('vscode.git');
      if (!ext) return undefined;
      return (ext.isActive ? ext.exports : await ext.activate()).getAPI(1);
    } catch {
      return undefined;
    }
  })();
  return api;
}

export async function repoAt(uri: vscode.Uri): Promise<Repo | undefined> {
  return (await getApi())?.getRepository(uri) ?? undefined;
}

export async function gitUserName(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return (await (await repoAt(uri))?.getConfig?.('user.name'))?.trim() || undefined;
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
  if (!r?.checkIgnore) return undefined;
  try {
    return (await r.checkIgnore([localPath(uri)])).size > 0;
  } catch {
    return undefined;
  }
}

/** Whether git tracks any file under this folder (Make Local warns: a committed thread stays in history). */
export async function gitTracks(uri: vscode.Uri): Promise<boolean | undefined> {
  const r = await repoAt(uri);
  if (!r?.log) return undefined;
  try {
    return (await r.log({ maxEntries: 1, path: localPath(uri) })).length > 0;
  } catch {
    return undefined;
  }
}
