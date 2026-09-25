# Nginx + Tailscale 登录限流

文中的域名、IP、用户名和路径均为示例，请替换为自己的配置。

适用链路：浏览器 → 云服务器 Nginx → Tailscale → Relay。DNS 直接解析到云服务器，无 CDN。

以下仅为示例：云端代理 Tailscale IP 为 `100.64.0.20`，源站 IP 为 `100.64.0.10`。
代码和模板已准备好；下列操作才会使现有服务生效。不要把 JSON 字段加入旧版本后重启旧程序，旧配置校验会拒绝未知字段。

## 1. 在云服务器修改 Nginx

将以下内容保存为 `/etc/nginx/conf.d/relay-login-limits.conf`，确保此目录由 `nginx.conf` 的 `http {}` 引入；如果目录不在 http 中加载，就把内容直接放进 `http {}`。只定义一次，不要给每个站点重复定义。

```nginx
map "$request_method:$uri" $relay_login_ip {
    default "";
    "POST:/api/login" $binary_remote_addr;
}
limit_req_zone $relay_login_ip zone=relay_login:10m rate=10r/m;
```

在每个 Relay 站点实际负责转发的 `location /` 中增加下列指令。已有 `X-Forwarded-For` 时替换原指令，不要并排写两个。不需要重写证书、监听端口和上游地址。

```nginx
limit_req zone=relay_login burst=5 nodelay;
limit_req_status 429;
proxy_set_header X-Forwarded-For $remote_addr;
```

这是漏桶限速：平均每分钟 10 次，允许积累 5 个额外突发请求，超出返回 429；不是允许任意时刻一口气发送 10 次。非登录请求的 key 为空，不消耗额度。所有 Relay 站点复用同一个 zone，因此同一公网 IP 在不同账号入口共享 Nginx 额度。

如果已有更具体的 `/api/` 或 `/api/login` location，要把限流和转发头放到实际处理登录的 location。`proxy_set_header` 有继承规则：某层定义任何一个后，上层整组可能不再继承，因此应与该 location 的 Host、Connection 等转发头放在一起。

保留原有如下设置（特别是带端口的 Host、浏览器原始 Origin，以及 SSE 配置）：

```nginx
proxy_set_header Host $http_host;
proxy_set_header Connection "";
proxy_set_header X-Forwarded-Proto $scheme;
proxy_buffering off;
proxy_request_buffering off;
proxy_cache off;
proxy_read_timeout 3600s;
```

本场景 Nginx 直接面对访客，不应配置 `set_real_ip_from 0.0.0.0/0` 或 `::/0` 来信任客户端 IP 头。也不要使用 `$proxy_add_x_forwarded_for`；这里需要覆盖为单个地址。

备份原站点配置后，检查并重载：

```bash
sudo nginx -t
# 仅在上一步成功后执行：
sudo systemctl reload nginx
```

完整站点参考 `deploy/nginx/remote-workbench-tailscale.conf`，公共 http 配置参考 `deploy/nginx/relay-login-limits.conf`。不要用模板中的证书占位符覆盖现有站点。

## 2. 在真实服务器修改各 Relay 的 gateway.json

在 JSON 顶层增加字段（注意相邻字段间的逗号），其余配置保留：

```json
"trustedProxyIps": ["100.64.0.20"]
```

填写的是**云端 Nginx 的 Tailscale IP**，不是源站自身的 `100.64.0.10`，也不是整个 Tailscale 网段。

示例实例与配置路径（以自己的注册配置为准）：

| 实例     | Gateway 配置                                           | 公网端口 |
| -------- | ------------------------------------------------------ | -------- |
| operator | `/home/operator/Documents/relay/.runtime/gateway.json` | 14080    |
| user1    | `/home/user1/.local/share/relay-instance/gateway.json` | 14081    |
| user2    | `/home/user2/.local/share/relay-instance/gateway.json` | 14082    |
| user3    | `/home/user3/.local/share/relay-instance/gateway.json` | 14083    |
| user4    | `/home/user4/.local/share/relay-instance/gateway.json` | 14084    |

