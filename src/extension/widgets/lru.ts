// A least-recently-used map bounded by the total size of its values (as the caller measures them).

export class SizeLru<V> {
  private readonly map = new Map<string, { value: V; size: number }>();
  private total = 0;

  readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get size(): number {
    return this.total;
  }

  get count(): number {
    return this.map.size;
  }

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  /** Stores a value; values bigger than the whole cache aren't kept. */
  set(key: string, value: V, size: number): void {
    const old = this.map.get(key);
    if (old) {
      this.total -= old.size;
      this.map.delete(key);
    }
    if (size > this.maxSize) return;
    this.map.set(key, { value, size });
    this.total += size;
    for (const [k, e] of this.map) {
      if (this.total <= this.maxSize) break;
      this.map.delete(k);
      this.total -= e.size;
    }
  }

  delete(key: string): void {
    const e = this.map.get(key);
    if (!e) return;
    this.map.delete(key);
    this.total -= e.size;
  }

  clear(): void {
    this.map.clear();
    this.total = 0;
  }
}
