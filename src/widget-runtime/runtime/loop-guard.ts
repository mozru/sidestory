// globalThis.__cxLoopGuard(): called by the compiler's loop guards on every iteration of every loop in
// widget code (docs/WIDGETS-PLAN.md §3). One global counter, and a "last yielded" timestamp refreshed by a
// MessageChannel tick: if guarded loops keep running for over LIMIT_MS without the event loop getting a
// turn, the guard throws. Cheap in tight loops (a decrement; the clock is read every `stride` iterations,
// and the stride adapts so slow iterations are still checked often).

export const LOOP_LIMIT_MS = 1000;
export const LOOP_GUARD_MESSAGE =
  `A loop ran for more than ${LOOP_LIMIT_MS / 1000} s without yielding, so it was stopped. ` +
  'Spread heavy work over frames (requestAnimationFrame, d3.timer).';

export function installLoopGuard(): void {
  let countdown = 1;
  let stride = 1;
  let lastCheck = 0;
  let pending = false; // a tick is in flight: the event loop hasn't had a turn since `windowStart`
  let windowStart = 0;
  const channel = new MessageChannel();
  channel.port1.onmessage = () => { pending = false; };

  function check() {
    const now = performance.now();
    const dt = now - lastCheck;
    lastCheck = now;
    if (dt < 1 && stride < 4096) stride *= 2;
    else if (dt > 8 && stride > 1) stride = Math.max(1, stride >> 2);
    countdown = stride;
    if (!pending) {
      pending = true;
      windowStart = now;
      channel.port2.postMessage(0);
      return;
    }
    if (now - windowStart > LOOP_LIMIT_MS) {
      countdown = 1; // keep throwing (every iteration) until the event loop gets a turn
      stride = 1;
      throw new Error(LOOP_GUARD_MESSAGE);
    }
  }

  Object.defineProperty(globalThis, '__cxLoopGuard', {
    value: function __cxLoopGuard() { if (--countdown <= 0) check(); },
    configurable: false, writable: false, enumerable: false,
  });
}
