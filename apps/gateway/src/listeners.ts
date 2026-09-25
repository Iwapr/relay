import { buildGateway } from './server.ts';
import { gatewayConfigSchema, gatewayListenerConfigs, type GatewayConfig } from './config.ts';
import { createRemoteManager } from './remote-access.ts';

/** Keep LAN sessions and the Agent alive while changing the overlay listener. */
export async function startGateway(input: GatewayConfig, configPath?: string) {
  const initial = gatewayConfigSchema.parse(input);
  let overlay: Awaited<ReturnType<typeof buildGateway>> | undefined;
  let overlayHost: string | undefined;
  const closeOverlay = async () => {
    const old = overlay;
    overlay = undefined;
    overlayHost = undefined;
    if (old) {
      const closing = old.close();
      old.server.closeAllConnections();
      await closing;
    }
  };
  const remote = createRemoteManager(initial, configPath, async (next) => {
    if (overlayHost === next.tailscaleHost) return;
    // Bind the replacement first, so a failed bind leaves the old listener working.
    let replacement: typeof overlay;
    if (next.tailscaleHost) {
      replacement = await buildGateway(gatewayListenerConfigs(next)[1], remote);
      try {
        await replacement.listen({ host: next.tailscaleHost, port: next.port });
      } catch (error) {
        await replacement.close();
        throw error;
      }
    }
    await closeOverlay();
    overlay = replacement;
    overlayHost = next.tailscaleHost;
  });
  const primary = await buildGateway(initial, remote);
  try {
    await primary.listen({ host: initial.host, port: initial.port });
    if (initial.tailscaleHost) {
      overlay = await buildGateway(gatewayListenerConfigs(initial)[1], remote);
      await overlay.listen({ host: initial.tailscaleHost, port: initial.port });
      overlayHost = initial.tailscaleHost;
    }
  } catch (error) {
    await Promise.allSettled([primary.close(), closeOverlay()]);
    throw error;
  }
  return {
    get addresses() {
      return gatewayListenerConfigs(remote.current()).map(({ host, port }) => `${host}:${port}`);
    },
    close: async () => {
      await Promise.all([primary.close(), closeOverlay()]);
    },
  };
}
