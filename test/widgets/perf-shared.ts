// Shared by the widget performance specs (perf.pw.ts, perf-isolation.pw.ts).
import { execFileSync } from 'node:child_process';
import type { CDPSession, Page } from '@playwright/test';
import { cjs, expect, init, libsFor, type Harness } from './fixtures.ts';

export const CHART = cjs(`
var _recharts = require("recharts");
var _card = require("@/components/ui/card");
var _button = require("@/components/ui/button");
var _motion = require("motion/react");
var _explainer = require("explainer");
var j = _jsxruntime.jsx, js = _jsxruntime.jsxs;
var data = Array.from({ length: 24 }, (_, i) => ({ x: i, y: Math.round(50 + 40 * Math.sin(i / 3)) }));
exports.default = function Chart() {
  var [n, setN] = (0, _explainer.useWidgetState)("n", 0);
  return js(_card.Card, { children: [
    j(_card.CardHeader, { children: j(_card.CardTitle, { children: "Throughput" }) }),
    js(_card.CardContent, { children: [
      j("div", { className: "h-48", children: j(_recharts.ResponsiveContainer, { children: js(_recharts.LineChart, { data, children: [
        j(_recharts.XAxis, { dataKey: "x" }), j(_recharts.YAxis, {}), j(_recharts.Tooltip, {}),
        j(_recharts.Line, { dataKey: "y", stroke: "var(--chart-1)", isAnimationActive: false, dot: false }),
      ] }) }) }),
      j(_motion.motion.div, { animate: { opacity: 1 }, initial: { opacity: 0.5 }, children: j(_button.Button, { onClick: () => setN(n + 1), children: "n=" + n }) }),
    ] }),
  ] });
};`);
export const LIBS = libsFor(['react', 'recharts', 'motion', 'ui', 'clsx']);
export const chartInit = () => init('chart.tsx', { 'chart.tsx': CHART });

export const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
export const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

export async function mountAndWait(harness: Harness): Promise<number> {
  const id = await harness.mount({ libs: LIBS, init: chartInit() });
  await expect(harness.frame(id).locator('.recharts-line path').first()).toBeAttached({ timeout: 10_000 });
  return id;
}

/** RSS of the browser's processes by type (renderer, GPU, browser…), from SystemInfo + ps. */
export async function processes(page: Page): Promise<{ type: string; pid: number; rss: number }[]> {
  const browserSession = await page.context().browser()!.newBrowserCDPSession();
  const { processInfo } = await browserSession.send('SystemInfo.getProcessInfo') as { processInfo: { type: string; id: number }[] };
  await browserSession.detach();
  const pids = processInfo.map((p) => p.id);
  const rss = new Map<number, number>();
  for (const line of execFileSync('ps', ['-o', 'pid=,rss=', '-p', pids.join(',')], { encoding: 'utf8' }).trim().split('\n')) {
    const [pid, kb] = line.trim().split(/\s+/).map(Number);
    rss.set(pid!, kb! * 1024);
  }
  return processInfo.map((p) => ({ type: p.type, pid: p.id, rss: rss.get(p.id) ?? 0 }));
}

export async function iframeTargets(page: Page): Promise<number> {
  const s = await page.context().browser()!.newBrowserCDPSession();
  const { targetInfos } = await s.send('Target.getTargets') as { targetInfos: { type: string }[] };
  await s.detach();
  return targetInfos.filter((t) => t.type === 'iframe').length;
}

export async function gcAndHeap(session: CDPSession): Promise<number> {
  await session.send('HeapProfiler.collectGarbage');
  const { usedSize } = await session.send('Runtime.getHeapUsage') as { usedSize: number };
  return usedSize;
}

