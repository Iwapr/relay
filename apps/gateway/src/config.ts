import { z } from 'zod';
import { cloudRelaySchema } from '../../../packages/contracts/src/remote-access.ts';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { isIP, isIPv4 } from 'node:net';
import { sshArguments } from '../../../packages/transport-ssh/src/index.ts';
const absolute = z.string().refine(isAbsolute, 'An absolute path is required');
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
/** Literal RFC1918 addresses only; never DNS, wildcard, public, or overlay addresses. */
export function isPrivateIPv4(host: string): boolean {
  if (!isIPv4(host)) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
/** Literal addresses from Tailscale's IPv4 range, enabled separately from LAN HTTP. */
export function isTailscaleIPv4(host: string): boolean {
  if (!isIPv4(host)) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
}
const loopbackHosts = ['127.0.0.1', '::1'];
const transport = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unix'), socketPath: absolute }).strict(),
  z
    .object({
      kind: z.literal('ssh'),
      host: z.string(),
      port: z.number().int().min(1).max(65535).default(22),
      user: z.string(),
      identityFile: absolute,
      knownHostsFile: absolute,
      remoteSocketPath: absolute,
    })
    .strict(),
]);
export const profileSchema = z
  .object({
    id,
    ownerId: id,
    label: z.string().min(1).max(120),
    tokenFile: absolute,
    expectedIdentity: z
      .object({
        uid: z.number().int().nonnegative(),
        username: z.string().min(1),
        home: absolute,
        agentId: z.string().optional(),
        machineId: z.string().optional(),
      })
      .strict(),
    transport,
  })
  .strict();
