// The widget runtime and libraries in a sandboxed frame under the panel's CSP (docs/WIDGETS-PLAN.md §2–§8).
// Widgets are hand-written CommonJS, as the compiler emits it.
import { MAX_WIDGET_HEIGHT, MAX_WIDGET_STATE_BYTES } from '../../src/shared/widget-protocol.ts';
import * as limits from '../../src/widget-runtime/limits.ts';
import { cjs, expect, init, libsFor, test, theme } from './fixtures.ts';

const CHECK_ICON = [['path', { d: 'M20 6 9 17l-5-5', key: '1gmf2c' }]];

const CHART = cjs(`
var _react = require("react");
var _recharts = require("recharts");
var _motion = require("motion/react");
var _card = require("@/components/ui/card");
var _button = require("@/components/ui/button");
var _badge = require("@/components/ui/badge");
var _utils = require("@/lib/utils");
var _explainer = require("explainer");
var _lucide = require("lucide-react");
var j = _jsxruntime.jsx, js = _jsxruntime.jsxs;
var data = [{ x: 1, y: 3 }, { x: 2, y: 5 }, { x: 3, y: 2 }, { x: 4, y: 6 }];
function Chart({ depth = 8 }) {
  var [n, setN] = (0, _explainer.useWidgetState)("n", 0);
  var [revealed, setRevealed] = (0, _react.useState)("none");
  var step = (0, _explainer.useActiveStep)();
  var angle = (0, _explainer.useStepValue)({ interface: 0, refill: 90, drain: 180 }, -1);
  return js(_card.Card, { className: (0, _utils.cn)("m-2", "m-3"), "data-testid": "card", children: [
    j(_card.CardHeader, { children: j(_card.CardTitle, { children: "Ring of " + depth }) }),
    js(_card.CardContent, { children: [
      j(_motion.motion.div, { "data-testid": "motion", initial: { opacity: 0 }, animate: { opacity: 1 }, className: "h-2 w-8 bg-chart-1" }),
      j("div", { "data-testid": "chart", children: j(_recharts.ResponsiveContainer, { width: "100%", height: "100%", children:
        j(_recharts.LineChart, { data, children: j(_recharts.Line, { dataKey: "y", stroke: "var(--chart-1)", isAnimationActive: false }) }) }) }),
      j("p", { "data-testid": "step", className: "text-red-500 dark:text-blue-500", children: step + ":" + angle }),
      j(_badge.Badge, { variant: "secondary", children: "badge" }),
      j(_button.Button, { "data-testid": "inc", onClick: () => setN(n + 1), children: "n=" + n }),
      j(_button.Button, { variant: "outline", "data-testid": "reveal", onClick: () => { (0, _explainer.reveal)("refill", { lines: [2, 3] }).then((ok) => setRevealed(String(ok))); }, children: "revealed=" + revealed }),
      j(_lucide.Check, { "data-testid": "icon" }),
    ] }),
  ] });
}
exports.default = Chart;
`);

const chartInit = (extra = {}) => init('widgets/chart.tsx', { 'widgets/chart.tsx': CHART }, { props: { depth: 8 }, icons: { Check: CHECK_ICON }, ...extra });
const CHART_LIBS = libsFor(['react', 'recharts', 'motion', 'ui', 'clsx', 'lucide']);

/** A one-module widget whose body is `src` (CommonJS). */
const one = (src: string, extra = {}) => init('w.tsx', { 'w.tsx': cjs(src) }, extra);
const REACT = libsFor(['react']);

test('the limits copied into the runtime match the protocol', () => {
  expect(limits.MAX_WIDGET_STATE_BYTES).toBe(MAX_WIDGET_STATE_BYTES);
  expect(limits.MAX_WIDGET_HEIGHT).toBe(MAX_WIDGET_HEIGHT);
});

