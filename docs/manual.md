# Relay 使用手册

文中的域名、IP、用户名和路径均为示例，请替换为自己的配置。

首次使用推荐 [简易安装](quickstart.md)。本文保留完整功能、限制和旧版迁移说明。

手机友好的自托管远程 Codex 工作台。浏览器负责对话和预览，Gateway 负责网站登录与 SSH 连接，远端 Linux 用户的 Agent 负责文件、持久任务和官方 `codex app-server`。

实现规格见 [plan.md](../plan.md)，逐项实测结果和未验证边界见 [实施状态](implementation-status.md)。这不是 OpenAI 官方产品。

## 手动部署（默认局域网）

需要 Linux、Node.js 24、Python 3、OpenSSH，以及已通过 ChatGPT 登录的 **Codex CLI 0.154.0-alpha.6.2**。项目固定依赖与协议；默认账号沿用官方登录缓存，命名账号由独立官方授权进程管理，Relay 仅在内存中读取其访问令牌供执行进程使用。系统 Node18 不满足生产运行要求；本开发目录已附带独立 Node24，`npm run` 会优先使用它。

```bash
npm ci                    # 新环境请用 Node24 执行
npm run build
npm run setup             # 默认允许浏览当前用户 home，敏感目录始终拒绝
npm run dev
```

打开 `.runtime/login.txt` 中的局域网地址（例如 **http://192.168.1.20:4080**）。首次部署自动选择唯一的私有 IPv4 网卡；多网卡时使用 `npm run setup -- --host 192.168.1.20` 指定，仅本机使用可指定 `--host 127.0.0.1`。默认不启用 Tailscale 或公网中转。账号为 `owner`，随机密码在 `.runtime/login.txt`（0600）。配置在 `.runtime/agent.json` 和 `.runtime/gateway.json`，重复 setup 不覆盖配置或密码。

可通过 `npm run setup -- --root /absolute/projects --port 4080` 指定首次配置。网站登录后，选择“打开远程文件夹”；打开后即可运行 Codex，无需额外确认项目信任。底部权限菜单支持只读、可编辑和完全访问。可编辑使用项目沙箱并按需审批；完全访问允许项目外文件和联网，命令不再逐项审批，仍受 Linux 用户权限限制。权限切换适用于新任务；文件回滚只覆盖项目快照，Enter 换行，点击箭头发送任务。仓库内的 `examples/welcome` 是权限0700的独立练习目录，可用来开始。可被其他用户进入的共享项目需要先配置共同目录锁，见部署文档。

顶部保留历史、新对话和会话入口；中间滚动查看记录，新对话页保持留白。模型、推理强度和任务权限均在底部输入框内选择。任务中心以会话为单位聚合多轮提问，显示该会话的当前状态，打开后回到完整记录。模型、推理强度和权限按连接／项目在当前浏览器持久记忆，断线重连或重开页面会恢复；新项目仍默认只读。连接身份和账号信息收在工作区菜单。文件夹入口显示已选项目，再次打开目录选择器时从该项目开始。

选择项目后，点击右上角工作区菜单中的“终端”进入 Terminal，在当前项目目录启动远端 Linux 用户的交互式 shell。手机界面提供 Ctrl、Esc、Tab、方向键、Home/End、常用符号和 Ctrl+C；Ctrl 点击后作用于下一个字母，点击“键盘”可重新唤起系统键盘。终端随可视区域缩放，关闭终端会结束 shell 及前台命令；页面断开超过 5 分钟会回收终端。终端按 Linux 用户权限运行，不使用对话中的任务权限模式或文件回滚。

输入框支持点击“添加图片”或直接粘贴截图；可预览、移除，也可只发图片。每条消息最多 4 张 PNG、JPEG 或 WebP，原图最大 20 MiB，发送前会自动缩放压缩；细小公式建议先裁剪截图。图片随消息交给支持图片的模型，刷新页面后仍能查看已发送的图片。上传失败时请移除后重新添加。

首次配置可用 `npm run setup -- --codex /绝对路径/codex` 明确选择已验证版本。本机使用从已安装 IDE 扩展复制的完整运行目录 `.runtime/codex/0.154.0-alpha.6.2/`，Agent 指向其中的 `codex`；扩展升级或清理旧目录不会删除这份副本。系统 PATH 中的旧 CLI 不因此改变。当前模型目录实测包含 GPT-6 Astra、GPT-5.6 Sol/Terra/Luna 和 GPT-5.5；网页显示账号实际返回的可用模型。