export const gatewayConfigSchema = z
  .object({
    publicOrigin: z.string().url(),
    stateDir: absolute,
    owner: z
      .object({
        id,
        username: z.string().min(1).max(100),
        passwordHash: z.string().regex(/^scrypt\$32768\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/),
      })
      .strict(),
    profiles: z.array(profileSchema).max(100),
    secureCookies: z.boolean().default(true),
    cookieNamespace: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,40}$/)
      .optional(),
    // Explicit opt-in for a trusted LAN. Public deployments still require HTTPS.
    allowLanHttp: z.boolean().default(false),
    allowTailscaleHttp: z.boolean().default(false),
    // Add a separate listener without changing the primary LAN/loopback origin.
    tailscaleHost: z.string().refine(isTailscaleIPv4, 'Use a literal Tailscale IPv4 address.').optional(),
    // Optional HTTPS entry point forwarded to the Tailscale HTTP listener.
    tailscaleProxyOrigin: z
      .string()
      .refine((value) => value === value.trim(), 'Use an exact origin without surrounding whitespace.')
      .url()
      .optional(),
    remoteRelay: cloudRelaySchema.optional(),
    // Exact proxy addresses only; no wildcard, DNS names, or trusted subnets.
    trustedProxyIps: z
      .array(z.string().refine((ip) => isIP(ip) !== 0, 'Use a literal proxy IP address.'))
      .max(20)
      .default([]),
    staticDir: absolute.optional(),
    sessionTtlSeconds: z.number().int().min(60).max(604800).default(43200),
    host: z
      .string()
      .refine(
        (host) => loopbackHosts.includes(host) || isPrivateIPv4(host) || isTailscaleIPv4(host),
        'Bind to loopback or a specific LAN/Tailscale IPv4 address.',
      )
      .default('127.0.0.1'),
    port: z.number().int().min(1).max(65535).default(4380),
  })
  .strict()
  .superRefine((v, c) => {
    const url = new URL(v.publicOrigin);
    if (url.origin !== v.publicOrigin || url.username || url.password)
      c.addIssue({
        code: 'custom',
        message: 'publicOrigin must be an exact origin without path or credentials.',
      });
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    const lan =
      v.allowLanHttp &&
      isPrivateIPv4(v.host) &&
      url.protocol === 'http:' &&
      url.hostname === v.host &&
      Number(url.port || 80) === v.port &&
      !v.secureCookies;
    const tailscale =
      v.allowTailscaleHttp &&
      isTailscaleIPv4(v.host) &&
      url.protocol === 'http:' &&
      url.hostname === v.host &&
      Number(url.port || 80) === v.port &&
      !v.secureCookies;
    if (v.allowLanHttp && !lan)
      c.addIssue({
        code: 'custom',
        message: 'LAN HTTP requires a matching private bind address, origin, port, and secureCookies:false.',
      });
    if (v.allowTailscaleHttp && !tailscale)
      c.addIssue({
        code: 'custom',
        message:
          'Tailscale HTTP requires a matching overlay bind address, origin, port, and secureCookies:false.',
      });
    if (v.tailscaleHost && (url.protocol !== 'http:' || v.secureCookies || v.tailscaleHost === v.host))
      c.addIssue({
        code: 'custom',
        message: 'The extra Tailscale listener requires an HTTP configuration and a distinct bind address.',
      });
    if (v.tailscaleProxyOrigin) {
      const proxy = URL.parse(v.tailscaleProxyOrigin);
      const tailscaleHosts = [...(tailscale ? [v.host] : []), ...(v.tailscaleHost ? [v.tailscaleHost] : [])];
      if (
        !proxy ||
        proxy.protocol !== 'https:' ||
        proxy.origin !== v.tailscaleProxyOrigin ||
        proxy.username ||
        proxy.password
      )
        c.addIssue({
          code: 'custom',
          message: 'tailscaleProxyOrigin must be an exact HTTPS origin without path or credentials.',
        });
      if (tailscaleHosts.length === 0)
        c.addIssue({
          code: 'custom',
          message: 'tailscaleProxyOrigin requires a Tailscale HTTP listener.',
        });
      else if (tailscaleHosts.some((host) => proxy?.host === new URL(`http://${host}:${v.port}`).host))
        c.addIssue({
          code: 'custom',
          message: 'The HTTPS proxy and direct Tailscale origins must have distinct hosts or ports.',
        });
    }
    if (!loopbackHosts.includes(v.host) && !lan && !tailscale)
      c.addIssue({
        code: 'custom',
        message:
          'A non-loopback bind requires explicit LAN or Tailscale HTTP mode; use the HTTPS reverse proxy for production.',
      });
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && !v.secureCookies && local) &&
      !lan &&
      !tailscale
    )
      c.addIssue({
        code: 'custom',
        message: 'HTTPS is required except loopback development or explicit LAN/Tailscale HTTP mode.',
      });
    if (!v.secureCookies && !local && !lan && !tailscale)
      c.addIssue({
        code: 'custom',
        message: 'Insecure cookies require loopback development or explicit LAN/Tailscale HTTP mode.',
      });
    if (new Set(v.profiles.map((p) => p.id)).size !== v.profiles.length)
      c.addIssue({ code: 'custom', message: 'Connection profile IDs must be unique.' });
    for (const p of v.profiles)
      if (p.transport.kind === 'ssh')
        try {
          sshArguments(p.transport, '/tmp/relay-check.sock');
        } catch {
          c.addIssue({ code: 'custom', message: `Invalid SSH profile: ${p.id}` });
        }
  });
export type GatewayConfig = z.input<typeof gatewayConfigSchema>;
export type ResolvedGatewayConfig = z.output<typeof gatewayConfigSchema>;
export type ConnectionProfile = z.output<typeof profileSchema>;
export function gatewayListenerConfigs(input: GatewayConfig): ResolvedGatewayConfig[] {
  const config = gatewayConfigSchema.parse(input);
  if (!config.tailscaleHost) return [config];
  return [
    config,
    gatewayConfigSchema.parse({
      ...config,
      host: config.tailscaleHost,
      publicOrigin: new URL(`http://${config.tailscaleHost}:${config.port}`).origin,
      allowLanHttp: false,
      allowTailscaleHttp: true,
      tailscaleHost: undefined,
    }),
  ];
}
export async function loadGatewayConfig(path: string): Promise<ResolvedGatewayConfig> {
  return gatewayConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}
