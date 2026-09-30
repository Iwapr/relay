import { test, expect } from '@playwright/test';
import { loginWorkbench } from './login.ts';

test('remote management opens below accounts and generates a relay guide on desktop and mobile', async ({
  page,
}) => {
  await loginWorkbench(page);
  let state = {
    manageable: true,
    enabled: false,
    localOrigin: 'http://192.168.1.20:4080',
    gatewayPort: 4180,
    tailscale: { state: 'ready', ip: '100.64.0.1', message: 'Tailscale 已连接，可启用远程入口。' },
  };
  await page.route('**/api/remote-access', async (route) => {
    if (route.request().method() === 'POST')
      state = { ...state, enabled: route.request().postDataJSON().enabled };
    await route.fulfill({ json: state });
  });
  await page.route('**/api/remote-access/guide', async (route) => {
    const body = route.request().postDataJSON();
    expect(body).toEqual({
      cloudIp: '203.0.113.10',
      cloudTailscaleIp: '100.64.0.2',
      domain: 'relay.example.com',
      port: 1443,
    });
    await route.fulfill({
      json: {
        origin: 'https://relay.example.com:1443',
        steps: [{ title: '安装 Nginx', text: '在云服务器执行', code: 'sudo apt-get install -y nginx' }],
      },
    });
  });
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click();
  const buttons = page.locator('#workspace-menu button');
  const labels = await buttons.allTextContents();
  expect(labels.indexOf('远程管理')).toBe(labels.indexOf('账号管理') + 1);
  await page.getByRole('button', { name: '远程管理', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '远程管理' });
  await expect(dialog.getByText('仅本机 / 局域网访问', { exact: true })).toBeVisible();
  await expect(dialog.locator('code').filter({ hasText: 'http://100.64.0.1:4180' })).toBeVisible();
  await dialog.getByLabel('启用 Tailscale 远程访问', { exact: true }).check();
  await dialog.getByLabel('使用云服务器中转', { exact: true }).check();
  await dialog.getByLabel('云服务器公网 IPv4', { exact: true }).fill('203.0.113.10');
  await dialog.getByLabel('访问域名', { exact: true }).fill('relay.example.com');
  await dialog.getByLabel('HTTPS 端口', { exact: true }).fill('1443');
  await dialog.getByLabel('云服务器 Tailscale IPv4', { exact: true }).fill('100.64.0.2');
  await dialog.getByRole('button', { name: '生成云服务器部署步骤' }).click();
  await expect(dialog.getByText('目标入口：https://relay.example.com:1443', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: '安装 Nginx' })).toBeVisible();
  await dialog.getByRole('button', { name: '保存并应用' }).click();
  await expect(dialog.getByRole('status')).toContainText('已保存并应用');
  await expect(dialog.getByText('远程入口已启用', { exact: true })).toBeVisible();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await dialog.getByLabel('启用 Tailscale 远程访问', { exact: true }).uncheck();
  await dialog.getByRole('button', { name: '保存并应用' }).click();
  await expect(dialog.getByRole('status')).toContainText('已关闭本项目远程入口');
  await dialog.getByRole('button', { name: '关闭远程管理' }).click();
  await expect(dialog).not.toBeVisible();
});
