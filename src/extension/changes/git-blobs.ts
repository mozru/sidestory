// Blobs read through the git extension, once for every reader: the diff editors' old sides (git-fs.ts), coverage's
// merge-base and committed sides (coverage-service.ts) and the comparison's check for unsaved files
// (comparison.ts). A (commit, path) never changes, so details and bytes are kept, by repository, commit and path
// (textconv output depends on the path's attributes, not the blob alone); reads in flight are shared.
import { SizeLru } from '../widgets/lru.ts';
import type { GitRepo } from './git-api.ts';
import { apiPath } from './git-api.ts';

export interface BlobDetails {
  mode: string;
  object: string;
  size: number;
}

/** The git extension's answer for a path a commit doesn't have (`GitErrorCodes.UnknownPath`), as opposed to an error. */
export function isUnknownPath(e: unknown): boolean {
  const x = e as { gitErrorCode?: unknown; message?: unknown } | undefined;
  return x?.gitErrorCode === 'UnknownPath' || (typeof x?.message === 'string' && /not known by git|does not exist in|exists on disk, but not in/i.test(x.message));
}

/** The repository's root, as the cache keys it: the git API hands out a new wrapper for the same repository. */
const rootOf = (repo: GitRepo) => repo.rootUri.toString();

export class GitBlobs {
  private readonly details = new SizeLru<Promise<BlobDetails | 'missing' | undefined>>(20_000);
  private readonly bytes: SizeLru<Uint8Array>;
  private readonly reading = new Map<string, Promise<Uint8Array>>();

  constructor(maxBytes = 64 * 1024 * 1024) {
    this.bytes = new SizeLru(maxBytes);
  }

  /** A path's mode, object id and size at a commit; 'missing' when the commit doesn't have it; undefined when git couldn't say. */
  stat(repo: GitRepo, sha: string, path: string): Promise<BlobDetails | 'missing' | undefined> {
    const key = `${rootOf(repo)}\n${sha}\n${path}`;
    let p = this.details.get(key);
    if (!p) {
      const q: Promise<BlobDetails | 'missing' | undefined> = repo.getObjectDetails(sha, apiPath(repo, path)).then(
        (d) => ({ mode: d.mode, object: d.object, size: d.size }),
        (e: unknown) => {
          if (isUnknownPath(e)) return 'missing';
          // Not cached: a failure may be passing (a partial clone fetching, git busy).
          if (this.details.get(key) === q) this.details.delete(key);
          return undefined;
        },
      );
      p = q;
      this.details.set(key, q, 1);
    }
    return p;
  }

  /** A blob's bytes (callers check `stat` for its mode and size first); rejects when git can't read it. */
  read(repo: GitRepo, sha: string, path: string): Promise<Uint8Array> {
    const key = `${rootOf(repo)}\n${sha}\n${path}`;
    const kept = this.bytes.get(key);
    if (kept) return Promise.resolve(kept);
    let p = this.reading.get(key);
    if (!p) {
      p = repo.buffer(sha, apiPath(repo, path)).then(
        (b) => {
          this.reading.delete(key);
          // A copy: a small Buffer is a view into a shared 8 KB pool the cache would otherwise keep alive.
          const out = new Uint8Array(b);
          this.bytes.set(key, out, Math.max(1, out.byteLength));
          return out;
        },
        (e: unknown) => {
          this.reading.delete(key);
          throw e;
        },
      );
      this.reading.set(key, p);
    }
    return p;
  }

  clear(): void {
    this.details.clear();
    this.bytes.clear();
  }
}
