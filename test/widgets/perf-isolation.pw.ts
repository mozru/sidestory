// Memory with site isolation, as on desktop (--site-per-process with IsolateSandboxedIframes): all widget
// frames of a panel share one renderer process, so memory is measured at the browser level (process RSS
// via SystemInfo.getProcessInfo + ps, frame targets via Target.getTargets) and per frame (JS heap of the
// widget process). docs/WIDGETS-PLAN.md §13.
import { expect, test } from './fixtures.ts';
import { gcAndHeap, iframeTargets, mb, mountAndWait, processes } from './perf-shared.ts';

test.use({ launchOptions: { args: ['--site-per-process', '--enable-features=IsolateSandboxedIframes'] } });
// Process RSS comes from `ps`, which Windows doesn't have.
test.skip(process.platform === 'win32', 'measures process memory with ps');


test('8 React + Recharts widgets: renderer processes, RSS and JS heap per frame', async ({ harness, page }) => {
  const renderers = async () => (await processes(page)).filter((p) => p.type === 'renderer');
  const base = await renderers();
  const ids = [await mountAndWait(harness)];
  const one = await renderers();
  const frame = await harness.frameHandle(ids[0]!);
  const session = await page.context().newCDPSession(frame); // an out-of-process frame: its own target
  const heap1 = await gcAndHeap(session);
  for (let i = 1; i < 8; i++) ids.push(await mountAndWait(harness));
  const eight = await renderers();
  const heap8 = await gcAndHeap(session);
  const targets = await iframeTargets(page);
  // The widget process: the renderer that grew most (process info doesn't say which frames it hosts).
  const rss = (list: typeof base, pid: number) => list.find((p) => p.pid === pid)?.rss ?? 0;
  const widgetPid = eight.map((p) => ({ pid: p.pid, growth: p.rss - rss(base, p.pid) })).sort((a, b) => b.growth - a.growth)[0]!.pid;

  const report = {
    rendererProcesses: { before: base.length, oneWidget: one.length, eightWidgets: eight.length },
    iframeTargets: targets,
    renderersRss: eight.map((p) => `${p.pid}${p.pid === widgetPid ? ' (widgets)' : ''}: ${mb(rss(base, p.pid))} → ${mb(rss(one, p.pid))} → ${mb(p.rss)}`),
    widgetProcessRss: { oneWidget: mb(rss(one, widgetPid)), eightWidgets: mb(rss(eight, widgetPid)), perExtraWidget: mb((rss(eight, widgetPid) - rss(one, widgetPid)) / 7) },
    widgetProcessJsHeap: { oneWidget: mb(heap1), eightWidgets: mb(heap8), perExtraWidget: mb((heap8 - heap1) / 7) },
    allRenderersRss: { before: mb(base.reduce((s, p) => s + p.rss, 0)), eightWidgets: mb(eight.reduce((s, p) => s + p.rss, 0)) },
  };
  console.log(`[widget perf] site isolation: ${JSON.stringify(report, null, 1)}`);
  // All widget frames of the panel share one extra process.
  expect(eight.length).toBe(one.length);
  expect(targets).toBe(8);
  await session.detach();
});
