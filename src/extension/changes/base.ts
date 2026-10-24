// What a branch is compared with (docs/CHANGES-PLAN.md §3.1, §4.3): the base grammar, resolving a base to a commit
// through fully qualified refs, and the default base. Everything goes through a small reader over the vscode.git
// API, so this file has no vscode import and is tested with a stub.

import { FULL_SHA, isValidBase } from '../../core/manifest.ts';

// §3.1's grammar lives with the manifest, which reads `base` too.
export { FULL_SHA, isValidBase };

/** What `resolveBase` needs from a repository. Every method resolves to undefined rather than throwing. */
export interface RefReader {
  /** The commit a fully qualified ref (or full id) names. */
  commit(ref: string): Promise<string | undefined>;
  /** The upstream of a local branch, as `<remote>/<name>`. */
  upstream(branch: string): Promise<{ remote: string; name: string } | undefined>;
  mergeBase(a: string, b: string): Promise<string | undefined>;
  /** Remote names, the default one first. */
  remotes(): string[];
}

export interface ResolvedBase {
  /** The spec as written: `main`, `origin/main`, a full id. */
  readonly spec: string;
  readonly sha: string;
  /** What the view shows: `main`, `main (origin/main)`, `3f2a1c9`. */
  readonly label: string;
  /** The fully qualified ref used, or 'commit'. */
  readonly via: string;
  /** The branch's own name when the base is a branch (for "You're on main"). */
  readonly branch?: string;
}

/**
 * §4.3: a full id if it exists; else `refs/heads/<name>` (and its upstream, the newer of the two, the upstream when
 * they have diverged), `refs/remotes/<remote>/<name>` (the default remote first), `refs/remotes/<name>`, then
 * `refs/tags/<name>`. Never a short name git would resolve its own way (tags before branches).
 */
export async function resolveBase(reader: RefReader, spec: string): Promise<ResolvedBase | undefined> {
  if (!isValidBase(spec)) return undefined;
  if (FULL_SHA.test(spec)) {
    const sha = await reader.commit(spec);
    return sha === spec ? { spec, sha, label: spec.slice(0, 7), via: 'commit' } : undefined;
  }
  const local = await reader.commit(`refs/heads/${spec}`);
  if (local) {
    const up = await reader.upstream(spec);
    const upRef = up && isValidBase(`${up.remote}/${up.name}`) ? `refs/remotes/${up.remote}/${up.name}` : undefined;
    const upSha = upRef ? await reader.commit(upRef) : undefined;
    if (up && upRef && upSha && upSha !== local) {
      const mb = await reader.mergeBase(local, upSha);
      // The upstream contains the local branch (local is behind), or they diverged: the upstream. A stale local
      // main would otherwise pull other people's merged commits into the diff.
      if (mb !== upSha) return { spec, sha: upSha, label: `${spec} (${up.remote}/${up.name})`, via: upRef, branch: spec };
    }
    return { spec, sha: local, label: spec, via: `refs/heads/${spec}`, branch: spec };
  }
  for (const remote of reader.remotes()) {
    const ref = `refs/remotes/${remote}/${spec}`;
    const sha = await reader.commit(ref);
    if (sha) return { spec, sha, label: `${remote}/${spec}`, via: ref, branch: spec };
  }
  const remoteRef = `refs/remotes/${spec}`;
  const remoteSha = spec.includes('/') ? await reader.commit(remoteRef) : undefined;
  if (remoteSha) return { spec, sha: remoteSha, label: spec, via: remoteRef, branch: spec.slice(spec.indexOf('/') + 1) };
  const tag = await reader.commit(`refs/tags/${spec}^{commit}`);
  if (tag) return { spec, sha: tag, label: spec, via: `refs/tags/${spec}` };
  return undefined;
}

/** Where a default base came from, for the base picker's first item. */
export type BaseSource = 'pick' | 'sidestory' | 'git-config' | 'setting' | 'remote-default' | 'fallback';

export interface DefaultBaseInputs {
  /** The user's explicit pick for this branch. */
  readonly pick?: string;
  /** `branch.<name>.vscode-merge-base` (the git extension's record, e.g. `origin/main`). */
  readonly gitConfig?: string;
  /** The `sidestory.changes.defaultBase` setting. */
  readonly setting?: string;
  /** The remote default branch's name, as `<remote>/<name>`. */
  readonly remoteDefault?: string;
}

/** The candidates in §4.3's order (sidestory bases, item 2, arrive with release 1b), invalid ones dropped. */
export function defaultBaseCandidates(i: DefaultBaseInputs): { spec: string; source: BaseSource }[] {
  const out: { spec: string; source: BaseSource }[] = [];
  const add = (spec: string | undefined, source: BaseSource) => {
    const s = spec?.trim();
    if (s && isValidBase(s) && !out.some((o) => o.spec === s)) out.push({ spec: s, source });
  };
  add(i.pick, 'pick');
  add(i.gitConfig, 'git-config');
  add(i.setting, 'setting');
  add(i.remoteDefault, 'remote-default');
  add('main', 'fallback');
  add('master', 'fallback');
  return out;
}

/** The first candidate that resolves. */
export async function resolveDefaultBase(reader: RefReader, i: DefaultBaseInputs): Promise<(ResolvedBase & { source: BaseSource }) | undefined> {
  for (const c of defaultBaseCandidates(i)) {
    const r = await resolveBase(reader, c.spec);
    if (r) return { ...r, source: c.source };
  }
  return undefined;
}

/**
 * The remote's default branch (§4.3 item 5): `refs/remotes/<remote>/HEAD`'s commit, then the remote branch at that
 * commit, preferring `main`, then `master`, then the first of `others` (the remote's branches with their commits,
 * by name, from one bounded listing).
 */
export async function remoteDefault(reader: RefReader, remote: string, others: () => Promise<{ name: string; commit?: string }[]>): Promise<string | undefined> {
  const head = await reader.commit(`refs/remotes/${remote}/HEAD`);
  if (!head) return undefined;
  for (const name of ['main', 'master']) if ((await reader.commit(`refs/remotes/${remote}/${name}`)) === head) return `${remote}/${name}`;
  for (const r of await others()) {
    if (r.name !== 'HEAD' && r.commit === head && isValidBase(`${remote}/${r.name}`)) return `${remote}/${r.name}`;
  }
  return undefined;
}

/** The "Commit…" input (§9.4): 4–64 hex digits, before anything reaches git. */
export const COMMIT_INPUT = /^[0-9a-fA-F]{4,64}$/;
