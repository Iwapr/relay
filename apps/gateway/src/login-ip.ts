import { isIP } from 'node:net';

function normalizeIp(value: string): string | undefined {
  const family = isIP(value);
  if (!family || value.includes('%')) return;
  if (family === 4) return value;
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(canonical);
  if (!mapped) return canonical;
  const high = parseInt(mapped[1], 16),
    low = parseInt(mapped[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

/** Trust exactly one address overwritten by the known edge proxy, never a forwarded chain. */
export function loginClientIp(
  peer: string,
  forwarded: string | string[] | undefined,
  trusted: string[],
): string {
  const address = normalizeIp(peer) ?? peer;
  if (!trusted.some((ip) => normalizeIp(ip) === address)) return address;
  if (typeof forwarded !== 'string') return address;
  return normalizeIp(forwarded.trim()) ?? address;
}
