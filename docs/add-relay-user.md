# 给已有 Linux 用户添加 Relay

文中的域名、IP、用户名和路径均为示例，请替换为自己的配置。

`manage-code-server-users.sh add USER` 创建 Linux 用户及 code-server。再运行本仓库的 `scripts/add-relay-user.py` 给同一用户安装独立 Relay；不再运行写死早期用户名的 `deploy-local-users.sh`。

前提：系统已有 Relay 模板服务及 `/etc/relay/source.json`，统一共享项目配置已完成（`relay-locks`、公共锁目录、`/srv/projects`）。用户必须已经存在。新用户的 home 可以保持 0700，不需要复制 Codex 登录、开放其他人的 home 或授予 sudo。

## 操作

在真实服务器的管理员终端执行，下面的 alice 换成实际 Linux 用户名：

```bash
cd /home/operator/Documents/relay
sudo python3 scripts/add-relay-user.py alice
sudo python3 scripts/add-relay-user.py alice --apply
```

第一条仅预览；第二条发布当前源码、生成独立私有配置及随机登录密码、加入锁组、注册并启动 `relay@alice.service`，纳入现有 `relay.service` 管理组。只重启新用户实例，不停止其他人的 Relay，不修改 code-server 配置或其 Tailscale Serve。

默认从 4080 开始选择未被已登记 Relay 或本机监听占用的端口；公网端口为该端口加 10000，同时避开已登记公网端口。也可指定 `--port 4085`，预览和应用使用相同参数。云服务器其他应用是否占用该公网端口仍需在云端确认。

网络配置默认参考已登记源码所属用户的 Relay（示例为 operator），也可指定 `--reference user1`。仅继承 LAN 地址、Tailscale 地址、公网域名及显式 `trustedProxyIps`；不复制 Gateway 登录密码、认证令牌、Codex 账号或会话。支持当前 LAN HTTP + Tailscale HTTP + 云端 HTTPS 反代部署；参考实例若不符合这个部署形态会拒绝自动配置。

实例配置和密码记录：

```text
/home/alice/.local/share/relay-instance/agent.json
/home/alice/.local/share/relay-instance/gateway.json
/home/alice/.local/share/relay-instance/login.txt
```

实际路径以该用户 passwd 记录的 home 为准。脚本不会在输出中打印密码。管理员查看：

```bash
sudo -u alice cat /home/alice/.local/share/relay-instance/login.txt
sudo systemctl status relay@alice.service --no-pager
```

Relay 密码独立于 code-server 密码。Codex 需要该用户自己登录；若其 CLI／插件已经在相同用户和默认 Codex 环境中登录，Relay 可使用该登录。新实例会开放自己的 home 和 `/srv/projects`、使用公共锁和 `taskUmask=0002`。它能列出项目名，但没有加入项目组前不能进入受限项目。为已有项目授权示例：`sudo usermod -aG example-project alice`，随后在任务空闲时重启该用户 Relay；code-server 若需加载新组身份也应在适当时机重启。

## 云端 Nginx

安装成功后，真实服务器生成 `/etc/relay/nginx/alice.conf`，包含实际分配的公网端口、域名、Tailscale 后端、SSE 配置、真实 IP 覆盖和登录限流。它不是已部署的云端配置。

将文件内容复制到云服务器 Nginx 的 `http` 上下文包含的配置目录（例如 `/etc/nginx/conf.d/relay-alice.conf`），沿用现有 `relay_login` 限流区定义。证书路径按当前域名的 Let's Encrypt 标准目录生成，如云端另有路径应调整。放行云端对应 TCP 端口，再验证并重载：

```bash
sudo nginx -t && sudo systemctl reload nginx
```

公网 URL 以安装输出为准；例如后台 4085 对应 `https://relay.example.com:14085`。本工具不修改云端防火墙、Nginx 或 Tailscale Serve。

## 重复执行与失败

已有注册、已有完整或部分实例配置都会拒绝覆盖，避免隐式重置密码。失败时保留新实例文件供检查，不回滚删除 Linux 用户或 home。先依据错误检查端口、权限和服务日志，不要重新执行 code-server 的 `add` 或删除用户来修复 Relay。

`manage-code-server-users.sh remove USER` 不管理 Relay 注册。以后删除 Linux 用户前，需先妥善停用并清理对应 Relay 实例及注册、处理备份，再删除用户；否则其 Relay 系统服务和管理组中会留下失效项。
