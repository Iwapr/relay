import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { AppError } from '../../contracts/src/index.ts';

export const defaultCommands = [
  'ls',
  'pwd',
  'git status',
  'git diff',
  'git log',
  'npm test',
  'npm run build',
  'npm run lint',
  'npm run test',
];
const command = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine(
    (s) => !/[\x00-\x1f\x7f;|&<>$`(){}\\*]/.test(s) && !s.startsWith('regex:'),
    '请输入普通命令前缀，不支持通配符、正则或 shell 运算符',
  );
export const geminiSettingsInput = z
  .object({
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    allowedCommands: z.array(command).max(100),
    deniedCommands: z.array(command).max(100),
  })
  .strict();
export interface GeminiSettings {
  revision: string;
  allowedCommands: string[];
  deniedCommands: string[];
  additionalRules: number;
}
export function settingsPath(home: string) {
  return join(home, '.gemini', 'antigravity-cli', 'settings.json');
}
export async function ensureGeminiSettings(home: string) {
  const path = settingsPath(home);
  await mkdir(join(home, '.gemini', 'antigravity-cli'), { recursive: true, mode: 0o700 });
  try {
    await writeFile(
      path,
      JSON.stringify(
        { enableTerminalSandbox: true, permissions: { allow: defaultCommands.map((c) => `command(${c})`) } },
        null,
        2,
      ) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
}
async function load(home: string) {
  await ensureGeminiSettings(home);
  const raw = await readFile(settingsPath(home), 'utf8');
  if (raw.length > 1024 * 1024) throw new AppError('invalid_request', 'Antigravity 设置文件过大', 400);
  const data = JSON.parse(raw);
  return { raw, data, revision: createHash('sha256').update(raw).digest('hex') };
}
function editable(rule: unknown): string | undefined {
  if (typeof rule !== 'string') return;
  const match = /^command\((.*)\)$/.exec(rule);
  return match && command.safeParse(match[1]).success ? match[1] : undefined;
}
export async function readGeminiSettings(home: string): Promise<GeminiSettings> {
  const { data, revision } = await load(home);
  const allow: unknown[] = data.permissions?.allow ?? [],
    deny: unknown[] = data.permissions?.deny ?? [];
  return {
    revision,
    allowedCommands: allow.map(editable).filter((s): s is string => s !== undefined),
    deniedCommands: deny.map(editable).filter((s): s is string => s !== undefined),
    additionalRules:
      [...allow, ...deny].filter((r) => editable(r) === undefined).length +
      (data.permissions?.ask?.length ?? 0),
  };
}
export async function writeGeminiSettings(home: string, input: z.infer<typeof geminiSettingsInput>) {
  const parsed = geminiSettingsInput.parse(input);
  const { data, revision } = await load(home);
  if (parsed.revision !== revision)
    throw new AppError('settings_conflict', '权限规则已变化，请重新加载后再保存', 409);
  data.permissions ??= {};
  for (const [key, values] of [
    ['allow', parsed.allowedCommands],
    ['deny', parsed.deniedCommands],
  ] as const)
    data.permissions[key] = [
      ...(data.permissions[key] ?? []).filter((r: unknown) => editable(r) === undefined),
      ...[...new Set(values)].map((c) => `command(${c})`),
    ];
  const path = settingsPath(home),
    temp = path + '.' + randomUUID();
  await writeFile(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, path);
  return readGeminiSettings(home);
}
