import { isAbsolute } from 'node:path';
export interface InstallOptions {
  yes: boolean;
  foreground: boolean;
  host?: string;
  port?: number;
  root?: string;
  codex?: string;
}
export function installOptions(args: string[]): InstallOptions {
  const result: InstallOptions = { yes: false, foreground: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--yes') result.yes = true;
    else if (arg === '--foreground') result.foreground = true;
    else if (['--host', '--port', '--root', '--codex'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} 需要参数`);
      if (arg === '--host') result.host = value;
      if (arg === '--port') {
        if (!/^[1-9]\d*$/.test(value) || Number(value) < 1024 || Number(value) > 65535)
          throw new Error('端口必须在 1024–65535');
        result.port = Number(value);
      }
      if (arg === '--root' || arg === '--codex') {
        if (!isAbsolute(value)) throw new Error(`${arg} 需要绝对路径`);
        if (arg === '--root') result.root = value;
        else result.codex = value;
      }
    } else throw new Error(`未知参数：${arg}；使用 ./install.sh --help`);
  }
  return result;
}
