import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { loginWorkbench } from './login';

async function picker(page: Page) {
  await page.getByRole('button', { name: '当前项目', exact: true }).click();
  return page.getByRole('dialog', { name: '切换项目', exact: true });
}
async function addProject(page: Page, path: string) {
  const projects = await picker(page);
  await projects.getByRole('button', { name: '打开新项目…', exact: true }).click();
  const folders = page.getByRole('dialog', { name: '打开远程文件夹', exact: true });
  await expect(folders.getByLabel('远程目录路径')).toHaveValue(/.+/);
  await folders.getByLabel('远程目录路径').fill(path);
  await folders.getByRole('button', { name: '前往', exact: true }).click();
  await expect(folders.getByLabel('远程目录路径')).toHaveValue(path);
  await expect(folders.locator('.folder-list')).toHaveAttribute('aria-busy', 'false');
  await folders.getByRole('button', { name: '打开文件夹', exact: true }).click();
  await expect(folders).toHaveCount(0);
  await expect(page.locator('.project-switch')).toHaveAttribute('title', path);
}

test('project picker opens folders, searches recent projects and restores conversations and drafts without duplicates', async ({
  page,
}, info) => {
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  const first = fixture.tasks[info.project.name];
  await loginWorkbench(page);
  await addProject(page, first);
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  const input = page.getByLabel('任务指令', { exact: true });
  await input.fill('项目切换前的对话');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.run-status.completed')).toBeVisible();
  const conversation = await page.locator('.chat-panel').getAttribute('data-conversation-id');
  await input.fill('项目一的未发送草稿');
  await addProject(page, fixture.primary);
  await input.fill('项目二的未发送草稿');
  let dialog = await picker(page);
  await expect(dialog.locator('li').first()).toContainText(fixture.primary);
  await expect(dialog.locator('button[aria-current="true"]')).toContainText(fixture.primary);
  await dialog.getByLabel('搜索项目').fill(first);
  await expect(dialog.locator('li')).toHaveCount(1);
  await dialog.locator('li button').click();
  await expect(input).toHaveValue('项目一的未发送草稿');
  await expect(page.locator('.chat-panel')).toHaveAttribute('data-conversation-id', conversation!);
  await page.reload();
  await expect(input).toHaveValue('项目一的未发送草稿');
  dialog = await picker(page);
  await expect(dialog.locator('li').first()).toContainText(first);
  await dialog.getByLabel('搜索项目').fill('没有这个项目-xyz');
  await expect(dialog.getByText('没有匹配的项目')).toBeVisible();
  await dialog.getByLabel('搜索项目').fill(fixture.primary);
  await dialog.locator('li button').click();
  await expect(input).toHaveValue('项目二的未发送草稿');
  await addProject(page, first);
  dialog = await picker(page);
  await dialog.getByLabel('搜索项目').fill(first);
  await expect(dialog.locator('li')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
  await page.screenshot({ path: `.runtime/project-picker-${info.project.name}.png` });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('opening the project picker refreshes a stale project list from the server', async ({ page }) => {
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  await loginWorkbench(page);
  await addProject(page, fixture.primary);
  await addProject(page, fixture.secondary);
  const snapshot = await (await page.request.get('/api/connections/a/snapshot?view=summary')).json();
  const first = snapshot.workspaces.find((project: any) => project.canonicalRoot === fixture.primary);
  expect(snapshot.workspaces.length).toBeGreaterThanOrEqual(2);
  // Reproduce a device retaining only its earlier project snapshot.
  await page.route(
    '**/api/connections/a/snapshot?view=summary',
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, json: { ...body, workspaces: [first] } });
    },
    { times: 1 },
  );
  await page.reload();
  await expect(page.locator('.project-switch')).toHaveAttribute('title', fixture.primary);
  await page.getByRole('button', { name: '当前项目', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '切换项目', exact: true });
  await expect(dialog.locator('li')).toHaveCount(snapshot.workspaces.length);
  await expect(dialog.getByText(fixture.secondary, { exact: true })).toBeVisible();
});

test('returning to the page refreshes projects missed while in the background', async ({ page }) => {
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  await loginWorkbench(page);
  await addProject(page, fixture.primary);
  await addProject(page, fixture.secondary);
  const snapshot = await (await page.request.get('/api/connections/a/snapshot?view=summary')).json();
  const first = snapshot.workspaces.find((project: any) => project.canonicalRoot === fixture.primary);
  await page.route(/\/api\/connections\/a\/(snapshot\?view=summary|workspaces)$/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, workspaces: [first] } });
  });
  await page.reload();
  await expect(page.locator('.project-switch')).toHaveAttribute('title', fixture.primary);
  await page.getByRole('button', { name: '当前项目', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '切换项目', exact: true });
  await expect(dialog.locator('li')).toHaveCount(1);
  await page.unroute(/\/api\/connections\/a\/(snapshot\?view=summary|workspaces)$/);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(dialog.locator('li')).toHaveCount(snapshot.workspaces.length);
  await expect(dialog.getByText(fixture.secondary, { exact: true })).toBeVisible();
});

test('projects are shared across AI accounts while opening with the selected account', async ({
  page,
}, info) => {
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  await loginWorkbench(page);
  await addProject(page, fixture.primary);
  await addProject(page, fixture.secondary);
  const me = await (await page.request.get('/api/me')).json();
  const response = await page.request.post('/api/connections/a/providers/codex/accounts', {
    headers: { 'x-csrf-token': me.csrfToken, origin: 'http://127.0.0.1:4399' },
    data: { label: '项目共享-' + info.project.name, provider: 'codex' },
  });
  expect(response.ok()).toBe(true);
  const { account } = await response.json();
  await page.reload();
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click();
  await page.getByLabel('切换 AI 账号', { exact: true }).selectOption('a~' + account.id);
  await expect(page.getByLabel('切换 AI 账号', { exact: true })).toHaveValue('a~' + account.id);
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click();
  const endpoint = '/api/connections/a/accounts/' + account.id;
  await expect
    .poll(async () => (await (await page.request.get(endpoint + '/workspaces')).json()).workspaces.length)
    .toBe(1);
  await page.getByRole('button', { name: '当前项目', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '切换项目', exact: true });
  await expect(dialog.getByText(fixture.primary, { exact: true })).toBeVisible();
  await expect(dialog.getByText(fixture.secondary, { exact: true })).toHaveCount(1);
  await dialog
    .getByRole('button')
    .filter({ has: page.getByText(fixture.primary, { exact: true }) })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.project-switch')).toHaveAttribute('title', fixture.primary);
  const local = (await (await page.request.get(endpoint + '/workspaces')).json()).workspaces;
  expect(local).toHaveLength(2);
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click();
  await expect(page.getByLabel('切换 AI 账号', { exact: true })).toHaveValue('a~' + account.id);
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click();
  await page.getByRole('button', { name: '当前项目', exact: true }).click();
  await expect(dialog.getByText(fixture.primary, { exact: true })).toHaveCount(1);
});
