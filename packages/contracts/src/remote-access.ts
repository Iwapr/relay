import { z } from 'zod';

export const cloudRelaySchema = z
  .object({
    cloudIp: z.ipv4(),
    domain: z
      .string()
      .max(253)
      .regex(/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/),
    port: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .refine((port) => port !== 80, 'Port 80 is reserved for certificate validation'),
    cloudTailscaleIp: z.ipv4().refine((ip) => {
      const [a, b] = ip.split('.').map(Number);
      return a === 100 && b >= 64 && b <= 127;
    }),
  })
  .strict();
export const remoteSettingsSchema = z
  .object({
    enabled: z.boolean(),
    relay: cloudRelaySchema.optional(),
  })
  .strict()
  .refine((v) => v.enabled || !v.relay, 'Enable Tailscale before configuring a relay');
export type CloudRelay = z.infer<typeof cloudRelaySchema>;
export interface RemoteStatus {
  manageable: boolean;
  reason?: string;
  enabled: boolean;
  localOrigin: string;
  remoteOrigin?: string;
  proxyOrigin?: string;
  relay?: CloudRelay;
  tailscale: { state: 'ready' | 'unavailable'; ip?: string; message: string };
}
export interface RelayGuide {
  origin: string;
  steps: Array<{ title: string; text: string; code?: string }>;
}
