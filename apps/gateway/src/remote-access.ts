import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { networkInterfaces } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { AppError } from '../../../packages/contracts/src/index.ts';
import {
  cloudRelaySchema,
  remoteSettingsSchema,
  type RemoteStatus,
  type RelayGuide,
} from '../../../packages/contracts/src/remote-access.ts';
import { gatewayConfigSchema, isTailscaleIPv4, type ResolvedGatewayConfig } from './config.ts';

export async function detectTailscale(): Promise<RemoteStatus['tailscale']> {
  try {
    const { stdout } = await promisify(execFile)('tailscale', ['status', '--json'], {
      timeout: 8000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    });
    const status = JSON.parse(stdout);
    const assigned = new Set(
      Object.values(networkInterfaces()).flatMap((entries) =>
        (entries ?? []).filter((e) => e.family === 'IPv4').map((e) => e.address),
      ),
    );
    const ip = status.TailscaleIPs?.find((value: string) => isTailscaleIPv4(value) && assigned.has(value));
    if (status.BackendState === 'Running' && ip)
      return { state: 'ready', ip, message: 'Tailscale 已连接，可启用远程入口。' };
    return {
      state: 'unavailable',
      message: 'Tailscale 尚未登录或未连接，请在服务器完成安装登录后刷新检测。',
    };
  } catch {
    return {
      state: 'unavailable',
      message: '无法读取 Tailscale 状态，请检查是否已安装、服务已启动，以及当前服务用户是否有读取权限。',
    };
  }
}

export function relayGuide(value: unknown, ip: string, gatewayPort: number): RelayGuide {
  const relay = cloudRelaySchema.parse(value);
  if (!isTailscaleIPv4(ip) || !Number.isInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65535)
    throw new Error('Invalid upstream');
  const origin = new URL(`https://${relay.domain}:${relay.port}`).origin;
  const config = `server {
    listen ${relay.port} ssl;
    server_name ${relay.domain};
    ssl_certificate /etc/letsencrypt/live/${relay.domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${relay.domain}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    access_log off;
    error_log /var/log/nginx/relay-error.log crit;
    client_max_body_size 1m;

    location / {
        proxy_pass http://${ip}:${gatewayPort};
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Connection "";
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_cache off;
        proxy_max_temp_file_size 0;
        proxy_read_timeout 3600s;
        proxy_send_timeout 30s;
        add_header X-Accel-Buffering no always;
    }
}`;
  return {
    origin,
    steps: [
      {
        title: '1. 准备域名和入口',
        text: `适用于 Ubuntu / Debian 云服务器。将 ${relay.domain} 的 A 记录指向 ${relay.cloudIp}；若存在 AAAA 记录，也必须正确指向本机。放行 TCP 80、443${relay.port === 443 ? '' : `、${relay.port}`}，保留 SSH 管理端口。80 用于 Certbot HTTP-01 证书签发和续期，请勿将其用作 HTTPS 端口。此方案需要域名。`,
      },
      {
        title: '2. 云服务器加入同一个 Tailscale 网络',
        text: '通过官方脚本安装并完成登录；确认输出的 IPv4 与表单中的云端 Tailscale IP 一致。',
        code: `curl -fsSL https://tailscale.com/install.sh -o /tmp/relay-tailscale-install.sh\nsudo sh /tmp/relay-tailscale-install.sh\nsudo tailscale up\ntailscale ip -4\ntailscale ping ${ip}`,
      },
      {
        title: '3. 限制内网访问范围',
        text: `在 Tailscale 管理控制台，将云服务器 ${relay.cloudTailscaleIp} 的访问范围限制为部署 Relay 的服务器 ${ip} 的 TCP ${gatewayPort}。检查并收紧已有的全互通规则；Relay 所在网络不需要公网端口映射。部署 Relay 的服务器防火墙也应允许此来源访问该端口。`,
      },
      {
        title: '4. 安装 Nginx 并申请证书',
        text: '以下命令适用于 Ubuntu / Debian。已有 Nginx 可以继续使用；先确保现有配置通过 nginx -t，且没有同域名、同端口的重复站点。Certbot 会提示输入邮箱并确认服务条款，通过 Nginx 临时完成端口 80 的验证。使用 --cert-name 固定证书路径，已有同名证书可复用。',
        code: `sudo apt-get update
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo nginx -t && sudo systemctl enable --now nginx
sudo certbot certonly --nginx --cert-name ${relay.domain} -d ${relay.domain}`,
      },
      {
        title: '5. 添加 Nginx HTTPS 中转站点',
        text: '证书申请成功后再执行。配置写入独立的 conf.d 文件，已有同名文件先备份；默认 Ubuntu / Debian Nginx 会加载此目录。保留原始 Host、浏览器 Origin 和自定义端口，关闭代理缓冲以支持流式响应。只有 nginx -t 通过后才重载。',
        code: `if sudo test -f /etc/nginx/conf.d/relay-${relay.domain}-${relay.port}.conf; then
  sudo cp -a /etc/nginx/conf.d/relay-${relay.domain}-${relay.port}.conf "/etc/nginx/conf.d/relay-${relay.domain}-${relay.port}.conf.backup.$(date +%Y%m%d%H%M%S)"
fi
sudo tee /etc/nginx/conf.d/relay-${relay.domain}-${relay.port}.conf >/dev/null <<'RELAY_NGINX'
${config}
RELAY_NGINX
sudo nginx -t && sudo systemctl reload nginx`,
      },
      {
        title: '6. 启用并验证证书自动续期',
        text: '保持域名解析和端口 80 可达。Certbot 定时检查证书；续期成功后通过部署钩子校验并重载 Nginx，使新证书生效。dry-run 只验证续期流程。',
        code: `sudo install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
sudo tee /etc/letsencrypt/renewal-hooks/deploy/relay-nginx.sh >/dev/null <<'RELAY_RENEW'
#!/bin/sh
set -e
/usr/sbin/nginx -t
/usr/bin/systemctl reload nginx
RELAY_RENEW
sudo chmod 755 /etc/letsencrypt/renewal-hooks/deploy/relay-nginx.sh
sudo systemctl enable --now certbot.timer
sudo certbot renew --cert-name ${relay.domain} --dry-run`,
      },
      {
        title: '7. 保存配置并验证',
        text: `先在此窗口点击“保存并应用”，然后通过 ${origin} 登录。使用原网站账号密码；外部用户无需安装 Tailscale。生成步骤不代表云端已部署成功。`,
        code: `curl -I ${origin}\nsudo journalctl -u nginx -n 50 --no-pager`,
      },
    ],
  };
}

