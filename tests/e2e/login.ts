import { expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

/** Feature tests reuse the isolated fixture's owner session. Account tests still
 * exercise the browser login, without exhausting the production sign-in limit. */
export async function loginWorkbench(page: Page) {
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  await page.context().addCookies(fixture.cookies);
  await page.goto('/');
  await expect(page.getByLabel('工作区菜单', { exact: true })).toBeVisible();
  await page.getByLabel('工作区菜单', { exact: true }).click();
  await expect(page.getByText('Codex · ChatGPT 已登录', { exact: true })).toBeVisible();
  await page.getByLabel('工作区菜单', { exact: true }).click();
}
