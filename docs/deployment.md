# 部署、升级与卸载

文中的域名、IP、用户名和路径均为示例，请替换为自己的配置。

本仓库提供可运行代码和独立服务模板；实现期间没有修改现有 code-server、Nginx、Tailscale、系统账号或 Codex 登录。远端真实服务器部署、跨主机 SSH 和公网 TLS 仍需在获授权的环境验收。Gateway 默认在回环接口上监听，公网访问由新的 HTTPS 子域反代；局域网和Tailscale可按下面的配置增加指定接口监听。

## 运行前提

- Linux 上已安装的 Node.js 24 LTS、npm、Python 3 和系统 OpenSSH `/usr/bin/ssh`。项目依赖以 `package-lock.json` 固定。部署时先 `npm ci`，再 `npm run build`。
- 每个 Agent 必须以实际目标普通用户运行，使用该用户自己的 HOME / CODEX_HOME 和官方 Codex 登录。当前验证版本为 `codex-cli 0.154.0-alpha.6.2`；记录 Codex 可执行文件绝对路径，协议及升级边界见 `docs/protocol-compatibility.md`。
- 远端 Agent 数据、控制令牌和 Unix socket 放在用户私有目录。目录 0700，令牌和配置 0600，socket 0600。项目目录权限保持原状。
- 模板服务使用系统级 systemd，首次安装需要 sudo。独立组件的旧用户服务方式还需 `systemctl --user` 可用，并按需由管理员设置 linger。
- 首次上线前使用可信渠道验证服务器主机密钥。`ssh-keyscan` 只能采集候选公钥，不能证明真实性。通过服务器控制台核对 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`，再由管理员维护专用 known_hosts 文件。变化必须重新核验，不能关闭检查。

## 配置和配对

使用 `deploy/agent-user-service/config.example.json` 和 `deploy/gateway/config.example.json` 作为模板，按实际用户、UID 和路径替换。模板中的密码哈希占位符不能启动服务。`npm run setup` 生成本地开发配置；其命令输出说明生成位置，开发配置不得直接用于公网。

首次配置可运行 `npm run setup -- --codex /绝对路径/codex`。本机使用 `.runtime/codex/0.154.0-alpha.6.2/codex`，其同级资源和伴随程序一并从已安装IDE扩展复制，防止扩展升级删除旧路径后影响工作台。不要只根据系统 PATH 中的 `codex --version` 推断服务实际版本；应检查 `agent.json` 的 `codexExecutable` 并对该绝对路径执行 `--version`。

Agent 的 `AGENT_CONFIG` 指向 JSON 配置：`stateDir`、`socketPath`、`tokenFile`、允许浏览的 `roots`，可选 `codexExecutable`、`sharedLockDirectory`、`maxProviders`、`maxPreviewBytes`、`sensitivePaths`、`taskUmask`。Gateway 的 `GATEWAY_CONFIG` 指向 JSON 配置：`publicOrigin`、`stateDir`、`owner`、`profiles`，可选 `host`、`port`、`staticDir`、`secureCookies`、`sessionTtlSeconds`、`allowLanHttp`、`tailscaleHost`、`tailscaleProxyOrigin`、`trustedProxyIps`。默认 Gateway 端口 4380；仓库的本地启动脚本和 Nginx 示例显式使用 4080，应保持一致。

Gateway 网站密码保存为 scrypt 哈希。可从终端环境变量生成，避免把明文密码写入命令历史：

```bash
read -r -s -p 'New website password: ' WORKBENCH_PASSWORD
export WORKBENCH_PASSWORD
node_modules/.bin/tsx --eval 'import {hashPassword} from "./apps/gateway/src/auth.ts"; hashPassword(process.env.WORKBENCH_PASSWORD ?? "").then(console.log)'
unset WORKBENCH_PASSWORD
```

密码至少 12 个字符。每条连接的 `ownerId` 必须匹配网站拥有者。Gateway 不允许浏览器上传 SSH 私钥、指定任意上游 URL 或传入任意 SSH 选项；网页只能选择管理员预置的 profile。V1 的首次安装和配对由管理员使用本页步骤完成，没有网页上传发行包功能。

为每个 Agent 创建至少 32 个字符的随机控制令牌，并经已核验 SSH 安全复制到 Gateway 的对应 `tokenFile`。令牌只允许字母、数字、`_`、`-`；例如 `openssl rand -hex 32`。不要把 Codex 登录凭据复制到 Gateway。Gateway 私钥和控制令牌必须为当前服务用户所有的普通文件，且不允许组或其他用户读取。known_hosts 不允许组或其他用户写入。

`expectedIdentity` 必须填实际 UID、用户名和 HOME；可提前固定 `agentId` 和 `machineId`。每次业务请求都会先读取真实 Agent 身份，核对协议版本和这些字段。第一次通过后，将 Agent ID 与机器 ID 固定到 Gateway 数据库；后续变化返回 `identity_mismatch`。替换 Agent 或机器时，先核验新身份并备份 Gateway 数据库，再由管理员在停服务期间清除该连接对应的 `identity_pins` 记录，更新预期身份后重新连接。不得用换一个 profile ID 绕过未经核验的主机密钥变化。

SSH profile 使用系统 OpenSSH、显式主机/端口/用户、专用 known_hosts 和私钥。实现不读取用户的任意 SSH config；复杂跳板机部署应由管理员提前准备受控的可达地址，V1 不接受浏览器提交跳板配置。SSH 只执行 `-N -T` 转发，不在 SSH 命令里启动 Agent。

转发采用 **Gateway 私有本地 Unix socket → 远端 Unix socket**，这与 plan 中回环 TCP 的示意略有不同：本地私有 socket 避免选空闲 TCP 端口后被其他本机进程抢占，也限制无关用户访问隧道。目录 0700，socket 0600，仍需 Agent 控制令牌。保持 `stateDir` 较短，以免超过 Linux Unix socket 路径长度限制。关闭 Gateway 或 SSH 只断开转发，远端 Agent 用户服务继续运行。

本机开发可以使用 `transport: {"kind":"unix","socketPath":"/absolute/agent.sock"}`，仅由后台配置启用。`secureCookies:false` 默认只允许 localhost/127.0.0.1/::1。可信局域网可显式设置 `allowLanHttp:true`，此时 `host` 必须为指定的RFC1918 IPv4，HTTP `publicOrigin` 的IP和端口必须与监听配置相同；仍验证Host、Origin和CSRF。`npm run lan` 可为现有本地配置设置这些字段。公网配置必须HTTPS并使用Secure Cookie。网站会话默认 12 小时后过期，改密码会使旧会话失效。

已安装并连接Tailscale的服务器，可运行 `npm run tailscale` 为现有HTTP开发配置增加 `tailscaleHost`。脚本通过 `tailscale ip -4` 读取地址，要求它位于 `100.64.0.0/10` 且已分配给本机网卡；Gateway在该地址和相同端口增加第二个监听，原 `host` 与 `publicOrigin` 保持不变。此选项仅允许 `secureCookies:false` 和HTTP主地址，命令拒绝修改HTTPS生产配置。脚本不修改Tailscale系统配置。

确认本地开发任务空闲后重启 `npm run dev`，在已连接Tailscale的设备上访问 `.runtime/login.txt` 的 `Tailscale地址`，使用明确的 `http://Tailscale-IP:端口`，例如 `http://100.64.0.10:4080`。局域网地址仍可使用，账号密码相同，各地址的Cookie分别保存。每个监听均验证相应Host和Origin，修改请求仍需CSRF token。设备间能否连接，还取决于Tailscale网络访问策略是否允许该端口。

