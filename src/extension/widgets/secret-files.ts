// Secret-looking file names (docs/WIDGETS-PLAN.md §5.2). Widgets never get these: not as code they
// can read, not as imports, not as images. Matched case-insensitively against a name (the last path segment).

const SECRET_NAME_PATTERNS: RegExp[] = [
  /^\.env/, // .env, .env.local, .envrc
  /secret/,
  /token/,
  /credential/,
  /\.(pem|key|p12|pfx|keystore|jks|tfvars)$/,
  /\.local\./, // settings.local.json
  /^appsettings\..+\.json$/,
  /kubeconfig/,
  /^(\.npmrc|\.netrc|\.pypirc|\.git-credentials|\.dockercfg|\.htpasswd)$/,
  /^id_/, // id_rsa, id_ed25519
];

/** True when a file name (not a path) looks like it holds secrets. */
export function isSecretFileName(name: string): boolean {
  const n = name.toLowerCase();
  return SECRET_NAME_PATTERNS.some((p) => p.test(n));
}

/** True when any segment of a `/`-separated path looks like a secret file name. */
export function isSecretPath(path: string): boolean {
  return path.split('/').some((seg) => seg !== '' && isSecretFileName(seg));
}
