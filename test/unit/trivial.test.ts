// Mark as Trivial's writes (docs/CHANGES-PLAN.md §7.6, §15): only sidestories whose package holds the file are
// offered; never through a symbolic link (`.sidestory`, the new folder, or a manifest that resolves outside the
// repository); a new sidestory is `.sidestory/<branch with / as ->`, and the why box says so.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => import('./vscode-stub.ts'));
const vscode = await import('./vscode-stub.ts');
const { markTrivial, holdsPath } = await import('../../src/extension/changes/trivial.ts');

let root = '';
let outside = '';
const picks: { label: string; description?: string }[][] = [];
const prompts: string[] = [];
let pickIndex: number | undefined;
const w = vscode.window as unknown as Record<string, unknown>;

const snap = () => ({ repo: { rootUri: vscode.Uri.file(root) }, head: { name: 'alice/retry' }, base: { spec: 'main' } }) as never;
const target = { path: 'src/x.ts', side: 'head' as const, range: { start: 1, end: 1 }, text: 'const x = 1;\n' };
const belonging = (folder: string, prefix: string) => ({ folder, prefix, dir: vscode.Uri.file(join(root, folder)), manifest: { title: folder } }) as never;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cx-trivial-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'cx-outside-')));
  picks.length = 0;
  prompts.length = 0;
  pickIndex = undefined;
  w.showQuickPick = async (items: { label: string }[]) => {
    picks.push(items);
    return pickIndex === undefined ? undefined : items[pickIndex];
  };
  w.showInputBox = async (o: { prompt: string }) => {
    prompts.push(o.prompt);
    return 'formatting only';
  };
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('Mark as Trivial', () => {
  it('offers only the sidestories whose package holds the file', async () => {
    expect(holdsPath({ prefix: '' }, 'src/x.ts')).toBe(true);
    expect(holdsPath({ prefix: 'pkg' }, 'pkg/src/x.ts')).toBe(true);
    expect(holdsPath({ prefix: 'pkg' }, 'pkgs/x.ts')).toBe(false);
    await markTrivial(snap(), [belonging('pkg/.sidestory/a', 'pkg'), belonging('.sidestory/b', '')], target);
    expect(picks[0]!.map((i) => i.description)).toEqual(['.sidestory/b', '.sidestory/alice-retry']);
  });

  it('repository text in the status bar is shown literally, never as an icon', async () => {
    const folder = '.sidestory/b$(zap)';
    mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, folder, 'manifest.json'), JSON.stringify({ version: 2, title: 'B', anchors: {} }));
    pickIndex = 0;
    await markTrivial(snap(), [belonging(folder, '')], { ...target, path: 'src/$(alert).ts' });
    const msg = vscode.statusMessages.at(-1)!;
    expect(msg).toContain('src/\\$(alert).ts');
    expect(msg).toContain('.sidestory/b\\$(zap)');
  });

  it('starts .sidestory/<branch-slug> and says so in the why box', async () => {
    expect(await markTrivial(snap(), [], target)).toBe('.sidestory/alice-retry');
    expect(prompts[0]).toMatch(/^Starts \.sidestory\/alice-retry\. Why/);
    const m = JSON.parse(readFileSync(join(root, '.sidestory/alice-retry/manifest.json'), 'utf8'));
    expect(m).toMatchObject({ base: 'main', anchors: { 'trivial-1': { file: 'src/x.ts', trivial: true, why: 'formatting only' } } });
    expect(readFileSync(join(root, '.sidestory/alice-retry/sidestory.html'), 'utf8')).toContain('<h1>Retry</h1>');
  });

  it('refuses a .sidestory that is a symbolic link', async () => {
    symlinkSync(outside, join(root, '.sidestory'));
    await expect(markTrivial(snap(), [], target)).rejects.toThrow('.sidestory is a symbolic link');
    expect(() => readFileSync(join(outside, 'alice-retry/manifest.json'))).toThrow();
  });

  it('refuses a sidestory folder that is a symbolic link', async () => {
    mkdirSync(join(root, '.sidestory'));
    symlinkSync(outside, join(root, '.sidestory/alice-retry'));
    await expect(markTrivial(snap(), [], target)).rejects.toThrow('.sidestory/alice-retry is a symbolic link');
  });

  it('refuses an existing sidestory whose manifest resolves outside the repository', async () => {
    mkdirSync(join(root, '.sidestory/b'), { recursive: true });
    writeFileSync(join(outside, 'manifest.json'), '{"version":2,"title":"B","anchors":{}}');
    symlinkSync(join(outside, 'manifest.json'), join(root, '.sidestory/b/manifest.json'));
    pickIndex = 0;
    await expect(markTrivial(snap(), [belonging('.sidestory/b', '')], target)).rejects.toThrow('not inside the repository');
    expect(readFileSync(join(outside, 'manifest.json'), 'utf8')).toBe('{"version":2,"title":"B","anchors":{}}');
  });
});
