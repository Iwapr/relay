import { z } from 'zod';
import { readFileSync } from 'node:fs';
export const AgentConfigSchema = z
  .object({
    stateDir: z.string().startsWith('/'),
    socketPath: z.string().startsWith('/'),
    tokenFile: z.string().startsWith('/'),
    roots: z.array(z.string().startsWith('/')).min(1),
    previewRoots: z.array(z.string().startsWith('/')).optional(),
    accountLabel: z.string().max(60).optional(),
    provider: z.enum(['codex', 'kimi', 'claude']).optional(),
    claudeExecutable: z.string().optional(),
    claudeHome: z.string().startsWith('/').optional(),
    kimiExecutable: z.string().optional(),
    kimiHome: z.string().startsWith('/').optional(),
    authHome: z.string().startsWith('/').optional(),
    codexHome: z.string().startsWith('/').optional(),
    codexExecutable: z.string().default('codex'),
    sharedLockDirectory: z.string().startsWith('/').optional(),
    maxProviders: z.number().int().min(1).max(16).default(4),
    sensitivePaths: z.array(z.string().startsWith('/')).optional(),
    taskUmask: z.enum(['0022', '0002']).default('0022'),
    maxPreviewBytes: z
      .number()
      .int()
      .positive()
      .default(50 * 1024 * 1024),
    allowRoot: z.boolean().default(false),
  })
  .strict();
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export function readConfig(path = process.env.AGENT_CONFIG) {
  if (!path) throw new Error('请设置 AGENT_CONFIG 配置文件路径');
  return AgentConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}
