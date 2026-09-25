import { readFile } from 'node:fs/promises';
import {
  marker,
  run,
  serviceArgs,
  serviceLocation,
  unitText,
  validateInstall,
  writeManagedUnit,
} from './service-utils.ts';

const options = serviceArgs(process.argv.slice(2));
await validateInstall(options.component, options.configPath, options.nodePath);
const { name, path } = serviceLocation(options.component);
const text = unitText(options.component, options.configPath, options.nodePath);
const old = await readFile(path, 'utf8').catch((e: NodeJS.ErrnoException) => {
  if (e.code === 'ENOENT') return undefined;
  throw e;
});
if (old && !old.startsWith(marker)) throw new Error(`Refusing to overwrite an unmanaged unit: ${path}`);
console.log(`${options.apply ? 'Installing' : 'Prepared'} user service: ${path}\n${text}`);
if (options.apply) {
  await writeManagedUnit(path, text);
  await run('systemctl', ['--user', 'daemon-reload']);
  await run('systemctl', ['--user', 'enable', name]);
  if (options.start) await run('systemctl', ['--user', 'start', name]);
  console.log('Installed. Existing running services were not restarted.');
} else console.log('Review the exact unit, then add --apply. Add --start only when ready to launch.');
try {
  const { stdout } = await run('loginctl', [
    'show-user',
    String(process.getuid?.()),
    '-p',
    'Linger',
    '--value',
  ]);
  if (stdout.trim() !== 'yes')
    console.log(
      'Linger is not enabled: the user service may stop after logout. Ask an administrator to review loginctl enable-linger for this specific user. No linger setting was changed.',
    );
} catch {
  console.log('Could not verify linger; verify reliable systemd user persistence before remote use.');
}
