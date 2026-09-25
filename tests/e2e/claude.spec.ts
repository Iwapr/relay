import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { loginWorkbench } from './login.ts';

test('Claude login, model selection, account isolation, task submission and reload work through the browser', async ({
  page,
}, info) => {
  await loginWorkbench(page);
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  const path = fixture.shared[info.project.name].path;
  const me = await (await page.request.get('/api/me')).json();
  const opened = await page.request.post('/api/connections/a/workspaces/open', {
    headers: { 'x-csrf-token': me.csrfToken, origin: 'http://127.0.0.1:4399' },
    data: { path },
  });
  const { workspace } = await opened.json();
  await page.evaluate((id) => sessionStorage.setItem('relay:a:workspace', JSON.stringify(id)), workspace.id);
  await page.reload();
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click();
  await page.getByRole('button', { name: '账号管理', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '账号管理' });
  await dialog.getByLabel('新账号类型').selectOption('claude');
  await dialog.getByLabel('新账号名称').fill(info.project.name + ' Claude');
  await dialog.getByRole('button', { name: '添加账号', exact: true }).click();
  const picker = dialog.getByLabel('当前 AI 账号');
  await expect(picker).not.toHaveValue('a');
  const selected = await picker.inputValue();
  await dialog.getByRole('button', { name: '登录 Claude 订阅账号', exact: true }).click();
  await expect(dialog.getByRole('link', { name: '打开官方授权页' })).toHaveAttribute(
    'href',
    /https:\/\/claude\.com\/oauth\/authorize/,
  );
  await dialog.getByLabel('Claude 授权码').fill('TEST-CODE');
  await dialog.getByRole('button', { name: '完成登录', exact: true }).click();
  await expect(dialog.locator('dd').filter({ hasText: 'claude-code' })).toBeVisible();
  await expect(dialog.getByLabel('Claude 授权码')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
  await expect(page.locator('.workspace-menu-trigger .status-dot')).not.toHaveClass(/unknown/);
  await page.screenshot({ path: `.runtime/e2e/${info.project.name}-claude-account.png` });
  await page.reload();
  await expect(page.getByLabel('模型', { exact: true })).toHaveValue('default');
  await expect(page.getByRole('button', { name: 'Claude 会话', exact: true })).toBeVisible();
  await page.getByLabel('权限模式').selectOption('workspace-write');
  await page.getByLabel('任务指令', { exact: true }).fill('hello');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.assistant-message').filter({ hasText: 'Claude hello' })).toBeVisible();
  await expect(page.locator('.reply-panel .run-label strong')).toHaveText('Claude');
  await expect(page.getByRole('region', { name: 'Claude 回复：已完成', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('.assistant-message').filter({ hasText: 'Claude hello' })).toBeVisible();
  await page.getByRole('button', { name: 'Claude 会话', exact: true }).click();
  const history = page.getByRole('dialog', { name: 'Claude 会话', exact: true });
  await expect(history.getByText('hello', { exact: true })).toBeVisible();
  await history.getByRole('button', { name: '全部项目', exact: true }).click();
  await history.getByRole('button', { name: '打开会话：hello', exact: true }).click();
  await expect(history).toHaveCount(0);
  await expect(page.locator('.assistant-message').filter({ hasText: 'Claude hello' })).toBeVisible();
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click();
  await expect(page.getByLabel('切换 AI 账号')).toHaveValue(selected);
  await page.getByLabel('切换 AI 账号').selectOption('a');
  await expect(page.getByText('Codex · ChatGPT 已登录', { exact: true })).toBeVisible();
  await expect(page.locator('.assistant-message').filter({ hasText: 'Claude hello' })).toHaveCount(0);
  await page.getByLabel('切换 AI 账号').selectOption(selected);
  await expect(page.locator('.assistant-message').filter({ hasText: 'Claude hello' })).toBeVisible();
});