`npm run dev` 是本机验证进程，退出会停止服务。常驻运行推荐下面的 `relay@用户名` 系统服务；公网入口使用 HTTPS。完整配置见 [部署文档](deployment.md)。

## 常驻服务与更新

已有本机实例只需迁移一次（在此目录执行）：

```bash
sudo python3 scripts/relay-service.py install \
  --users operator user1 user2 user3 user4 --public-host relay.example.com
```

此后在这个文件夹更新代码，再重启需要更新的用户即可；自动安装变更的依赖、构建并加载新版本：

```bash
sudo systemctl restart relay@user2
```

如果首次加入 Kimi 后重启报 `Program symlink escapes its package: .../node-pty/build/node_gyp_bins/python3`，需要更新旧的系统发布助手。新脚本会跳过 node-gyp 的编译缓存，保留原生运行库和其他软链接安全校验。在本源码目录执行：

```bash
sudo install -o root -g root -m 755 scripts/relay-service.py /usr/local/libexec/relay-service
sudo systemctl reset-failed relay@operator
sudo systemctl restart relay@operator
```

将 `operator` 换成需要恢复的实例用户名；更新助手不会重启其他实例。

旧版服务配置启用了 `NoNewPrivileges=true`，其内置终端无法使用 `sudo`。新版模板设置为 `false`，保留系统原有的 sudo 密码与授权规则。已有实例需从电脑本机终端或独立 SSH 执行一次（内置终端无法解除自身继承的限制）：

```bash
sudo sed -i 's/^NoNewPrivileges=true$/NoNewPrivileges=false/' /etc/systemd/system/relay@.service
sudo systemctl daemon-reload
sudo systemctl restart relay@operator
```

将 `operator` 换成目标用户；重启后重新打开内置终端。其他实例在各自重启后生效。

全部更新：`sudo systemctl restart relay`。查看状态：`systemctl status relay@user2`；日志：`sudo journalctl -u relay@user2 -f`。

如果提示 `Unit relay.service not found`，说明只安装了旧版 `relay@.service` 模板。在本目录执行 `sudo python3 scripts/relay-service.py install-group`，补装总入口及实例关联；此命令不会启动、停止、重启或重建任何实例。安装后再等任务空闲，重启目标实例加载新代码。未安装总入口时，也可以直接使用 `sudo systemctl restart relay@operator`（将 operator 换成目标用户）。

迁移保留每人的配置、密码、会话、Codex 登录及端口，停用旧的两个用户服务，并启用开机启动。公网端口按现有端口加 10000 注册：4080→14080、4082→14082。Nginx 需将对应端口代理到 Tailscale，并用 `proxy_set_header Host $http_host;` 保留端口。

