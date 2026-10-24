// docs/COMMENTS-PLAN.md §13.3: the Comments pane, chips and badges in the panel (host chrome).
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import type { ThreadView } from '../../src/shared/comments-protocol.ts';
import type { AnchorView, FromWebview, ToWebview } from '../../src/shared/protocol.ts';
import { THEMES, themeCss } from './themes.ts';

const FIXTURE = 'fixtures/sample-workspace/.sidestory/bit-reader';
const HTML = readFileSync(`${FIXTURE}/sidestory.html`, 'utf8');
const MANIFEST = JSON.parse(readFileSync(`${FIXTURE}/manifest.json`, 'utf8')) as { title: string; anchors: Record<string, { file: string; range: [number, number] }> };
const DIR = 'file:///ws/.sidestory/bit-reader';
const T1 = 't_01JB8X3K0M6Z9Q4T7R2W5Y1V8N';
const E1 = 'e_01JB8X3K0M6Z9Q4T7R2W5Y1V8N';
const E2 = 'e_01JB8X3K0M6Z9Q4T7R2W5Y1V9N';

const anchors = (): AnchorView[] => Object.entries(MANIFEST.anchors).map(([id, a]) => ({ id, file: a.file, range: { start: a.range[0], end: a.range[1] }, state: 'exact' }));
const send = (page: Page, m: ToWebview) => page.evaluate((msg) => (window as unknown as { __send(m: unknown): void }).__send(msg), m);
const posted = (page: Page) => page.evaluate(() => (window as unknown as { __posted: FromWebview[] }).__posted);
const clearPosted = (page: Page) => page.evaluate(() => ((window as unknown as { __posted: FromWebview[] }).__posted = []));

async function open(page: Page, author = '') {
  await page.goto('/test/webview/harness.html');
  await page.evaluate(([css, cls]) => {
    document.documentElement.setAttribute('style', css);
    document.body.className = cls;
  }, [themeCss('dark'), THEMES.dark.bodyClass] as const);
  await expect.poll(() => posted(page)).toContainEqual({ type: 'ready' });
  const base = await page.evaluate(() => `${location.origin}/fixtures/sample-workspace/.sidestory/bit-reader/`);
  await send(page, { type: 'init', title: MANIFEST.title, html: author ? HTML.replace('</section>', `${author}</section>`) : HTML, anchors: anchors(), dir: DIR, base, trail: [{ name: 'bit-reader', title: MANIFEST.title }] });
  await expect(page.locator('.cx-step').first()).toBeVisible();
}

function thread(extra: Partial<ThreadView> = {}): ThreadView {
  return {
    id: T1,
    tier: 'local',
    target: { kind: 'step', step: 'interface', label: '' },
    state: 'open',
    comments: [
      { id: E1, author: 'you', trust: 'local_user', claude: false, at: new Date(Date.now() - 180_000).toISOString(), body: 'Why is `ready` only high for **one** cycle?', mine: true, changed: false, retracted: false, toClaude: true },
      { id: E2, author: 'Claude (via you)', trust: 'claude', claude: true, at: new Date(Date.now() - 60_000).toISOString(), body: 'Because the consumer samples it on the next edge: see `rtl/bit_reader.sv#L10-L12`.\n\n- it avoids a double read\n- <img src=x onerror=alert(1)> stays text', mine: false, changed: false, retracted: false, toClaude: false },
    ],
    unread: true,
    suggestsResolve: true,
    waiting: false,
    canReply: true,
    canDelete: true,
    ...extra,
  };
}

const context = { push: true, session: 'sample-workspace (main) · 14:01', manySessions: true, defaultTier: 'local' as const, restricted: false };

test('step chips and section badges count open threads; the pane opens on T and follows the step', async ({ page }) => {
  await open(page);
  await send(page, { type: 'threads', dir: DIR, threads: [thread()], context });
  await expect(page.locator('.cx-step').first().locator('.cx-step-comments')).toHaveText('1');
  await expect(page.locator('.cx-badge.cx-has')).toHaveCount(1);
  await expect(page.locator('.cx-comments')).toBeHidden();
  await page.locator('.cx-scroll').focus();
  await page.keyboard.press('t');
  await expect(page.locator('.cx-comments')).toBeVisible();
  await expect(page.locator('.cx-c-title')).toHaveText('Comments · Step 1 · Interface');
  await expect(page.locator('.cx-c-card')).toHaveCount(1);
  await expect(page.locator('.cx-c-author').nth(1)).toHaveText('Claude (via you)');
  mkdirSync('test-results/screenshots', { recursive: true });
  await page.screenshot({ path: 'test-results/screenshots/comments-thread-on-step.png' });
  // The reply renders as text: no image, no HTML.
  expect(await page.locator('.cx-comments img').count()).toBe(0);
  await expect(page.locator('.cx-c-text-view').nth(1)).toContainText('<img src=x onerror=alert(1)> stays text');
  // A code reference is a button that goes through openCode's checks.
  await clearPosted(page);
  await page.locator('.cx-c-ref').click();
  expect(await posted(page)).toContainEqual({ type: 'openCode', path: 'rtl/bit_reader.sv', target: 'L10-L12' });
  // Following the step: another step shows its (no) threads.
  await page.locator('.cx-step').nth(2).click();
  await expect(page.locator('.cx-c-title')).toContainText('Step 3');
  await expect(page.locator('.cx-c-card')).toHaveCount(0);
});