## Relay 模板服务（推荐同机多用户）

对于已有本地实例，使用系统级 `relay@.service`，一次安装后只需更新源码并重启目标实例。模板由管理员安装，Agent 和 Gateway 始终以实例对应的普通 Linux 用户运行。

```bash
cd /home/operator/Documents/relay
sudo python3 scripts/relay-service.py install \
  --users operator user1 user2 user3 user4 --public-host relay.example.com
# 今后更新本目录代码后：
sudo systemctl restart relay@user2
# 或更新全部实例：
sudo systemctl restart relay
```

安装器针对已通过本项目 setup 配置的实例：源码所有者使用 `.runtime/{agent,gateway}.json`，其他用户使用 `~/.local/share/relay-instance/{agent,gateway}.json`。首次部署仍需先准备这些私有配置及源码 `.runtime/codex/<固定版本>/` 的完整 Codex 运行目录。系统需要 Python 3、systemd、npm；首次安装从项目依赖提取 Node 24 至 `/opt/relay/node`。

`--public-host` 为各实例设置精确 HTTPS 入口，公网端口等于已有端口加 `--port-offset`（默认 10000）。示例映射为 operator 14080、user1 14081、user2 14082、user3 14083、user4 14084；要求现有配置已有 Tailscale HTTP 监听。Nginx 应保留 `$http_host`，见下文反代模板。安装器不修改 Nginx，也不重新生成密码。

