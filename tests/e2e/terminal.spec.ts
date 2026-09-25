import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { loginWorkbench } from './login.ts';

test('terminal opens, accepts commands and provides mobile control keys', async ({ page }) => {
  await loginWorkbench(page);
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  await page.getByRole('button', { name: '当前项目', exact: true }).click();
  await page.getByRole('button', { name: '打开新项目…', exact: true }).click();
  await page.getByLabel('远程目录路径').fill(fixture.primary);
  await page.getByRole('button', { name: '前往', exact: true }).click();
  await expect(page.locator('.folder-list')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: '打开文件夹', exact: true }).click();
  await page.getByRole('button', { name: '工作区菜单', exact: true }).click();
  await page.getByRole('button', { name: '打开终端', exact: true }).click();
  const terminal = page.getByRole('dialog', { name: 'Terminal 终端' });
  await expect(terminal.getByRole('status')).toHaveText('已连接');
  const input = page.getByRole('textbox', { name: '终端输入' });
  await input.focus();
  await page.keyboard.type("printf 'TERMINAL_%s\\n' SUCCESS");
  await terminal.getByRole('button', { name: 'Enter', exact: true }).click();
  await expect(terminal.locator('.xterm-rows')).toContainText('TERMINAL_SUCCESS');
  await terminal.getByRole('button', { name: 'Ctrl', exact: true }).click();
  await expect(terminal.getByRole('button', { name: 'Ctrl', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.keyboard.type('c');
  await expect(terminal.getByRole('button', { name: 'Ctrl', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  for (const name of ['Esc', 'Tab', '↑', '↓', '←', '→', '中断 Ctrl+C'])
    await expect(terminal.getByRole('button', { name, exact: true })).toBeVisible();
  const bounds = await terminal.boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  if (test.info().project.name === 'mobile') {
    await page.setViewportSize({ width: 375, height: 430 });
    await expect
      .poll(async () => (await terminal.getByRole('button', { name: 'Enter', exact: true }).boundingBox())!.y)
      .toBeLessThan(430);
    await input.focus();
    await page.keyboard.type("printf 'RESIZED_%s\\n' OK");
    await terminal.getByRole('button', { name: 'Enter', exact: true }).click();
    await expect(terminal.locator('.xterm-rows')).toContainText('RESIZED_OK');
  }
  await page.screenshot({ path: `.runtime/e2e/terminal-${test.info().project.name}.png` });
  await terminal.getByRole('button', { name: '关闭终端', exact: true }).click();
  await expect(terminal).not.toBeVisible();
  await expect(page.getByRole('button', { name: '工作区菜单', exact: true })).toBeFocused();
});
