import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { loginWorkbench } from './login.ts';

test('owner adds and authorizes an account, switches in place, and retains the selection after reload', async ({
  page,
}, info) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/');
  await page.getByLabel('账号', { exact: true }).fill('owner');
  await page.getByLabel('密码', { exact: true }).fill('browser-fixture-password');
  await page.getByRole('button', { name: '进入工作台', exact: true }).click();
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click();
  await expect(page.getByText('Codex · ChatGPT 已登录', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '账号管理', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '账号管理' });
  const cookies = await page.context().cookies();
  const session = cookies.find((cookie) => cookie.httpOnly)!;
  await dialog.getByLabel('新账号名称').fill(info.project.name + ' 工作账号');
  await dialog.getByRole('button', { name: '添加账号', exact: true }).click();
  await expect(dialog.getByLabel('当前 AI 账号')).not.toHaveValue('a');
  const selected = await dialog.getByLabel('当前 AI 账号').inputValue();
  expect(selected).toMatch(/^a~/);
  await expect(page.locator('.workspace-menu-trigger .status-dot')).toHaveClass(/unknown/);
  await dialog.getByRole('button', { name: '通过设备码登录 ChatGPT' }).click();
  await expect(dialog.getByText('TEST-1234', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('link', { name: '打开官方授权页' })).toHaveAttribute(
    'href',
    'https://auth.openai.com/codex/device',
  );
  await expect(dialog.locator('dd').filter({ hasText: 'second@example.test' })).toBeVisible();
  await expect(dialog.getByText('TEST-1234', { exact: true })).not.toBeVisible();
  await expect(page.locator('.workspace-menu-trigger .status-dot')).not.toHaveClass(/unknown/);
  await dialog.getByLabel('当前 AI 账号').selectOption('a');
  await expect(dialog.locator('dd').filter({ hasText: 'fixture@example.invalid' })).toBeVisible();
  await dialog.getByLabel('当前 AI 账号').selectOption(selected);
  await expect(dialog.locator('dd').filter({ hasText: 'second@example.test' })).toBeVisible();
  // The cards and dropdown share the account switch handler. Both must work
  // without calling React hooks from an event callback.
  await dialog.locator('.account-profile-card').filter({ hasText: '跟随 Codex' }).click();
  await expect(dialog.getByLabel('当前 AI 账号')).toHaveValue('a');
  await dialog
    .locator('.account-profile-card')
    .filter({ hasText: info.project.name + ' 工作账号' })
    .click();
  await expect(dialog.getByLabel('当前 AI 账号')).toHaveValue(selected);
  expect(pageErrors).toEqual([]);
  expect((await page.context().cookies()).find((cookie) => cookie.name === session.name)?.value).toBe(
    session.value,
  );
  expect((await (await page.request.get('/api/me')).json()).user.username).toBe('owner');
  await page.screenshot({ path: `.runtime/e2e/${info.project.name}-accounts.png` });
  await page.reload();
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click();
  await expect(page.getByLabel('切换 AI 账号')).toHaveValue(selected);
  await expect(page.getByLabel('服务器和 Linux 用户')).toHaveValue('a');
  await page.getByLabel('切换 AI 账号').selectOption('a');
  await expect(page.getByText('Codex · ChatGPT 已登录', { exact: true })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  expect(overflow).toBe(false);
});

test('switching accounts retains the native conversation and owner session', async ({ page }, info) => {
  await loginWorkbench(page);
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  const shared = fixture.shared[info.project.name];
  const me = await (await page.request.get('/api/me')).json();
  const profiles = await (await page.request.get('/api/connections/a/providers/codex/accounts')).json();
  const profile = profiles.accounts.find(
    (p: { id: string; account?: { authenticated: boolean } }) =>
      p.id !== 'default' && p.account?.authenticated,
  );
  expect(profile).toBeTruthy();
  const imported = await page.request.post('/api/connections/a/providers/codex/sessions/import', {
    headers: { 'x-csrf-token': me.csrfToken, origin: 'http://127.0.0.1:4399' },
    data: { threadId: shared.threadId },
  });
  expect(imported.ok()).toBe(true);
  const { workspace, conversation } = await imported.json();
  await page.evaluate(
    ({ workspace, conversation }) => {
      sessionStorage.setItem('relay:connection', JSON.stringify('a'));
      sessionStorage.setItem('relay:a:workspace', JSON.stringify(workspace.id));
      sessionStorage.setItem('relay:a:' + workspace.id + ':conversation', JSON.stringify(conversation.id));
    },
    { workspace, conversation },
  );
  await page.reload();
  await expect(page.locator('.native-turn .user-message').first()).toContainText(
    '这是在 IDE 中写入的测试提问。',
  );
  await page.getByLabel('工作区菜单', { exact: true }).click();
  await page.getByLabel('切换 AI 账号', { exact: true }).selectOption('a~' + profile.id);
  await expect(page.getByLabel('切换 AI 账号', { exact: true })).toHaveValue('a~' + profile.id);
  await expect(page.locator('.project-switch')).toHaveAttribute('title', shared.path);
  await expect(page.locator('.native-turn .user-message').first()).toContainText(
    '这是在 IDE 中写入的测试提问。',
  );
  const snapshot = await (
    await page.request.get('/api/connections/a/accounts/' + profile.id + '/snapshot')
  ).json();
  expect(
    snapshot.conversations.some(
      (c: { providerSessionId: string }) => c.providerSessionId === shared.threadId,
    ),
  ).toBe(true);
  await page.getByLabel('切换 AI 账号', { exact: true }).selectOption('a');
  await expect(page.locator('.native-turn .user-message').first()).toContainText(
    '这是在 IDE 中写入的测试提问。',
  );
  expect((await (await page.request.get('/api/me')).json()).user.username).toBe('owner');
});

test('Kimi Code login, model selection, account isolation, task submission and reload work through the browser', async ({
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
  await dialog.getByLabel('新账号类型').selectOption('kimi');
  await dialog.getByLabel('新账号名称').fill(info.project.name + ' Kimi');
  await dialog.getByRole('button', { name: '添加账号', exact: true }).click();
  const picker = dialog.getByLabel('当前 AI 账号');
  await expect(picker).not.toHaveValue('a');
  const selected = await picker.inputValue();
  await dialog.getByRole('button', { name: '通过设备码登录 Kimi Code', exact: true }).click();
  await expect(dialog.getByText('TEST-1234', { exact: true })).toBeVisible();
  await expect(dialog.locator('dd').filter({ hasText: 'kimi-code' })).toBeVisible();
  await expect(dialog.getByText('剩余 75%', { exact: true })).toBeVisible();
  await expect(dialog.getByText('剩余 60%', { exact: true })).toBeVisible();
  await expect(dialog.getByText('12.34 CNY', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
  await expect(page.locator('.workspace-menu-trigger .status-dot')).not.toHaveClass(/unknown/);
  await page.screenshot({ path: `.runtime/e2e/${info.project.name}-kimi-account.png` });
  await page.reload();
  await expect(page.getByLabel('模型', { exact: true })).toHaveValue('kimi-fixture');
  await expect(page.getByRole('button', { name: 'Kimi 会话', exact: true })).toBeVisible();
  await page.getByLabel('权限模式').selectOption('workspace-write');
  await page.getByLabel('任务指令', { exact: true }).fill('hello');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.assistant-message').filter({ hasText: 'Kimi default' })).toBeVisible();
  await expect(page.locator('.reply-panel .run-label strong')).toHaveText('Kimi');
  await expect(page.getByRole('region', { name: 'Kimi 回复：已完成', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('.assistant-message').filter({ hasText: 'Kimi default' })).toBeVisible();
  await page.getByRole('button', { name: 'Kimi 会话', exact: true }).click();
  const history = page.getByRole('dialog', { name: 'Kimi 会话', exact: true });
  await expect(history.getByText('hello', { exact: true })).toBeVisible();
  await history.getByRole('button', { name: '全部项目', exact: true }).click();
  await history.getByRole('button', { name: '打开会话：hello', exact: true }).click();
  await expect(history).toHaveCount(0);
  await expect(page.locator('.assistant-message').filter({ hasText: 'Kimi default' })).toBeVisible();
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click();
  await expect(page.getByLabel('切换 AI 账号')).toHaveValue(selected);
  await page.getByLabel('切换 AI 账号').selectOption('a');
  await expect(page.getByText('Codex · ChatGPT 已登录', { exact: true })).toBeVisible();
  await expect(page.locator('.assistant-message').filter({ hasText: 'Kimi default' })).toHaveCount(0);
  await page.getByLabel('切换 AI 账号').selectOption(selected);
  await expect(page.locator('.assistant-message').filter({ hasText: 'Kimi default' })).toBeVisible();
});

test('account management separates server identity and deletes an AI account after confirmation', async ({
  page,
}, info) => {
  await loginWorkbench(page);
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click();
  await page.getByRole('button', { name: '账号管理', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '账号管理', exact: true });
  await expect(dialog.getByRole('tab', { name: /AI 账号/ })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByRole('heading', { name: '连接诊断' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '删除 AI 账号', exact: true })).toHaveCount(0);
  await dialog.getByRole('tab', { name: '服务器身份', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: '服务器远端', exact: true })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: '连接诊断', exact: true })).toBeVisible();
  await expect(dialog.getByLabel('新账号名称')).toHaveCount(0);
  await page.screenshot({ path: `.runtime/e2e/${info.project.name}-account-server.png` });
  await dialog.getByRole('tab', { name: /AI 账号/ }).click();
  await dialog.getByLabel('新账号类型').selectOption('kimi');
  await dialog.getByLabel('新账号名称').fill('待删除 ' + info.project.name);
  await dialog.getByRole('button', { name: '添加账号', exact: true }).click();
  const picker = dialog.getByLabel('当前 AI 账号');
  await expect(picker).not.toHaveValue('a');
  const id = (await picker.inputValue()).split('~')[1];
  await dialog.getByRole('button', { name: '删除 AI 账号', exact: true }).click();
  await expect(dialog.getByRole('group', { name: '确认删除账号' })).toBeVisible();
  await dialog.getByRole('button', { name: '保留账号', exact: true }).click();
  await expect(picker).toHaveValue('a~' + id);
  await dialog.getByRole('button', { name: '删除 AI 账号', exact: true }).click();
  await page.screenshot({ path: `.runtime/e2e/${info.project.name}-account-delete.png` });
  await dialog.getByRole('button', { name: '确认删除账号', exact: true }).click();
  await expect(picker).toHaveValue('a');
  await expect(dialog.getByText('待删除 ' + info.project.name, { exact: true })).toHaveCount(0);
  expect((await page.request.get('/api/connections/a/accounts/' + id + '/snapshot')).status()).toBe(404);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
  await page.reload();
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click();
  await page.getByRole('button', { name: '账号管理', exact: true }).click();
  await expect(dialog.getByLabel('当前 AI 账号').locator(`option[value="a~${id}"]`)).toHaveCount(0);
});

test('account indicators require authenticated provider state and recover from failed checks', async ({
  page,
}) => {
  await loginWorkbench(page);
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click();
  const dot = page.locator('.workspace-menu-trigger .status-dot');
  const summary = page.locator('.connection-summary');
  let state: any = { authenticated: false, authMode: 'chatgpt' };
  let failed = false;
  await page.route('**/providers/codex/account', (route) =>
    route.fulfill({
      status: failed ? 503 : 200,
      contentType: 'application/json',
      body: JSON.stringify(
        failed ? { error: { code: 'agent_unavailable', message: 'test unavailable' } } : state,
      ),
    }),
  );
  const refresh = async () => {
    await page.reload();
    await page.getByRole('button', { name: '工作区菜单', exact: true }).click();
  };
  await refresh();
  await expect(dot).toHaveAttribute('aria-label', '账号未登录');
  await expect(dot).toHaveClass(/unknown/);
  await expect(summary.locator('.status-dot')).toHaveClass(/unknown/);
  await expect(summary).toContainText('账号未登录');
  state = { authenticated: true, authMode: 'apikey' };
  await refresh();
  await expect(dot).toHaveAttribute('aria-label', '账号未登录');
  failed = true;
  await refresh();
  await expect(dot).toHaveAttribute('aria-label', '账号状态未确认');
  await expect(summary.locator('.status-dot')).toHaveClass(/unknown/);
  failed = false;
  state = { authenticated: true, authMode: 'chatgpt' };
  await refresh();
  await expect(dot).toHaveAttribute('aria-label', 'ChatGPT 已登录');
  await expect(dot).not.toHaveClass(/unknown/);
  await expect(summary.locator('.status-dot')).not.toHaveClass(/unknown/);
});
