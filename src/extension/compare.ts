// Compare with… (docs/GUIDE.md "Comparing versions"): the reader picks another version of the sidestory (the
// branch's merge base, the last commit that changed it, or any commit, branch or tag), and it opens beside the
// current one, read from git (read-only, through the sidestory-git: file system, code and all). The two panels then
// move through the steps together; VS Code's own diff editor shows what changed in the code and the page's source.
import * as vscode from 'vscode';
import type { Snapshot } from './changes/comparison.ts';
import { gitApi, relPath, type GitRepo } from './changes/git-api.ts';
import { plainForMessage } from '../core/display-text.ts';
import { localPath } from './local-path.ts';

/** The version picked: its repository, the sidestory's folder in it, the commit, and what to call it. */
export interface PickedVersion {
  repo: GitRepo;
  rel: string;
  commit: string;
  label: string;
}

const short = (sha: string) => sha.slice(0, 7);
const firstLine = (s: string) => (s.split('\n')[0] ?? '').slice(0, 60);

async function repoFor(uri: vscode.Uri): Promise<GitRepo | undefined> {
  const s = await gitApi();
  return s.kind === 'ok' ? (s.api.getRepository(uri) ?? undefined) : undefined;
}

async function readAt(repo: GitRepo, commit: string, path: string): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await repo.buffer(commit, localPath(vscode.Uri.joinPath(repo.rootUri, ...path.split('/')))));
  } catch {
    return undefined; // not there at that commit
  }
}

interface Item extends vscode.QuickPickItem {
  run: () => Promise<{ commit: string; label: string } | undefined>;
}

/** Asks which version to compare with. Undefined: cancelled, or nothing to compare with (said why). */
export async function pickVersion(dir: vscode.Uri, snapshot: Snapshot | undefined): Promise<PickedVersion | undefined> {
  const repo = await repoFor(dir);
  const rel = repo && relPath(repo, dir);
  if (!repo || !rel) {
    void vscode.window.showInformationMessage("Compare needs the sidestory to be in a git repository that VS Code's Git extension has open.");
    return undefined;
  }
  const items: Item[] = [];
  if (snapshot && !snapshot.onBase && snapshot.repo.rootUri.toString() === repo.rootUri.toString()) {
    const name = snapshot.base.spec;
    items.push({ label: `$(git-merge) ${name}`, description: `merge base · ${short(snapshot.mergeBase)}`, detail: 'What this branch changed in the sidestory', run: async () => ({ commit: snapshot.mergeBase, label: `${name}, ${short(snapshot.mergeBase)}` }) });
  }
  let log: { hash: string; message: string }[] = [];
  try {
    log = await repo.log({ maxEntries: 2, path: localPath(vscode.Uri.joinPath(repo.rootUri, ...rel.split('/'))) });
  } catch {
    log = [];
  }
  // The last commit that changed it; if the sidestory is just as it was committed there, the one before.
  const now = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, 'sidestory.html')).then((b) => new TextDecoder().decode(b), () => undefined);
  const latest = log[0];
  const prev = latest && (await readAt(repo, latest.hash, `${rel}/sidestory.html`)) === now ? log[1] : latest;
  if (prev) items.push({ label: '$(history) Previous version', description: `${short(prev.hash)} · ${firstLine(prev.message)}`, detail: 'The last commit that changed this sidestory', run: async () => ({ commit: prev.hash, label: short(prev.hash) }) });
  items.push({
    label: '$(edit) Enter a commit, branch or tag…',
    run: async () => {
      const ref = (await vscode.window.showInputBox({ title: 'Compare with', prompt: 'A commit, branch or tag', placeHolder: 'v0.2.8, origin/main, 4c5d6e7' }))?.trim();
      if (!ref) return undefined;
      if (!/^[\w./@^~{}-]{1,200}$/.test(ref) || ref.startsWith('-')) {
        void vscode.window.showWarningMessage(`"${plainForMessage(ref, 60)}" isn't a commit, branch or tag name.`);
        return undefined;
      }
      try {
        const c = await repo.getCommit(ref);
        return { commit: c.hash, label: ref.length <= 20 ? `${ref}, ${short(c.hash)}` : short(c.hash) };
      } catch {
        void vscode.window.showWarningMessage(`Git doesn't know "${plainForMessage(ref, 60)}".`);
        return undefined;
      }
    },
  });
  const chosen = await vscode.window.showQuickPick(items, { title: 'Compare this sidestory with', matchOnDescription: true });
  const r = await chosen?.run();
  if (!r) return undefined;
  if ((await readAt(repo, r.commit, `${rel}/manifest.json`)) === undefined) {
    void vscode.window.showInformationMessage(`This sidestory isn't there at ${plainForMessage(short(r.commit), 10)}: nothing to compare with.`);
    return undefined;
  }
  return { repo, rel, ...r };
}
