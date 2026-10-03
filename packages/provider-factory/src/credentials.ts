import { mkdir, chmod, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { AppError } from '../../contracts/src/index.ts';

export async function readFactoryKey(home: string): Promise<string | null> {
  try {
    const data = JSON.parse(await readFile(join(home, 'relay-credential.json'), 'utf8'));
    if (typeof data.apiKey !== 'string' || !data.apiKey) throw new Error();
    return data.apiKey;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new AppError('auth_required', '无法读取 Factory API Key，请重新配置', 401);
  }
}
export async function writeFactoryKey(home: string, apiKey: string) {
  // Public Sessions API access is not a prerequisite for local Droid inference.
  // Edge 403 responses and doctor warnings cannot establish whether a key is valid.
  // Save locally; the official CLI verifies authorization on the user's first task.
  apiKey = apiKey.trim();
  if (apiKey.length > 4096 || /[\s\x00-\x1f\x7f]/.test(apiKey))
    throw new AppError('invalid_request', 'API Key 格式无效，请只粘贴密钥本身，不要包含空格或换行', 400);
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  const path = join(home, 'relay-credential.json');
  if (!apiKey) {
    await rm(path, { force: true });
    return;
  }
  const temp = path + '.' + randomUUID();
  try {
    await writeFile(temp, JSON.stringify({ apiKey }), { mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
