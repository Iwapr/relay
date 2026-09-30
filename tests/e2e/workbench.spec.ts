import { test, expect, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { loginWorkbench as login } from './login.ts';
async function mobileView(page: Page, name: string) {
  if ((page.viewportSize()?.width ?? 0) < 761) {
    await page.getByLabel('切换视图', { exact: true }).click();
  }
  await page.locator('.mobile-nav').getByRole('button', { name, exact: true }).click();
}
async function filesTab(page: Page) {
  if ((page.viewportSize()?.width ?? 0) < 761) await mobileView(page, '文件');
}
async function chatTab(page: Page) {
  await mobileView(page, '对话');
}
async function historyDialog(page: Page, open: boolean) {
  const dialog = page.getByRole('dialog', { name: 'Codex 会话', exact: true });
  if (open && !(await dialog.count()))
    await page.getByRole('button', { name: 'Codex 会话', exact: true }).click();
  if (!open && (await dialog.count()))
    await dialog.getByRole('button', { name: '关闭 Codex 会话', exact: true }).click();
}
async function currentConversation(page: Page) {
  return (await page.locator('.chat-panel').getAttribute('data-conversation-id')) ?? '';
}
async function selectConversation(page: Page, id: string) {
  await historyDialog(page, false);
  await page.getByRole('button', { name: 'Codex 会话', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Codex 会话', exact: true })
    .locator(`[data-conversation-id="${id}"]`)
    .getByRole('button', { name: /^打开会话/ })
    .click();
}
async function expectHistoryTitle(page: Page, title: string) {
  await historyDialog(page, true);
  const dialog = page.getByRole('dialog', { name: 'Codex 会话', exact: true });
  await expect(dialog.getByRole('button', { name: `打开会话：${title}`, exact: true })).toHaveCount(1);
  await dialog.getByRole('button', { name: '关闭 Codex 会话', exact: true }).click();
}
// Display-only history tests need an explicitly persisted fixture conversation.
async function createFixtureConversation(page: Page) {
  const snapshot = await (await page.request.get('/api/connections/a/snapshot')).json();
  const root = await page.locator('.project-switch').getAttribute('title');
  const workspace = snapshot.workspaces.find((item: any) => item.canonicalRoot === root);
  const me = await (await page.request.get('/api/me')).json();
  const response = await page.request.post(`/api/connections/a/workspaces/${workspace.id}/conversations`, {
    headers: { 'x-csrf-token': me.csrfToken, origin: 'http://127.0.0.1:4399' },
    data: { title: '新对话' },
  });
  expect(response.ok()).toBe(true);
  const { conversation } = await response.json();
  await page.reload();
  await selectConversation(page, conversation.id);
  return conversation.id as string;
}

async function openFolder(page: Page, path: string) {
  await filesTab(page);
  await page.getByRole('button', { name: '打开远程文件夹', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: '打开远程文件夹' });
  await expect(dialog.getByLabel('远程目录路径')).toHaveValue(/.+/);
  await dialog.getByLabel('远程目录路径').fill(path);
  await dialog.getByRole('button', { name: '前往', exact: true }).click();
  await expect(dialog.getByLabel('远程目录路径')).toHaveValue(path);
  await expect(dialog.locator('.folder-list')).toHaveAttribute('aria-busy', 'false');
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await dialog.getByRole('button', { name: '打开文件夹', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.project-switch')).toHaveAttribute('title', path);
}
async function openFile(page: Page, name: string) {
  await filesTab(page);
  await page.locator('.file-list').getByRole('button', { name, exact: true }).click();
}

test('file watches follow visible panels and release when the task page hides them', async ({
  page,
}, info) => {
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  const root = fixture.tasks[info.project.name];
  await writeFile(root + '/watch-preview.md', '# Watch before');
  await login(page);
  await openFolder(page, root);
  const status = async () =>
    (await (await page.request.get('/api/connections/a/status')).json()).diagnostics.fileWatches;
  await expect.poll(async () => (await status()).directories).toBe(1);
  expect((await status()).projects).toBe(0);
  await openFile(page, 'watch-preview.md');
  await expect.poll(async () => (await status()).files).toBe(1);
  await expect(page.getByRole('heading', { name: 'Watch before', exact: true })).toBeVisible();
  await writeFile(root + '/watch-preview.md', '# Watch after');
  await expect(page.getByRole('button', { name: '文件有新版本，点击刷新 · 保留阅读位置' })).toBeVisible();
  await chatTab(page);
  await expect.poll(async () => (await status()).files).toBe(0);
  await expect.poll(async () => (await status()).directories).toBe(info.project.name === 'mobile' ? 0 : 1);
  await mobileView(page, '任务');
  await expect.poll(async () => (await status()).viewLeases).toBe(0);
  expect((await status()).projects).toBe(0);
  await writeFile(root + '/watch-preview.md', '# Changed while hidden');
  await mobileView(page, '预览');
  await expect.poll(async () => (await status()).files).toBe(1);
  await expect(page.getByRole('button', { name: '文件有新版本，点击刷新 · 保留阅读位置' })).toBeVisible();
  await page.getByRole('button', { name: '文件有新版本，点击刷新 · 保留阅读位置' }).click();
  await expect(page.getByRole('heading', { name: 'Changed while hidden' })).toBeVisible();
  await mobileView(page, '任务');
  await expect.poll(async () => (await status()).viewLeases).toBe(0);
});

test('PDF citation and reference links navigate to named and explicit destinations', async ({ page }) => {
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  await login(page);
  await openFolder(page, fixture.primary);
  await openFile(page, 'paper.pdf');
  const firstPage = page.locator('.pdfViewer .page[data-page-number="1"]');
  const citation = firstPage.getByRole('link', { name: 'Page one - selectable text', exact: true });
  await expect(citation).toBeVisible();
  const width = await firstPage.evaluate((el) => el.getBoundingClientRect().width);
  const originalUrl = page.url();
  await citation.click();
  await expect(page.getByLabel('页码', { exact: true })).toHaveValue('2');
  const reference = page
    .locator('.page[data-page-number="2"]')
    .getByRole('link', { name: 'Second page', exact: true });
  await expect(reference).toBeVisible();
  expect(await firstPage.evaluate((el) => el.getBoundingClientRect().width)).toBe(width);
  await reference.click();
  await expect(page.getByLabel('页码', { exact: true })).toHaveValue('1');
  expect(page.url()).toBe(originalUrl);
  const external = firstPage.locator('.annotationLayer a[href="https://example.com/"]');
  await expect(external).toHaveAttribute('target', '_blank');
  await expect(external).toHaveAttribute('rel', /noopener/);
  await expect(page.locator('.pdf-view [role="alert"]')).toHaveCount(0);
});

test('Chinese LaTeX PDF loads bundled font maps and renders Chinese text', async ({ page }) => {
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  await writeFile(fixture.primary + '/chinese.pdf', await readFile('tests/fixtures/pdf/cjk.pdf'));
  const warnings: string[] = [];
  const maps: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'warning') warnings.push(message.text());
  });
  page.on('response', (response) => {
    if (response.url().includes('/pdfjs/cmaps/') && response.ok()) maps.push(response.url());
  });
  await login(page);
  await openFolder(page, fixture.primary);
  await openFile(page, 'chinese.pdf');
  await expect(page.locator('.pdfViewer canvas').first()).toBeVisible();
  await expect(page.locator('.pdfViewer .textLayer')).toContainText('中文讲义预览测试');
  await expect(page.locator('.pdfViewer .textLayer')).toContainText('椭圆曲线与类群');
  await expect.poll(() => maps.length).toBeGreaterThan(0);
  await expect(page.locator('.pdf-view [role="alert"]')).toHaveCount(0);
  expect(warnings.filter((w) => /font|cMap|standardFont|Ensure that/i.test(w))).toEqual([]);
});

test('HTML previews render styles, offer source, and isolate active content', async ({ page }) => {
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  const html = `<!doctype html><html><head><style>h1 { color: rgb(12, 34, 56); }</style></head>
    <body><h1>HTML 页面测试</h1><script>parent.__htmlPreviewExecuted = true</script>
    <img src="https://untrusted.invalid/track.png">
    <a href="https://untrusted.invalid/leave">外部链接</a></body></html>`;
  await writeFile(fixture.primary + '/preview.html', html);
  const outbound: string[] = [];
  await page.route('https://untrusted.invalid/**', async (route) => {
    outbound.push(route.request().url());
    await route.fulfill({ status: 204 });
  });
  await login(page);
  await openFolder(page, fixture.primary);
  await openFile(page, 'preview.html');
  const frame = page.frameLocator('iframe[title="preview.html 页面预览"]');
  await expect(frame.getByRole('heading')).toHaveText('HTML 页面测试');
  await expect(frame.getByRole('heading')).toHaveCSS('color', 'rgb(12, 34, 56)');
  await expect(frame.locator('a')).not.toHaveAttribute('href');
  expect(await page.evaluate(() => Reflect.get(window, '__htmlPreviewExecuted'))).toBeUndefined();
  expect(outbound).toEqual([]);
  await page.getByRole('button', { name: '源代码', exact: true }).click();
  await expect(page.locator('.html-preview-source')).toContainText('<h1>HTML 页面测试</h1>');
  await expect(page.locator('.html-preview iframe')).toHaveCount(0);
  await page.getByRole('button', { name: '页面预览', exact: true }).click();
  await expect(frame.getByRole('heading')).toBeVisible();
  await expect(page.locator('.html-preview iframe')).toHaveAttribute('sandbox', '');
});

test('all VS Code history opens its original project and keeps one toolbar, scrolling messages and a bottom composer', async ({
  page,
}, info) => {
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  const shared = fixture.shared[info.project.name];
  await login(page);
  await openFolder(page, fixture.primary);
  await chatTab(page);
  // Long history is explicit browser-fixture data, used to exercise independent scrolling.
  await page.route('**/conversations/*', async (route) => {
    if (
      route.request().method() !== 'GET' ||
      !/\/conversations\/[^/?]+$/.test(route.request().url().split('?')[0])
    ) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const body = await response.json();
    if (body.nativeHistory) {
      body.nativeHistory.turns = Array.from({ length: 24 }, (_, i) => ({
        id: `layout-fixture-${i}`,
        state: 'completed',
        userText: `测试问题 ${i + 1}`,
        messages: [
          {
            id: `layout-answer-${i}`,
            kind: 'assistant',
            text: '这是一段用于验证阅读区域高度和滚动行为的浏览器测试记录。'.repeat(12),
          },
        ],
      }));
    }
    await route.fulfill({ response, json: body });
  });
  await page.getByRole('button', { name: 'Codex 会话', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Codex 会话', exact: true });
  await expect(dialog.getByRole('button', { name: '当前项目', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await dialog.getByRole('button', { name: '全部项目', exact: true }).click();
  const target = dialog
    .locator('.shared-session-list li')
    .filter({ hasText: shared.path })
    .filter({ has: page.getByRole('button', { name: '打开会话：IDE 中的共享测试会话', exact: true }) });
  await expect(dialog.getByLabel('刷新 Codex 会话', { exact: true })).toBeEnabled();
  for (let i = 0; i < 8 && (await target.count()) === 0; i++) {
    const more = dialog.getByRole('button', { name: '加载更多会话', exact: true });
    await expect(more).toBeVisible();
    await more.click();
    await expect(dialog.getByLabel('刷新 Codex 会话', { exact: true })).toBeEnabled();
  }
  await target.getByRole('button', { name: '打开会话：IDE 中的共享测试会话', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.project-switch')).toHaveAttribute('title', shared.path);
  await expect(page.locator('.native-turn')).toHaveCount(24);
  const id = await currentConversation(page);
  const detail = await (await page.request.get(`/api/connections/a/conversations/${id}`)).json();
  expect(detail.conversation.providerSessionId).toBe(shared.threadId);
  const distanceFromBottom = () =>
    page.locator('.chat-scroll').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  await expect.poll(distanceFromBottom).toBeLessThan(3);
  // Simulate a fresh tab: only persistent browser preferences remain.
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await expect(page.locator('.native-turn')).toHaveCount(24);
  expect(await currentConversation(page)).toBe(id);
  await expect.poll(distanceFromBottom).toBeLessThan(3);

  const geometry = await page.evaluate(() => {
    const rect = (selector: string) => {
      const r = document.querySelector(selector)!.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height };
    };
    const scroller = document.querySelector('.chat-scroll')!;
    return {
      header: rect('.topbar'),
      history: rect('.chat-scroll'),
      composer: rect('.composer-area'),
      input: rect('textarea[aria-label="任务指令"]'),
      viewport: innerHeight,
      scrollable: scroller.scrollHeight > scroller.clientHeight,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
    };
  });
  expect(geometry.header.height).toBeLessThanOrEqual(56);
  expect(Math.abs(geometry.history.top - geometry.header.bottom)).toBeLessThanOrEqual(1);
  expect(geometry.history.height).toBeGreaterThan(500);
  expect(geometry.composer.bottom).toBeGreaterThanOrEqual(geometry.viewport - 1);
  expect(geometry.input.bottom).toBeLessThan(geometry.viewport);
  expect(geometry.scrollable).toBe(true);
  expect(geometry.horizontalOverflow).toBe(false);
  await page.locator('.chat-scroll').evaluate((node) => {
    node.scrollTop = 0;
  });
  const afterScroll = await page.locator('.composer-area').boundingBox();
  expect(afterScroll!.y).toBeCloseTo(geometry.composer.top, 0);
  await page.screenshot({ path: `.runtime/e2e/${info.project.name}-compact-chat.png` });
});

test('shared Codex session picker paginates, shows IDE history and resumes the same thread after reload', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  const shared = fixture.shared[info.project.name];
  await login(page);
  await openFolder(page, shared.path);
  await chatTab(page);
  await page.getByRole('button', { name: 'Codex 会话', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Codex 会话', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '当前项目', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: '打开会话：IDE 中的共享测试会话', exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole('button', { name: '打开会话：更早的共享测试会话', exact: true })).toHaveCount(
    0,
  );
  await dialog.getByRole('button', { name: '加载更多会话', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: '打开会话：更早的共享测试会话', exact: true }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: '打开会话：IDE 中的共享测试会话', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.native-turn .user-message')).toContainText('这是在 IDE 中写入的测试提问。');
  await expect(page.locator('.native-turn .assistant-message')).toContainText('这是 IDE 原有的测试回复。');
  const conversationId = await currentConversation(page);
  let detail = await (await page.request.get(`/api/connections/a/conversations/${conversationId}`)).json();
  expect(detail.conversation.providerSessionId).toBe(shared.threadId);
  expect(detail.runs).toHaveLength(0);

  await historyDialog(page, true);
  await expect(page.getByRole('button', { name: '刷新会话记录', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '刷新 Codex 会话', exact: true }).click();
  await historyDialog(page, false);
  await expect(page.locator('.native-turn')).toHaveCount(1);
  await page.getByLabel('任务指令', { exact: true }).fill('继续同一条共享会话的浏览器测试');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(
    page.locator('.assistant-message').filter({ hasText: '这是仅用于浏览器自动化验收的测试响应。' }),
  ).toBeVisible();
  await expect
    .poll(async () => {
      detail = await (await page.request.get(`/api/connections/a/conversations/${conversationId}`)).json();
      return detail.runs[0]?.state;
    })
    .toBe('completed');
  expect(detail.conversation.providerSessionId).toBe(shared.threadId);
  expect(detail.runs).toHaveLength(1);

  await page.reload();
  await expect(page.getByLabel('工作区菜单', { exact: true })).toBeVisible();
  await chatTab(page);
  expect(await currentConversation(page)).toBe(conversationId);
  await expect(page.locator('.native-turn .assistant-message')).toContainText('这是 IDE 原有的测试回复。');
  await expect(
    page.locator('.assistant-message').filter({ hasText: '这是仅用于浏览器自动化验收的测试响应。' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Codex 会话', exact: true }).click();
  await dialog.getByRole('button', { name: '当前项目', exact: true }).click();
  await dialog.getByRole('button', { name: '打开会话：IDE 中的共享测试会话', exact: true }).click();
  expect(await currentConversation(page)).toBe(conversationId);
  const snapshot = await (await page.request.get('/api/connections/a/snapshot')).json();
  expect(
    snapshot.conversations.filter(
      (conversation: { providerSessionId: string }) => conversation.providerSessionId === shared.threadId,
    ),
  ).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});

test('shared history refreshes an external turn without declaring unknown execution interrupted or taking control', async ({
  page,
}, info) => {
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  const shared = fixture.shared[info.project.name];
  await login(page);
  await openFolder(page, shared.path);
  await chatTab(page);
  let state: 'unknown' | 'running' | 'completed' = 'unknown';
  let historyReads = 0;
  const mutations: string[] = [];
  page.on('request', (request) => {
    if (/\/(?:runs|cancel|steer|answer)(?:[/?]|$)/.test(request.url()) && request.method() !== 'GET')
      mutations.push(request.url());
  });
  await page.route('**/conversations/*', async (route) => {
    if (
      route.request().method() !== 'GET' ||
      !/\/conversations\/[^/?]+$/.test(route.request().url().split('?')[0])
    ) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const body = await response.json();
    if (body.nativeHistory?.id === shared.threadId) {
      historyReads++;
      body.nativeHistory.turns = [
        {
          id: 'external-turn-fixture',
          state,
          userText: '其他设备上的当前任务',
          messages: [{ id: 'external-message-fixture', kind: 'assistant', text: `外部记录：${state}` }],
        },
      ];
    }
    await route.fulfill({ response, json: body });
  });
  await page.getByRole('button', { name: 'Codex 会话', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Codex 会话', exact: true });
  await dialog.getByRole('button', { name: '当前项目', exact: true }).click();
  await dialog.getByRole('button', { name: '打开会话：IDE 中的共享测试会话', exact: true }).click();
  const reply = page.locator('.native-turn .reply-panel');
  await expect(reply).toHaveAttribute('data-state', 'unknown');
  await expect(reply).toContainText('运行状态待确认');
  await expect(reply).not.toContainText('执行已中断');
  await expect(reply).not.toContainText('另一端正在执行');
  await expect(reply.locator('..').locator('..').getByRole('button', { name: '从这里分支' })).toBeDisabled();
  const initialReads = historyReads;
  state = 'running';
  await expect(reply).toHaveAttribute('data-state', 'running');
  await expect(reply).toContainText('另一端正在执行');
  await expect(reply).toContainText('外部记录：running');
  expect(historyReads).toBeGreaterThan(initialReads);
  state = 'completed';
  await expect(reply).toHaveAttribute('data-state', 'completed');
  await expect(reply).toContainText('外部记录：completed');
  expect(mutations).toEqual([]);
});

test('background shared history cannot replace a live Relay reply or duplicate its active turn', async ({
  page,
}, info) => {
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  await login(page);
  await openFolder(page, fixture.tasks[info.project.name]);
  await chatTab(page);
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await page.getByLabel('任务指令', { exact: true }).fill('异步问题测试');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  const reply = page.locator('.reply-panel').filter({ hasText: '选择方案' });
  await expect(reply).toHaveAttribute('data-state', 'running');
  const conversationId = await currentConversation(page);
  try {
    await page.route(`**/conversations/${conversationId}?view=native*`, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const local = await (
        await page.request.get(`/api/connections/a/conversations/${conversationId}?view=page`)
      ).json();
      const run = local.runs.at(-1);
      body.nativeHistory.turns = [
        {
          id: run.providerTurnId,
          state: 'interrupted',
          userText: '重复的原生当前轮次',
          messages: [],
        },
        {
          id: 'refresh-proof-fixture',
          state: 'completed',
          userText: '后台历史刷新已到达',
          messages: [],
        },
      ];
      await route.fulfill({ response, json: body });
    });
    // Wait for the actual periodic request while SSE still owns the running turn.
    await expect(page.locator('.native-turn')).toHaveCount(1);
    await expect(page.locator('.native-turn')).toContainText('后台历史刷新已到达');
    await expect(reply).toHaveAttribute('data-state', 'running');
    await expect(reply).toContainText('选择方案');
    await expect(page.locator('.chat-scroll')).not.toContainText('陈旧历史内容不应覆盖实时消息');
    await expect(page.locator('.chat-scroll')).not.toContainText('重复的原生当前轮次');
  } finally {
    await page.unroute(`**/conversations/${conversationId}?view=native*`);
    await page.getByRole('button', { name: '取消任务', exact: true }).click();
    await expect(reply).toHaveAttribute('data-state', 'cancelled');
  }
});

test('folder picker navigates nested Chinese and spaced directories by clicking, goes up, and opens selection', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  await login(page);
  await filesTab(page);
  await page.getByRole('button', { name: '打开远程文件夹', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: '打开远程文件夹' });
  const path = dialog.getByLabel('远程目录路径');
  const folders = dialog.locator('.folder-list');
  await dialog.locator('.folder-roots').getByRole('button', { name: fixture.projects, exact: true }).click();
  await expect(path).toHaveValue(fixture.projects);
  await folders.getByRole('button', { name: '目录 点击测试', exact: true }).click();
  await expect(path).toHaveValue(fixture.browsing);
  await expect(folders.getByRole('button', { name: '普通 文件.txt', exact: true })).toHaveCount(0);
  await folders.getByRole('button', { name: '嵌套 资料', exact: true }).click();
  await expect(path).toHaveValue(fixture.nested);
  await expect(folders.getByRole('button')).toHaveText(['上一级']);
  await folders.getByRole('button', { name: '上一级', exact: true }).click();
  await expect(path).toHaveValue(fixture.browsing);
  await folders.getByRole('button', { name: '上一级', exact: true }).click();
  await expect(path).toHaveValue(fixture.projects);
  await expect(folders.getByRole('button', { name: '普通 文件.txt', exact: true })).toHaveCount(0);
  await folders.getByRole('button', { name: '目录 点击测试', exact: true }).click();
  await expect(path).toHaveValue(fixture.browsing);
  await folders.getByRole('button', { name: '嵌套 资料', exact: true }).click();
  await expect(path).toHaveValue(fixture.nested);
  await expect(dialog.locator('.error')).toHaveCount(0);
  await dialog.getByRole('button', { name: '打开文件夹', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.project-switch')).toHaveAttribute('title', fixture.nested);
  await openFile(page, 'README.md');
  await expect(page.locator('article.document h1')).toHaveText('点击目录打开成功');
  expect(errors).toEqual([]);
});

test('real remote directory, Markdown safety, math, relative image, and paginated PDF', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const outbound: string[] = [];
  const ranges: string[] = [];
  page.on('response', (response) => {
    if (response.url().includes('/file?') && response.status() === 206)
      ranges.push(response.headers()['content-range'] ?? '');
  });
  page.on('request', (request) => {
    if (request.url().includes('untrusted.invalid')) outbound.push(request.url());
  });
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  await page.goto('/');
  await page.screenshot({ path: `.runtime/e2e/${info.project.name}-login.png`, fullPage: true });
  await login(page);
  await openFolder(page, fixture.primary);
  await openFile(page, 'README.md');
  await expect(page.locator('.workspace-grid > :is(.file-panel, .chat-panel, .preview-panel)')).toHaveCount(
    3,
  );
  await expect(page.locator('article.document h1')).toHaveText('移动文档工作台');
  await expect(page.locator('article.document .katex')).toHaveCount(2);
  await expect(page.getByText('[图片未自动加载：外部追踪]')).toBeVisible();
  await expect(page.locator('article.document img')).toHaveCount(1);
  await expect
    .poll(() =>
      page
        .locator('article.document img')
        .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
    )
    .toBe(true);
  expect(outbound).toEqual([]);
  expect(await page.evaluate(() => Reflect.get(window, '__relayXss'))).toBeUndefined();
  expect(await page.locator('article.document script').count()).toBe(0);
  await page.screenshot({ path: `.runtime/e2e/${info.project.name}-markdown.png`, fullPage: true });
  await page.getByRole('button', { name: '打开说明', exact: true }).click();
  await expect(page.locator('.code-preview')).toContainText('远端中文文件');
  await writeFile(fixture.primary + '/notes.txt', `远端中文文件 · ${info.project.name} 外部更新`);
  await expect(page.locator('.version-banner')).toBeVisible();
  await page.locator('.version-banner').click();
  await expect(page.locator('.code-preview')).toContainText(`${info.project.name} 外部更新`);
  await openFile(page, 'paper.pdf');
  await expect(page.locator('.pdfViewer .page[data-page-number="1"] canvas')).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator('.pdfViewer .page[data-page-number="1"] canvas')
        .evaluate((c: HTMLCanvasElement) => c.width),
    )
    .toBeGreaterThan(100);
  await expect(page.locator('.page[data-page-number="1"] .textLayer')).toContainText(
    'Relay document preview',
  );
  await page.locator('.pdf-scroll').evaluate((el) => {
    el.scrollTop = el.querySelector<HTMLElement>('[data-page-number="2"]')!.offsetTop;
  });
  await expect(page.getByLabel('页码', { exact: true })).toHaveValue('2');
  await expect(page.locator('.page[data-page-number="2"] .textLayer')).toContainText('Second page');
  await page.getByRole('button', { name: '全屏', exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  await page.getByRole('button', { name: '退出全屏', exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
  await expect.poll(() => ranges.length).toBeGreaterThan(0);
  expect(ranges.every((range) => /^bytes \d+-\d+\/\d+$/.test(range))).toBe(true);
  await expect(page.getByRole('button', { name: '引用选中文本', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '放大', exact: true }).click();
  await page.screenshot({ path: `.runtime/e2e/${info.project.name}-pdf.png`, fullPage: true });
  await openFile(page, 'README.md');
  await openFile(page, 'paper.pdf');
  await expect(page.getByLabel('页码', { exact: true })).toHaveValue('2');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});

test('without secure-context randomUUID, retry creates one task, approval survives reload and cancel works', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Reproduce the crypto API exposed by browsers on private LAN HTTP origins.
  await page.addInitScript(() => {
    Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined, configurable: true });
  });
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  await login(page);
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe('undefined');
  await openFolder(page, fixture.tasks[info.project.name]);
  await chatTab(page);
  await expect(page.getByLabel('模型', { exact: true })).toHaveValue('fixture-model');
  await page.getByLabel('推理强度', { exact: true }).selectOption('medium');
  const text = `${info.project.name} 审批验收 ${Date.now()}`;
  const runs: string[] = [];
  const requestIds: string[] = [];
  page.on('request', (req) => {
    if (req.method() === 'POST') {
      const clientRequestId = req.postDataJSON()?.clientRequestId;
      if (clientRequestId) requestIds.push(clientRequestId);
    }
    if (req.method() === 'POST' && /\/conversations\/[^/]+\/runs$/.test(req.url())) runs.push(req.url());
  });
  let dropped = false;
  await page.route('**/conversations/*/runs', async (route) => {
    if (dropped) {
      await route.continue();
      return;
    }
    dropped = true;
    const received = await route.fetch();
    expect(received.ok()).toBe(true);
    await route.abort('failed');
  });
  await page.getByLabel('任务指令', { exact: true }).fill(text);
  await page.getByLabel('任务指令', { exact: true }).press('Shift+Enter');
  expect(runs).toHaveLength(0);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.composer-area [role=alert]')).toContainText('未自动重发');
  await expect(page.getByRole('button', { name: '允许本次', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.getByLabel('任务指令', { exact: true })).toHaveValue('');
  expect(runs).toHaveLength(2);
  const snapshot = await (await page.request.get('/api/connections/a/snapshot')).json();
  expect(snapshot.runs.filter((r: { text: string }) => r.text === text)).toHaveLength(1);
  await page.screenshot({ path: `.runtime/e2e/${info.project.name}-approval.png`, fullPage: true });
  await page.getByLabel('工作区菜单', { exact: true }).click();
  await page.getByLabel('服务器和 Linux 用户').selectOption('b');
  await expect(page.getByText('Codex · apikey', { exact: true })).toBeVisible();
  await page.getByLabel('工作区菜单', { exact: true }).click();
  await openFolder(page, fixture.primary);
  await openFile(page, 'README.md');
  await expect(page.locator('.workspace-grid > :is(.file-panel, .chat-panel, .preview-panel)')).toHaveCount(
    3,
  );
  await expect(page.locator('article.document h1')).toHaveText('移动文档工作台');
  await chatTab(page);
  await page.getByLabel('任务指令', { exact: true }).fill('API Key 模式不能提交');
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeDisabled();
  await page.getByLabel('工作区菜单', { exact: true }).click();
  await page.getByRole('button', { name: '账号管理', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('apikey');
  await expect(page.getByRole('dialog')).toContainText('暂无额度数据');
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByLabel('工作区菜单', { exact: true }).click();
  await page.getByLabel('服务器和 Linux 用户').selectOption('a');
  await expect(page.getByText('Codex · ChatGPT 已登录', { exact: true })).toBeVisible();
  await page.getByLabel('工作区菜单', { exact: true }).click();
  await chatTab(page);
  await expect(page.getByRole('button', { name: '允许本次', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '允许本次', exact: true })).toBeVisible();
  expect(runs).toHaveLength(2);
  await page.getByRole('button', { name: '允许本次', exact: true }).click();
  await expect(page.locator('.assistant-message').last()).toContainText('测试审批已收到');
  await expect(page.locator('.run-status.completed').last()).toBeVisible();
  await page.getByLabel('任务指令', { exact: true }).fill(`${info.project.name} 审批等待取消`);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.getByRole('button', { name: '允许本次', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '取消任务', exact: true }).click();
  await expect(page.locator('.run-status.cancelled').last()).toBeVisible();
  expect(requestIds).toHaveLength(5);
  expect(
    requestIds.every((id) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id),
    ),
  ).toBe(true);
  expect(requestIds[0]).toBe(requestIds[1]);
  expect(new Set(requestIds).size).toBe(4);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: `.runtime/e2e/${info.project.name}-chat.png`, fullPage: true });
});

test('fork and confirmed rollback restore actual files on desktop and mobile', async ({ page }, info) => {
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  const folder = fixture.tasks[info.project.name];
  await writeFile(`${folder}/rollback.txt`, 'original file');
  await login(page);
  await openFolder(page, folder);
  await chatTab(page);
  await expect(page.getByLabel('模型', { exact: true }).locator('option')).not.toContainText(['选择模型']);
  await page.getByLabel('任务指令', { exact: true }).fill('文件回滚测试');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  const rollback = page
    .locator('.turn')
    .filter({ has: page.locator('.user-message', { hasText: /^文件回滚测试/ }) })
    .getByRole('button', { name: '回滚本轮（含文件）', exact: true });
  await expect(rollback).toBeEnabled();
  expect(await readFile(`${folder}/rollback.txt`, 'utf8')).toBe('changed by fixture');
  const originalConversation = await currentConversation(page);
  await rollback.click();
  const dialog = page.getByRole('dialog', { name: '回滚本轮对话和文件' });
  await expect(dialog).toContainText('rollback.txt');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect(await readFile(`${folder}/rollback.txt`, 'utf8')).toBe('changed by fixture');
  await rollback.click();
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: `.runtime/e2e/${info.project.name}-rollback.png`, fullPage: true });
  await dialog.getByRole('button', { name: '确认回滚文件和对话', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByLabel('任务指令', { exact: true })).toHaveValue('文件回滚测试');
  expect(await readFile(`${folder}/rollback.txt`, 'utf8')).toBe('original file');
  expect(await currentConversation(page)).not.toBe(originalConversation);
  // Original conversation remains selectable, and ordinary fork keeps current files.
  await selectConversation(page, originalConversation);
  await historyDialog(page, false);
  const fork = page.getByRole('button', { name: '从这里分支', exact: true }).last();
  await expect(fork).toBeEnabled();
  await fork.click();
  await expect.poll(async () => currentConversation(page)).not.toBe(originalConversation);
  expect(await readFile(`${folder}/rollback.txt`, 'utf8')).toBe('original file');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('clean new sessions keep controls in the composer and task center groups repeated questions', async ({
  page,
}, info) => {
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  await login(page);
  await openFolder(page, fixture.tasks[info.project.name]);
  await chatTab(page);
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  // The intentionally empty placeholder may have zero height. Check the
  // rendered empty state and the actual visible conversation region separately.
  await expect(page.locator('.chat-empty')).toBeAttached();
  await expect(page.locator('.chat-scroll')).toBeVisible();
  await expect(page.locator('.chat-scroll')).toHaveText('');
  await expect(page.getByText('帮我了解这个项目')).toHaveCount(0);
  const composer = page.locator('.composer');
  await expect(composer.getByLabel('模型', { exact: true })).toBeVisible();
  await expect(composer.getByLabel('推理强度', { exact: true })).toBeVisible();
  await expect(composer.getByLabel('权限模式', { exact: true })).toBeVisible();
  await expect(page.locator('.topbar select[aria-label="模型"]')).toHaveCount(0);
  await composer.getByLabel('推理强度', { exact: true }).selectOption('medium');
  await composer.getByLabel('权限模式', { exact: true }).selectOption('workspace-write');
  await page.screenshot({ path: `.runtime/e2e/${info.project.name}-clean-composer.png` });
  expect(await currentConversation(page)).toBe('');
  for (const [index, text] of ['会话分组第一问', '会话分组第二问'].entries()) {
    await page.getByLabel('任务指令', { exact: true }).fill(text);
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    await expect(page.locator('.run-status.completed')).toHaveCount(index + 1);
  }
  const id = await currentConversation(page);
  const detail = await (await page.request.get(`/api/connections/a/conversations/${id}`)).json();
  expect(detail.runs).toHaveLength(2);
  expect(
    detail.runs.every(
      (run: any) => run.reasoningEffort === 'medium' && run.permissionMode === 'workspace-write',
    ),
  ).toBe(true);
  await mobileView(page, '任务');
  const card = page.locator(`[data-session-id="${id}"]`);
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('会话分组第一问');
  await expect(card).toContainText('会话分组第二问');
  await page.screenshot({ path: `.runtime/e2e/${info.project.name}-session-tasks.png` });
  await card.getByRole('button', { name: '打开', exact: true }).click();
  await expect(page.locator('.user-message')).toHaveCount(2);
  expect(await currentConversation(page)).toBe(id);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('project permission survives reconnect and tab recreation without leaking to other projects', async ({
  page,
  context,
}, info) => {
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  await page.addInitScript(() => {
    const Original = window.EventSource;
    (window as any).__streams = [];
    window.EventSource = class extends Original {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        (window as any).__streams.push(this);
      }
    };
  });
  await login(page);
  await openFolder(page, fixture.tasks[info.project.name]);
  await chatTab(page);
  await page.getByLabel('权限模式', { exact: true }).selectOption('workspace-write');
  await page.getByLabel('推理强度', { exact: true }).selectOption('medium');
  const reconnect = page.waitForResponse(
    (r) => new URL(r.url()).pathname.endsWith('/snapshot') && r.request().method() === 'GET',
  );
  await page.evaluate(() => {
    const stream = (window as any).__streams.at(-1) as EventSource;
    stream.close();
    stream.dispatchEvent(new Event('error'));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });
  await reconnect;
  await expect(page.getByLabel('权限模式', { exact: true })).toHaveValue('workspace-write');
  await expect(page.locator('.project-switch')).toHaveAttribute('title', fixture.tasks[info.project.name]);
  const reopened = await context.newPage();
  await page.close();
  await reopened.goto('/');
  await expect(reopened.getByLabel('模型', { exact: true })).toHaveValue('fixture-model');
  await expect(reopened.locator('.project-switch')).toHaveAttribute(
    'title',
    fixture.tasks[info.project.name],
  );
  await expect(reopened.getByLabel('权限模式', { exact: true })).toHaveValue('workspace-write');
  await expect(reopened.getByLabel('推理强度', { exact: true })).toHaveValue('medium');
  await openFolder(reopened, fixture.secondary);
  await chatTab(reopened);
  await expect(reopened.getByLabel('权限模式', { exact: true })).toHaveValue('read-only');
  await openFolder(reopened, fixture.tasks[info.project.name]);
  await chatTab(reopened);
  await expect(reopened.getByLabel('权限模式', { exact: true })).toHaveValue('workspace-write');
  await reopened.getByLabel('任务指令', { exact: true }).fill('恢复后的权限验证');
  const submitted = reopened.waitForRequest(
    (r) => /\/conversations\/[^/]+\/runs$/.test(r.url()) && r.method() === 'POST',
  );
  await reopened.getByRole('button', { name: '发送任务', exact: true }).click();
  expect((await submitted).postDataJSON().permissionMode).toBe('workspace-write');
  await expect(reopened.locator('.run-status.completed').last()).toBeVisible();
});

test('reply cards distinguish running, waiting, complete, failed and cancelled states without color alone', async ({
  page,
}, info) => {
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  await login(page);
  await openFolder(page, fixture.tasks[info.project.name]);
  await chatTab(page);
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  // The intentionally empty placeholder may have zero height. Check the
  // rendered empty state and the actual visible conversation region separately.
  await expect(page.locator('.chat-empty')).toBeAttached();
  await expect(page.locator('.chat-scroll')).toBeVisible();
  const id = await createFixtureConversation(page);
  const states = ['running', 'waiting_approval', 'completed', 'failed', 'cancelled', 'uncertain'];
  // Display-only fixture history; no task or native session is executed.
  await page.route(`**/conversations/${id}?view=page`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.nativeHistory = undefined;
    body.runs = states.map((state, index) => ({
      id: `status-fixture-${index}`,
      workspaceId: body.conversation.workspaceId,
      conversationId: id,
      state,
      text: `状态展示 ${index + 1}`,
      model: 'fixture-model',
      reasoningEffort: null,
      permissionMode: 'read-only',
      providerTurnId: null,
      error: null,
      createdAt: `2026-01-01T00:00:0${index}Z`,
      updatedAt: `2026-01-01T00:00:0${index}Z`,
    }));
    body.messages = body.runs.map((run: any) => ({
      id: run.id + '-answer',
      runId: run.id,
      conversationId: id,
      workspaceId: run.workspaceId,
      kind: 'assistant',
      text: '这是用于验证回复状态的测试内容。',
      payload: {},
      createdAt: run.createdAt,
    }));
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  await expect(page.locator('.reply-panel')).toHaveCount(states.length);
  const colors = [];
  for (const state of states) {
    const panel = page.locator(`.reply-${state}`);
    await expect(panel.getByRole('status')).toContainText(/正在执行|等待确认|已完成|失败|已取消|结果待核实/);
    await expect(panel.locator('.assistant-message')).toContainText('测试内容');
    const style = await panel.evaluate((node) => ({
      color: getComputedStyle(node).backgroundColor,
      border: getComputedStyle(node).borderLeftWidth,
    }));
    expect(style.border).toBe('4px');
    colors.push(style.color);
  }
  expect(new Set(colors.slice(0, 5)).size).toBe(5);
  await expect(page.locator('.reply-waiting_approval')).toContainText('等待你确认操作后继续');
  await expect(page.locator('.reply-uncertain')).toContainText('执行结果尚未确认');
  await page.locator('.chat-scroll').evaluate((node) => {
    node.scrollTop = 0;
  });
  await page.screenshot({ path: `.runtime/e2e/${info.project.name}-reply-states.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('full access persists and async questions can be answered during a running task', async ({
  page,
}, info) => {
  // Reproduce already persisted copies produced by old history recovery.
  await page.route('**/conversations/*', async (route) => {
    if (
      route.request().method() !== 'GET' ||
      !/\/conversations\/[^/?]+$/.test(route.request().url().split('?')[0])
    ) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const body = await response.json();
    const live = body.messages?.find((m: any) => m.payload?.questions?.length);
    if (live) {
      for (const id of ['item-3', 'item-12'])
        body.messages.push({
          ...live,
          id: live.runId + ':' + id,
          createdAt: body.runs[0].createdAt,
          payload: { questions: live.payload.questions },
        });
    }
    await route.fulfill({ response, json: body });
  });

  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  await login(page);
  await openFolder(page, fixture.tasks[info.project.name]);
  await chatTab(page);
  await page.getByLabel('权限模式', { exact: true }).selectOption('full-access');
  await page.reload();
  await expect(page.getByLabel('权限模式', { exact: true })).toHaveValue('full-access');
  const submitted = page.waitForRequest((r) => r.method() === 'POST' && /\/runs$/.test(r.url()));
  await page.getByLabel('任务指令', { exact: true }).fill('异步问题测试');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  expect((await submitted).postDataJSON().permissionMode).toBe('full-access');
  const card = page.getByLabel('回答 Codex 的问题', { exact: true });
  await expect(card).toBeVisible();
  // The running task adds a stop button; all controls must still share one row.
  const originalViewport = page.viewportSize()!;
  for (const width of [320, 375, 390, originalViewport.width]) {
    await page.setViewportSize({ width, height: originalViewport.height });
    const controls = page.locator('.composer-bottom select, .composer-bottom .actions button');
    const boxes = await controls.evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, center: rect.top + rect.height / 2 };
      }),
    );
    expect(boxes).toHaveLength(6);
    expect(Math.max(...boxes.map((b) => b.center)) - Math.min(...boxes.map((b) => b.center))).toBeLessThan(3);
    for (let i = 1; i < boxes.length; i++) expect(boxes[i].left).toBeGreaterThanOrEqual(boxes[i - 1].right);
    expect(boxes.at(-1)!.right).toBeLessThanOrEqual(width);
  }
  await expect(card.getByRole('button', { name: '提交回答', exact: true })).toBeDisabled();
  await card.getByRole('button', { name: '方案 B', exact: true }).click();
  await expect(card.getByRole('button', { name: '方案 B', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await card.getByLabel('自定义回答：选择方案').fill('方案 B，并保留原文件');
  await page.reload();
  await expect(card).toHaveCount(1);
  await expect(page.getByText('选择方案', { exact: true })).toHaveCount(1);
  await expect(card.getByLabel('自定义回答：选择方案')).toHaveValue('方案 B，并保留原文件');
  const response = page.waitForResponse((r) => r.request().method() === 'POST' && /\/reply$/.test(r.url()));
  await card.getByRole('button', { name: '提交回答', exact: true }).click();
  expect((await (await response).json()).delivery).toBe('steered');
  await expect(card).toContainText('回答已发送到当前任务');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: `.runtime/e2e/${info.project.name}-questions.png`, fullPage: true });
});

test('keyboard height recovers after missing resize, blur and viewport zoom', async ({ page }, info) => {
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  await login(page);
  await openFolder(page, fixture.tasks[info.project.name]);
  await chatTab(page);
  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    (window as any).__keyboardHeight = 400;
    (window as any).__keyboardScale = 1;
    Object.defineProperty(viewport, 'height', {
      configurable: true,
      get: () => (window as any).__keyboardHeight,
    });
    Object.defineProperty(viewport, 'scale', {
      configurable: true,
      get: () => (window as any).__keyboardScale,
    });
  });
  const input = page.getByLabel('任务指令', { exact: true });
  await input.fill('保留输入草稿');
  const height = () => page.locator('.workbench').evaluate((el) => el.getBoundingClientRect().height);
  await expect.poll(height).toBe(400);
  // Android back can hide the keyboard without blurring or sending a final resize.
  await page.evaluate(() => {
    (window as any).__keyboardHeight = window.innerHeight;
  });
  await expect.poll(height).toBe(page.viewportSize()!.height);
  await page.evaluate(() => {
    (window as any).__keyboardHeight = 400;
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect.poll(height).toBe(400);
  await input.blur();
  await expect.poll(height).toBe(page.viewportSize()!.height);
  await input.focus();
  await expect.poll(height).toBe(400);
  await page.evaluate(() => {
    (window as any).__keyboardScale = 1.5;
  });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--workbench-height')))
    .toBe('');
  await expect(input).toHaveValue('保留输入草稿');
});

test('quota shows remaining percentages and keeps unknown windows unknown', async ({ page }) => {
  await page.route('**/providers/codex/quota', (route) =>
    route.fulfill({
      json: {
        quota: {
          windows: [
            { name: '五小时', usedPercent: 37, windowDurationMins: 300, resetsAt: null },
            { name: '周额度', usedPercent: null, windowDurationMins: 10080, resetsAt: null },
          ],
          updatedAt: new Date().toISOString(),
          stale: false,
        },
      },
    }),
  );
  await login(page);
  await page.getByLabel('工作区菜单', { exact: true }).click();
  await page.getByRole('button', { name: '账号管理', exact: true }).click();
  await expect(page.locator('.quota-window').first()).toContainText('剩余 63%');
  await expect(page.getByRole('progressbar', { name: '剩余额度' })).toHaveAttribute('value', '63');
  await expect(page.locator('.quota-window').nth(1)).toContainText('未知');
  await expect(page.locator('.quota-window').nth(1).locator('progress')).toHaveCount(0);
});

test('takeover lists all affected conversations and requires confirmation; cancellation sends no stop', async ({
  page,
}) => {
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  let previews = 0,
    stops = 0;
  let occupied = false;
  await page.route('**/conversations/*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), takeoverAvailable: occupied } });
  });
  await page.route('**/conversations/*/takeover/preview', (route) => {
    previews++;
    return route.fulfill({
      json: {
        token: 'preview-token',
        sessions: [
          { id: 'target', title: '当前被占用的对话', cwd: '/projects/current' },
          { id: 'other', title: '另一个会受到影响的对话', cwd: '/projects/other', source: 'subagent' },
        ],
      },
    });
  });
  await page.route('**/conversations/*/takeover', (route) => {
    stops++;
    occupied = false;
    expect(route.request().postDataJSON()).toMatchObject({ token: 'preview-token', confirmed: true });
    return route.fulfill({ json: { released: true } });
  });
  await login(page);
  await openFolder(page, fixture.primary);
  await chatTab(page);
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await page.getByLabel('任务指令', { exact: true }).fill('接管界面测试');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  const takeover = page.getByRole('button', { name: '在此接管', exact: true });
  await expect(page.getByLabel('Codex 回复：已完成', { exact: true })).toBeVisible();
  await expect(takeover).toHaveCount(0);
  occupied = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(takeover).toBeEnabled();
  await takeover.click();
  const dialog = page.getByRole('alertdialog', { name: '确认中断并在此接管？' });
  await expect(dialog.getByText('另一个会受到影响的对话', { exact: true })).toBeVisible();
  await expect(dialog.getByText('子代理会话（也会被中断）', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  expect(stops).toBe(0);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(stops).toBe(0);
  await takeover.click();
  await dialog.getByRole('button', { name: '确认中断 2 个对话并接管', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(takeover).toHaveCount(0);
  expect(previews).toBe(2);
  expect(stops).toBe(1);
  await page.unrouteAll({ behavior: 'wait' });
});

test('tool records collapse to one row per round in Relay and shared history and stay folded during updates', async ({
  page,
}, info) => {
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  const shared = fixture.shared[info.project.name];
  let count = 24;
  await login(page);
  await openFolder(page, shared.path);
  await chatTab(page);
  await page.route('**/conversations/*', async (route) => {
    if (
      route.request().method() !== 'GET' ||
      !/\/conversations\/[^/?]+$/.test(route.request().url().split('?')[0])
    ) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const body = await response.json();
    if (body.nativeHistory?.id === shared.threadId) {
      const messages = (source: string) =>
        Array.from({ length: count }, (_, i) => ({
          id: `${source}-tool-${i}`,
          kind: 'tool',
          text: `${source}-output-${i}`,
          payload: { command: `command-${i}` },
        }));
      body.nativeHistory.turns = [
        {
          id: 'native-tool-round',
          state: 'completed',
          userText: '共享工具记录测试',
          messages: [
            ...messages('native'),
            {
              id: 'native-answer',
              kind: 'assistant',
              text: '共享回复保持可见',
              questions: [{ title: '下一步要做什么？', options: ['继续', '结束'] }],
            },
          ],
        },
      ];
      const run = {
        id: 'relay-tool-round',
        workspaceId: body.conversation.workspaceId,
        conversationId: body.conversation.id,
        state: 'failed',
        text: '本地工具记录测试',
        model: 'fixture-model',
        reasoningEffort: null,
        permissionMode: 'read-only',
        providerTurnId: null,
        error: '这条错误仍然直接可见',
        createdAt: '2026-01-02T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      };
      body.runs = [run];
      body.messages = [
        ...messages('relay'),
        { id: 'relay-answer', kind: 'assistant', text: '本地回复保持可见', payload: {} },
      ].map((message) => ({
        ...message,
        runId: run.id,
        workspaceId: run.workspaceId,
        conversationId: run.conversationId,
        createdAt: run.createdAt,
      }));
    }
    await route.fulfill({ response, json: body });
  });
  await page.getByRole('button', { name: 'Codex 会话', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Codex 会话', exact: true });
  await picker.getByRole('button', { name: '当前项目', exact: true }).click();
  await picker.getByRole('button', { name: '打开会话：IDE 中的共享测试会话', exact: true }).click();
  const native = page.locator('.native-turn .tool-history');
  const relay = page.locator('.reply-failed .tool-history');
  await expect(page.locator('.tool-history')).toHaveCount(2);
  for (const group of [native, relay]) {
    await expect(group.locator(':scope > summary')).toContainText('执行记录 · 24 项');
    await expect(group).not.toHaveAttribute('open');
    await expect(group.locator('.tool-message')).toHaveCount(0);
  }
  await expect(page.getByText('共享回复保持可见', { exact: true })).toBeVisible();
  await expect(page.getByText('本地回复保持可见', { exact: true })).toBeVisible();
  await expect(page.getByText('下一步要做什么？', { exact: true })).toBeVisible();
  await expect(page.getByText('这条错误仍然直接可见', { exact: true })).toBeVisible();
  await relay.locator(':scope > summary').click();
  await expect(relay.locator('.tool-message')).toHaveCount(24);
  await relay.locator('.tool-message summary').first().click();
  await expect(relay.getByText('relay-output-0', { exact: true })).toBeVisible();
  count = 25;
  await expect(native.locator(':scope > summary')).toContainText('执行记录 · 25 项');
  await expect(native).not.toHaveAttribute('open');
  await expect(relay).toHaveAttribute('open');
  await expect(relay.getByText('relay-output-0', { exact: true })).toBeVisible();
  await relay.locator(':scope > summary').click();
  await expect(relay.locator('.tool-message')).toHaveCount(0);
  await native.locator(':scope > summary').focus();
  await page.keyboard.press('Enter');
  await expect(native.locator('.tool-message')).toHaveCount(25);
  await native.locator('.tool-message summary').first().click();
  await expect(native.getByText('native-output-0', { exact: true })).toBeVisible();
  await native.locator(':scope > summary').click();
  await expect(native.locator(':scope > summary')).toContainText('展开');
  await expect(native.locator('.tool-message')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: `.runtime/e2e/${info.project.name}-collapsed-tools.png` });
});

test('LaTeX renders in Relay replies and shared history while code and malformed formulas remain readable', async ({
  page,
}, info) => {
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  await openFolder(page, fixture.tasks[info.project.name]);
  await chatTab(page);
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  const id = await createFixtureConversation(page);
  const formula =
    String.raw`行内公式：\(E=mc^2\)，以及 $a+b$。

\[
\begin{aligned}
f(x) &= \frac{x^2}{2} \\
g(x) &= \sqrt{x}
\end{aligned}
\]

$$
\int_0^1 x^2\,dx=\frac{1}{3}
$$

\[
\boxed{\operatorname{char}_\Lambda(X_\infty)
=
p^{\sum_i\min(b,\mu_i)}\operatorname{char}_\Lambda(p^b X_\infty)}
\]

\[
0\to X_\infty[p^b]\to X_\infty\xrightarrow{p^b}p^b X_\infty\to0
\]

` +
    '\\[' +
    Array.from({ length: 35 }, (_, i) => `x_{${i}}`).join('+') +
    '\\]\n\n' +
    '```latex\n\\(x^2\\)\n```\n\n' +
    String.raw`无法解析的示例：\(\frac{1}\)。后面的回复仍可阅读。`;
  await page.route(`**/conversations/${id}?view=page`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const run = {
      id: 'latex-relay-turn',
      workspaceId: body.conversation.workspaceId,
      conversationId: id,
      state: 'completed',
      text: '请渲染数学公式',
      model: 'fixture-model',
      reasoningEffort: null,
      permissionMode: 'read-only',
      providerTurnId: null,
      error: null,
      createdAt: '2026-01-02T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    };
    body.runs = [run];
    body.messages = [
      {
        id: 'latex-relay-answer',
        runId: run.id,
        conversationId: id,
        workspaceId: run.workspaceId,
        kind: 'assistant',
        text: formula,
        payload: {},
        createdAt: run.createdAt,
      },
    ];
    body.nativeHistory = {
      id: 'latex-shared-thread',
      title: '共享公式',
      cwd: fixture.tasks[info.project.name],
      updatedAt: run.createdAt,
      turns: [
        {
          id: 'latex-native-turn',
          state: 'completed',
          userText: '共享公式示例',
          messages: [{ id: 'latex-native-answer', kind: 'assistant', text: formula }],
        },
      ],
    };
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  const replies = page.locator('.assistant-message');
  await expect(replies).toHaveCount(2);
  for (const reply of await replies.all()) {
    await expect(reply.locator('.katex')).toHaveCount(7);
    await expect(reply.locator('h1, h2')).toHaveCount(0);
    await expect(reply.locator('.fbox')).toHaveCSS('border-top-style', 'solid');
    await expect(reply.locator('.vlist').first()).toHaveCSS('display', 'table-cell');
    await expect(reply.locator('.katex-display')).toHaveCount(5);
    await expect(reply.locator('.katex-error')).toHaveCount(1);
    await expect(reply.locator('pre code')).toHaveText('\\(x^2\\)\n');
    await expect(reply).toContainText('后面的回复仍可阅读');
  }
  if (info.project.name === 'mobile') {
    expect(
      await replies
        .first()
        .locator('.katex-display')
        .last()
        .evaluate((node) => node.scrollWidth > node.clientWidth),
    ).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
  await page.locator('.chat-scroll').evaluate((node) => {
    node.scrollTop = 0;
  });
  await page.screenshot({ path: `.runtime/e2e/${info.project.name}-latex-replies.png` });
});

test('selecting and pasting images sends actual attachments, preserves them across reload and retries a lost reply once', async ({
  page,
}, info) => {
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  await login(page);
  await openFolder(page, fixture.tasks[info.project.name]);
  await chatTab(page);
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 160;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, 320, 160);
    ctx.fillStyle = 'black';
    ctx.font = '28px sans-serif';
    ctx.fillText('LATEX-SCREENSHOT', 8, 70);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const picker = page.getByLabel('图片附件', { exact: true });
  await picker.setInputFiles({
    name: '选择图片.png',
    mimeType: 'image/png',
    buffer: Buffer.from(base64, 'base64'),
  });
  const drafts = page.getByLabel('待发送图片', { exact: true });
  await expect(drafts.getByText('已就绪', { exact: true })).toHaveCount(1);
  await page.getByLabel('任务指令', { exact: true }).evaluate((element, data) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], '粘贴截图.png', { type: 'image/png' }),
    );
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, base64);
  await expect(drafts.getByText('已就绪', { exact: true })).toHaveCount(2);
  await drafts.getByRole('button', { name: '移除图片：选择图片.png', exact: true }).click();
  const submissions: Array<{ clientRequestId: string; imageIds: string[] }> = [];
  await page.route('**/conversations/*/runs', async (route) => {
    submissions.push(route.request().postDataJSON());
    if (submissions.length === 1) {
      await route.fetch();
      await route.fulfill({
        status: 503,
        json: { error: { code: 'lost_reply', message: '发送回执丢失（测试）' } },
      });
    } else await route.continue();
  });
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '发送回执丢失' })).toBeVisible();
  await expect(drafts.getByText('已就绪', { exact: true })).toHaveCount(1);
  await page.reload();
  await expect(drafts.getByText('已就绪', { exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.getByText('测试提供方收到了 1 张图片内容。', { exact: true })).toHaveCount(1);
  await expect(drafts).not.toBeVisible();
  await expect(
    page.getByLabel('已发送图片', { exact: true }).getByRole('img', { name: '粘贴截图.png', exact: true }),
  ).toHaveCount(1);
  expect(submissions).toHaveLength(2);
  expect(submissions[0].clientRequestId).toBe(submissions[1].clientRequestId);
  expect(submissions[0].imageIds).toEqual(submissions[1].imageIds);
  expect(submissions[0].imageIds).toHaveLength(1);
  await page.reload();
  const image = page
    .getByLabel('已发送图片', { exact: true })
    .getByRole('img', { name: '粘贴截图.png', exact: true });
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0))
    .toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: `.runtime/e2e/${info.project.name}-image-attachments.png` });
});

test('failed image uploads remain removable and prevent sending an incomplete message', async ({
  page,
}, info) => {
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  await login(page);
  await openFolder(page, fixture.tasks[info.project.name]);
  await chatTab(page);
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await page
    .getByLabel('图片附件', { exact: true })
    .setInputFiles({ name: 'unsafe.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
  await expect(page.getByRole('alert').filter({ hasText: '请选择 PNG、JPEG 或 WebP' })).toBeVisible();
  const data = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 10;
    return c.toDataURL().split(',')[1];
  });
  await page.route('**/workspaces/*/images', (route) =>
    route.fulfill({
      status: 503,
      json: { error: { code: 'upload_failed', message: '图片上传失败（测试）' } },
    }),
  );
  await page
    .getByLabel('图片附件', { exact: true })
    .setInputFiles({ name: '失败图片.png', mimeType: 'image/png', buffer: Buffer.from(data, 'base64') });
  await expect(page.getByLabel('待发送图片', { exact: true }).getByRole('alert')).toHaveText(
    '图片上传失败（测试）',
  );
  await page.getByLabel('任务指令', { exact: true }).fill('请看附件');
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '移除图片：失败图片.png', exact: true }).click();
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeEnabled();
});

test('conversation titles persist, desktop Enter sends, and code selection and copying survive refresh', async ({
  page,
  context,
}, info) => {
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  await login(page);
  await openFolder(page, fixture.tasks[info.project.name]);
  await chatTab(page);
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  const input = page.getByLabel('任务指令', { exact: true });
  await input.fill('复制选择测试');
  await input.press('Shift+Enter');
  await input.pressSequentially('第二行');
  await expect(input).toHaveValue('复制选择测试\n第二行');
  // IME confirmation must not submit the current draft.
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  await expect(input).toHaveValue('复制选择测试\n第二行');
  if (info.project.name === 'desktop') await input.press('Enter');
  else {
    await input.press('Enter');
    await expect(input).toHaveValue('复制选择测试\n第二行\n');
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
  }
  await expect(input).toHaveValue('');
  const code = page.locator('.assistant-message pre code').last();
  await expect(code).toHaveText('echo "保持选区"\nprintf "second"\n');
  const activeConversation = await currentConversation(page);
  let text = await code.textContent();
  const selectedText = await code.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    (window as any).__selectedCode = node;
    return selection.toString();
  });
  const refreshed = await page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' && /\/conversations\/[^/?]+$/.test(response.url().split('?')[0]),
  );
  await refreshed.finished();
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(selectedText);
  expect(await code.evaluate((node) => node === (window as any).__selectedCode)).toBe(true);
  await expect
    .poll(async () => {
      const snapshot = await (await page.request.get('/api/connections/a/snapshot')).json();
      return snapshot.messages.some(
        (message: any) => message.conversationId === activeConversation && message.text.includes('流式新增'),
      );
    })
    .toBe(true);
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  expect(await code.textContent()).toBe(text);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selectedText);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await expect(code).toContainText('流式新增');
  text = await code.textContent();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: '复制代码', exact: true }).last().click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
  await expect(page.getByRole('button', { name: '复制代码', exact: true }).last()).toContainText('已复制');
  // The LAN HTTP fallback copies just the code too.
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    document.execCommand = (command) => {
      if (command === 'copy')
        (window as any).__fallbackCopy = (document.activeElement as HTMLTextAreaElement).value;
      return true;
    };
  });
  await page.getByRole('button', { name: '复制代码', exact: true }).last().click();
  expect(await page.evaluate(() => (window as any).__fallbackCopy)).toBe(text);
  await historyDialog(page, true);
  await page
    .locator(`li[data-conversation-id="${activeConversation}"]`)
    .filter({ has: page.getByRole('button', { name: '修改对话标题', exact: true }) })
    .getByRole('button', { name: '修改对话标题', exact: true })
    .click();
  const title = `重命名会话 ${info.project.name}`;
  await page.getByLabel('对话标题', { exact: true }).fill(title);
  await page.getByRole('button', { name: '保存标题', exact: true }).click();
  await expectHistoryTitle(page, title);
  await historyDialog(page, false);
  await page.reload();
  await historyDialog(page, true);
  await expectHistoryTitle(page, title);
  await historyDialog(page, false);
  await page.getByRole('button', { name: '取消任务', exact: true }).click();
});

test('refresh loads files and six recent rounds without waiting for native history or repeating the snapshot', async ({
  page,
}, info) => {
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  await login(page);
  await openFolder(page, fixture.primary);
  await openFile(page, 'notes.txt');
  await chatTab(page);
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  const conversation = await createFixtureConversation(page);
  const me = await (await page.request.get('/api/me')).json();
  for (let i = 0; i < 8; i++) {
    const response = await page.request.post(`/api/connections/a/conversations/${conversation}/runs`, {
      headers: { 'x-csrf-token': me.csrfToken, origin: 'http://127.0.0.1:4399' },
      data: {
        clientRequestId: crypto.randomUUID(),
        text: `分页验收 ${i}`,
        model: 'fixture-model',
        reasoningEffort: 'medium',
        permissionMode: 'read-only',
      },
    });
    expect(response.ok()).toBe(true);
    await expect
      .poll(
        async () =>
          (
            await (
              await page.request.get(`/api/connections/a/conversations/${conversation}?view=page`)
            ).json()
          ).runs.at(-1)?.state,
      )
      .toBe('completed');
  }
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pattern = `**/conversations/${conversation}?view=native*`;
  await page.route(pattern, async (route) => {
    await gate;
    await route.continue().catch(() => {});
  });
  const snapshots: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/snapshot')) snapshots.push(request.url());
  });
  try {
    await page.reload();
    await chatTab(page);
    await expect(page.locator('.turn')).toHaveCount(6);
    await expect(page.locator('.user-message').filter({ hasText: '分页验收 7' })).toBeVisible();
    await expect(page.locator('.user-message').filter({ hasText: '分页验收 0' })).toHaveCount(0);
    await page.getByRole('button', { name: '加载较早记录', exact: true }).click();
    await expect(page.locator('.turn')).toHaveCount(8);
    await expect(page.locator('.user-message').filter({ hasText: '分页验收 0' })).toHaveCount(1);
    await expect(page.getByRole('button', { name: '加载较早记录', exact: true })).toHaveCount(0);
    await filesTab(page);
    await expect(
      page.locator('.file-list').getByRole('button', { name: 'notes.txt', exact: true }),
    ).toBeVisible();
    await mobileView(page, '预览');
    await expect(page.locator('.preview-panel')).toContainText('远端中文文件');
    expect(snapshots).toHaveLength(1);
    expect(new URL(snapshots[0]).searchParams.get('view')).toBe('summary');
  } finally {
    release();
    await page.unroute(pattern);
  }
});

test('external Codex login updates without an open account dialog and logout clears the old identity', async ({
  page,
}) => {
  let email: string | null = 'before@example.test';
  let reads = 0;
  await page.route('**/providers/codex/account', async (route) => {
    reads++;
    await route.fulfill({
      json: {
        authenticated: !!email,
        authMode: email ? 'chatgpt' : null,
        identifier: email,
        planType: email ? 'pro' : null,
        requiresOpenaiAuth: true,
      },
    });
  });
  await login(page);
  await page.getByLabel('工作区菜单', { exact: true }).click();
  const picker = page.getByLabel('切换 AI 账号', { exact: true });
  await expect(picker.locator('option:checked')).toContainText('before@example.test');
  email = 'after@example.test';
  // Periodic refresh must work even though the account dialog has never opened.
  await expect(picker.locator('option:checked')).toContainText('after@example.test', { timeout: 22_000 });
  const previous = reads;
  email = null;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => reads).toBeGreaterThan(previous);
  await expect(picker.locator('option:checked')).not.toContainText('@example.test');
});

test('new conversation stays unsaved until sending and survives refresh', async ({ page }, info) => {
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  await login(page);
  await openFolder(page, fixture.tasks[info.project.name]);
  await chatTab(page);
  const existing = await createFixtureConversation(page);
  const snapshot = async () => (await page.request.get('/api/connections/a/snapshot')).json();
  const before = (await snapshot()).conversations.length;
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: '新对话', exact: true }).click();
  }
  await expect(page.locator('.chat-empty')).toBeAttached();
  expect(await currentConversation(page)).toBe('');
  await page.reload();
  await expect(page.locator('.chat-empty')).toBeAttached();
  expect(await currentConversation(page)).toBe('');
  expect((await snapshot()).conversations.length).toBe(before);
  const title = `首次发送后保存 ${info.project.name}`;
  await page.getByLabel('任务指令', { exact: true }).fill(title);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.reply-panel')).toBeVisible();
  const created = await currentConversation(page);
  expect(created).not.toBe('');
  expect(created).not.toBe(existing);
  expect((await snapshot()).conversations.length).toBe(before + 1);
  await historyDialog(page, true);
  await expectHistoryTitle(page, title);
  await selectConversation(page, existing);
  expect(await currentConversation(page)).toBe(existing);
});

test('local conversations stay accessible in unified history when native history fails', async ({
  page,
}, info) => {
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  await login(page);
  await openFolder(page, fixture.tasks[info.project.name]);
  await chatTab(page);
  const id = await createFixtureConversation(page);
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await page.route('**/native-sessions*', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: '原生历史暂不可用' } }),
    }),
  );
  await selectConversation(page, id);
  expect(await currentConversation(page)).toBe(id);
  await historyDialog(page, true);
  await expect(page.getByLabel('历史会话', { exact: true })).toHaveCount(0);
  await expect(
    page
      .locator(`li[data-conversation-id="${id}"]`)
      .getByRole('button', { name: '修改对话标题', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '对话设置', exact: true })).toHaveCount(0);
});

test('native history can be renamed inline without opening it and survives reload', async ({
  page,
}, info) => {
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  await login(page);
  await openFolder(page, fixture.shared[info.project.name].path);
  await chatTab(page);
  const before = await currentConversation(page);
  await historyDialog(page, true);
  const dialog = page.getByRole('dialog', { name: 'Codex 会话', exact: true });
  await dialog.getByRole('button', { name: '加载更多会话', exact: true }).click();
  const row = dialog
    .locator('li')
    .filter({ has: page.getByRole('button', { name: '打开会话：更早的共享测试会话', exact: true }) });
  await row.getByRole('button', { name: '修改对话标题', exact: true }).click();
  const title = `历史内改名 ${info.project.name}`;
  await row.getByLabel('对话标题', { exact: true }).fill(title);
  await row.getByRole('button', { name: '保存标题', exact: true }).click();
  await expect(dialog.getByRole('button', { name: `打开会话：${title}`, exact: true })).toHaveCount(1);
  expect(await currentConversation(page)).toBe(before);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
  await page.reload();
  await expectHistoryTitle(page, title);
  await expect(page.getByRole('button', { name: '对话设置', exact: true })).toHaveCount(0);
});

test('local and temporary file links preview without switching project or navigating', async ({
  page,
  context,
}) => {
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  await login(page);
  await openFolder(page, fixture.secondary);
  await chatTab(page);
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await page.getByLabel('任务指令', { exact: true }).fill('文件链接预览测试');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  const url = page.url();
  await page.evaluate(() => {
    (window as any).__previewNavigationSentinel = 'unchanged';
  });
  await page.getByRole('button', { name: '绝对路径图片', exact: true }).click();
  const preview = page.locator('.preview-panel');
  await expect(preview.locator('.preview-content > img')).toBeVisible();
  await expect
    .poll(() =>
      preview.locator('.preview-content > img').evaluate((node: HTMLImageElement) => node.naturalWidth),
    )
    .toBeGreaterThan(0);
  await chatTab(page);
  await page.getByRole('button', { name: '相对路径文档', exact: true }).click();
  await expect(preview.getByRole('heading', { name: '移动文档工作台' })).toBeVisible();
  await chatTab(page);
  await page.getByRole('button', { name: '绝对路径 PDF', exact: true }).click();
  await expect(preview.locator('canvas').first()).toBeVisible();
  await chatTab(page);
  await page.getByRole('button', { name: '项目外截图', exact: true }).click();
  await expect(preview.locator('.preview-content > img')).toBeVisible();
  await expect
    .poll(() =>
      preview.locator('.preview-content > img').evaluate((node: HTMLImageElement) => node.naturalWidth),
    )
    .toBeGreaterThan(0);
  const download = await page.getByRole('link', { name: '下载文件', exact: true }).getAttribute('href');
  expect((await page.request.get(download!)).ok()).toBe(true);
  await chatTab(page);
  const conversationId = await currentConversation(page);
  await page.getByRole('button', { name: '项目外 PDF', exact: true }).click();
  await expect(preview.locator('canvas').first()).toBeVisible();
  await chatTab(page);
  await page.getByRole('button', { name: '项目外文档', exact: true }).click();
  await expect(preview.getByRole('heading', { name: '临时文档预览' })).toBeVisible();
  await expect
    .poll(() =>
      preview.getByRole('img', { name: '临时图片' }).evaluate((node: HTMLImageElement) => node.naturalWidth),
    )
    .toBeGreaterThan(0);
  await preview.getByRole('button', { name: '临时 PDF', exact: true }).click();
  await expect(preview.locator('canvas').first()).toBeVisible();
  await chatTab(page);
  await page.getByRole('button', { name: '已清理截图', exact: true }).click();
  await expect(preview.getByRole('alert')).toContainText('文件不存在');
  await chatTab(page);
  await page.getByRole('button', { name: '范围外文件', exact: true }).click();
  await expect(preview.getByRole('alert')).toContainText('允许预览的目录范围');
  await expect(page.locator('.project-switch')).toHaveAttribute('title', fixture.secondary);
  expect(await currentConversation(page)).toBe(conversationId);
  expect(page.url()).toBe(url);
  expect(context.pages()).toHaveLength(1);
  expect(await page.evaluate(() => (window as any).__previewNavigationSentinel)).toBe('unchanged');
});

test('task navigation lives in the view menu and updates its active count', async ({ page }, info) => {
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  await login(page);
  await openFolder(page, fixture.tasks[info.project.name]);
  await chatTab(page);
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await page.getByLabel('任务指令', { exact: true }).fill('导航审批测试');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.getByRole('button', { name: '允许本次', exact: true })).toBeVisible();
  if (info.project.name === 'mobile') await page.getByLabel('切换视图', { exact: true }).click();
  const task = page.locator('.workspace-nav').getByRole('button', { name: '任务', exact: true });
  await expect(task.locator('.task-count')).toHaveText('1');
  await task.click();
  await expect(page.locator('.tasks-page h1')).toHaveText('任务');
  if (info.project.name === 'mobile') await expect(page.locator('.workspace-nav')).not.toBeVisible();
  await page.getByLabel('工作区菜单', { exact: true }).click();
  await expect(page.locator('.workspace-menu').getByRole('button', { name: /任务/ })).toHaveCount(0);
  await page.getByLabel('工作区菜单', { exact: true }).click();
  await page.locator('.tasks-page').getByRole('button', { name: '拒绝', exact: true }).click();
  if (info.project.name === 'mobile') await page.getByLabel('切换视图', { exact: true }).click();
  await expect(task.locator('.task-count')).toHaveCount(0);
});

test('task cards open their own conversation, including older sessions in the current project', async ({
  page,
}, info) => {
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  await login(page);
  await openFolder(page, fixture.tasks[info.project.name]);
  await chatTab(page);
  const created: Array<{ id: string; text: string }> = [];
  for (const text of ['较早的指定任务', '最新的指定任务']) {
    await page.getByRole('button', { name: '新对话', exact: true }).click();
    await page.getByLabel('任务指令', { exact: true }).fill(text);
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    await expect(page.locator('.run-status.completed')).toBeVisible();
    created.push({ id: await currentConversation(page), text });
  }
  const openTask = async (index: number) => {
    await mobileView(page, '任务');
    await page
      .locator(`[data-session-id="${created[index].id}"]`)
      .getByRole('button', { name: '打开', exact: true })
      .click();
    await expect(page.locator('.chat-panel')).toHaveAttribute('data-conversation-id', created[index].id);
    await expect(page.locator('.user-message')).toHaveCount(1);
    await expect(page.locator('.user-message')).toContainText(created[index].text);
  };
  await openTask(0);
  await page.reload();
  await expect(page.locator('.chat-panel')).toHaveAttribute('data-conversation-id', created[0].id);
  await openTask(1);
  // Returning from another project must also preserve the card's target.
  await openFolder(page, fixture.secondary);
  await openTask(0);
});

test('desktop preview divider resizes both panels and restores the chosen split', async ({ page }, info) => {
  await login(page);
  await mobileView(page, '预览');
  const divider = page.getByRole('separator', { name: '调整对话与预览宽度' });
  if (info.project.name === 'mobile') {
    await expect(divider).toBeHidden();
    await expect(page.locator('.chat-panel')).toBeHidden();
    await expect(page.locator('.preview-panel')).toBeVisible();
    return;
  }
  await expect(divider).toBeVisible();
  const before = (await page.locator('.chat-panel').boundingBox())!;
  const previewBefore = (await page.locator('.preview-panel').boundingBox())!;
  const handle = (await divider.boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 100);
  await page.mouse.down();
  await page.mouse.move(handle.x + 150, handle.y + 100, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator('.preview-resize-overlay')).toHaveCount(0);
  const after = (await page.locator('.chat-panel').boundingBox())!;
  expect(after.width).toBeGreaterThan(before.width + 100);
  expect((await page.locator('.preview-panel').boundingBox())!.width).toBeLessThan(previewBefore.width - 100);
  await page.reload();
  await mobileView(page, '预览');
  await expect
    .poll(async () => Math.abs((await page.locator('.chat-panel').boundingBox())!.width - after.width))
    .toBeLessThan(2);
  await divider.focus();
  await page.keyboard.press('ArrowLeft');
  await expect
    .poll(async () => (await page.locator('.chat-panel').boundingBox())!.width)
    .toBeLessThan(after.width - 10);
  await page.keyboard.press('End');
  expect((await page.locator('.preview-panel').boundingBox())!.width).toBeGreaterThanOrEqual(279);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});