可以用 `sudoedit` 编辑这些配置。先用 `sudo cp -p 原路径 备份路径` 备份；保持原所有者及 0600 权限。不需要修改 owner、密码哈希、端口或 tailscaleProxyOrigin。

新代码默认规则：

- 每 IP 滚动 15 分钟内失败 10 次，从第 10 次失败起暂停登录 15 分钟。
- 成功登录不记失败，也不清空同一 IP 最近的失败记录，避免一次成功绕过累计限制。
- 同一 IP 的校验中请求也占用临时名额，防止同时发送多次请求越过失败上限；请求异常退出的名额在一分钟后回收。
- 每个 Gateway 数据库每 60 秒最多开始 60 次登录校验，成功也占全局额度；同实例的 LAN/Tailscale 监听共享额度，不同账号实例分别计算。
- 429 响应包含剩余等待秒数 `Retry-After`。封禁期间重试不会延长封禁。
- 重启保留新限流状态；旧版每 IP 5 次、全局 50 次的桶不再参与判定。
- 已登录用户的会话、聊天和任务不受登录限制影响。

## 3. 加载新版本

使用 `relay@用户.service` 的部署，先确认对应用户任务均已完成，再逐个重启；这会重新构建、发布源代码并启动 Agent 和 Gateway，**不只是重启网页**。

```bash
cd /home/operator/Documents/relay
npm run build
sudo systemctl restart relay@operator.service
sudo systemctl status relay@operator.service --no-pager
```

确认 operator 入口正常后，同样在各自任务空闲时逐个执行：

```bash
sudo systemctl restart relay@user1.service
sudo systemctl restart relay@user2.service
sudo systemctl restart relay@user3.service
sudo systemctl restart relay@user4.service
```

不要在仍有任务运行时重启 `relay.service` 总入口。当前管理员安装的发布器会从此工作目录构建代码；如果部署迁移过，先核对 `/etc/relay/source.json` 的 source 指向。

## 4. 限制 Tailscale 源站入口

在 Tailscale 访问策略中，只允许云服务器 `100.64.0.20` 访问源站 `100.64.0.10` 的 Relay 端口，并保留明确需要的管理设备。operator 的源站端口是 4080；其他实例端口应按各自 gateway.json 的 `port` 核对，不能使用公网的 1408x 代替。

Tailscale 的 allow/grants 规则会叠加：新增一条精确允许规则，并不能覆盖原来更宽泛的允许规则。需要收窄原有涵盖这些目标端口的通配规则，再用策略测试验证云服务器可达、普通节点不可达、管理访问保留。不要直接覆盖整份策略，SSH 和其他服务也可能依赖它。LAN 监听若继续保留，应仅向可信管理网络开放。

当前没有读取或修改你的 Tailscale ACL，所以这里仍需要管理员按现有策略执行。

## 5. 验收与排错

1. 每个入口先正常登录，确认 Cookie 和聊天流正常。
2. 从另一个公网 IP 登录，确认不会共享 Relay 的失败次数。
3. 若要人工测试失败封禁，用测试来源 IP，每次间隔至少 7 秒，连续输错 10 次，再正确登录应返回 429；已有登录会话仍可用。间隔过短会先命中 Nginx，未转发到 Relay 的请求不计入 Relay 失败数。
4. 改变客户端提交的 X-Forwarded-For 不应改变计数；Nginx 必须覆盖它。
5. 超限时 Nginx 默认返回 HTML 429，Relay 返回 JSON 429；可在浏览器开发者工具 Network 中区分。Relay 429 会包含 Retry-After；Nginx 默认没有该头。
6. 验证重启后 15 分钟封禁仍在，期限结束后恢复；无需反复重启生产任务来测试，仓库安全测试已覆盖持久化行为。

不安装 fail2ban，不封整个站点，不记录密码或聊天内容。