源码仍在本目录，构建以源码所属普通用户执行，程序发布到 `/opt/relay` 供各用户读取；用户数据保留在原私有目录。未重启的实例继续运行原版本。重启会同时重启该用户的 Agent 和 Gateway，请等该实例的任务完成再操作。首次迁移会检查活动任务并在发现任务时停止迁移。详细机制和适用范围见 [模板服务](deployment.md#relay-模板服务推荐同机多用户)。

## 局域网访问

新部署默认使用可信局域网地址。已有版本仍保留原配置；若原来只监听 `127.0.0.1`，可按以下方式切换到局域网：

```bash
npm run lan                         # 只有一个私有IPv4网卡时自动选择
# 多网卡时指定：npm run lan -- --host 192.168.10.20
npm run dev                         # 已运行的开发服务需要先在空闲时停止，再启动
```

命令更新 `.runtime/gateway.json` 的主监听地址、`publicOrigin` 和 `allowLanHttp`，并更新 `.runtime/login.txt` 的访问地址；账号、密码、Agent配置保持原值。其他设备使用该文件中的 **HTTP局域网IP地址**，无需在手机输入127.0.0.1，也不要改用HTTPS或其他主机名。LAN主监听仅绑定选定私有网卡，已配置的Tailscale监听继续保留；不监听0.0.0.0，Origin、CSRF和登录保护仍生效。

这是可信局域网的HTTP模式；公网仍使用HTTPS反代。若IP通过DHCP改变，重新运行`npm run lan`并重启Gateway。若已绑定LAN但其他设备仍超时，再检查双方网络、Wi-Fi访客隔离及主机防火墙的对应端口；不要直接关闭防火墙。生产环境只重启Gateway，Agent的活动任务继续运行；本地`npm run dev`会同时管理两个进程，应先确认任务空闲。

## 远程管理（0.2.0）

右上角「工作区菜单」→「远程管理」（位于「账号管理」下方）。在办公室局域网或本机入口登录后，可检测 Tailscale 状态、启用或关闭当前实例的远程监听，无需重启 Gateway 或 Agent。

首次使用需管理员在办公室服务器安装并登录 Tailscale；窗口提供安装命令，网页不会自动执行 sudo。登录后刷新检测，勾选「启用 Tailscale 远程访问」并保存。远程设备加入同一个 Tailscale 网络后，使用窗口显示的地址和原网站账号密码登录。

可选「使用云服务器中转」：填写云端公网 IPv4、访问域名、HTTPS 端口（默认 443）和云端 Tailscale IPv4，生成 Ubuntu / Debian + Nginx + Certbot 的部署步骤。域名需解析到云端公网 IP；云端加入同一个 Tailscale 网络。完成云端步骤并在窗口保存后，外部用户通过 HTTPS 访问，无需安装 Tailscale。指引保留 Host 和自定义端口、支持流式响应，并配置精确的云端代理 IP 信任。生成代码并不代表已经完成云端部署。

远程配置写入当前 Gateway 的私有配置文件，原局域网地址、密码和项目保持不变。只有本机 / 局域网入口允许修改配置，公网及 Tailscale 入口只读。关闭远程访问会断开远程浏览器连接，但不会退出系统 Tailscale 或停止 Agent 任务。外部描述文件强制指定公网入口的旧 `relay@用户` 部署显示只读，继续由管理员维护，以免覆盖统一配置。

发行包及升级步骤见 [0.2.0 发布说明](releases/0.2.0.md)。

## Tailscale访问（命令行方式）

服务器已连接Tailscale时，可在保留现有局域网或本机地址的同时，增加Tailscale监听：

```bash
npm run tailscale
npm run dev                         # 已运行的开发服务需要先在空闲时停止，再启动
```

命令通过 `tailscale ip -4` 读取本机地址，并核对该地址已分配给本机网卡，再写入 `.runtime/gateway.json` 的 `tailscaleHost`。原监听地址继续可用，新监听使用相同端口；账号密码相同。连接Tailscale的设备使用 `.runtime/login.txt` 新增的 **Tailscale地址**，例如 `http://100.64.0.10:4080`，请保留HTTP协议和端口。两个地址的浏览器登录会话分别保存。

此命令仅适用于现有HTTP开发配置，不修改Tailscale系统配置。Gateway只增加选定Tailscale IPv4的监听，继续验证Host、Origin、CSRF和网站登录。若设备仍无法连接，核对两端Tailscale状态，以及该设备到服务器对应端口的网络访问策略。

如果由云服务器 Nginx 将 `https://relay.example.com:14080` 反代到 `http://100.64.0.10:4080`，在 `.runtime/gateway.json` 增加 `"tailscaleProxyOrigin": "https://relay.example.com:14080"`，保留原有 `publicOrigin`、`host`、`allowLanHttp`、`secureCookies:false` 和 `tailscaleHost`。Nginx 必须传递包含端口的原始 Host（`proxy_set_header Host $http_host;`），并保留浏览器的 Origin。HTTPS 入口使用独立的 Secure Cookie，原 LAN 和 Tailscale HTTP 直连继续可用。配置后只需重启 Gateway：`systemctl --user restart remote-workbench-gateway.service`。完整示例见 [云端 Nginx 经 Tailscale 反代](deployment.md#云端-nginx-经-tailscale-反代)。

## 在同一个 owner 登录中切换 ChatGPT 账号

打开右上角「工作区菜单」→「账号管理」→「AI 账号」，填写账号名称并点击「添加账号」。选择新账号后点击「通过设备码登录 ChatGPT」，打开官方授权页，确认浏览器中登录的是目标 ChatGPT 账号，再输入设备码；完成后页面自动更新邮箱、订阅、模型和额度。授权中途可以取消，刷新页面后也可以重新点击登录以恢复未结束的授权流程。

以后直接使用工作区菜单或账号窗口中的「AI 账号」下拉框切换，owner 登录、端口和访问地址不变。默认项「跟随 Codex」沿用共享 Codex 目录的官方登录，最多额外添加 8 个独立授权的命名账号。所有账号使用同一个执行 `CODEX_HOME`，因此都能从「Codex 会话」查看 VS Code 和其他账号的原生历史。切换时自动打开当前会话的原生 ID，下一次提交使用新选账号；已经提交的任务继续由原账号执行。任务中心汇总各账号任务，重叠目录的任务仍按目录锁排队。

“跟随 Codex”会同步同一系统用户、同一 `CODEX_HOME` 和凭据存储环境中的官方登录。页面可见时约每 15 秒查询一次，账号窗口打开时每 5 秒查询，切回窗口时也会查询；后端共享 10 秒短缓存，通过独立的官方进程读取账号、模型和额度，不直接读取默认账号的凭据正文。外部换号后无需重启 Relay；每轮任务启动时重新建立执行进程，因此排队中的默认账号任务使用实际启动时的登录。Relay 不会为同步账号而重启或强行切换运行中的任务。命名账号仍使用各自的独立授权。不同用户、目录或凭据存储中的登录不属于同一个同步范围。

命名账号的 `stateDir/accounts/<账号ID>/codex/` 用作官方授权环境，设备码登录和令牌刷新由该环境中的 Codex 完成。Relay 后端读取其中的访问令牌，通过实验性 `chatgptAuthTokens` 接口注入共享历史下的临时执行进程；执行进程使用 `ephemeral` 凭据存储，不覆盖共享 Codex 数据目录中的登录文件，也不向网页发送令牌。进程重启时重新注入，授权失效时提示重新登录。`state/` 仍独立保存 Relay 任务、事件与项目映射；原生对话内容共享，浏览器草稿分别保存。

升级后首次访问旧命名账号时，会在原生 writer 锁保护下复制其旧 `sessions/` 和 `archived_sessions/` 到共享目录，保留原 ID 和原件，不合并 SQLite 或凭据。迁移遇到占用、同 ID 冲突或迁移后旧目录又被改写时会报错，避免覆盖记录。迁移完成后请只通过共享执行目录继续对话，不再用旧授权目录运行任务。详见 [部署说明](deployment.md#共享历史多账号升级)。

## 账号管理与删除

「账号管理」分为 **AI 账号** 和 **服务器身份** 两页。AI 账号页集中展示已添加账号、当前登录信息与对应额度，可添加、切换及删除命名账号；服务器身份页展示服务器远端身份、项目路径与连接诊断。

删除前会在页面内显示确认说明。删除将终止该账号尚未完成的设备码授权，移除其保存的凭据、Relay 任务记录及独立 Kimi 会话；项目文件和 ChatGPT 共享 Codex 历史保留。活动任务、排队任务或会话维护期间拒绝删除。删除当前账号后回到“跟随 Codex”，该默认入口不可删除。此操作仅管理 Relay 保存的数据，不注销第三方平台账号或取消订阅。

## 添加和切换 Kimi Code 账号

打开「工作区菜单」→「账号管理」→「AI 账号」，在「新账号类型」选择 **Kimi Code**，填写名称并添加。点击「通过设备码登录 Kimi Code」，在官方授权页确认目标 Kimi 账号并完成授权。登录后模型菜单显示该账号的实际模型与推理选项；可直接在「AI 账号」菜单切换 ChatGPT 和 Kimi Code，网站登录与地址不变。

Kimi 使用同一套 Kimi 登录账号，但需要具备 Kimi Code 权益。接入通过官方 **Kimi Code CLI 2.0.2** 的设备码授权与 ACP，不使用网页版 Cookie，也不需要 Moonshot API Key。CLI 已作为固定 npm 依赖包含在项目中，`npm ci` 安装；默认随 Agent 的 Node24 启动，不需要额外全局安装。可在 Agent 配置中用 `kimiExecutable` 指向同版本的独立 CLI。

每个连接最多增加 8 个 Kimi Code 账号，与 8 个命名 ChatGPT 账号分别计数。Kimi 的配置、官方管理的凭据和会话保存在 `stateDir/accounts/<ID>/kimi/`，Relay 的任务记录保存在同账号的 `state/`；浏览器不接收访问令牌。切换账号保留项目选择，使用目标账号自己的对话，不跨 Kimi 账号或 ChatGPT/Kimi 迁移上下文。已经提交的任务由原账号继续执行，各账号仍共用项目目录锁。刷新页面或重启 Agent 后可继续 Relay 中的 Kimi 对话。

Kimi 的权限菜单为「规划（Plan）」「工具审批」「完全访问」，对应官方 ACP 的 `plan`、`default`、`yolo`。这些是 Kimi 自身的规划和审批策略，**不提供 Codex 的项目文件沙箱**；完全访问自动批准工具操作，执行仍受当前 Linux 用户权限限制。支持流式回复、图片、工具确认、选项提问与取消任务。Kimi 问题目前按官方 ACP 提供的选项作答，不支持自定义答案。

「账号管理 → AI 账号」会通过官方 Kimi CLI 查询当前账号的剩余额度，显示官方返回的 5 小时、每周、月度窗口与重置时间，以及加油包余额和月消费上限。额度按账号隔离、自动刷新；查询失败明确提示，不推算剩余次数。查询临时启动仅监听本机、保留身份验证的官方服务，查询后关闭，OAuth 凭证与续期由官方 CLI 管理。邮箱和套餐仍受 ACP 信息限制。顶部「Kimi 会话」可查看当前账号在 Relay 中创建的历史，支持当前项目／全部项目筛选和继续对话。此接入暂不支持浏览／导入外部 Kimi CLI 历史、从指定轮次分支或文件回滚，Relay 内已保存的对话记录可正常查看。ChatGPT 原有共享历史与分支能力保持可用。

更新运行中的实例需要在任务空闲时重启对应 Relay 服务，加载新的 Agent、Gateway 和前端。真实账号的授权确认需要你在 Kimi 官方页面完成。

## 添加和切换 Claude 订阅账号

在「账号管理 → AI 账号」选择 **Claude** 并添加账号，点击「登录 Claude 订阅账号」，打开官方授权页并确认目标 Pro／Max 等支持 Claude Code 的订阅账号。如果官方页面显示授权码，将其粘贴回 Relay 的「Claude 授权码」并点「完成登录」；CLI 也可在收到官方回调后自动完成登录。授权码仅交给正在等待的官方登录进程，不写入数据库。取消、过期或删除账号会停止该登录进程，旧登录的授权码不能提交到新流程。

接入使用固定的官方 **Claude Code CLI 2.1.280**，通过其 `stream-json` 与控制协议执行任务；npm 安装包含平台原生程序，无需全局安装。默认采用订阅登录，执行环境会清除主机上的 Claude／Anthropic API Key、OAuth 环境令牌及其他云认证覆盖，不回退到 API Key。可以用 `claudeExecutable` 配置同版本的独立 CLI。真实订阅权益和模型访问由 Anthropic 判断；未完成官方授权前，不代表已验证真实模型调用。

每个连接最多增加 8 个 Claude 账号，与 ChatGPT、Kimi 分别计数。账号目录为 `stateDir/accounts/<ID>/claude/`，官方凭据与会话在其中的 `.claude/`，任务记录在同账号的 `state/`。凭据存储和续期由 CLI 管理；Relay 通过官方 `auth status` 查询状态。账号切换使用各自的对话，并沿用 Relay 项目目录锁。CLI 运行时不加载额外的 user/project/local settings 或外部 MCP 配置。

支持模型列表、可用推理等级、文字流式回复、图片、工具审批、交互提问、取消及重启后的会话续接。权限菜单使用「规划（Plan）」「工具审批」「完全访问」，对应 Claude 的 `plan`、`default`、`bypassPermissions`，不是 Codex 的操作系统文件沙箱；完全访问自动批准工具，仍受当前 Linux 用户权限限制。网页会话列表只展示此账号在 Relay 中创建的历史。本版不支持额度查询、外部 Claude 历史导入、指定轮次分支或文件回滚。

更新后需在任务空闲时重启目标 Relay 服务，加载新的 Agent、Gateway 和前端。自动化测试使用隔离 CLI 协议夹具；真实 CLI 已用于验证未登录状态、初始化模型目录、生成官方授权链接和取消登录，真实订阅登录后的模型调用需要用户授权后验证。

## 与 VS Code／code-server 共享 Codex 会话

Agent 与 IDE 的 Codex 必须运行在**同一台 Linux、同一用户、同一 `CODEX_HOME`** 下，例如用户 `operator` 和 `/home/operator/.codex`。点击顶部历史图标 **“Codex 会话”**，默认查看全部可访问项目的记录，无需先打开该项目。每条会话显示所属路径；打开后自动切回原项目，保留原生会话 ID。新发现的项目可直接继续任务，无需逐个确认信任。

在 IDE 追加内容后，可手动刷新工作台；浏览器重新获得焦点时也会刷新共享历史，可见页面约每 5 秒自动读取最新记录。另一端运行状态无法从历史确认时显示“运行状态待确认”，不会仅凭未完成记录宣称执行中断。同一会话需在两端轮流使用：另一端仍持有会话时，Codex 会返回占用提示。可以先在那一端结束任务并关闭该会话，再回工作台重试；也可以点击“在此接管”，核对同一进程占用的主对话及子代理会话，并二次确认中断。普通发送不会自动接管。工作台完成一轮后会释放原生进程，便于 IDE 继续。

列表可切换为“当前项目”，仅包含允许目录内的 OpenAI 顶层会话，过滤敏感、已删除和被替换的目录及子代理。历史显示最近最多 100 轮和有界文本，达到上限会提示截断；完整记录仍由本机 Codex 保存。不提供跨机器云同步，浏览器草稿、阅读位置和引用分别保存。

## 已实现

- 手机“对话／文件／预览／任务”分页与桌面文档、文件、对话布局。
- Gateway 网站登录、scrypt 密码、持久 HttpOnly Cookie、CSRF/Origin、登录限速、连接所有权、SSH 严格主机验证、真实 Agent 身份核对。
- Codex 真实账号、模型／推理选项、多个额度窗口、流式内容、同机 IDE 各项目原生会话共享、审批与问题、确认取消；拒绝 API Key 与自定义模型提供方回退。
- Agent SQLite 任务、事件回放与状态快照、持久请求去重、崩溃中断／不确定状态、代际审批、目录与重叠目录执行锁。
- 远端目录选择与分页文件树、Markdown/GFM/KaTeX、相对图片、PDF.js 页码／缩放／选择文本／固定版本 Range、代码和图片只读预览。
- Git 差异和非 Git 文件变化观察、选中文字加入下条指令、按工作区恢复草稿／预览位置。
- 独立服务模板、预览后安装／卸载脚本、在线 SQLite 备份、API 文档、测试、诊断和发行包。

### 文件上传与下载

文件面板提供“上传文件”（支持多选）和“上传文件夹”，上传到当前浏览的远端目录并保留文件夹层级。单文件最多 100 MiB，每批最多 10000 个文件，显示进度、取消和逐项失败原因；同名文件不会覆盖，需重命名后重传。项目任务运行期间不能提交上传，已完成的文件保留。文件夹选择取决于浏览器支持；浏览器文件夹选择器不包含空目录，空文件可以上传。

勾选文件或文件夹后点“下载所选”：单个文件直接下载，多个文件或文件夹打包为 ZIP。单文件保留原始字节，图片不会压缩；ZIP 保留项目相对路径和空目录。一次下载原始内容最多 256 MiB、10000 项、64 层目录。打包跳过受保护路径、链接及无法读取的项目，并显示跳过数量。准备好后交给浏览器保存；手机上的保存位置取决于浏览器。

上传分块兼容现有 1 MiB 代理请求限制。传输沿用网站登录、连接与账号授权，无需额外 SSH 密钥或开放端口。上传暂存 30 分钟无操作后清理；下载临时副本有效 5 分钟，不是公开分享链接。功能升级需更新发行版并重启对应 Relay 实例。

### 项目外文件预览

聊天中的绝对文件路径（例如 `/tmp/relay-ui-review/shot.png`）会直接进入预览，不切换当前项目或会话。支持图片、PDF、Markdown 和文本；临时 Markdown 中的相对图片与文件链接以该文档所在目录解析。

Agent 的 `roots` 仍控制项目浏览范围。额外只读预览目录由可选配置 `previewRoots` 控制，未配置时为 `["/tmp"]`；设为 `[]` 可关闭额外目录。预览文件须位于 `roots` 或 `previewRoots` 内，并通过当前 Linux 用户的读取权限、敏感路径、符号链接和文件类型检查。额外预览目录不会自动成为项目目录，也不会开放目录浏览或写入。

文件已被移动或清理、没有权限或不在允许范围内时，预览页显示对应提示。配置或后端代码变更需重启 Agent；使用独立发行目录部署的实例需更新发行版后生效。

## 验证

```bash
npm run typecheck
npm test
npm run build
npm exec playwright -- install chromium
npm run test:e2e
npm run diagnose
npm run probe             # 使用 Agent 配置中的版本探测账号、模型、额度
npm run smoke:live         # 明确执行真实 Codex，在独立测试目录写文件并验证闭环
npm run openapi
npm run release
```

浏览器自动化使用明确隔离的测试 Provider；真实 Codex 验证使用现有 ChatGPT 登录，会实际使用订阅额度。项目不会自动提交或推送 Git，不提供充值入口，不把测试 Provider 注册到生产。

## 文档

- [架构与可靠性](architecture.md)
- [实施状态与验收矩阵](implementation-status.md)
- [固定协议与实际兼容问题](protocol-compatibility.md)
- [部署、升级、卸载、备份](deployment.md)
- [故障排查](troubleshooting.md)
- [OpenAPI 3.1](openapi.json)

生产多主机／多 Linux 用户、实际手机网络切换、用户 systemd 与公网 HTTPS 仍须在目标环境验收；详见状态文档。不要把本机自动化通过当作生产部署已经完成。

回复状态使用浅色卡片、左侧色条和文字图标共同区分：蓝色执行中、黄色等待确认／待核实、绿色完成、红色失败／中断、灰色排队／取消。Codex 共享历史也使用相同样式。

### 对话分支与文件回滚

每轮结束后可点「从这里分支」，复制截至该轮的原生 Codex 对话，文件保持当前状态。手机端同样支持。

新任务执行前后会自动保存有界的项目文件恢复点。「回滚本轮（含文件）」先列出文件清单，确认后恢复任务期间新增、修改、删除的工作文件，并新建本轮执行前的对话分支；原对话保留，提问放回输入框。当前仅支持项目最近一轮，旧的 Codex/Relay 记录没有文件快照，不能补做文件回滚。任务后的其他修改若与目标文件冲突会拒绝恢复。

范围是项目工作文件，不含 Git 提交、项目外文件、外部数据库或服务。依赖目录、敏感文件、链接、特殊文件及带 ACL/扩展属性或其他属主的文件不备份，检测到它们在任务期间变更时拒绝自动回滚。单文件上限64 MiB，项目内容256 MiB、普通路径12000个，恢复最多1000个路径；私有恢复点存储预留空间后限制在2 GiB内，超过限制只禁用恢复点，不影响任务执行。执行期间请避免其他编辑器或进程同时修改项目；目录锁只能协调 Relay 任务。

恢复点位于 Agent 私有状态目录的 `checkpoints/`。恢复有持久日志，普通失败会尝试撤销已执行的恢复动作；断电、进程中断或无法撤销时，保留前后备份和日志，并阻止项目继续自动执行。应先检查 `restore-<请求ID>.json` 和数据库中的 `restoreBlocked` 记录，完成文件核对或人工恢复后再由管理员解除阻塞；不要直接删除恢复日志后重试。

Codex 的异步问题会显示选项和自定义回答框，点击“提交回答”即可在当前任务中追加回答；任务已结束时，回答会作为新一轮消息提交。未提交的选项不会自动发送。

### 会话被其他窗口占用时

打开原生 Codex 会话后，输入框上方提供“在此接管”。点击后会列出占用进程影响的全部对话；只有再次点击“确认中断 … 个对话并接管”才会结束该进程。取消不产生中断。历史和已落盘的文件修改保留，未保存输出可能丢失，外部命令可能继续运行。接管成功后可在当前窗口继续发送，不会自动重跑上一轮；浏览器或 VS Code 窗口本身不会关闭。占用者或受影响会话发生变化时需重新确认。

共享项目统一放在 `/srv/projects`，由各项目的 Linux 组控制访问，Relay 实例共用协作锁。配置迁移及新建项目命令见 [统一共享项目](shared-projects.md)。

给已存在的 Linux/code-server 用户添加独立 Relay，可用 `sudo python3 scripts/add-relay-user.py USER --apply`；默认无 `--apply` 时只预览。详见 [新增 Relay 用户实例](add-relay-user.md)。
