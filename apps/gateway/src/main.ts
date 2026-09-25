import { startGateway } from './listeners.ts';
import { loadGatewayConfig } from './config.ts';

process.umask(0o077);
const path = process.env.GATEWAY_CONFIG;
if (!path) throw new Error('Set GATEWAY_CONFIG to the absolute path of your private gateway configuration.');
const config = await loadGatewayConfig(path);
const gateway = await startGateway(config, path);
for (const address of gateway.addresses) console.log(`Remote Workbench Gateway listening on ${address}`);
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    void gateway.close().then(() => process.exit(0));
  });
