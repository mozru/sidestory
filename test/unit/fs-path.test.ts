// The fsPath guard (docs/CHANGES-PLAN.md §15): a URI's `fsPath` is only a real path for `file:` URIs, so new code
// goes through `localPath` (src/extension/local-path.ts), which throws for any other scheme. The uses below were
// reviewed (each is on a `file:` URI: a workspace root, a repository root, a path the git API gave); a new one fails
// here until it is reviewed too, or uses `localPath`.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REVIEWED: Record<string, number> = {
  'changes/comparison.ts': 1,
  'changes/git-api.ts': 1,
  'changes/git-fs.ts': 1,
  'changes/probe.ts': 1,
  'changes/service.ts': 1, // the resourcePath context key's values (Open Changes with Base): matched, never read
  'explainers.ts': 11,
  'extension.ts': 3,
  'highlight/service.ts': 4,
  'local-path.ts': 2,
  'pin.ts': 4,
  'session.ts': 6,
  'widgets/git.ts': 15,
  'widgets/host.ts': 8,
};

function files(dir: string, base = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name), `${base}${d.name}/`) : d.name.endsWith('.ts') ? [`${base}${d.name}`] : []));
}

describe('fsPath outside the reviewed uses', () => {
  it('src/extension uses .fsPath only where reviewed', () => {
    const found: Record<string, number> = {};
    for (const f of files('src/extension')) {
      const n = (readFileSync(join('src/extension', f), 'utf8').match(/\.fsPath\b/g) ?? []).length;
      if (n) found[f] = n;
    }
    expect(Object.keys(found).length).toBeGreaterThan(3);
    for (const [f, n] of Object.entries(found)) expect(n, `${f}: ${n} uses of .fsPath (reviewed: ${REVIEWED[f] ?? 0}); use localPath(uri)`).toBeLessThanOrEqual(REVIEWED[f] ?? 0);
  });
});
