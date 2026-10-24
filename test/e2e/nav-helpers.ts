// Helpers for the navigation specs (docs/NAVIGATION-PLAN.md §12.3): the Sidestories view, CodeLens, quick picks.
import { expect, type Locator, type Page } from '@playwright/test';
import { command } from './helpers.ts';

/** The Sidestories view's pane. */
export const sidebar = (page: Page) => page.locator('.pane', { has: page.locator('.pane-header', { hasText: /^Sidestories/ }) }).first();

/** A row of the Sidestories tree by its label (exact). */
export const treeRow = (page: Page, label: string | RegExp) =>
  sidebar(page).locator('.monaco-list-row', { has: page.locator('.label-name', { hasText: typeof label === 'string' ? new RegExp(`^${escape(label)}$`) : label }) }).first();

/** Opens the Sidestory activity bar container. */
export async function openSidebar(page: Page): Promise<void> {
  const icon = page.locator('.activitybar .action-item a[aria-label^="Sidestory"]').first();
  await expect(icon).toBeVisible({ timeout: 30_000 });
  if (!(await sidebar(page).isVisible())) await icon.click();
  await expect(sidebar(page)).toBeVisible();
}

/** Labels of the visible rows, with their tree level. */
export async function rows(page: Page): Promise<{ label: string; level: number; description: string }[]> {
  return sidebar(page)
    .locator('.monaco-list-row')
    .evaluateAll((els) =>
      els.map((el) => ({
        label: el.querySelector('.label-name')?.textContent ?? '',
        level: Number(el.getAttribute('aria-level') ?? 0),
        description: el.querySelector('.label-description')?.textContent ?? '',
      })),
    );
}

/** Expands a row if it is collapsed. */
export async function expand(row: Locator): Promise<void> {
  if ((await row.getAttribute('aria-expanded')) === 'false') await row.locator('.monaco-tl-twistie').click();
  await expect(row).toHaveAttribute('aria-expanded', 'true');
}

/** Runs a view title action by its tooltip: in the pane's header when the container shows several views, else the container's. */
export async function viewAction(page: Page, title: string, pane: Locator = sidebar(page)): Promise<void> {
  const header = pane.locator('.pane-header');
  const own = header.locator(`.actions-container a[aria-label^="${title}"]`).first();
  await header.hover().catch(() => {});
  if (await own.count()) {
    await own.click();
    return;
  }
  const bar = page.locator('.part.sidebar .composite.title');
  await bar.hover();
  await bar.locator(`.actions-container a[aria-label^="${title}"]`).first().click();
}

/** The CodeLens texts shown in an editor. */
export const lenses = (page: Page, file: string) => page.locator(`.monaco-editor[data-uri$="${file}"] .codelens-decoration`);

/** Opens a workspace file by name through Quick Open. */
export async function openFile(page: Page, path: string): Promise<void> {
  await page.locator('.part.sidebar .composite.title').click().catch(() => {});
  await page.keyboard.press('ControlOrMeta+P');
  await expect(page.locator('.quick-input-widget')).toBeVisible();
  await page.keyboard.type(path);
  await expect(page.locator('.quick-input-list .monaco-list-row').first()).toContainText(path.split('/').at(-1)!);
  await page.keyboard.press('Enter');
  await expect(page.locator('.tab.active', { hasText: path.split('/').at(-1)! })).toBeVisible();
}

export { command };

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}