export interface RemoteManager {
  status(): Promise<RemoteStatus>;
  configure(value: unknown): Promise<RemoteStatus>;
  guide(value: unknown): Promise<RelayGuide>;
  current(): ResolvedGatewayConfig;
}

export function createRemoteManager(
  initial: ResolvedGatewayConfig,
  configPath: string | undefined,
  apply: (next: ResolvedGatewayConfig) => Promise<void>,
  detect = detectTailscale,
): RemoteManager {
  let current = initial;
  let busy = false;
  const manageable = Boolean(configPath && !initial.secureCookies && !initial.allowTailscaleHttp);
  const status = async (): Promise<RemoteStatus> => ({
    manageable,
    reason: manageable
      ? undefined
      : '此部署由外部配置管理，或主入口不是局域网 HTTP；请由服务器管理员配置远程入口。',
    enabled: Boolean(current.tailscaleHost),
    localOrigin: current.publicOrigin,
    gatewayPort: current.port,
    remoteOrigin: current.tailscaleHost ? `http://${current.tailscaleHost}:${current.port}` : undefined,
    proxyOrigin: current.tailscaleProxyOrigin,
    relay: current.remoteRelay,
    tailscale: await detect(),
  });
  return {
    current: () => current,
    status,
    guide: async (value) => {
      const detected = await detect();
      const ip = detected.ip ?? current.tailscaleHost;
      if (!ip)
        throw new AppError(
          'invalid_request',
          '请先在部署 Relay 的服务器连接 Tailscale，再生成中转步骤。',
          400,
        );
      return relayGuide(value, ip, current.port);
    },
    configure: async (value) => {
      if (!manageable) throw new AppError('permission_denied', '此部署不支持通过网页修改远程配置。', 403);
      if (busy) throw new AppError('invalid_request', '配置正在更新，请稍后重试。', 409);
      const settings = remoteSettingsSchema.parse(value);
      busy = true;
      const previous = current;
      const temp = `${configPath}.${randomUUID()}.tmp`;
      let applied = false;
      try {
        const diskText = await readFile(configPath!, 'utf8');
        const disk = gatewayConfigSchema.parse(JSON.parse(diskText));
        for (const key of [
          'tailscaleHost',
          'tailscaleProxyOrigin',
          'trustedProxyIps',
          'remoteRelay',
          'host',
          'port',
          'publicOrigin',
        ] as const)
          if (JSON.stringify(disk[key]) !== JSON.stringify(current[key]))
            throw new AppError('invalid_request', '配置已被外部修改，请重启 Gateway 后重试。', 409);
        const detected = settings.enabled ? await detect() : undefined;
        if (settings.enabled && !detected?.ip)
          throw new AppError('invalid_request', 'Tailscale 尚未连接，请完成安装登录并刷新检测。', 400);
        const patch = {
          tailscaleHost: settings.enabled ? detected!.ip : undefined,
          tailscaleProxyOrigin: settings.relay
            ? new URL(`https://${settings.relay.domain}:${settings.relay.port}`).origin
            : undefined,
          remoteRelay: settings.relay,
          trustedProxyIps: settings.relay ? [settings.relay.cloudTailscaleIp] : [],
        };
        const next = gatewayConfigSchema.parse({ ...current, ...patch });
        const nextDisk = gatewayConfigSchema.parse({ ...disk, ...patch });
        await writeFile(temp, JSON.stringify(nextDisk, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        await apply(next);
        applied = true;
        if ((await readFile(configPath!, 'utf8')) !== diskText)
          throw new AppError('invalid_request', '配置文件已发生变化，请重试。', 409);
        await rename(temp, configPath!);
        current = next;
      } catch (error) {
        if (applied) await apply(previous);
        if (error instanceof AppError) throw error;
        throw new AppError(
          'invalid_request',
          '远程入口未更新：请检查配置文件权限、Tailscale 网卡及端口是否可用。',
          400,
        );
      } finally {
        busy = false;
        await unlink(temp).catch(() => {});
      }
      return status();
    },
  };
}