`relay.service` 统一管理所有已注册实例，`sudo systemctl restart relay` 会重启全部实例，`sudo systemctl stop relay` 会停止全部实例；单个用户仍可通过 `relay@用户名` 管理。后续安装新用户时自动加入统一服务，原有注册用户继续保留。如果此前已安装只有模板的版本，或遇到 `Unit relay.service not found`，在源码目录执行 `sudo python3 scripts/relay-service.py install-group` 即可补装总入口及 `PartOf` 关联。该命令校验现有注册实例，添加服务与模板 drop-in，执行 daemon-reload 并 enable；不会启动、停止、重启、迁移或构建任何实例，不要求任务空闲。随后等任务结束，再重启对应实例加载代码修复。无需重新执行整套迁移。统一服务的状态表示管理入口，具体实例是否正常仍以 `systemctl status relay@用户名` 和其日志为准。

服务配置分两层：`/etc/relay/source.json` 注册源码位置和构建用户；`/etc/relay/instances/<用户名>.json` 只保存私有配置的路径及可选公网入口。密码、令牌、数据库和登录缓存留在原目录。运行时覆盖旧配置里的程序资源路径，让 Codex 与前端指向此次发布版本，无需逐人手工改 JSON。

每次启动的准备步骤以源码所有者运行构建；依赖锁变化时先执行 `npm ci`。构建成功后发布只读于普通用户的独立版本目录。构建用全局锁串行化，相同源码复用已有版本，依赖与 Codex 分别缓存，因此批量重启只构建一次。运行中的其他实例继续使用各自固定版本，不随源码修改而切换。不要同时在目录内编辑代码或手工构建；检测到源码在构建期间改变会拒绝发布，请保存后重新重启。

安装器检查活动任务，验证配置和 systemd 模板后才停用本项目原来的 `remote-workbench-agent/gateway` 用户服务，并启用 `relay@用户名` 开机启动。迁移失败会恢复已保存的安装配置并尝试恢复原服务，备份保留于 `/var/lib/relay/install-backups/`。重复安装可更新注册信息和系统服务辅助脚本；平时应用代码更新无需重装。

```bash
systemctl status relay@user2
sudo journalctl -u relay@user2 -f
sudo systemctl stop relay@user2
sudo systemctl start relay@user2
```

`restart` 同时重启该实例的 Agent 和 Gateway，会中断其正在执行的任务，应在空闲时执行。构建或启动失败时命令返回失败，可从 journal 查看原因；修正源码后再次 restart。失败构建不发布半成品，但 restart 已停止旧进程，不承诺自动恢复运行。历史发行目录保留在 `/opt/relay/releases`，不会自动清理。此模板服务不需要用户总线环境变量或 linger。

