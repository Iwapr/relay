import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { loginWorkbench } from './login.ts';

test('DeepSeek API configuration, fixed full access, task history and mobile composer', async ({
  page,
}, info) => {
  await loginWorkbench(page);
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  const me = await (await page.request.get('/api/me')).json();
  const headers = { 'x-csrf-token': me.csrfToken, origin: 'http://127.0.0.1:4399' };
  const profiles = await (await page.request.get('/api/connections/a/providers/codex/accounts')).json();
  for (const p of profiles.accounts.filter((a: any) => a.provider === 'deepseek'))
    await page.request.post(`/api/connections/a/providers/codex/accounts/${p.id}/delete`, {
      headers,
      data: {},
    });
  const opened = await page.request.post('/api/connections/a/workspaces/open', {
    headers,
    data: { path: fixture.shared[info.project.name].path },
  });
  const { workspace } = await opened.json();
  await page.evaluate((id) => sessionStorage.setItem('relay:a:workspace', JSON.stringify(id)), workspace.id);
  await page.reload();
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click();
  await page.getByRole('button', { name: '账号管理', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '账号管理' });
  await dialog.getByLabel('新账号类型').selectOption('deepseek');
  await dialog.getByLabel('新账号名称').fill(info.project.name + ' DeepSeek');
  await dialog.getByRole('button', { name: '添加账号', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'DeepSeek API Key', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /设备码登录/ })).toHaveCount(0);
  await dialog.getByLabel('DeepSeek API Key', { exact: true }).fill('invalid-secret');
  await dialog.getByRole('button', { name: '验证并保存 API Key', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('无效');
  await dialog.getByLabel('DeepSeek API Key', { exact: true }).fill('test-deepseek-browser');
  await dialog.getByRole('button', { name: '验证并保存 API Key', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('已验证并保存');
  await expect(dialog.getByLabel('DeepSeek API Key', { exact: true })).toHaveValue('');
  await expect(dialog.getByText('12.34 CNY', { exact: true })).toBeVisible();
  await page.screenshot({ path: `.runtime/e2e/${info.project.name}-deepseek-account.png` });
  await page.reload();
  await expect(page.getByLabel('模型', { exact: true })).toHaveValue('deepseek-flash');
  await expect(page.getByLabel('权限模式：完全访问（固定）', { exact: true })).toBeVisible();
  await expect(page.locator('select[aria-label="权限模式"]')).toHaveCount(0);
  await expect(page.locator('.composer-help p')).toBeHidden();
  await page.getByLabel('推理强度').selectOption('low');
  await page.getByLabel('任务指令', { exact: true }).fill('第一行\n第二行\n最后一行');
  await page.getByLabel('任务指令', { exact: true }).press('Control+End');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
  const send = await page.getByRole('button', { name: '发送任务', exact: true }).boundingBox();
  expect(send!.y + send!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await page.screenshot({ path: `.runtime/e2e/${info.project.name}-deepseek-composer.png` });
  await page.getByLabel('任务指令', { exact: true }).fill('hello');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.assistant-message').filter({ hasText: 'DeepSeek hello' })).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'DeepSeek（测试） 回复：已完成', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.locator('.assistant-message').filter({ hasText: 'DeepSeek hello' })).toBeVisible();
  await page.getByRole('button', { name: 'DeepSeek（测试）会话', exact: true }).click();
  const history = page.getByRole('dialog', { name: 'DeepSeek（测试）会话', exact: true });
  await expect(history.getByText('hello', { exact: true })).toBeVisible();
  await history.getByRole('button', { name: '打开会话：hello', exact: true }).click();
  await page.getByLabel('任务指令', { exact: true }).fill('again');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.assistant-message').filter({ hasText: 'DeepSeek again' })).toBeVisible();
});
