// Copies the authoring guides into the Claude Code skill (plugins/sidestory/skills/sidestory/references/),
// which is installed on its own, without the rest of the repository. Links that leave docs/ become GitHub URLs.
// test/unit/skill.test.ts fails when the copies are out of date: run `npm run sync-skill`.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SKILL_REFERENCES = 'plugins/sidestory/skills/sidestory/references';
export const GUIDES = ['GUIDE.md', 'WIDGETS.md'];
const REPO = 'https://github.com/mozru/sidestory';

/** The skill's copy of docs/<name>. */
export function skillCopy(markdown) {
  const header = '<!-- Copied from docs/ by scripts/sync-skill.mjs; edit the original. -->\n';
  // ![alt](../path) → raw file; [text](../path) → the file on GitHub. Links within docs/ stay relative (both guides are copied).
  const body = markdown
    .replace(/(!\[[^\]]*\]\()\.\.\/([^)\s]+)\)/g, `$1${REPO}/raw/main/$2)`)
    .replace(/(\[[^\]]*\]\()\.\.\/([^)\s]+)\)/g, `$1${REPO}/blob/main/$2)`)
    .replace(/(\[[^\]]*\]\()(?!https?:|#|GUIDE\.md|WIDGETS\.md)([^)\s]+\.md(?:#[^)\s]*)?)\)/g, `$1${REPO}/blob/main/docs/$2)`);
  return header + body;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const name of GUIDES) writeFileSync(`${SKILL_REFERENCES}/${name}`, skillCopy(readFileSync(`docs/${name}`, 'utf8')));
  console.log(`Updated ${GUIDES.map((n) => `${SKILL_REFERENCES}/${n}`).join(', ')}`);
  // The sidestory-comments plugin's server: one committed bundle, since plugins are installed without a build step.
  const esbuild = await import('esbuild');
  const { mcpServerBuild, PLUGIN_SERVER } = await import('./mcp-build.mjs');
  await esbuild.build({ ...mcpServerBuild(PLUGIN_SERVER), minify: true, legalComments: 'eof', logLevel: 'warning' });
  console.log(`Updated ${PLUGIN_SERVER}`);
}