卸载单个实例服务可执行 `sudo systemctl disable --now relay@用户名`；配置和数据保留。下文 `systemctl --user`、仅 Gateway 重启和旧卸载脚本只适用于未迁移的独立组件部署；迁移后统一使用 `systemctl ... relay@用户名`。

## 独立用户服务

以下为 Agent/Gateway 分机部署或原有用户服务的安装方式；同机多用户优先使用上一节模板。

在目标普通用户下预览精确的 Agent 服务。下面的路径都是待替换的示例，Node 路径必须是实际 Node 24 可执行文件：

```bash
node_modules/.bin/tsx scripts/install-service.ts \
  --component agent \
  --config /home/alice/.config/remote-workbench/agent.json \
  --node /opt/node24/bin/node
```

命令默认只诊断并打印单元内容。确认具体路径后，添加 `--apply --start` 会安装 `~/.config/systemd/user/remote-workbench-agent.service`、reload 用户管理器、enable 并 start。相同配置重复执行保持幂等；遇到同名但不属于本安装器的单元会拒绝覆盖。已运行的服务不会被自动 restart。

Gateway 在公网中转服务器的专用普通用户下执行相同命令，改为 `--component gateway` 和该用户的 Gateway 配置。服务命名为 `remote-workbench-gateway.service`。安装器不会安装系统级服务，不修改 code-server，不创建账号，也不复制私钥或登录文件。

独立服务不属于 code-server 的进程组，升级或关闭编辑器后仍能运行。安装成功后用 `systemctl --user is-active remote-workbench-agent remote-workbench-gateway` 确认两者为 active，用 `systemctl --user is-enabled remote-workbench-agent remote-workbench-gateway` 确认已启用自动启动；此时不要再运行 `npm run dev`，以免重复启动和占用端口。

部分 code-server 终端未设置用户总线环境变量，会报 `Failed to connect to bus: No medium found`，即使用户管理器已在运行。确认当前用户的 `/run/user/$(id -u)/bus` 存在后，可在该终端设置：

```bash
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
systemctl --user status remote-workbench-agent remote-workbench-gateway
```

这些变量只让当前终端连接本用户的服务管理器。若用户管理器本身未运行，仍需先解决该运行前提。

在真实目标用户下运行 `codex login status` 并核验账号；这不会将凭据传回网站。systemd 环境可能与交互 shell 不同。用绝对 `codexExecutable` 和受控的用户服务环境配置 PATH、代理或 CODEX_HOME；不要将带密码的代理 URL 写入网页或诊断输出。不要把 Gateway 环境整体传入 Agent。

与 VS Code／code-server 共享会话时，IDE 的 Codex 与 Agent 还须位于同一台机器、同一Linux用户并使用相同 `CODEX_HOME`；例如用户 `operator`、`/home/operator/.codex`。两个入口打开相同规范项目目录，在工作台“Codex 会话”中选择原生记录。不要为了共享去复制登录缓存、合并数据库或移除原生锁。同一条会话应轮流使用，另一端仍占用时先在那里结束任务并关闭会话；工作台完成一轮后释放自己的原生进程。跨机器云同步不在此功能范围内。

## Nginx 与 HTTPS

`deploy/nginx/remote-workbench.conf` 是新增站点模板，端口显式为 4080。替换独立子域、证书路径、Gateway 端口，人工审查与现有站点无冲突后再安装。安装器不会改 Nginx。执行 `nginx -t` 通过后由现有运维流程 reload。

模板关闭应用访问日志、代理响应缓冲、代理请求缓冲、磁盘临时响应文件和代理缓存，保留 SSE。Gateway 不记录请求体、响应体、项目正文或聊天正文。其 SQLite 只保存网站账号哈希、会话、连接秘密引用、身份固定记录和限速计数。网页会话使用 HttpOnly/Secure/SameSite Cookie，修改请求必须携带准确 Origin 和 `x-csrf-token`。

