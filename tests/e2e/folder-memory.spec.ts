import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

import { loginWorkbench as login } from './login.ts';
async function filesTab(page: Page) {
  if ((page.viewportSize()?.width ?? 0) < 761) {
    await page.getByLabel('切换视图', { exact: true }).click();
    await page.locator('.mobile-nav').getByRole('button', { name: '文件', exact: true }).click();
  }
}
async function selectConnection(page: Page, connection: string) {
  await page.getByLabel('工作区菜单', { exact: true }).click();
  await page.getByLabel('服务器和 Linux 用户').selectOption(connection);
  await page.getByLabel('工作区菜单', { exact: true }).click();
}
async function picker(page: Page) {
  await filesTab(page);
  await page.getByRole('button', { name: '打开远程文件夹', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: '打开远程文件夹' });
  await expect(dialog.locator('.folder-list')).toHaveAttribute('aria-busy', 'false');
  return dialog;
}
async function openFolder(page: Page, path: string) {
  const dialog = await picker(page);
  await dialog.getByLabel('远程目录路径').fill(path);
  await dialog.getByRole('button', { name: '前往', exact: true }).click();
  await expect(dialog.locator('.folder-list')).toHaveAttribute('aria-busy', 'false');
  await expect(dialog.locator('.error')).toHaveCount(0);
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await dialog.getByRole('button', { name: '打开文件夹', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

test('folder picker reopens the selected project and file tree remembers each project directory', async ({
  page,
}) => {
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  await login(page);
  await openFolder(page, fixture.browsing);
  await page.locator('.file-list').getByRole('button', { name: '嵌套 资料', exact: true }).click();
  await expect(
    page.locator('.file-list').getByRole('button', { name: 'README.md', exact: true }),
  ).toBeVisible();

  if ((page.viewportSize()?.width ?? 0) < 761) {
    await page.getByLabel('切换视图', { exact: true }).click();
    await page.locator('.mobile-nav').getByRole('button', { name: '对话', exact: true }).click();
    await filesTab(page);
    await expect(
      page.locator('.file-list').getByRole('button', { name: 'README.md', exact: true }),
    ).toBeVisible();
  }
  let dialog = await picker(page);
  await expect(dialog.getByLabel('远程目录路径')).toHaveValue(fixture.browsing);
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await dialog.locator('.folder-list').getByRole('button', { name: '嵌套 资料', exact: true }).click();
  await expect(dialog.getByLabel('远程目录路径')).toHaveValue(fixture.nested);
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();

  await page.reload();
  await expect(page.getByLabel('工作区菜单', { exact: true })).toBeVisible();
  await filesTab(page);
  await expect(
    page.locator('.file-list').getByRole('button', { name: 'README.md', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.tree-options')).toContainText('嵌套 资料');
  dialog = await picker(page);
  await expect(dialog.getByLabel('远程目录路径')).toHaveValue(fixture.browsing);
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();

  await openFolder(page, fixture.secondary);
  await expect(
    page.locator('.file-list').getByRole('button', { name: 'notes.txt', exact: true }),
  ).toBeVisible();
  dialog = await picker(page);
  await expect(dialog.getByLabel('远程目录路径')).toHaveValue(fixture.secondary);
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await dialog
    .locator('.folder-shortcuts')
    .getByRole('button', { name: fixture.browsing, exact: true })
    .click();
  await expect(dialog.locator('.folder-list')).toHaveAttribute('aria-busy', 'false');
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await dialog.getByRole('button', { name: '打开文件夹', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.tree-options')).toContainText('嵌套 资料');
  await expect(
    page.locator('.file-list').getByRole('button', { name: 'README.md', exact: true }),
  ).toBeVisible();
  const otherSnapshot = await (await page.request.get('/api/connections/b/snapshot')).json();
  await page.evaluate((path) => {
    sessionStorage.setItem('relay:b:last-folder', JSON.stringify(path));
  }, fixture.secondary);
  const otherLoaded = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith('/connections/b/snapshot'),
  );
  await selectConnection(page, 'b');
  await otherLoaded;
  dialog = await picker(page);
  await expect(dialog.getByLabel('远程目录路径')).toHaveValue(
    otherSnapshot.workspaces.at(-1)?.canonicalRoot ?? fixture.secondary,
  );
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await selectConnection(page, 'a');
  await filesTab(page);
  await expect(page.locator('.tree-options')).toContainText('嵌套 资料');
});

test('failed and stale folder reads cannot replace the current selection or open an unverified directory', async ({
  page,
}) => {
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  await login(page);
  await openFolder(page, fixture.browsing);
  const dialog = await picker(page);
  const path = dialog.getByLabel('远程目录路径');
  await path.fill(fixture.projects + '/does-not-exist');
  await dialog.getByRole('button', { name: '前往', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByRole('button', { name: '打开文件夹', exact: true })).toBeDisabled();
  await dialog.locator('.folder-roots').getByRole('button', { name: fixture.projects, exact: true }).click();
  await expect(dialog.locator('.folder-list')).toHaveAttribute('aria-busy', 'false');
  await expect(path).toHaveValue(fixture.projects);

  let finishOldRead!: () => void;
  let oldReadStarted!: () => void;
  const oldStarted = new Promise<void>((resolve) => {
    oldReadStarted = resolve;
  });
  const oldFinished = new Promise<void>((resolve) => {
    finishOldRead = resolve;
  });
  await page.route('**/fs/directories?**', async (route) => {
    const requested = new URL(route.request().url()).searchParams.get('path');
    if (requested !== fixture.browsing) return route.continue();
    oldReadStarted();
    await oldFinished;
    await route.fulfill({ json: { path: fixture.browsing, entries: [], nextCursor: null } }).catch(() => {});
  });
  await dialog.locator('.folder-list').getByRole('button', { name: '目录 点击测试', exact: true }).click();
  await oldStarted;
  await path.fill(fixture.secondary);
  await dialog.getByRole('button', { name: '前往', exact: true }).click();
  await expect(dialog.locator('.folder-list')).toHaveAttribute('aria-busy', 'false');
  finishOldRead();
  await expect(path).toHaveValue(fixture.secondary);
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await dialog.getByRole('button', { name: '打开文件夹', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.locator('.file-list').getByRole('button', { name: 'notes.txt', exact: true }),
  ).toBeVisible();
});

test('folder opening waits for the selected directory without a trust prompt', async ({ page }) => {
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  await login(page);
  await openFolder(page, fixture.browsing);
  const dialog = await picker(page);
  let finishRead!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    finishRead = resolve;
  });
  await page.route('**/fs/directories?**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('path') !== fixture.secondary)
      return route.continue();
    const response = await route.fetch();
    markStarted();
    await finished;
    await route.fulfill({ response });
  });
  await dialog.getByLabel('远程目录路径').fill(fixture.secondary);
  await expect(dialog.getByRole('button', { name: '打开文件夹', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '前往', exact: true }).click();
  await started;
  await expect(dialog.getByRole('button', { name: '打开文件夹', exact: true })).toBeDisabled();
  finishRead();
  await expect(dialog.locator('.folder-list')).toHaveAttribute('aria-busy', 'false');
  await expect(dialog.getByRole('button', { name: '打开文件夹', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await dialog.getByRole('button', { name: '打开文件夹', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const snapshot = await (await page.request.get('/api/connections/a/snapshot')).json();
  expect(
    snapshot.workspaces.find(
      (workspace: { canonicalRoot: string }) => workspace.canonicalRoot === fixture.secondary,
    ),
  ).not.toHaveProperty('trusted');
  if ((page.viewportSize()?.width ?? 0) < 761) {
    await page.getByLabel('切换视图', { exact: true }).click();
    await page.locator('.mobile-nav').getByRole('button', { name: '对话', exact: true }).click();
  }
  await expect(page.getByText('此项目仅供浏览。打开文件夹时确认信任后可执行任务。')).toHaveCount(0);
  await page.getByRole('textbox', { name: '任务指令' }).fill('No project confirmation');
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeEnabled();
});

test('create a project folder from the picker, refuse duplicates, and open it immediately', async ({
  page,
}, info) => {
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  await login(page);
  await openFolder(page, fixture.browsing);
  const dialog = await picker(page);
  await dialog.getByRole('button', { name: '新建项目文件夹', exact: true }).click();
  const name = '新项目 ' + info.project.name + ' ' + Date.now();
  await dialog.getByLabel('项目文件夹名称').fill('../escape');
  await expect(dialog.getByRole('button', { name: '创建并打开', exact: true })).toBeDisabled();
  await dialog.getByLabel('项目文件夹名称').fill('嵌套 资料');
  await dialog.getByRole('button', { name: '创建并打开', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('同名');
  await dialog.getByLabel('项目文件夹名称').fill(name);
  await page.screenshot({ path: `.runtime/e2e/${info.project.name}-create-project.png` });
  await dialog.getByRole('button', { name: '创建并打开', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const reopened = await picker(page);
  await expect(reopened.getByLabel('远程目录路径')).toHaveValue(fixture.browsing + '/' + name);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
});
