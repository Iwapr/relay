import { test, expect } from '@playwright/test';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { loginWorkbench } from './login.ts';

test('record public README interface with isolated demo data', async ({ page }, info) => {
  test.skip(process.env.RELAY_RECORD_MEDIA !== '1', 'Opt-in documentation recording');
  const mobile = info.project.name === 'mobile';
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 820 });
  const output = `.runtime/readme-media/${info.project.name}`;
  await mkdir(output, { recursive: true });
  await mkdir('docs/images', { recursive: true });
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  const workspaceRoot = mobile ? fixture.secondary : fixture.primary;
  await writeFile(
    workspaceRoot + '/README.md',
    '# 项目工作台\n\n把想法变成可以交付的结果。\n\n## 本周计划\n\n- [x] 整理项目资料\n- [x] 完成第一版文档\n- [ ] 检查图表与公式\n- [ ] 导出最终报告\n\n## 一个小例子\n\n用 Markdown 记录过程，也可以直接预览公式：\n\n$$\\int_0^1 x^2\\,dx=\\frac{1}{3}$$\n\n```python\ndef summarize(items):\n    return "\\n".join(items)\n```\n\n## 协作\n\n在电脑上开始，在手机上继续。文件与任务都保留在自己的服务器。\n',
  );
  await page.route('**/api/remote-access', (route) =>
    route.fulfill({
      json: {
        manageable: true,
        enabled: false,
        localOrigin: 'http://192.168.10.20:4080',
        tailscale: { state: 'ready', ip: '100.64.0.10', message: 'Tailscale 已连接，可启用远程入口。' },
      },
    }),
  );
  // The fixture Agent uses the OS identity for its security checks. Publish only a
  // fixed display identity in this opt-in recording, never the machine username.
  await page.route('**/api/connections', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      response,
      json: {
        ...data,
        connections: data.connections.map((connection: Record<string, unknown>, index: number) => ({
          ...connection,
          username: 'demo',
          label: `演示服务器 ${index + 1}`,
        })),
      },
    });
  });
  await loginWorkbench(page);
  async function view(name: string) {
    if (mobile) await page.getByLabel('切换视图', { exact: true }).click();
    await page.locator('.mobile-nav').getByRole('button', { name, exact: true }).click();
  }
  if (mobile) await view('文件');
  await page.getByRole('button', { name: '打开远程文件夹', exact: true }).first().click();
  const picker = page.getByRole('dialog', { name: '打开远程文件夹' });
  await picker.getByLabel('远程目录路径').fill(workspaceRoot);
  await picker.getByRole('button', { name: '前往', exact: true }).click();
  await expect(picker.locator('.folder-list')).toHaveAttribute('aria-busy', 'false');
  await picker.getByRole('button', { name: '打开文件夹', exact: true }).click();
  await expect(page.locator('.project-switch')).toHaveAttribute('title', workspaceRoot);
  await page.reload();
  await expect(page.getByRole('combobox', { name: '模型', exact: true })).toHaveValue('fixture-model');
  if (mobile) await view('对话');
  const input = page.getByPlaceholder('描述你想完成的工作，也可以粘贴截图…');
  await input.fill('请总结项目说明，并列出下一步。');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.getByText('先完成图表和公式检查，再导出报告。', { exact: false }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: '取消任务', exact: true })).not.toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  let frame = 0;
  async function shot() {
    await page.screenshot({
      path: `${output}/${String(frame++).padStart(2, '0')}.png`,
      animations: 'disabled',
    });
  }
  await shot();
  if (mobile) await view('文件');
  await shot();
  await page.locator('.file-list').getByRole('button', { name: 'README.md', exact: true }).click();
  await expect(page.locator('.preview-content').getByText('项目工作台', { exact: true })).toBeVisible();
  await shot();
  await copyFile(`${output}/${mobile ? '00' : '02'}.png`, `docs/images/${info.project.name}.png`);
  if (mobile) await view('对话');
  await shot();
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click();
  await expect(page.getByLabel('服务器和 Linux 用户', { exact: true })).toContainText('演示服务器 1 · demo');
  await shot();
  await page.getByRole('button', { name: '远程管理', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '远程管理' })).toBeVisible();
  await shot();
  await page.getByRole('button', { name: '关闭远程管理' }).click();
  await shot();
});
