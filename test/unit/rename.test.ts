// The folder rename (docs/NAVIGATION-PLAN.md §2): sidestories live in `.sidestory/<name>/sidestory.html`, and
// nothing still looks for the old folder or page names (spelled OLD_DIR and OLD_PAGE here, so the §2.3 greps stay empty).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { checkExplainer, main } from '../../src/cli/check-widgets.ts';
import { Uri, workspace } from './vscode-stub.ts';

vi.mock('vscode', () => import('./vscode-stub.ts'));

const { htmlUri, refFromDir } = await import('../../src/extension/explainers.ts');

const repo = join(__dirname, '../..');
const OLD_DIR = `.${'explain'}`;
const OLD_PAGE = `${'explainer'}.html`;
const base = mkdtempSync(join(tmpdir(), 'cx-rename-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('refFromDir', () => {
  workspace.root = Uri.file('/ws');
  const ref = (p: string) => refFromDir(Uri.file(p) as never);

  it('accepts <root>/.sidestory/<name>, with the page sidestory.html', () => {
    const r = ref('/ws/pkg/.sidestory/x')!;
    expect(r.name).toBe('x');
    expect(r.root.path).toBe('/ws/pkg');
    expect(htmlUri(r).path).toBe('/ws/pkg/.sidestory/x/sidestory.html');
  });

  it('rejects the old folder name and a Sidestory folder inside another', () => {
    expect(ref(`/ws/${OLD_DIR}/x`)).toBeUndefined();
    expect(ref('/ws/.sidestory/x/.sidestory/y')).toBeUndefined();
    expect(ref('/ws/.sidestory')).toBeUndefined();
  });
});

describe('package.json', () => {
  const text = readFileSync(join(repo, 'package.json'), 'utf8');

  it('names neither the old folder nor the old page', () => {
    expect(text).not.toMatch(new RegExp(`\\${OLD_DIR}(?![\\w-])`));
    expect(text).not.toContain(OLD_PAGE);
  });

  it('activates on .sidestory manifests and offers Open Sidestory on .sidestory folders', () => {
    const pkg = JSON.parse(text);
    expect(pkg.activationEvents).toContain('workspaceContains:**/.sidestory/*/manifest.json');
    const menu = pkg.contributes.menus['explorer/context'].find((m: { command: string }) => m.command === 'sidestory.open');
    expect(menu.when).toContain('resourceDirname =~ /\\.sidestory$/');
  });
});

describe('the checker', () => {
  it('warns about a folder outside .sidestory (not-in-sidestory) and names the folder `sidestory` in --json', async () => {
    const dir = join(base, OLD_DIR, 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'sidestory.html'), '<!doctype html><section data-explain-anchor="a"><h2>A</h2></section>\n');
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: 1, title: 'Demo', anchors: {} }));
    const r = await checkExplainer(dir);
    expect(r.findings.map((f) => f.code)).toContain('not-in-sidestory');
    const out: string[] = [];
    await main([dir, '--json'], { out: (s) => out.push(s), err: () => {} });
    const json = JSON.parse(out.join(''));
    expect(json.sidestory).toBe(dir);
    expect(json).not.toHaveProperty('explainer');
  });

  it('reads sidestory.html, not the old page name', async () => {
    const dir = join(base, 'old/.sidestory/demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, OLD_PAGE), '<!doctype html>\n');
    const r = await checkExplainer(dir);
    expect(r.findings.find((f) => f.code === 'not-found')?.message).toContain('sidestory.html');
  });
});
