import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { codexExecutable } from './codex-executable.ts';
const exec = promisify(execFile);
const commands: Record<string, [string, string[]]> = {
  codex: [await codexExecutable({ configured: true }), ['--version']],
  ssh: ['ssh', ['-V']],
  python: ['python3', ['--version']],
  systemdUser: ['systemctl', ['--user', 'is-system-running']],
  linger: ['loginctl', ['show-user', userInfo().username, '-p', 'Linger']],
  tailscale: ['systemctl', ['is-active', 'tailscaled']],
};
const checks = await Promise.all(
  Object.entries(commands).map(async ([name, [command, args]]) => {
    try {
      const r = await exec(command, args, { timeout: 8000, maxBuffer: 8192 });
      return [name, { ok: true, result: (r.stdout || r.stderr).trim() }];
    } catch (e) {
      const error = e as Error & { stderr?: string; stdout?: string };
      return [
        name,
        { ok: false, result: (error.stderr || error.stdout || error.message).trim().slice(0, 1000) },
      ];
    }
  }),
);
console.log(
  JSON.stringify(
    {
      node: process.version,
      uid: process.getuid?.(),
      username: userInfo().username,
      home: homedir(),
      codexHome: process.env.CODEX_HOME ?? join(homedir(), '.codex'),
      checks: Object.fromEntries(checks),
      note: '只读检查；未读取凭据正文或更改现有服务。',
    },
    null,
    2,
  ),
);
