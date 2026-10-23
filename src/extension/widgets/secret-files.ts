// Secret-looking file names (docs/WIDGETS-PLAN.md §5.2, SECURITY.md). Widgets never get these: not as code
// they can read (`useAnchorCode`), not as imports, not as images. The one place the rule lives: code access,
// the compiler and the checker all ask here. Judged on the file's NAME only (folder names don't count:
// `src/tokens/lexer.ts` is ordinary code), case-insensitively:
// - always: `.env`, `.env.*`, `.envrc`; `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keystore`, `*.jks`, `*.tfvars`;
//   `*kubeconfig*`; SSH keys `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519` (and `.pub`); `.npmrc`, `.netrc`,
//   `.pypirc`, `.git-credentials`, `.dockercfg`, `.htpasswd`; `appsettings.*.json`;
// - for config and data files only (extension json, yaml/yml, toml, ini, env, conf, cfg, properties, xml,
//   txt, or none): names containing `secret`, `credential`, `password`, `token` or `apikey` (`api-key`,
//   `api_key`), and `*.local.*` (settings.local.json). Source files (.ts, .tsx, .js, .py, .sv, .go …) are
//   never secret by name: `tokenBucket.ts` and `tokens-chart.tsx` are code.

const ALWAYS: RegExp[] = [
  /^\.env(\..*)?$/, // .env, .env.local, .env.production
  /^\.envrc$/,
  /\.(pem|key|p12|pfx|keystore|jks|tfvars)$/,
  /kubeconfig/,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /^(\.npmrc|\.netrc|\.pypirc|\.git-credentials|\.dockercfg|\.htpasswd)$/,
  /^appsettings\..+\.json$/,
];

/** Extensions of config and data files, where a secret-sounding name means what it says. */
const CONFIG_EXTENSIONS = new Set(['json', 'yaml', 'yml', 'toml', 'ini', 'env', 'conf', 'cfg', 'properties', 'xml', 'txt']);
const SECRET_WORD = /secret|credential|password|token|api[-_.]?key/;

/** The extension of a file name, lowercase, without the dot ('' for none, and for dot files like `.token`). */
function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i + 1);
}

/** True when a file name (not a path) looks like it holds secrets. */
export function isSecretFileName(name: string): boolean {
  const n = name.toLowerCase();
  if (ALWAYS.some((p) => p.test(n))) return true;
  const ext = extensionOf(n);
  if (ext !== '' && !CONFIG_EXTENSIONS.has(ext)) return false;
  return SECRET_WORD.test(n) || /\.local\./.test(n);
}

/** True when the file a `/`-separated path names looks like it holds secrets (its folders don't count). */
export function isSecretPath(path: string): boolean {
  const name = path.split('/').filter((s) => s !== '').at(-1);
  return name !== undefined && isSecretFileName(name);
}