test('composer: C comments, A asks Claude with the intent; Ctrl/Cmd+Enter sends in the visible mode; Esc keeps the draft', async ({ page }) => {
  await open(page);
  await send(page, { type: 'threads', dir: DIR, threads: [], context });
  await page.locator('.cx-scroll').focus();
  await page.keyboard.press('a');
  const ta = page.locator('.cx-c-composer textarea');
  await expect(ta).toBeFocused();
  await expect(page.locator('.cx-c-send')).toHaveText('Ask Claude · sample-workspace (main) · 14:01');
  await ta.fill('What does valid mean here?');
  await page.keyboard.press('Escape');
  await expect(page.locator('.cx-c-composer')).toHaveCount(0);
  await page.locator('.cx-scroll').focus();
  await page.keyboard.press('a');
  await expect(page.locator('.cx-c-composer textarea')).toHaveValue('What does valid mean here?');
  // The composer takes focus on the next frame: wait for it, as a reader's next key would.
  await expect(page.locator('.cx-c-composer textarea')).toBeFocused();
  await page.locator('.cx-c-intent').selectOption('edit');
  await clearPosted(page);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
  expect(await posted(page)).toContainEqual({ type: 'commentCreate', step: 'interface', body: 'What does valid mean here?', toClaude: true, intent: 'edit' });
  await page.locator('.cx-scroll').focus();
  await page.keyboard.press('c');
  await expect(page.locator('.cx-c-send')).toHaveText('Comment');
  await page.locator('.cx-c-composer textarea').fill('A note');
  await clearPosted(page);
  await page.locator('.cx-c-send').click();
  expect(await posted(page)).toContainEqual({ type: 'commentCreate', step: 'interface', body: 'A note', toClaude: false });
});

test('replying after a Claude reply defaults to Ask Claude; delivery lines and their actions', async ({ page }) => {
  await open(page);
  const t = thread();
  t.comments[0]!.delivery = { state: 'no-session', text: "No Claude session with Sidestory's channel is running here", actions: ['copyPrompt', 'chooseSession', 'howTo'] };
  await send(page, { type: 'threads', dir: DIR, threads: [t], context });
  await page.locator('.cx-scroll').focus();
  await page.keyboard.press('t');
  await expect(page.locator('.cx-c-delivery')).toContainText("No Claude session with Sidestory's channel is running here");
  await clearPosted(page);
  await page.locator('.cx-c-delivery').getByRole('button', { name: 'Copy Prompt' }).click();
  expect(await posted(page)).toContainEqual({ type: 'deliveryAction', event: E1, action: 'copyPrompt' });
  await page.getByRole('button', { name: 'Reply…' }).click();
  await expect(page.locator('.cx-c-segbtn[aria-checked="true"]')).toHaveText('Ask Claude');
  await clearPosted(page);
  await page.locator('.cx-c-suggest').getByRole('button', { name: 'Resolve' }).click();
  expect(await posted(page)).toContainEqual({ type: 'threadAction', thread: T1, action: 'resolve' });
});

test('own comments: Edit and Delete; a card marks itself read after a second in view', async ({ page }) => {
  await open(page);
  await send(page, { type: 'threads', dir: DIR, threads: [thread()], context });
  await page.locator('.cx-scroll').focus();
  await page.keyboard.press('t');
  await expect.poll(async () => (await posted(page)).some((m) => m.type === 'threadRead'), { timeout: 4000 }).toBe(true);
  await page.locator('.cx-c-comment').first().getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  const ta = page.locator('.cx-c-comment textarea');
  await ta.fill('Why one cycle?');
  await clearPosted(page);
  await page.getByRole('button', { name: 'Save' }).click();
  expect(await posted(page)).toContainEqual({ type: 'commentEdit', event: E1, body: 'Why one cycle?' });
  await page.locator('.cx-c-comment').first().getByRole('button', { name: 'More actions' }).click();
  await clearPosted(page);
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  expect(await posted(page)).toContainEqual({ type: 'commentRetract', event: E1 });
});

test('the Esc order: composer, then pane, then the rest', async ({ page }) => {
  await open(page);
  await send(page, { type: 'threads', dir: DIR, threads: [thread()], context });
  await page.locator('.cx-scroll').focus();
  await page.keyboard.press('c');
  await page.keyboard.press('Escape');
  await expect(page.locator('.cx-c-composer')).toHaveCount(0);
  await expect(page.locator('.cx-comments')).toBeVisible();
  await page.locator('.cx-scroll').focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('.cx-comments')).toBeHidden();
});

test("author CSS can't cover or restyle the pane or badges", async ({ page }) => {
  await open(page, '<style>* { position: fixed !important; z-index: 2147483647 !important; inset: 0 !important; background: red !important; } .cx-comments, .cx-badge { display: none !important; }</style>');
  await send(page, { type: 'threads', dir: DIR, threads: [thread()], context });
  await page.locator('.cx-scroll').focus();
  await page.keyboard.press('t');
  await expect(page.locator('.cx-comments')).toBeVisible();
  const hit = await page.evaluate(() => {
    const r = document.querySelector('.cx-c-title')!.getBoundingClientRect();
    return document.elementFromPoint(r.left + 5, r.top + 5)?.closest('.cx-comments') !== null;
  });
  expect(hit).toBe(true);
});

test('the pane passes axe', async ({ page }) => {
  await open(page);
  await send(page, { type: 'threads', dir: DIR, threads: [thread()], context });
  await page.locator('.cx-scroll').focus();
  await page.keyboard.press('t');
  await page.getByRole('button', { name: 'Reply…' }).click();
  const r = await new AxeBuilder({ page }).include('.cx-comments').analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(', ')}`)).toEqual([]);
});
