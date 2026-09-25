import { readFile, unlink } from 'node:fs/promises';
import { request } from 'node:http';
import { marker, run, serviceArgs, serviceLocation, quoteUnit } from './service-utils.ts';

const options = serviceArgs(process.argv.slice(2));
if (process.getuid?.() === 0) throw new Error('Run this as the service’s ordinary Linux user.');
const { name, path } = serviceLocation(options.component);
const unit = await readFile(path, 'utf8').catch((e: NodeJS.ErrnoException) => {
  if (e.code === 'ENOENT') return undefined;
  throw e;
});
if (!unit) {
  console.log('This user service is already absent; configuration and data remain intact.');
  process.exit(0);
}
if (!unit.startsWith(marker)) throw new Error('Refusing to remove a service not created by this installer.');
if (
  !unit.includes(
    `Environment=${quoteUnit(`${options.component === 'agent' ? 'AGENT' : 'GATEWAY'}_CONFIG=${options.configPath}`)}\n`,
  )
)
  throw new Error('The supplied config does not match the installed service. Use its exact config path.');
if (options.component === 'agent' && !options.allowInterruption) {
  const config = JSON.parse(await readFile(options.configPath, 'utf8')) as {
    socketPath: string;
    tokenFile: string;
  };
  const token = (await readFile(config.tokenFile, 'utf8')).trim();
  const active = await new Promise<number>((resolve, reject) => {
    const req = request(
      { socketPath: config.socketPath, path: '/status', headers: { authorization: `Bearer ${token}` } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
          if (data.length > 65536) req.destroy(new Error('Invalid Agent status.'));
        });
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (res.statusCode !== 200 || !Number.isInteger(result.activeRuns)) throw new Error();
            resolve(result.activeRuns);
          } catch {
            reject(new Error('Could not verify the Agent’s active tasks.'));
          }
        });
      },
    );
    req.setTimeout(5000, () => req.destroy(new Error('Agent status timed out.')));
    req.on('error', reject);
    req.end();
  }).catch(() => -1);
  if (active !== 0)
    throw new Error(
      `${active < 0 ? 'Unable to verify running tasks.' : `${active} task(s) are active.`} Stopping this Agent can interrupt tasks. Use --allow-interruption only after explicitly accepting that outcome.`,
    );
}
console.log(
  `${options.apply ? 'Removing' : 'Prepared removal of'} ${path}. Service configuration, data, tokens, Codex login and all projects are retained.`,
);
if (options.apply) {
  await run('systemctl', ['--user', 'disable', '--now', name]);
  await unlink(path);
  await run('systemctl', ['--user', 'daemon-reload']);
} else console.log('Add --apply to stop and remove only this user service.');
