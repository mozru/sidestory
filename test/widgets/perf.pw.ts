// Widget boot time, and JS heap per frame without site isolation (docs/WIDGETS-PLAN.md §13).
// Prints a report; asserts loose bounds only. perf-isolation.pw.ts measures under site isolation.
import { cjs, expect, init, libsFor, test } from './fixtures.ts';
import { gcAndHeap, mb, median, mountAndWait } from './perf-shared.ts';

test.describe('boot time', () => {
  test('React + Recharts + Motion + ui: libraries, runtime and widget to first paint', async ({ harness }) => {
    // The first frame compiles the libraries; later ones hit V8's cache for identical script text.
    const cold = await harness.timing(await mountAndWait(harness));
    const samples: { boot: number; ready: number; firstHeight: number }[] = [];
    for (let i = 0; i < 7; i++) {
      const id = await mountAndWait(harness);
      samples.push(await harness.timing(id));
      await harness.page.evaluate((id) => (window as any).cx.remove(id), id);
    }
    const r = {
      boot: median(samples.map((s) => s.boot)), ready: median(samples.map((s) => s.ready)), firstPaint: median(samples.map((s) => s.firstHeight)),
    };
    console.log(`[widget perf] boot (frame created → bootstrap ran) ${r.boot.toFixed(0)} ms; ` +
      `libraries + runtime evaluated ${r.ready.toFixed(0)} ms; first paint (first non-zero height) ${r.firstPaint.toFixed(0)} ms ` +
      `(median of ${samples.length}; budget 150 ms); first frame (cold compile): ready ${cold.ready.toFixed(0)} ms, first paint ${cold.firstHeight.toFixed(0)} ms`);
    // The budget is 150 ms on a typical laptop; CI machines vary, so the hard bound is looser.
    expect(r.firstPaint).toBeLessThan(400);
  });
});

test.describe('memory without site isolation', () => {
  test('JS heap per widget frame (same process as the page)', async ({ harness, page }) => {
    const session = await page.context().newCDPSession(page);
    const before = await gcAndHeap(session);
    await mountAndWait(harness);
    const one = await gcAndHeap(session);
    for (let i = 1; i < 8; i++) await mountAndWait(harness);
    const eight = await gcAndHeap(session);
    console.log(`[widget perf] no isolation: page heap ${mb(before)}; +1 widget ${mb(one - before)}; +8 widgets ${mb(eight - before)} (${mb((eight - one) / 7)} per extra widget)`);
    expect((eight - one) / 7).toBeLessThan(30 * 1048576);
  });
});

test('loop guard overhead in a tight loop', async ({ harness }) => {
  const id = await harness.mount({ libs: libsFor(['react']), init: init('w.tsx', { 'w.tsx': cjs('exports.default = function W() { return _jsxruntime.jsx("p", { children: "x" }); };') }) });
  await harness.waitFor(id, 'height');
  const frame = await harness.frameHandle(id);
  const [plain, guarded] = await frame.evaluate(() => {
    const g = (globalThis as any).__cxLoopGuard as () => void;
    let t = performance.now(), k = 0;
    for (let i = 0; i < 5e7; i++) k += i & 1;
    const plain = performance.now() - t;
    t = performance.now();
    for (let i = 0; i < 5e7; i++) { g(); k += i & 1; }
    return [plain, performance.now() - t, k];
  });
  console.log(`[widget perf] 50M-iteration loop: ${plain!.toFixed(0)} ms plain, ${guarded!.toFixed(0)} ms guarded`);
  expect(guarded).toBeLessThan(1000);
});
