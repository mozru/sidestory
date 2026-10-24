import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs script without declarations
import { GUIDES, SKILL_REFERENCES, skillCopy } from '../../scripts/sync-skill.mjs';

const repo = join(__dirname, '../..');
const read = (p: string) => readFileSync(join(repo, p), 'utf8').replace(/\r\n/g, '\n');

describe('Claude Code skill (plugins/sidestory)', () => {
  it.each(GUIDES as string[])('ships an up-to-date copy of docs/%s (run `npm run sync-skill`)', (name) => {
    expect(read(`${SKILL_REFERENCES}/${name}`)).toBe(skillCopy(read(`docs/${name}`)));
  });

  it("links the references it names and the copies don't point outside the skill", () => {
    const skill = read('plugins/sidestory/skills/sidestory/SKILL.md');
    for (const name of GUIDES as string[]) expect(skill).toContain(`references/${name}`);
    for (const name of GUIDES as string[]) expect(read(`${SKILL_REFERENCES}/${name}`)).not.toMatch(/\]\(\.\.\//);
  });

  it('marketplace and plugin manifests agree', () => {
    const market = JSON.parse(read('.claude-plugin/marketplace.json'));
    const plugin = JSON.parse(read('plugins/sidestory/.claude-plugin/plugin.json'));
    expect(market.plugins.map((p: { source: string }) => p.source)).toEqual(['./plugins/sidestory', './plugins/sidestory-comments']);
    expect(plugin.name).toBe(market.plugins[0].name);
    const comments = JSON.parse(read('plugins/sidestory-comments/.claude-plugin/plugin.json'));
    expect(comments.name).toBe(market.plugins[1].name);
    expect(comments.dependencies).toEqual(['sidestory']);
    expect(comments.channels).toEqual([{ server: 'sidestory', displayName: 'Sidestory comments' }]);
    const mcp = JSON.parse(read('plugins/sidestory-comments/.mcp.json'));
    expect(Object.keys(mcp.mcpServers)).toEqual(['sidestory']);
    expect(mcp.mcpServers.sidestory.args).toEqual(['${CLAUDE_PLUGIN_ROOT}/server/mcp.cjs', '--project', '${CLAUDE_PROJECT_DIR}']);
  });

  it('ships the comments server bundle, pinned to MCP SDK 1.x', () => {
    const bundle = read('plugins/sidestory-comments/server/mcp.cjs');
    expect(bundle.startsWith('// Sidestory comments MCP server.')).toBe(true);
    expect(bundle).not.toContain('2026-07-28');
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.devDependencies['@modelcontextprotocol/sdk']).toMatch(/^1\.\d+\.\d+$/);
  });
});