test('a React + Recharts + Motion + shadcn widget renders, themed by Tailwind and the VS Code tokens', async ({ harness }) => {
  const id = await harness.mount({ libs: CHART_LIBS, init: chartInit() });
  const f = harness.frame(id);
  await expect(f.getByText('Ring of 8')).toBeVisible();
  await expect(f.locator('svg.recharts-surface')).toBeVisible();
  await expect(f.locator('.recharts-line path').first()).toHaveAttribute('stroke', 'var(--chart-1)');
  // ResponsiveContainer with a percentage height in an auto-height parent falls back to 300 px.
  expect((await f.getByTestId('chart').boundingBox())!.height).toBe(300);
  await expect(f.getByTestId('icon')).toHaveClass(/lucide-check/);
  await expect(f.getByTestId('motion')).toHaveCSS('opacity', '1');
  await expect(f.getByTestId('step')).toHaveText('refill:90');
  // Tailwind + tokens: bg-primary is the theme's button background, borders from the theme, cn() merged.
  const dark = theme('dark').vars;
  const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
  await expect(f.getByTestId('inc')).toHaveCSS('background-color', rgb(dark['--vscode-button-background']!));
  await expect(f.getByTestId('card')).toHaveCSS('margin', '12px');
  await expect(f.getByTestId('motion')).toHaveCSS('background-color', rgb(dark['--vscode-charts-blue'] ?? '#3794ff'));
  await expect(f.locator('body')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  // No errors reported.
  expect(await harness.messages(id, 'error')).toEqual([]);
});

test('dark: follows the theme class on <html>, and theme updates restyle the widget', async ({ harness }) => {
  const id = await harness.mount({ libs: CHART_LIBS, init: chartInit() });
  const f = harness.frame(id);
  const step = f.getByTestId('step');
  await expect(step).toHaveCSS('color', /oklch\(0\.623 0\.214 259|rgb\(43, 127, 255\)/); // blue-500
  await expect(f.locator('html')).toHaveClass('dark');
  await harness.send(id, { type: 'theme', ...theme('light') });
  await expect(f.locator('html')).toHaveClass('light');
  await expect(f.locator('html')).toHaveCSS('color-scheme', 'light');
  await expect(step).toHaveCSS('color', /oklch\(0\.637 0\.237 25|rgb\(251, 44, 54\)/); // red-500
  await expect(f.getByTestId('inc')).toHaveCSS('background-color', /rgb\(0, 95, 184\)|rgb\(0, 120, 212\)/);
  await harness.send(id, { type: 'theme', ...theme('hc') });
  // Dark High Contrast has no button background: primary falls back to the text color (cx-no-button-bg).
  await expect(f.locator('html')).toHaveClass('dark hc cx-no-button-bg');
  await expect(f.locator('body')).toHaveClass(theme('hc').bodyClass);
});

test('reports its height, and follows content changes', async ({ harness }) => {
  const id = await harness.mount({
    libs: REACT, init: one(`
var _react = require("react");
exports.default = function W() {
  var [tall, setTall] = (0, _react.useState)(false);
  return _jsxruntime.jsx("button", { "data-testid": "b", style: { height: tall ? 300 : 120, display: "block" }, onClick: () => setTall(true), children: "grow" });
};`),
  });
  await harness.waitFor(id, 'height', (m) => m.px === 120);
  await harness.frame(id).getByTestId('b').click();
  await harness.waitFor(id, 'height', (m) => m.px === 300);
  await expect(harness.page.locator(`#w${id}`)).toHaveCSS('height', '300px');
});

test('h-screen and min-h-screen size to content instead of looping; 100vh that grows is frozen with a message', async ({ harness }) => {
  const a = await harness.mount({
    libs: REACT, init: one(`exports.default = function W() {
  return _jsxruntime.jsx("div", { className: "h-screen min-h-screen p-6 flex items-center", children: _jsxruntime.jsx("div", { className: "h-20", children: "x" }) });
};`),
  });
  await harness.waitFor(a, 'height', (m) => m.px === 128);
  await harness.page.waitForTimeout(800);
  const heights = (await harness.messages(a, 'height')).map((m) => m.px);
  expect(heights.at(-1)).toBe(128);
  expect(heights.length).toBeLessThan(5);

  const b = await harness.mount({
    libs: REACT, init: one(`exports.default = function W() {
  return _jsxruntime.jsxs("div", { children: [_jsxruntime.jsx("div", { style: { minHeight: "100vh" }, children: "grows with the frame" }), _jsxruntime.jsx("p", { children: "footer" })] });
};`),
  });
  await expect(harness.frame(b).locator('.cx-notice')).toContainText('sizes itself to the window');
  const n = (await harness.messages(b, 'height')).length;
  await harness.page.waitForTimeout(500);
  expect((await harness.messages(b, 'height')).length).toBe(n);
});

test('window.innerHeight is the panel viewport height, and follows viewport messages', async ({ harness }) => {
  const id = await harness.mount({
    libs: REACT, init: one(`var _react = require("react");
exports.default = function W() {
  var [, force] = (0, _react.useReducer)((x) => x + 1, 0);
  return _jsxruntime.jsx("button", { "data-testid": "h", onClick: force, children: String(window.innerHeight) });
};`, { viewportHeight: 777 }),
  });
  await expect(harness.frame(id).getByTestId('h')).toHaveText('777');
  await harness.send(id, { type: 'viewport', height: 555 });
  await harness.frame(id).getByTestId('h').click();
  await expect(harness.frame(id).getByTestId('h')).toHaveText('555');
});

test('useWidgetState round-trips through state/saveState and init.state', async ({ harness }) => {
  const id = await harness.mount({ libs: CHART_LIBS, init: chartInit() });
  const f = harness.frame(id);
  await f.getByTestId('inc').click();
  await f.getByTestId('inc').click();
  await expect(f.getByTestId('inc')).toHaveText('n=2');
  const coalesced = await harness.waitFor(id, 'state', (m) => m.json === '{"n":2}');
  expect(coalesced).toBeTruthy();
  expect((await harness.messages(id, 'state')).length).toBe(1); // two clicks, one write
  await harness.send(id, { type: 'saveState' });
  await expect.poll(async () => (await harness.messages(id, 'state')).length).toBe(2);
  const json = (await harness.messages(id, 'state')).at(-1).json;
  expect(JSON.parse(json)).toEqual({ n: 2 });

  const again = await harness.mount({ libs: CHART_LIBS, init: chartInit({ state: json }) });
  await expect(harness.frame(again).getByTestId('inc')).toHaveText('n=2');
});

test('reveal() posts synchronously from the click and resolves with the panel\'s result', async ({ harness }) => {
  const ok = await harness.mount({ libs: CHART_LIBS, init: chartInit() });
  await harness.frame(ok).getByTestId('reveal').click();
  await expect(harness.frame(ok).getByTestId('reveal')).toHaveText('revealed=true');
  const m = (await harness.messages(ok, 'reveal'))[0];
  expect(m).toMatchObject({ type: 'reveal', anchor: 'refill', lines: [2, 3] });
  // reveal precedes the focusExit the click causes (messages from one window arrive in order).
  const types = (await harness.messages(ok)).map((x) => x.type);
  expect(types.indexOf('reveal')).toBeLessThan(types.lastIndexOf('focusExit'));

  const refused = await harness.mount({ libs: CHART_LIBS, init: chartInit(), resultOk: false });
  await harness.frame(refused).getByTestId('reveal').click();
  await expect(harness.frame(refused).getByTestId('reveal')).toHaveText('revealed=false');
});

test('SDK: steps, anchors, code, highlight, goToStep, Ref', async ({ harness }) => {
  const id = await harness.mount({
    libs: REACT,
    codes: { refill: { anchor: 'refill', status: 'ok', text: 'always_ff @(posedge clk)\n  wr <= wr + 1;', startLine: 11, language: 'systemverilog', state: 'ok' } },
    init: one(`var X = require("explainer");
exports.default = function W() {
  var s = X.useStep(), code = X.useAnchorCode("refill"), secret = X.useAnchorCode("drain"), mine = X.useIsMyStepActive();
  return _jsxruntime.jsxs("div", { children: [
    _jsxruntime.jsx("p", { "data-testid": "s", children: [s.id, s.index, s.count, mine, X.useIsActive("drain"), X.useAnchors().length, X.useMyAnchor()].join(",") }),
    _jsxruntime.jsx("pre", { "data-testid": "code", children: code ? code.startLine + ":" + code.text.split("\\n")[0] : "loading" }),
    _jsxruntime.jsx("p", { "data-testid": "secret", children: secret ? secret.status + ":" + secret.reason : "loading" }),
    _jsxruntime.jsx("button", { "data-testid": "hl", onClick: () => X.highlight([2, 3], { identifiers: ["wr"] }), children: "hl" }),
    _jsxruntime.jsx("button", { "data-testid": "go", onClick: () => X.goToStep("drain"), children: "go" }),
    _jsxruntime.jsx(X.Ref, { anchor: "interface", lines: 4, children: "the interface" }),
  ] });
};`),
  });
  const f = harness.frame(id);
  await expect(f.getByTestId('s')).toHaveText('refill,1,3,true,false,3,refill');
  await expect(f.getByTestId('code')).toHaveText('11:always_ff @(posedge clk)');
  await expect(f.getByTestId('secret')).toHaveText('unavailable:not-pinned');
  await harness.send(id, { type: 'step', activeStep: 'drain' });
  await expect(f.getByTestId('s')).toHaveText('drain,2,3,false,true,3,refill');
  await f.getByTestId('hl').click();
  await harness.waitFor(id, 'highlight', (m) => m.lines?.[0] === 2 && m.lines?.[1] === 3 && m.identifiers?.[0] === 'wr');
  await f.getByTestId('go').click();
  await harness.waitFor(id, 'step', (m) => m.anchor === 'drain' && typeof m.id === 'number');
  await f.getByText('the interface').click();
  await harness.waitFor(id, 'reveal', (m) => m.anchor === 'interface' && m.lines?.[0] === 4);
  expect((await harness.messages(id, 'requestCode')).map((m) => m.anchor).sort()).toEqual(['drain', 'refill']);
});

test('render errors are reported with file and line, and shown in the box', async ({ harness }) => {
  const id = await harness.mount({
    libs: REACT,
    init: init('widgets/a.tsx', {
      'widgets/a.tsx': cjs(`var _b = require("./lib/b");
exports.default = function A() {
  return _jsxruntime.jsx("div", { children: (0, _b.label)(null) });
};`),
      'widgets/lib/b.ts': `"use strict";Object.defineProperty(exports, "__esModule", {value: true});
function label(x) {
  // line 3
  return x.name.toUpperCase();
}
exports.label = label;`,
    }),
  });
  const err = await harness.waitFor(id, 'error');
  expect(err).toMatchObject({ file: 'widgets/lib/b.ts', line: 4 });
  expect(err.message).toMatch(/TypeError: Cannot read properties of null/);
  await expect(harness.frame(id).locator('.cx-error')).toContainText('widgets/lib/b.ts:4');
});

test('syntax errors, missing modules and a missing default export are reported', async ({ harness }) => {
  const syntax = await harness.mount({ libs: REACT, init: init('w.tsx', { 'w.tsx': 'var a = 1;\nvar b = ;\n' }) });
  expect(await harness.waitFor(syntax, 'error')).toMatchObject({ file: 'w.tsx', line: 2, message: expect.stringMatching(/SyntaxError/) });

  const missing = await harness.mount({ libs: REACT, init: one('require("three");') });
  expect((await harness.waitFor(missing, 'error')).message).toMatch(/Cannot find module 'three'/);

  const noDefault = await harness.mount({ libs: REACT, init: one('exports.helper = 1;') });
  expect((await harness.waitFor(noDefault, 'error')).message).toMatch(/no default export/);

  const named = await harness.mount({ libs: REACT, init: one('exports.App = function App() { return _jsxruntime.jsx("p", { children: "named App" }); };') });
  await expect(harness.frame(named).getByText('named App')).toBeVisible();
});

test('errors in event handlers are reported with file and line', async ({ harness }) => {
  const id = await harness.mount({
    libs: REACT, init: one(`exports.default = function W() {
  return _jsxruntime.jsx("button", { "data-testid": "b", onClick: () => {
    throw new RangeError("bad click");
  }, children: "b" });
};`),
  });
  await harness.frame(id).getByTestId('b').click();
  expect(await harness.waitFor(id, 'error')).toMatchObject({ message: 'RangeError: bad click', file: 'w.tsx', line: 5 });
});

test('the loop guard stops a loop that never yields, with a clear error', async ({ harness }) => {
  const id = await harness.mount({
    libs: REACT, init: one(`var _react = require("react");
exports.default = function W() {
  var [n, setN] = (0, _react.useState)(0);
  function spin() {
    var i = 0;
    while (true) { __cxLoopGuard(); i++; }
  }
  // A loop that yields between bursts is fine.
  (0, _react.useEffect)(() => { var k = 0; for (var i = 0; i < 2e6; i++) { __cxLoopGuard(); k += i; } setN(k > 0 ? 1 : 0); }, []);
  return _jsxruntime.jsx("button", { "data-testid": "b", onClick: spin, children: "n=" + n });
};`),
  });
  const f = harness.frame(id);
  await expect(f.getByTestId('b')).toHaveText('n=1');
  const t0 = Date.now();
  await f.getByTestId('b').click();
  const err = await harness.waitFor(id, 'error');
  expect(Date.now() - t0).toBeLessThan(3000);
  expect(err).toMatchObject({ file: 'w.tsx', line: 8 });
  expect(err.message).toMatch(/without yielding.*requestAnimationFrame/);
  // The widget is still alive afterwards.
  await expect(f.getByTestId('b')).toHaveText('n=1');
});

test('focusExit: Tab at the edges, Escape, shortcuts and pointer clicks; Enter keeps focus', async ({ harness, page }) => {
  const id = await harness.mount({
    libs: REACT, init: one(`exports.default = function W() {
  return _jsxruntime.jsxs("div", { children: [
    _jsxruntime.jsx("button", { "data-testid": "first", children: "first" }),
    _jsxruntime.jsx("input", { "data-testid": "text" }),
    _jsxruntime.jsx("input", { "data-testid": "range", type: "range" }),
    _jsxruntime.jsx("button", { "data-testid": "last", onKeyDown: (e) => { if (e.key === "x") e.preventDefault(); }, children: "last" }),
  ] });
};`),
  });
  const f = harness.frame(id);
  const exits = async () => (await harness.messages(id, 'focusExit')).map((m) => m.dir);

  await f.getByTestId('last').focus();
  await page.keyboard.press('Tab');
  await expect.poll(exits).toEqual(['forward']);
  await f.getByTestId('first').focus();
  await page.keyboard.press('Shift+Tab');
  await expect.poll(exits).toEqual(['forward', 'backward']);
  await page.keyboard.press('Tab'); // inside: moves to the text input, no exit
  await expect(f.getByTestId('text')).toBeFocused();
  await page.keyboard.press('Control+a'); // editing keys stay
  await page.keyboard.press('Alt+ArrowLeft'); // in a text field too
  await page.keyboard.press('Escape');
  await expect.poll(exits).toEqual(['forward', 'backward', 'escape']);
  await f.getByTestId('first').focus();
  await page.keyboard.press('Control+k');
  await expect.poll(exits).toEqual(['forward', 'backward', 'escape', 'shortcut']);

  // Keyboard activation keeps focus in the widget; a pointer click on a button gives it back.
  await f.getByTestId('first').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await page.waitForTimeout(100);
  expect(await exits()).toHaveLength(4);
  await f.getByTestId('first').click();
  await expect.poll(exits).toEqual(['forward', 'backward', 'escape', 'shortcut', 'pointer']);
  // ...but not a click into a text field or range.
  await f.getByTestId('text').click();
  await f.getByTestId('range').click();
  await page.waitForTimeout(100);
  expect(await exits()).toHaveLength(5);
});

test('focus() is a no-op unless the reader is interacting with the widget', async ({ harness, page }) => {
  const id = await harness.mount({
    libs: REACT, init: one(`var _react = require("react");
exports.default = function W() {
  var ref = (0, _react.useRef)(null);
  (0, _react.useEffect)(() => { setTimeout(() => { ref.current.focus(); window.__tried = true; }, 50); }, []);
  return _jsxruntime.jsxs("div", { children: [
    _jsxruntime.jsx("input", { ref, "data-testid": "i", autoFocus: true }),
    _jsxruntime.jsx("button", { "data-testid": "b", onClick: () => ref.current.focus(), children: "focus it" }),
  ] });
};`),
  });
  await page.locator('#outside').focus();
  const frame = await harness.frameHandle(id);
  await expect.poll(() => frame.evaluate(() => (window as any).__tried === true)).toBe(true);
  await expect(page.locator('#outside')).toBeFocused();
  expect(await frame.evaluate(() => document.activeElement?.tagName)).toBe('BODY');
  // From a click in the widget, it works.
  await harness.frame(id).getByTestId('b').click();
  await expect(harness.frame(id).getByTestId('i')).toBeFocused();
});

test('localStorage and sessionStorage are in-memory shims', async ({ harness }) => {
  const id = await harness.mount({
    libs: REACT, init: one(`exports.default = function W() {
  localStorage.setItem("a", 1);
  localStorage.b = "two";
  sessionStorage.setItem("s", "x");
  var out = [localStorage.getItem("a"), localStorage.b, localStorage.length, Object.keys(localStorage).join("+"), sessionStorage.getItem("s"), localStorage.getItem("nope")];
  localStorage.removeItem("a");
  out.push(localStorage.length);
  return _jsxruntime.jsx("p", { "data-testid": "o", children: JSON.stringify(out) });
};`),
  });
  await expect(harness.frame(id).getByTestId('o')).toHaveText('["1","two",2,"a+b","x",null,1]');
});

test('fetch and XHR fail with a clear message, also shown in the box', async ({ harness }) => {
  const id = await harness.mount({
    libs: REACT, init: one(`var _react = require("react");
exports.default = function W() {
  var [msg, setMsg] = (0, _react.useState)("…");
  (0, _react.useEffect)(() => {
    fetch("https://example.com/data.json").then(() => setMsg("fetched?!"), (e) => {
      var x = "";
      try { var r = new XMLHttpRequest(); r.open("GET", "/x"); } catch (e2) { x = e2.message; }
      setMsg(e.message + " | " + (x === e.message));
    });
  }, []);
  return _jsxruntime.jsx("p", { "data-testid": "m", children: msg });
};`),
  });
  const f = harness.frame(id);
  await expect(f.getByTestId('m')).toHaveText(/^Widgets can't use the network\. Import data as a file instead.* \| true$/);
  await expect(f.locator('.cx-notice')).toContainText("Widgets can't use the network");
});

test('answers ping with pong, also while hidden', async ({ harness }) => {
  const id = await harness.mount({ libs: REACT, init: one('exports.default = function W() { return _jsxruntime.jsx("p", { children: "hi" }); };') });
  await harness.waitFor(id, 'height');
  await harness.send(id, { type: 'ping', n: 7 });
  await harness.waitFor(id, 'pong', (m) => m.n === 7);
  await harness.send(id, { type: 'visible', visible: false });
  await harness.send(id, { type: 'ping', n: 8 });
  await harness.waitFor(id, 'pong', (m) => m.n === 8);
});

test('visible: false suspends timers, intervals, frames and CSS animations; visible: true resumes them', async ({ harness }) => {
  const id = await harness.mount({
    libs: REACT, init: one(`var _react = require("react");
exports.default = function W() {
  (0, _react.useEffect)(() => {
    window.ticks = 0; window.frames = 0; window.late = 0;
    setInterval(() => window.ticks++, 20);
    (function loop() { window.frames++; requestAnimationFrame(loop); })();
    window.armTimeout = () => setTimeout(() => window.late++, 150);
  }, []);
  return _jsxruntime.jsx("div", { "data-testid": "spin", className: "animate-spin h-4 w-4 bg-chart-1" });
};`),
  });
  const frame = await harness.frameHandle(id);
  await expect.poll(() => frame.evaluate(() => (window as any).ticks)).toBeGreaterThan(3);
  const anim = () => frame.evaluate(() => document.getAnimations().map((a) => a.playState).join());
  await expect.poll(anim).toBe('running');

  await frame.evaluate(() => (window as any).armTimeout());
  await harness.send(id, { type: 'visible', visible: false });
  await expect.poll(anim).toBe('paused');
  const before = await frame.evaluate(() => [(window as any).ticks, (window as any).frames]);
  await harness.page.waitForTimeout(400);
  expect(await frame.evaluate(() => [(window as any).ticks, (window as any).frames, (window as any).late])).toEqual([...before, 0]);

  await harness.send(id, { type: 'visible', visible: true });
  await expect.poll(() => frame.evaluate(() => (window as any).ticks)).toBeGreaterThan(before[0]! + 2);
  await expect.poll(() => frame.evaluate(() => (window as any).frames)).toBeGreaterThan(before[1]! + 2);
  await expect.poll(() => frame.evaluate(() => (window as any).late)).toBe(1);
  await expect.poll(anim).toBe('running');
});

test('shadcn shims: tabs, select, switch, checkbox, slider, progress, alert, tooltip inside the frame', async ({ harness, page }) => {
  const id = await harness.mount({
    libs: libsFor(['react', 'ui']), fixedHeight: false,
    init: one(`var _react = require("react");
var T = require("@/components/ui/tabs"), S = require("@/components/ui/select"), Sw = require("@/components/ui/switch"),
  C = require("@/components/ui/checkbox"), Sl = require("@/components/ui/slider"), P = require("@/components/ui/progress"),
  A = require("@/components/ui/alert"), Tt = require("@/components/ui/tooltip"), L = require("@/components/ui/label"),
  I = require("@/components/ui/input"), Sep = require("@/components/ui/separator"), Sa = require("@/components/ui/scroll-area");
var j = _jsxruntime.jsx, js = _jsxruntime.jsxs;
exports.default = function W() {
  var [fruit, setFruit] = (0, _react.useState)("");
  var [on, setOn] = (0, _react.useState)(false);
  var [v, setV] = (0, _react.useState)([30]);
  return j(Tt.TooltipProvider, { delayDuration: 0, children: js("div", { className: "p-2 flex flex-col gap-2", children: [
    js(Tt.Tooltip, { children: [j(Tt.TooltipTrigger, { asChild: true, children: j("button", { "data-testid": "tip", children: "hover me" }) }),
      j(Tt.TooltipContent, { children: "A tooltip with quite a lot of text that must stay inside the frame" })] }),
    js(T.Tabs, { defaultValue: "a", children: [
      js(T.TabsList, { children: [j(T.TabsTrigger, { value: "a", children: "Tab A" }), j(T.TabsTrigger, { value: "b", children: "Tab B" })] }),
      j(T.TabsContent, { value: "a", children: "content A" }), j(T.TabsContent, { value: "b", children: "content B" })] }),
    js(S.Select, { value: fruit, onValueChange: setFruit, children: [
      j(S.SelectTrigger, { "aria-label": "fruit", className: "w-40", children: j(S.SelectValue, { placeholder: "Pick a fruit" }) }),
      js(S.SelectContent, { children: [j(S.SelectItem, { value: "apple", children: "Apple" }), j(S.SelectItem, { value: "pear", children: "Pear" })] })] }),
    js("div", { className: "flex items-center gap-2", children: [j(Sw.Switch, { id: "sw", checked: on, onCheckedChange: setOn }), j(L.Label, { htmlFor: "sw", children: "switch" })] }),
    j(C.Checkbox, { "aria-label": "check", defaultChecked: true }),
    j(Sl.Slider, { "aria-label": "slider", value: v, onValueChange: setV, max: 100, step: 10 }),
    j(P.Progress, { value: v[0] }), j(Sep.Separator, {}), j(I.Input, { placeholder: "type" }),
    js(A.Alert, { variant: "destructive", children: [j(A.AlertTitle, { children: "Heads up" }), j(A.AlertDescription, { children: "desc" })] }),
    j(Sa.ScrollArea, { className: "h-10", children: "scroll" }),
    j("p", { "data-testid": "state", children: [fruit, on, v[0]].join(",") }),
  ] }) });
};`),
  });
  const f = harness.frame(id);
  await f.getByRole('tab', { name: 'Tab B' }).click();
  await expect(f.getByText('content B')).toBeVisible();
  await expect(f.getByText('content A')).toHaveCount(0);
  await f.getByRole('tab', { name: 'Tab B' }).press('ArrowLeft');
  await expect(f.getByText('content A')).toBeVisible();
  await f.getByLabel('fruit').selectOption('pear');
  await f.getByRole('switch').click();
  await expect(f.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  await f.getByLabel('slider').fill('70');
  await expect(f.getByTestId('state')).toHaveText('pear,true,70');
  await expect(f.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '70');
  await expect(f.getByLabel('check')).toBeChecked();
  await expect(f.getByRole('alert')).toContainText('Heads up');
  // The tooltip trigger is at the top of the frame: the tooltip flips below and stays inside.
  await f.getByTestId('tip').hover();
  const tip = f.getByRole('tooltip');
  await expect(tip).toBeVisible();
  const [box, frameBox] = [await tip.boundingBox(), await page.locator(`#w${id}`).boundingBox()];
  expect(box!.y).toBeGreaterThanOrEqual(frameBox!.y);
  expect(box!.x + box!.width).toBeLessThanOrEqual(frameBox!.x + frameBox!.width);
  expect(await harness.messages(id, 'error')).toEqual([]);
});

test('only messages from the parent are accepted', async ({ harness }) => {
  const id = await harness.mount({ libs: REACT, init: one('exports.default = function W() { return _jsxruntime.jsx("p", { children: "hi" }); };') });
  await harness.waitFor(id, 'height');
  const frame = await harness.frameHandle(id);
  // A message the widget posts to itself (source = its own window) is ignored.
  await frame.evaluate(() => window.postMessage({ type: 'ping', n: 99 }, '*'));
  await harness.page.waitForTimeout(200);
  expect(await harness.messages(id, 'pong')).toEqual([]);
});

test('SDK environment: useTheme, useVisible, useReducedMotion (and MotionConfig), asset()', async ({ harness }) => {
  const id = await harness.mount({
    libs: libsFor(['react', 'motion']),
    init: init('widgets/w.tsx', {
      'widgets/w.tsx': cjs(`var X = require("explainer"), M = require("motion/react"), logo = require("./logo.svg");
exports.default = function W() {
  var t = X.useTheme();
  return _jsxruntime.jsx("p", { "data-testid": "env", children: [t.kind, t.color("chart-1"), t.color("button.background"), X.useVisible(), X.useReducedMotion(), (0, M.useReducedMotionConfig)(), X.asset("logo.svg") === logo.default, X.asset("pic.png")].join("|") });
};`),
      'widgets/logo.svg': '"use strict";Object.defineProperty(exports, "__esModule", {value: true});exports.default = "data:image/svg+xml,%3Csvg%2F%3E";',
    }, { reducedMotion: true, assets: { 'widgets/pic.png': 'data:image/png;base64,AA==' } }),
  });
  const env = harness.frame(id).getByTestId('env');
  const blue = theme('dark').vars['--vscode-charts-blue'] ?? '#3794ff';
  const button = theme('dark').vars['--vscode-button-background'];
  await expect(env).toHaveText(`dark|${blue}|${button}|true|true|true|true|data:image/png;base64,AA==`);
  await harness.send(id, { type: 'visible', visible: false });
  await harness.send(id, { type: 'theme', ...theme('light') });
  await expect(env).toHaveText(/^light\|.*\|false\|true\|true\|true\|/);
});

test('an expand animation that grows for a while isn’t frozen; a frozen widget that shrinks starts reporting again', async ({ harness }) => {
  // Grows in ten eased steps a frame apart (a typical accordion or Motion layout animation), then stops.
  const id = await harness.mount({
    libs: REACT, init: one(`var _react = require("react");
exports.default = function W() {
  var [h, setH] = (0, _react.useState)(40);
  (0, _react.useEffect)(() => {
    var i = 0;
    var t = setInterval(() => { i++; setH(40 + Math.round(400 * (1 - Math.pow(1 - i / 12, 3)))); if (i >= 12) clearInterval(t); }, 110);
    return () => clearInterval(t);
  }, []);
  return _jsxruntime.jsx("div", { "data-testid": "box", style: { height: h } });
};`),
  });
  await harness.waitFor(id, 'height', (m) => m.px === 440, 8000);
  await expect(harness.frame(id).locator('.cx-notice')).toHaveCount(0);

  // A real loop (sized to its frame, plus a footer) is frozen; when it stops sizing itself to the frame, it reports again.
  const b = await harness.mount({
    libs: REACT, init: one(`var _react = require("react");
exports.default = function W() {
  var [loop, setLoop] = (0, _react.useState)(true);
  window.stop = () => setLoop(false);
  return _jsxruntime.jsxs("div", { children: [_jsxruntime.jsx("div", { style: { minHeight: loop ? "100vh" : 50 }, children: "x" }), _jsxruntime.jsx("p", { children: "footer" })] });
};`),
  });
  await expect(harness.frame(b).locator('.cx-notice')).toContainText('sizes itself to the window', { timeout: 10_000 });
  const frame = await harness.frameHandle(b);
  await frame.evaluate(() => (window as any).stop());
  await harness.waitFor(b, 'height', (m) => m.px < 150);
  await expect(harness.frame(b).locator('.cx-notice')).toHaveCount(0);
});

test('content that grows steadily on its own (a row every 100 ms for 2.5 s) isn’t frozen', async ({ harness }) => {
  const id = await harness.mount({
    libs: REACT, init: one(`var _react = require("react");
exports.default = function W() {
  var [n, setN] = (0, _react.useState)(1);
  (0, _react.useEffect)(() => { var t = setInterval(() => setN((x) => (x < 25 ? x + 1 : x)), 100); return () => clearInterval(t); }, []);
  return _jsxruntime.jsx("div", { children: Array.from({ length: n }, (_, i) => _jsxruntime.jsx("p", { style: { height: 20, margin: 0 }, children: "row " + i }, i)) });
};`),
  });
  await harness.waitFor(id, 'height', (m) => m.px === 500, 8000);
  await expect(harness.frame(id).locator('.cx-notice')).toHaveCount(0);
});

test('a widget’s own animation-play-state still works after it was hidden and shown', async ({ harness }) => {
  const id = await harness.mount({
    libs: REACT, init: one(`exports.default = function W() {
  return _jsxruntime.jsxs("div", { children: [_jsxruntime.jsx("style", { children: "@keyframes cxspin { to { transform: rotate(1turn) } } .s { animation: cxspin 1s linear infinite; width: 10px; height: 10px; }" }), _jsxruntime.jsx("div", { "data-testid": "s", className: "s" })] });
};`),
  });
  const frame = await harness.frameHandle(id);
  const state = () => frame.evaluate(() => document.getAnimations().map((a) => a.playState).join());
  await expect.poll(state).toBe('running');
  await harness.send(id, { type: 'visible', visible: false });
  await expect.poll(state).toBe('paused');
  await harness.send(id, { type: 'visible', visible: true });
  await expect.poll(state).toBe('running');
  // The widget pauses its own animation with CSS (here while off screen): it stays paused when shown.
  await harness.send(id, { type: 'visible', visible: false });
  await frame.evaluate(() => ((document.querySelector('.s') as HTMLElement).style.animationPlayState = 'paused'));
  await harness.send(id, { type: 'visible', visible: true });
  await frame.waitForTimeout(200);
  expect(await state()).toBe('paused');
  await frame.evaluate(() => ((document.querySelector('.s') as HTMLElement).style.animationPlayState = 'running'));
  await expect.poll(state).toBe('running');
});

test('ResponsiveContainer with a percentage height inside a padded parent gets the fallback height', async ({ harness }) => {
  const id = await harness.mount({
    libs: libsFor(['react', 'recharts']), init: one(`var R = require("recharts");
var data = [{ x: 1, y: 3 }, { x: 2, y: 5 }];
exports.default = function W() {
  return _jsxruntime.jsx("div", { style: { padding: 12, border: "2px solid gray" }, children: _jsxruntime.jsx(R.ResponsiveContainer, { width: "100%", height: "100%", children:
    _jsxruntime.jsx(R.LineChart, { data, children: _jsxruntime.jsx(R.Line, { dataKey: "y", isAnimationActive: false }) }) }) });
};`),
  });
  await expect.poll(async () => (await harness.frame(id).locator('.recharts-responsive-container').boundingBox())?.height ?? 0).toBe(300);
  await expect(harness.frame(id).locator('svg.recharts-surface')).toHaveAttribute('height', '300');
});

test('SDK calls with arguments the panel would drop are reported, not sent', async ({ harness }) => {
  const id = await harness.mount({
    libs: REACT, init: one(`var X = require("explainer");
exports.default = function W() {
  window.calls = { hl0: () => X.highlight(0), hlFloat: () => X.highlight([1.5, 3]), hlIds: () => X.highlight(2, { identifiers: ["a-b"] }), revealBad: () => X.reveal("1bad"), stepBad: () => X.goToStep({}), ok: () => X.highlight([2, 4], { anchor: "refill" }) };
  return _jsxruntime.jsx("p", { children: "x" });
};`),
  });
  const frame = await harness.frameHandle(id);
  await harness.waitFor(id, 'height');
  for (const c of ['hl0', 'hlFloat', 'hlIds', 'ok']) await frame.evaluate((c) => (window as any).calls[c](), c);
  expect(await frame.evaluate(() => (window as any).calls.revealBad())).toBe(false);
  expect(await frame.evaluate(() => (window as any).calls.stepBad())).toBe(false);
  await expect.poll(async () => (await harness.messages(id, 'error')).length).toBe(5);
  const errors = (await harness.messages(id, 'error')).map((m) => m.message).join('\n');
  expect(errors).toContain('highlight(): lines must be');
  expect(errors).toContain('highlight(): identifiers must be');
  expect(errors).toContain('reveal(): "1bad" isn\'t an anchor id');
  expect(errors).toContain('goToStep():');
  expect((await harness.messages(id, 'highlight')).map((m) => [m.lines, m.anchor])).toEqual([[[2, 4], 'refill']]);
  expect(await harness.messages(id, 'reveal')).toEqual([]);
  expect(await harness.messages(id, 'step')).toEqual([]);
});

test('reduced motion follows theme messages (VS Code’s workbench.reduceMotion)', async ({ harness }) => {
  const id = await harness.mount({
    libs: REACT, init: one(`var X = require("explainer");
exports.default = function W() { return _jsxruntime.jsx("p", { "data-testid": "rm", children: String(X.useReducedMotion()) }); };`),
  });
  const rm = harness.frame(id).getByTestId('rm');
  await expect(rm).toHaveText('false');
  await harness.send(id, { type: 'theme', ...theme('dark'), reducedMotion: true });
  await expect(rm).toHaveText('true');
  await harness.send(id, { type: 'theme', ...theme('dark'), reducedMotion: false });
  await expect(rm).toHaveText('false');
});

test('ui: an onClick or onChange of the widget’s own runs alongside the shim’s; Slider takes a number value', async ({ harness }) => {
  const id = await harness.mount({
    libs: libsFor(['react', 'ui']), init: one(`var _react = require("react");
var T = require("@/components/ui/tabs"), Sw = require("@/components/ui/switch"), C = require("@/components/ui/checkbox"), Sl = require("@/components/ui/slider");
var j = _jsxruntime.jsx, js = _jsxruntime.jsxs;
exports.default = function W() {
  var [log, setLog] = (0, _react.useState)([]);
  var add = (s) => setLog((l) => l.concat(s));
  return js("div", { children: [
    js(T.Tabs, { defaultValue: "a", children: [js(T.TabsList, { children: [j(T.TabsTrigger, { value: "a", children: "A" }), j(T.TabsTrigger, { value: "b", onClick: () => add("tab"), children: "B" })] }),
      j(T.TabsContent, { value: "b", children: "content B" })] }),
    j(Sw.Switch, { onClick: () => add("switch") }),
    j(C.Checkbox, { "aria-label": "check", onChange: () => add("check") }),
    j(Sl.Slider, { "aria-label": "slider", defaultValue: 40, max: 100 }),
    j("p", { "data-testid": "log", children: log.join(",") }),
  ] });
};`),
  });
  const f = harness.frame(id);
  await f.getByRole('tab', { name: 'B' }).click();
  await expect(f.getByText('content B')).toBeVisible();
  await f.getByRole('switch').click();
  await expect(f.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  await f.getByLabel('check').click();
  await expect(f.getByLabel('check')).toBeChecked();
  await expect(f.getByTestId('log')).toHaveText('tab,switch,check');
  await expect(f.getByLabel('slider')).toHaveValue('40');
});

test('Tailwind’s performance entries are cleared, the widget’s own marks are kept', async ({ harness }) => {
  const id = await harness.mount({
    libs: libsFor(['react']), init: one(`var _react = require("react");
exports.default = function W() {
  var [n, setN] = (0, _react.useState)(0);
  window.grow = () => setN((x) => x + 1);
  return _jsxruntime.jsx("div", { className: n ? "p-" + n : "", children: "x" });
};`),
  });
  const frame = await harness.frameHandle(id);
  await harness.waitFor(id, 'height');
  await frame.evaluate(() => { performance.mark('mine'); (window as any).grow(); });
  await harness.waitFor(id, 'height', (m) => m.px > 30);
  expect(await frame.evaluate(() => performance.getEntriesByType('mark').map((e) => e.name))).toEqual(['mine']);
});

const SHIMS = `
var _button = require("@/components/ui/button");
var _badge = require("@/components/ui/badge");
var j = _jsxruntime.jsx, js = _jsxruntime.jsxs;
function W() {
  return js("div", { className: "flex flex-wrap gap-2 p-2", children: [
    ["default", "destructive", "outline", "secondary", "ghost", "link"].map((v) => j(_button.Button, { variant: v, "data-contrast": "Button " + v, children: v }, "b" + v)),
    ["default", "secondary", "destructive", "outline"].map((v) => j(_badge.Badge, { variant: v, "data-contrast": "Badge " + v, children: v }, "g" + v)),
    j("span", { className: "text-muted-foreground", "data-contrast": "muted text", children: "muted" }),
  ] });
}
exports.default = W;
`;

for (const name of ['dark', 'light', 'hc', 'hc-light'] as const) {
  test(`the ui components' text reads at 4.5:1 or better on their own background (${name})`, async ({ harness }) => {
    const t = theme(name);
    const id = await harness.mount({ libs: libsFor(['react', 'ui', 'clsx']), init: one(SHIMS, { theme: t }) });
    const f = harness.frame(id);
    await expect(f.locator('[data-contrast]')).toHaveCount(11);
    const ratios = await f.locator('body').evaluate((_b, page) => {
      // Any CSS color (rgb, oklch, oklab, color-mix) as RGBA, through a canvas.
      const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
      const rgba = (c: string) => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = '#000';
        ctx.fillStyle = c;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        return [d[0]!, d[1]!, d[2]!, d[3]! / 255] as const;
      };
      const over = (top: readonly [number, number, number, number], under: readonly [number, number, number]) =>
        [0, 1, 2].map((i) => top[i]! * top[3] + under[i]! * (1 - top[3])) as [number, number, number];
      const lum = (c: readonly number[]) => {
        const [r, g, b] = c.map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
      };
      const out: Record<string, number> = {};
      for (const el of document.querySelectorAll<HTMLElement>('[data-contrast]')) {
        // The frame is transparent over the panel: what shows through is the editor background.
        const layers: Element[] = [];
        for (let e: Element | null = el; e; e = e.parentElement) layers.unshift(e);
        let bg = over(rgba(page), [0, 0, 0]);
        for (const e of layers) bg = over(rgba(getComputedStyle(e).backgroundColor), bg);
        const fg = over(rgba(getComputedStyle(el).color), bg);
        const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
        out[el.dataset.contrast!] = Math.round(((a! + 0.05) / (b! + 0.05)) * 100) / 100;
      }
      return out;
    }, t.vars['--vscode-editor-background']!);
    for (const [what, ratio] of Object.entries(ratios)) expect(ratio, `${what} in ${name}`).toBeGreaterThanOrEqual(4.5);
  });
}
