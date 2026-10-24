// The bootstrap's one git question (docs/CHANGES-PLAN.md §9.1): is HEAD on a branch with commits its default base
// doesn't have? Then the Sidestory container is worth showing even with no sidestory yet, since its "This branch" group
// offers to explain the branch. One getMergeBase call per candidate base through the vscode.git API (never
// git itself), no file list. Bundled into the bootstrap: it imports nothing but `vscode`.
import * as vscode from 'vscode';

interface ProbeRepo {
  readonly state: { readonly HEAD?: { readonly commit?: string } };
  getMergeBase(a: string, b: string): Promise<string | undefined>;
}
interface ProbeApi {
  readonly state: string;
  readonly repositories: ProbeRepo[];
  readonly onDidChangeState: vscode.Event<string>;
  readonly onDidOpenRepository: vscode.Event<ProbeRepo>;
}

const REF = /^(?![-/])[A-Za-z0-9._/-]{1,200}$/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits for the git extension to open its repositories (at most `timeoutMs`). */
async function repositories(api: ProbeApi, timeoutMs: number): Promise<ProbeRepo[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (api.repositories.some((r) => r.state.HEAD?.commit)) return api.repositories;
    // Initialized with no repository for a while: not a git folder.
    if (api.state === 'initialized' && !api.repositories.length && Date.now() - start > 5000) return [];
    await sleep(500);
  }
  return api.repositories;
}

export async function branchDiffersFromBase(timeoutMs = 30_000): Promise<boolean> {
  try {
    if (!vscode.workspace.isTrusted) return false;
    const ext = vscode.extensions.getExtension<{ enabled: boolean; getAPI(v: 1): ProbeApi }>('vscode.git');
    if (!ext) return false;
    const exports = ext.isActive ? ext.exports : await ext.activate();
    if (!exports.enabled) return false;
    const api = exports.getAPI(1);
    const setting = vscode.workspace.getConfiguration('sidestory.changes').get<string>('defaultBase')?.trim();
    const candidates = [
      ...(setting && REF.test(setting) && !setting.includes('..') && !setting.includes('@{') ? [`refs/heads/${setting}`, `refs/remotes/${setting}`, `refs/remotes/origin/${setting}`] : []),
      'refs/remotes/origin/HEAD',
      'refs/heads/main',
      'refs/heads/master',
      'refs/remotes/origin/main',
      'refs/remotes/origin/master',
    ];
    for (const repo of (await repositories(api, timeoutMs)).slice(0, 5)) {
      const head = repo.state.HEAD?.commit;
      if (!head) continue;
      for (const base of candidates) {
        const mb = await repo.getMergeBase(base, head).catch(() => undefined);
        if (!mb) continue;
        if (mb.trim() !== head) return true;
        break;
      }
    }
  } catch {
    // no answer: the container stays as it is
  }
  return false;
}