Gateway 默认不信任 X-Forwarded-For；使用反代时，配置 `trustedProxyIps` 为反代的精确来源 IP，并让 Nginx 用 `$remote_addr` 覆盖该请求头。只有指定代理传来的单个合法 IP 用于登录限流，Host、Origin 与 Cookie 校验不依赖转发头。每 IP 滚动 15 分钟内失败 10 次后，从第 10 次失败开始暂停登录 15 分钟；成功登录不累计失败。每个 Gateway 数据库另有每 60 秒 60 次密码校验尝试的全局上限（成功也计入全局额度），不同监听共用数据库时共用额度。规则持久化，重启不清除新限流记录；旧版限流桶不再参与判定。已登录请求不受登录限流影响。具体部署步骤见 [Nginx + Tailscale 登录限流](login-rate-limits.md)。

### 云端 Nginx 经 Tailscale 反代

云服务器可以终止 HTTPS，再通过 Tailscale 将请求转发到本机 Gateway。例如 `https://relay.example.com:14080` → `http://100.64.0.10:4080`。已有 LAN 和 Tailscale HTTP 入口可以继续使用。

在本机 `.runtime/gateway.json` 添加以下字段，保留其他字段原值，包括 `publicOrigin`、`host`、`allowLanHttp`、`secureCookies:false`、`tailscaleHost`、账号和连接配置：

```json
"tailscaleProxyOrigin": "https://relay.example.com:14080"
```

该字段必须是精确的 HTTPS origin，包含对外端口，不带路径、末尾斜杠、查询或片段，并要求已配置 `tailscaleHost`。在此例中 `tailscaleHost` 为 `100.64.0.10`，Gateway 端口仍为 `4080`。外部域名只由 Tailscale 监听接纳，LAN 主监听仍只接纳原配置地址。

云服务器配置可参考 [`deploy/nginx/remote-workbench-tailscale.conf`](../deploy/nginx/remote-workbench-tailscale.conf)。模板已使用上述域名、端口和上游地址，需替换证书路径，并确认云服务器可访问上游。Nginx 用 `proxy_set_header Host $http_host;` 保留 `relay.example.com:14080`；`$host` 会丢失对外端口。保留浏览器原始 Origin，不要将 Host 或 Origin 改成上游 Tailscale 地址。模板关闭缓冲与缓存，保留 SSE 流式响应。

Gateway 按 Host 选择入口，再严格核对相应 Origin 和 CSRF token。HTTPS 入口使用独立的 `__Host-` 前缀、Secure、HttpOnly Cookie，即使原 HTTP 入口仍设置 `secureCookies:false`。各入口需分别登录，使用同一账号密码。

本机完成构建并更新配置后，只重启 Gateway，Agent 的活动任务继续运行：

```bash
npm run build
systemctl --user restart remote-workbench-gateway.service
```

云服务器运行 `nginx -t` 检查配置，通过后按现有运维流程 reload Nginx，再访问 `https://relay.example.com:14080`。

## 备份、升级与回退

对 Gateway 和每个 Agent 数据库使用 SQLite 在线备份，不单独复制正在写入的主数据库文件：

```bash
node_modules/.bin/tsx scripts/backup-database.ts \
  /home/alice/.local/state/remote-workbench/agent.sqlite \
  /home/alice/private-backups/agent-2026-09-19.sqlite
```

目标目录应预先建立为 0700；备份文件以 0600 保存，已存在的目标会被拒绝。备份可能包含会话和项目内容，应留在该远端用户的授权存储，不上传到 Gateway。配置及令牌另行使用受控的秘密备份流程。

升级前从 `/status` 或网站任务页核对所有 Agent 的活动任务，等待结束或明确接受中断。保存当前版本、配置、协议生成记录和数据库备份。在独立新发行目录安装依赖、构建和测试，核验新版本兼容性，再更新用户服务单元。安装脚本不会重启已有服务；由用户明确执行相应 `systemctl --user restart remote-workbench-*.service`。Gateway 重启不会停止远端任务；Agent 重启可能中断 Codex 与外部命令，重启恢复不自动重复请求。

