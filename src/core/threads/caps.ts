// Size caps for comment threads (docs/COMMENTS-PLAN.md §3.3). Kept free of zod: the panel imports them.
export const CAPS = {
  eventBytes: 32_000,
  eventsPerThread: 200,
  threadsPerSidestory: 1000,
  threadsTotal: 5000,
  bytesPerSidestory: 20_000_000,
  bodyChars: 8000,
  nameChars: 64,
  edited: 20,
} as const;
