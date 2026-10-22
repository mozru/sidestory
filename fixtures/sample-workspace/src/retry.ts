export interface RetryOptions {
  /** Attempts after the first one. */
  retries: number;
  /** Ceiling of the first backoff, in milliseconds. */
  baseMs: number;
  /** No single wait is longer than this. */
  maxMs: number;
  /** Return false to give up early, e.g. on a 4xx error. */
  shouldRetry?: (err: unknown) => boolean;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** "Full jitter": a random wait between 0 and an exponentially growing ceiling. */
export function backoffDelay(attempt: number, opts: RetryOptions, rand = Math.random): number {
  const ceiling = Math.min(opts.maxMs, opts.baseMs * 2 ** attempt);
  return Math.floor(rand() * ceiling);
}

export async function retry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const retryable = opts.shouldRetry?.(err) ?? true;
      if (!retryable || attempt >= opts.retries) throw err;
      await sleep(backoffDelay(attempt, opts));
    }
  }
}
