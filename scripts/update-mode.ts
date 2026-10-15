import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';

/** The same update entry serves shared installations and standalone checkouts. */
export async function sharedUpdateCommand(
  root: string,
  args: string[],
  registration = '/etc/relay/source.json',
  uid = process.getuid?.(),
) {
  let config: { source: string };
  try {
    config = JSON.parse(await readFile(registration, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if ((await realpath(config.source)) !== (await realpath(root))) return null;
  const command = ['python3', join(root, 'scripts/relay-service.py'), 'update', ...args];
  return uid === 0 ? { program: command[0]!, args: command.slice(1) } : { program: 'sudo', args: command };
}
