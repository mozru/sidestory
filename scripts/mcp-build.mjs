// The esbuild options for the Sidestory comments MCP server bundle (docs/COMMENTS-PLAN.md §9.1): one CommonJS file,
// no native modules, Node 20+. Used by build.mjs (dist/mcp.cjs) and sync-skill.mjs (the plugin's committed copy).
export const PLUGIN_SERVER = 'plugins/sidestory-comments/server/mcp.cjs';

export function mcpServerBuild(outfile, common = {}) {
  return {
    ...common,
    entryPoints: ['src/mcp/main.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    mainFields: ['module', 'main'],
    banner: { js: '// Sidestory comments MCP server. Built from src/mcp by `npm run sync-skill`; do not edit.' },
    plugins: [
      {
        name: 'no-ajv',
        setup(build) {
          // The SDK's server imports Ajv only for elicitation, which this server never uses (src/mcp/no-ajv.ts).
          build.onResolve({ filter: /validation\/ajv-provider\.js$/ }, () => ({ path: new URL('../src/mcp/no-ajv.ts', import.meta.url).pathname }));
        },
      },
    ],
  };
}