回退时先停止目标服务，恢复相配套的发行目录与兼容数据库备份，保留失败版本的私有数据供调查，再启动。不要将旧程序直接指向可能不兼容的新数据库。不得运行 git reset、清理用户项目或覆盖 Codex 凭据作为回退方案。

## 卸载与日志

预览卸载：

```bash
node_modules/.bin/tsx scripts/uninstall-service.ts \
  --component agent \
  --config /home/alice/.config/remote-workbench/agent.json \
  --node /opt/node24/bin/node
```

添加 `--apply` 才会 stop、disable 并移除本安装器创建的那一个用户服务。Agent 存在活动任务或无法确认任务状态时会拒绝，需要用户明确接受中断后再指定 `--allow-interruption`。配置、数据库、项目、Codex 登录、令牌和 SSH 密钥全部保留；删除秘密、撤销 SSH authorized_keys、公网域名/证书和 Nginx 新站点属于另行明确的管理员操作。卸载不会改动 linger 或其他服务。

服务日志使用 `journalctl --user -u remote-workbench-agent` 或 `remote-workbench-gateway`。沿用管理员现有 journald 限额与轮转策略；首次上线核验保留时间和磁盘上限。本仓库不修改系统全局日志配置。诊断 SSH 失败时网页仅显示固定分类错误，不回显可能带有主机环境秘密的原始 stderr。

## 当前验证边界

自动化测试覆盖 Gateway 登录、会话恢复/失效、Origin/CSRF、登录限速、连接所有权、身份变化拒绝、路由白名单、Range/SSE 透传和 SSH 参数安全。Unix socket 集成测试验证关闭 Gateway 后远端服务仍独立存在。系统 OpenSSH 跨真实服务器、两名真实 Linux 用户、linger、Nginx TLS、手机睡眠/网络切换以及真实主机密钥变化仍需部署环境验收，不能把单元测试通过视为这些项目已通过。

