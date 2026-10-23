// The word users see (docs/NAVIGATION-PLAN.md §3): an explainer is a "sidestory" in every title and description
// the extension contributes. The format's own names (`data-explain-*`, the widget module 'explainer') aren't text.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));

/** Every `title`, `description` and `markdownDescription` string in package.json, with where it is. */
function texts(node: unknown, path = ''): [string, string][] {
  if (Array.isArray(node)) return node.flatMap((v, i) => texts(v, `${path}[${i}]`));
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([k, v]) =>
    typeof v === 'string' && ['title', 'description', 'markdownDescription'].includes(k) ? [[`${path}.${k}`, v] as [string, string]] : texts(v, `${path}.${k}`),
  );
}

describe('package.json wording', () => {
  const all = texts(pkg);

  it('finds the strings it checks', () => {
    expect(all.length).toBeGreaterThan(20);
    expect(Object.fromEntries(all)['.description']).toMatch(/^Rich sidestories beside your code/);
  });

  it.each(all)('%s says "sidestory", not "explainer"', (_where, text) => {
    expect(text).not.toMatch(/explainer/i);
  });

  it('names the open command Open Sidestory…', () => {
    expect(pkg.contributes.commands.find((c: { command: string }) => c.command === 'sidestory.open').title).toBe('Open Sidestory…');
  });
});
