// One PreparedText per (document, version), shared by panels and the workspace index (docs/NAVIGATION-PLAN.md
// §7.2): a 10 MB file's PreparedText is 60 MB or more, so this keeps at most two, drops each 5 s after its last
// use, and never keeps documents over 1 MB (they are prepared for the caller and not cached).
import { PreparedText } from '../core/text.ts';

export const PREPARED_CACHE = { entries: 2, ttlMs: 5000, maxChars: 1_000_000 } as const;

interface Entry {
  version: number;
  text: PreparedText;
  timer: ReturnType<typeof setTimeout>;
}

export class PreparedTextCache {
  private readonly entries = new Map<string, Entry>();

  /** The prepared text of `key` at `version`, from the cache or made from `source()` now. */
  get(key: string, version: number, source: () => string): PreparedText {
    const hit = this.entries.get(key);
    if (hit && hit.version === version) {
      this.touch(key, hit);
      return hit.text;
    }
    const raw = source();
    const text = PreparedText.from(raw);
    if (raw.length > PREPARED_CACHE.maxChars) return text;
    if (hit) this.drop(key);
    while (this.entries.size >= PREPARED_CACHE.entries) this.drop(this.entries.keys().next().value!);
    const entry: Entry = { version, text, timer: setTimeout(() => this.drop(key), PREPARED_CACHE.ttlMs) };
    this.entries.set(key, entry);
    return text;
  }

  get size(): number {
    return this.entries.size;
  }

  private touch(key: string, e: Entry): void {
    clearTimeout(e.timer);
    e.timer = setTimeout(() => this.drop(key), PREPARED_CACHE.ttlMs);
    // Most recently used last, so the oldest goes first.
    this.entries.delete(key);
    this.entries.set(key, e);
  }

  private drop(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    clearTimeout(e.timer);
    this.entries.delete(key);
  }

  dispose(): void {
    for (const k of [...this.entries.keys()]) this.drop(k);
  }
}
