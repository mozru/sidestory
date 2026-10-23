// Index memory (docs/NAVIGATION-PLAN.md §11.1, §12.1): about 120 B per anchor and 450 B per step, measured with
// gc() over 50,000 of each. Runs in its own vitest project (forks, --expose-gc): see vitest.config.ts.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { manifestText, tempRoot, write } from './nav-fixtures.ts';
import { Uri, workspace } from './vscode-stub.ts';

vi.mock('vscode', () => import('./vscode-stub.ts'));

const { SidestoryIndex } = await import('../../src/extension/nav/index.ts');
const { SidestoryWatcher } = await import('../../src/extension/nav/watcher.ts');

const gc = (globalThis as { gc?: () => void }).gc;
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const STORIES = 100;
const PER = 500; // the manifest's anchor limit

async function heap(): Promise<number> {
  for (let i = 0; i < 3; i++) {
    gc!();
    await new Promise((r) => setTimeout(r, 10));
  }
  return process.memoryUsage().heapUsed;
}

/** Bytes the index holds for a workspace, per item. */
async function measure(build: (root: string) => void, items: number, stories = STORIES): Promise<number> {
  const root = tempRoot('cx-mem-');
  roots.push(root);
  build(root);
  workspace.root = Uri.file(root);
  const before = await heap();
  const watcher = new SidestoryWatcher();
  const index = new SidestoryIndex(watcher);
  await index.refresh();
  const after = await heap();
  expect(index.stats()).toMatchObject({ sidestories: stories });
  index.dispose();
  watcher.dispose();
  return (after - before) / Math.max(1, items);
}

describe.runIf(!!gc)('index memory', () => {
  it('about 120 B per anchor (50,000 anchors over 1,000 files)', async () => {
    const per = await measure((root) => {
      for (let s = 0; s < STORIES; s++) {
        const anchors: Record<string, { file: string; range: [number, number] }> = {};
        for (let i = 0; i < PER; i++) anchors[`anchor-${i}`] = { file: `src/m${(s * PER + i) % 1000}/file.ts`, range: [i + 1, i + 3] };
        write(join(root, '.sidestory', `s${s}`, 'manifest.json'), manifestText({ title: `Sidestory ${s}`, anchors }));
        write(join(root, '.sidestory', `s${s}`, 'sidestory.html'), '<p>no steps</p>');
      }
    }, STORIES * PER);
    console.log(`index memory: ${per.toFixed(0)} B per anchor`);
    expect(per).toBeLessThan(120 * 1.5);
  }, 60_000);

  it('about 450 B per step (50,000 steps, titles and blurbs of realistic length)', async () => {
    const title = 'A step title of a realistic length, about sixty characters';
    const blurb = 'A first paragraph that runs for a while, the way a real step opens its explanation of the code it covers.';
    const per = await measure((root) => {
      for (let s = 0; s < STORIES; s++) {
        const html = Array.from({ length: PER }, (_, i) => `<section data-explain-anchor="s${i}"><h2>${title} ${i}</h2><p>${blurb} ${i}</p></section>`).join('\n');
        write(join(root, '.sidestory', `s${s}`, 'manifest.json'), manifestText({ title: `Sidestory ${s}` }));
        write(join(root, '.sidestory', `s${s}`, 'sidestory.html'), html);
      }
    }, STORIES * PER);
    console.log(`index memory: ${per.toFixed(0)} B per step`);
    expect(per).toBeLessThan(450 * 1.5);
  }, 60_000);

  it('outlines keep no page source alive (long ids, titles and detail names are copies, not slices)', async () => {
    const PAGES = 40;
    const filler = `<p>${'x'.repeat(200)}</p>\n`.repeat(2500); // ~500 KB per page
    const per = await measure((root) => {
      for (let s = 0; s < PAGES; s++) {
        const html = `<section data-explain-anchor="a-rather-long-step-identifier-${s}" data-explain-title="A-title-that-needs-no-cleaning-${s}"><h2>H</h2><p data-explain-detail="some-detail-name-${s}">Go.</p></section>${filler}`;
        write(join(root, '.sidestory', `s${s}`, 'manifest.json'), manifestText({ title: `Sidestory ${s}` }));
        write(join(root, '.sidestory', `s${s}`, 'sidestory.html'), html);
      }
    }, PAGES, PAGES);
    console.log(`index memory: ${per.toFixed(0)} B per outlined 500 KB page`);
    // A retained page would be ~1 MB (UTF-16); a flattened outline is a few hundred bytes.
    expect(per).toBeLessThan(20_000);
  }, 60_000);
});
