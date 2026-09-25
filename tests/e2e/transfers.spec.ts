import { test, expect, type Page } from '@playwright/test';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loginWorkbench } from './login';
const exec = promisify(execFile);
async function openFiles(page: Page, directory: string) {
  if ((page.viewportSize()?.width ?? 0) < 761) {
    await page.getByLabel('切换视图', { exact: true }).click();
    await page.locator('.mobile-nav').getByRole('button', { name: '文件', exact: true }).click();
  }
  await page.getByRole('button', { name: '打开远程文件夹', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: '打开远程文件夹' });
  await dialog.getByLabel('远程目录路径').fill(directory);
  await dialog.getByRole('button', { name: '前往', exact: true }).click();
  await expect(dialog.locator('.folder-list')).toHaveAttribute('aria-busy', 'false');
  await dialog.getByRole('button', { name: '打开文件夹', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}
test('file panel uploads files and folders, downloads originals and selected ZIPs, and reports conflicts', async ({
  page,
}, testInfo) => {
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  const target = path.join(fixture.primary, 'transfers-' + testInfo.project.name);
  const local = await mkdtemp(path.join(tmpdir(), 'relay-browser-upload-'));
  await mkdir(target, { recursive: true });
  try {
    await loginWorkbench(page);
    await openFiles(page, target);
    await page.getByRole('button', { name: '传输', exact: true }).click();
    await page.getByRole('button', { name: '选择下载文件', exact: true }).click();
    const payload = Buffer.alloc(650000, 173);
    await page.getByLabel('选择上传文件', { exact: true }).setInputFiles([
      { name: '原始 数据.bin', mimeType: 'application/octet-stream', buffer: payload },
      { name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) },
    ]);
    await expect(page.getByRole('status')).toContainText('已上传 2 个文件');
    assertBytes(await readFile(path.join(target, '原始 数据.bin')), payload);
    const downloadEvent = page.waitForEvent('download');
    await page.getByLabel('选择 原始 数据.bin', { exact: true }).check();
    await page.getByRole('button', { name: '下载所选 (1)', exact: true }).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe('原始 数据.bin');
    assertBytes(await readFile((await download.path())!), payload);
    await page.getByLabel('选择 原始 数据.bin', { exact: true }).uncheck();

    const folder = path.join(local, '上传 文件夹');
    await mkdir(path.join(folder, 'nested'), { recursive: true });
    await writeFile(path.join(folder, 'nested/a.txt'), '中文内容');
    await writeFile(path.join(folder, 'b.txt'), 'second');
    await page.getByLabel('选择上传文件夹', { exact: true }).setInputFiles(folder);
    await expect(page.getByRole('button', { name: '上传 文件夹', exact: true })).toBeVisible();
    expect(await readFile(path.join(target, '上传 文件夹/nested/a.txt'), 'utf8')).toBe('中文内容');
    await page.getByLabel('选择 上传 文件夹', { exact: true }).check();
    await page.getByLabel('选择 empty.txt', { exact: true }).check();
    const zipEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载所选 (2)', exact: true }).click();
    const zip = await zipEvent;
    const archive = (await zip.path())!;
    await exec('python3', [
      '-c',
      'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.read("上传 文件夹/nested/a.txt").decode()=="中文内容"; assert z.read("empty.txt")==b""',
      archive,
    ]);

    const folderEvent = page.waitForEvent('download');
    await page.getByLabel('选择 empty.txt', { exact: true }).uncheck();
    await page.getByRole('button', { name: '下载所选 (1)', exact: true }).click();
    expect((await folderEvent).suggestedFilename()).toBe('上传 文件夹.zip');
    await page
      .getByLabel('选择上传文件', { exact: true })
      .setInputFiles({ name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.from('overwrite') });
    await expect(page.getByRole('alert')).toContainText('同名文件已存在');
    expect((await readFile(path.join(target, 'empty.txt'))).length).toBe(0);
  } finally {
    await rm(local, { recursive: true, force: true });
  }
});
function assertBytes(actual: Buffer, expected: Buffer) {
  expect(actual.equals(expected)).toBe(true);
}

test('file management uses explicit controls for create, rename, copy, move and delete', async ({
  page,
}, testInfo) => {
  const fixture = JSON.parse(await readFile('.runtime/e2e/fixture.json', 'utf8'));
  const target = path.join(fixture.primary, 'management-' + testInfo.project.name);
  await mkdir(target, { recursive: true });
  await loginWorkbench(page);
  await openFiles(page, target);
  await expect(page.getByLabel('选择已加载的全部文件')).toHaveCount(0);
  await page.getByRole('button', { name: '新建', exact: true }).click();
  for (const [kind, name] of [
    ['新建文件夹', 'destination'],
    ['新建文件', 'hello.txt'],
  ]) {
    await page.getByRole('button', { name: kind, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: kind, exact: true });
    await dialog.getByLabel('名称', { exact: true }).fill(name);
    await dialog.getByRole('button', { name: '确认', exact: true }).click();
    await expect(dialog).not.toBeVisible();
  }
  await page.getByRole('button', { name: '管理', exact: true }).click();
  await page.getByLabel('选择 hello.txt', { exact: true }).check();
  await page.getByRole('button', { name: '重命名', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('名称', { exact: true }).fill('renamed.txt');
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  for (const action of ['复制', '移动']) {
    await page.getByLabel('选择 renamed.txt', { exact: true }).check();
    await page.getByRole('button', { name: action, exact: true }).click();
    dialog = page.getByRole('dialog', { name: action + '到', exact: true });
    await dialog.getByRole('button', { name: '📁 destination', exact: true }).click();
    await dialog.getByRole('button', { name: action + '到这里', exact: true }).click();
    if (action === '复制') {
      await expect(dialog).not.toBeVisible();
      expect(await readFile(path.join(target, 'destination/renamed.txt'), 'utf8')).toBe('');
      await rm(path.join(target, 'destination/renamed.txt'));
    } else await expect(dialog).not.toBeVisible();
  }
  await page.getByLabel('选择 destination', { exact: true }).check();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '删除', exact: true });
  await expect(dialog).toContainText('无法撤销');
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'destination', exact: true })).toHaveCount(0);
});
