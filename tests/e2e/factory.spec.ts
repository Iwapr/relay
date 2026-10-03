import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { loginWorkbench } from './login.ts';

test('Droid API configuration, permissions, task history and mobile composer', async ({ page }, info) => {
  await loginWorkbench(page);
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  const me = await (await page.request.get('/api/me')).json();
  const headers = { 'x-csrf-token': me.csrfToken, origin: 'http://127.0.0.1:4399' };
  const profiles = await (await page.request.get('/api/connections/a/providers/codex/accounts')).json();
  for (const p of profiles.accounts.filter((a: any) => a.provider === 'factory'))
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
  await dialog.getByLabel('新账号类型').selectOption('factory');
  await dialog.getByLabel('新账号名称').fill(info.project.name + ' Droid');
  await dialog.getByRole('button', { name: '添加账号', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Factory API Key', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /设备码登录/ })).toHaveCount(0);
  await dialog.getByLabel('Factory API Key', { exact: true }).fill('invalid secret');
  await dialog.getByRole('button', { name: '保存 API Key', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('无效');
  await dialog.getByLabel('Factory API Key', { exact: true }).fill('test-factory-browser');
  await dialog.getByRole('button', { name: '保存 API Key', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('已保存，尚未验证');
  await expect(dialog.getByLabel('Factory API Key', { exact: true })).toHaveValue('');
  await expect(dialog.getByText(/Factory 额度接口返回 403/)).toBeVisible();
  await page.screenshot({ path: `.runtime/e2e/${info.project.name}-factory-account.png` });
  await page.reload();
  await expect(page.getByLabel('模型', { exact: true })).toHaveValue('fixture-opus');
  await expect(page.getByLabel('权限模式', { exact: true })).toHaveValue('read-only');
  await page.getByLabel('权限模式', { exact: true }).selectOption('workspace-write');
  await expect(page.locator('.composer-help p')).toBeHidden();
  await page.getByLabel('推理强度').selectOption('low');
  await page.getByLabel('任务指令', { exact: true }).fill('第一行\n第二行\n最后一行');
  await page.getByLabel('任务指令', { exact: true }).press('Control+End');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
  const send = await page.getByRole('button', { name: '发送任务', exact: true }).boundingBox();
  expect(send!.y + send!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await page.screenshot({ path: `.runtime/e2e/${info.project.name}-factory-composer.png` });
  await page.getByLabel('任务指令', { exact: true }).fill('hello');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.assistant-message').filter({ hasText: 'Droid hello' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Droid（测试） 回复：已完成', exact: true })).toBeVisible();
  await expect(page.getByText('本次用量 · 12.5 credits', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('本次用量 · 12.5 credits', { exact: true })).toBeVisible();
  await expect(page.locator('.assistant-message').filter({ hasText: 'Droid hello' })).toBeVisible();
  await page.getByRole('button', { name: 'Droid（测试）会话', exact: true }).click();
  const history = page.getByRole('dialog', { name: 'Droid（测试）会话', exact: true });
  await expect(history.getByText('hello', { exact: true })).toBeVisible();
  await history.getByRole('button', { name: '打开会话：hello', exact: true }).click();
  await page.getByLabel('任务指令', { exact: true }).fill('again');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.assistant-message').filter({ hasText: 'Droid again' })).toBeVisible();
  await page.getByLabel('任务指令', { exact: true }).fill('approval');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.getByText('Droid 请求工具审批', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '允许本次', exact: true }).click();
  await expect(page.locator('.assistant-message').filter({ hasText: 'proceed_once' })).toBeVisible();
  await page.getByLabel('任务指令', { exact: true }).fill('question');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.getByText('Choose style（可多选）', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'simple', exact: true }).click();
  await page.getByRole('button', { name: 'detailed', exact: true }).click();
  await expect(page.getByRole('button', { name: 'simple', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: 'detailed', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: '提交回答', exact: true }).click();
  await expect(page.locator('.assistant-message').filter({ hasText: 'simple, detailed' })).toBeVisible();
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click();
  await page.getByRole('button', { name: '账号管理', exact: true }).click();
  const usage = page.getByRole('region', { name: 'Droid Usage', exact: true });
  await expect(usage.getByText('50 credits', { exact: true })).toBeVisible();
  await expect(usage).toContainText('已记录 4 次任务');
});