参考：[OpenSSH ssh(1)](https://man.openbsd.org/ssh)、[Node.js 24 SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)、[Fastify Reply](https://fastify.dev/docs/latest/Reference/Reply/)。

## 文件服务与共享项目补充

统一 `/srv/projects`、公共锁目录和新建项目的管理员操作，见 [统一共享项目](shared-projects.md)。

`sensitivePaths` 应包含自定义的网关/Agent 配置、私密缓存与凭据目录；文件服务默认拒绝工作台标准私有目录、Codex和SSH路径。本地setup配置拒绝整个`.runtime`。不要将密码文件放进可预览的普通项目路径。

`taskUmask` 默认 `0022`，共享协作可配置 `0002`。它只作用于Codex子进程；服务秘密仍按0700/0600显式创建。参与同一共享项目的Agent必须使用同一个管理员创建的`sharedLockDirectory`，目录2770、正确用户组，并确保父目录允许参与者进入。无法证明被当前用户私有祖先目录隔离的目录按共享范围处理，即使项目根本身0755，也可能包含组可写文件。没有共享锁配置时拒绝运行，避免一方用私有锁、另一方用共享锁。

`npm run release` 生成不含凭据的源码包及 SHA-256 文件。传输发行包后，先在对应目录运行 `sha256sum -c remote-workbench-0.1.0.tar.gz.sha256`，再解压到独立发行目录。包不包含node_modules；目标必须以Node24运行`npm ci && npm run build`。任何远端上传、安装和启动仍按已确认目标和安装器流程执行。

## 切换 Linux 用户

网页登录账号与 Agent 的 Linux 运行用户是两个独立身份。例如连接使用 Linux 用户 `operator`。网页右上角工作区菜单中的“服务器和 Linux 用户”只能选择已经配置的连接，不能通过改显示名切换系统身份。

为另一个用户新增连接时：

1. 以目标普通用户部署独立 Agent，使用该用户的 HOME、Codex 登录、项目根目录、私有状态目录和令牌，按上面的用户服务步骤启动。
2. 在 Gateway 配置的 `profiles` 中新增该用户的连接，填入实际 UID、用户名和 HOME，以及匹配的令牌引用。同机不同用户推荐通过 SSH 连接本机、转发目标用户的私有 socket；不要放宽原有 socket 或用户目录权限。SSH 服务、专用密钥和核验过的 known_hosts 必须已配置。字段示例见 `deploy/gateway/config.example.json`。
3. 重启 Gateway 后，在网页“服务器和 Linux 用户”中选择新连接。保留原连接可随时切回；新用户使用自己的 Codex 会话历史。

若原地替换已有连接身份，必须先按本页 `expectedIdentity` 段落处理身份固定记录，不能只修改用户名。切换 Linux 用户不会迁移原用户文件、Codex 登录或会话记录。

### 旧版用户服务的批量实例

已有实例的日常更新优先使用上面的模板服务。旧版 `scripts/deploy-local-users.sh` 用于首次创建 systemd 用户服务，需要显式指定网卡地址、独立发行目录、完整 Codex 运行目录，以及每个已存在的 Linux 用户和端口。它不会选择默认用户或默认网络地址。

以下均为示例；先完成 `npm run build`，替换参数后检查：

```bash
bash scripts/deploy-local-users.sh \
  --lan 192.168.10.20 --tailscale 100.64.0.10 \
  --release /opt/relay-users-v0.2.0 \
  --codex-dir /absolute/path/to/codex-runtime \
  --instance user1:4081 --instance user2:4082 --check
```

`--check` 只校验参数，不验证系统用户、网卡或文件，也不改系统。实际部署需管理员审阅参数，去掉 `--check` 并以 `sudo bash` 执行同一命令。执行时会检查地址已分配到本机、用户不是 UID 0，并保留已有实例凭据。脚本会复制程序至指定发行目录、启用所选用户的 linger 和服务；配置、密码和日志位于各用户私有目录。

## 共享历史多账号升级

该版本把命名账号拆为独立授权环境和共享执行环境，默认共享根 Agent 的 Codex home（例如 `/home/operator/.codex`）。不需要退出 owner 或重新授权已有账号。VS Code 必须使用同机同用户的相同目录；不同机器、其他 Linux 用户的历史不在此共享范围。

升级前保存共享 Codex 目录及各账号目录的私密备份；Relay 数据库使用 SQLite 备份 API。等实例任务空闲后，在已注册源码目录运行 `npm run build`，然后执行 `sudo systemctl restart relay@operator`（其他实例替换用户名）。服务启动器会按源码生成发行快照。浏览器刷新后，账号下拉框的默认项为「跟随 Codex」。命名账号首次访问会复制旧 rollout 到共享目录，保留原件和迁移校验清单；认证文件与数据库不合并。

若出现 `history_migration_required`，先结束旧／目标会话占用再重试；存在同 ID 内容冲突或迁移后旧记录改变时，检查原件与共享版本，不能靠删除锁或盲目覆盖解决。迁移后的账号授权目录只用于授权，不再用于 CLI／IDE 执行。回退程序时也必须保留共享目录新增记录；旧账号目录是迁移时的保留副本，不代表最新对话，不能直接覆盖回去。

自动化测试使用隔离凭据和本地模拟回复，不能替代真实双账号续聊或实际 VS Code UI 验收。实际授权、额度及模型请求应使用部署者自己的账号验证；实验协议升级时需要重新验证。

## 为新用户添加实例

已有 Linux 用户可用 [新增 Relay 用户实例](add-relay-user.md) 中的独立入口。自动接入统一共享项目配置，只安装指定用户，不需要重新停止全部既有实例。
