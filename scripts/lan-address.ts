import { networkInterfaces } from 'node:os';
import { isPrivateIPv4 } from '../apps/gateway/src/config.ts';
export function selectLanAddress(explicit?: string, interfaces = networkInterfaces()): string {
  if (explicit === '127.0.0.1') return explicit;
  const addresses = [
    ...new Set(
      Object.values(interfaces).flatMap((entries) =>
        (entries ?? [])
          .filter((entry) => entry.family === 'IPv4' && !entry.internal && isPrivateIPv4(entry.address))
          .map((entry) => entry.address),
      ),
    ),
  ];
  if (explicit && addresses.includes(explicit)) return explicit;
  if (!explicit && addresses.length === 1) return addresses[0];
  throw new Error(
    `请用 --host 指定局域网网卡地址（${addresses.join(', ') || '未检测到私有 IPv4'}）；仅本机使用可指定 --host 127.0.0.1。`,
  );
}
