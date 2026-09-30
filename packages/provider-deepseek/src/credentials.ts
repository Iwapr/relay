import { mkdir, readFile, writeFile, rename, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../contracts/src/index.ts';

export const DEEPSEEK_API = 'https://api.deepseek.com';
export async function readKey(home: string): Promise<string | null> {
  try {
    return JSON.parse(await readFile(join(home, 'relay-credential.json'), 'utf8')).apiKey;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('无法读取 DeepSeek 密钥配置');
  }
}
export function apiError(status: number) {
  return new AppError(
    status === 401 || status === 403 ? 'auth_required' : 'agent_unavailable',
    status === 401 || status === 403
      ? 'DeepSeek API Key 无效或已失效，请重新配置'
      : status === 402
        ? 'DeepSeek API 余额不足，请充值'
        : status === 429
          ? 'DeepSeek API 请求过于频繁，请稍后重试'
          : 'DeepSeek 官方 API 暂时不可用，请检查网络后重试',
    status === 401 || status === 403 ? 401 : 503,
  );
}
export async function officialRequest(key: string, path: '/models' | '/user/balance') {
  let response: Response;
  try {
    response = await fetch(DEEPSEEK_API + path, {
      headers: { Authorization: `Bearer ${key}` },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new AppError('agent_unavailable', '无法连接 DeepSeek 官方 API，请检查网络', 503);
  }
  if (!response.ok) throw apiError(response.status);
  try {
    return await response.json();
  } catch {
    throw new AppError('agent_unavailable', 'DeepSeek API 返回了无效数据', 503);
  }
}
export async function writeKey(home: string, apiKey: string) {
  // Validation never replaces a working credential on failure and never echoes the secret.
  if (apiKey) {
    const data = await officialRequest(apiKey, '/models');
    if (!Array.isArray(data.data) || !data.data.some((m: any) => typeof m.id === 'string'))
      throw new AppError('agent_unavailable', 'DeepSeek 未返回可用模型，密钥未保存', 503);
  }
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
