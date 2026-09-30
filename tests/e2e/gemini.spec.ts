import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { loginWorkbench } from './login.ts';

test('Gemini（测试） login, model selection, account isolation, task submission and reload work through the browser', async ({
  page,
}, info) => {
  await loginWorkbench(page);
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  const path = fixture.shared[info.project.name].path;
  const me = await (await page.request.get('/api/me')).json();
  const profiles = await (await page.request.get('/api/connections/a/providers/codex/accounts')).json();
  for (const profile of profiles.accounts.filter((a: any) => a.provider === 'antigravity'))
    await page.request.post(`/api/connections/a/providers/codex/accounts/${profile.id}/delete`, {
      headers: { 'x-csrf-token': me.csrfToken, origin: 'http://127.0.0.1:4399' },
      data: {},
    });
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
  await dialog.getByLabel('新账号类型').selectOption('antigravity');
  await dialog.getByLabel('新账号名称').fill(info.project.name + ' Gemini（测试）');
  await dialog.getByRole('button', { name: '添加账号', exact: true }).click();
  const picker = dialog.getByLabel('当前 AI 账号');
  await expect(picker).not.toHaveValue('a');
  const selected = await picker.inputValue();
  await dialog.getByRole('button', { name: '登录 Google 账号（测试）', exact: true }).click();
  await expect(dialog.getByRole('link', { name: '打开官方授权页' })).toHaveAttribute(
    'href',
    /https:\/\/accounts\.google\.com\/o\/oauth2\/auth/,
  );
  await dialog.getByLabel('Gemini（测试） 授权码').fill('TEST-CODE');
  await dialog.getByRole('button', { name: '完成登录', exact: true }).click();
  await expect(dialog.locator('dd').filter({ hasText: 'google-antigravity' })).toBeVisible();
  await expect(dialog.getByLabel('Gemini（测试） 授权码')).toHaveCount(0);
  await expect(dialog.locator('.quota-window').filter({ hasText: 'Gemini 每周额度' })).toBeVisible();
  const allow = dialog.getByLabel('Gemini 允许的命令');
  await expect(allow).toHaveValue(/ls/);
  await allow.fill((await allow.inputValue()) + '\npython -m pytest');
  await dialog.getByLabel('Gemini 禁止的命令').fill('git push');
  await dialog.getByRole('button', { name: '保存命令权限', exact: true }).click();
  await expect(dialog.getByText('权限规则已保存，下次任务生效。')).toBeVisible();
  await dialog.getByRole('button', { name: '重新加载权限', exact: true }).click();
  await expect(allow).toHaveValue(/python -m pytest/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
  await expect(page.locator('.workspace-menu-trigger .status-dot')).not.toHaveClass(/unknown/);
  await page.screenshot({ path: `.runtime/e2e/${info.project.name}-antigravity-account.png` });
  await page.reload();
  await expect(page.getByLabel('模型', { exact: true })).toHaveValue('gemini-3.1-pro-high');
  await expect(page.getByRole('button', { name: 'Gemini（测试）会话', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '添加图片', exact: true })).toBeDisabled();
  await expect(page.getByLabel('权限模式').locator('option[value="workspace-write"]')).toHaveText(
    '按规则执行（测试）',
  );
  await page.getByLabel('推理强度').selectOption('low');
  await page.getByLabel('权限模式').selectOption('workspace-write');
  const help = page.locator('.composer-help');
  await expect(help.locator('p')).toBeHidden();
  await help.locator('summary').click();
  await expect(help.locator('p')).toBeVisible();
  await help.locator('summary').click();
  const input = page.getByLabel('任务指令', { exact: true });
  await input.fill('第一行\n第二行\n最后一行');
  await input.press('Control+End');
  const layout = await page.locator('.composer-area').evaluate((area) => {
    const input = area.querySelector('textarea')!;
    const inputBox = input.getBoundingClientRect();
    const controls = area.querySelector('.composer-bottom')!.getBoundingClientRect();
    const send = area.querySelector('.send-button')!.getBoundingClientRect();
    return {
      inputClear: inputBox.bottom <= controls.top,
      lastLineVisible: input.scrollTop + input.clientHeight >= input.scrollHeight - 2,
      sendVisible: send.right <= innerWidth && send.bottom <= innerHeight,
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
    };
  });
  expect(layout).toEqual({ inputClear: true, lastLineVisible: true, sendVisible: true, overflow: false });
  await page.screenshot({ path: `.runtime/e2e/${info.project.name}-antigravity-composer.png` });
  await page.getByLabel('任务指令', { exact: true }).fill('hello');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.assistant-message').filter({ hasText: 'Gemini hello' })).toBeVisible();
  await expect(page.locator('.reply-panel .run-label strong')).toHaveText('Gemini（测试）');
  await expect(page.getByRole('region', { name: 'Gemini（测试） 回复：已完成', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '恢复本轮文件', exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.locator('.assistant-message').filter({ hasText: 'Gemini hello' })).toBeVisible();
  await page.getByRole('button', { name: 'Gemini（测试）会话', exact: true }).click();
  const history = page.getByRole('dialog', { name: 'Gemini（测试）会话', exact: true });
  await expect(history.getByText('hello', { exact: true })).toBeVisible();
  await history.getByRole('button', { name: '全部项目', exact: true }).click();
  await history.getByRole('button', { name: '打开会话：hello', exact: true }).click();
  await expect(history).toHaveCount(0);
  await expect(page.locator('.assistant-message').filter({ hasText: 'Gemini hello' })).toBeVisible();
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click();
  await expect(page.getByLabel('切换 AI 账号')).toHaveValue(selected);
  await page.getByLabel('切换 AI 账号').selectOption('a');
  await expect(page.getByText('Codex · ChatGPT 已登录', { exact: true })).toBeVisible();
  await expect(page.locator('.assistant-message').filter({ hasText: 'Gemini hello' })).toHaveCount(0);
  await page.getByLabel('切换 AI 账号').selectOption(selected);
  await expect(page.locator('.assistant-message').filter({ hasText: 'Gemini hello' })).toBeVisible();
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click();
  await page.getByRole('button', { name: '恢复本轮文件', exact: true }).click();
  const restore = page.getByRole('dialog', { name: '仅恢复本轮文件', exact: true });
  await expect(restore.getByText(/模型记忆不会回退/)).toBeVisible();
  await restore.getByRole('button', { name: '确认恢复文件并新建会话', exact: true }).click();
  await expect(restore).toHaveCount(0);
  await expect(page.getByLabel('任务指令', { exact: true })).toHaveValue('hello');
});
