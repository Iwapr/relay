# Remote Workbench：移动端远程 AI 项目工作台

## 实现设计 V1｜第一版仅支持 Codex

文档日期：2026-09-18。本文是实施设计，尚未在用户设备上部署或验证。文中“必须／应当”是本项目要求；第三方实际能力须以实施时固定的 Codex 版本和官方 schema 为准。

## 0. 产品目标与边界

做一个手机友好的自托管网页工作台。手机只发送指令、显示 AI 回复、处理确认并预览文件；项目文件读写、命令执行、编译、测试、AI 工具进程以及会话持久化全部发生在所选远程 Linux 电脑上。

用户的核心操作路径：

```text
打开工作台 → 选择服务器和 Linux 用户 → 浏览远程目录并打开一个文件夹
→ 选择 Codex 模型 → 发送任务 → 查看回复或批准操作
→ 预览项目中的 Markdown / PDF → 继续提出修改要求
```

界面借鉴 Prism 的“文档与对话共处一个工作空间”的组织方式，但使用独立品牌、独立实现。第一版只接 Codex，预留其他 AI 工具的适配接口。

### 0.1 第一版必须交付

- 单个网站登录账号可管理多个已获授权的“服务器＋Linux 用户”连接；能够方便切换连接和项目目录。
- 通过远端官方 Codex 使用该 Linux 用户已有的 ChatGPT 登录；显示真实认证方式、账号标识、额度状态、模型和推理强度。
- 流式对话、历史会话、执行状态、操作审批、用户提问、取消任务。
- 远程文件夹选择器、项目文件树、Markdown（含数学公式）和 PDF 预览、图片和文本／代码只读查看。
- 手机断线、熄屏、切换页面或切换连接，不终止远端已经开始的任务。
- 刷新和重连后恢复显示；明确区分“任务仍在运行”“连接不可用”“远端进程已中断”。
- 修改记录或差异视图；有 Git 和没有 Git 的目录都可以使用。
- AI 工具、远程连接、文件服务、会话存储和前端展示分层，未来接入其他工具不重写整个系统。

### 0.2 第一版不做

不做完整 VS Code、VS Code 扩展宿主、远程桌面、手机原生 App、Claude Code 实现、多人实时协同编辑、任意终端模拟器、跨机器自动同步项目、跨工具无损会话迁移、自动提交／推送 Git、支付／充值操作。

网站账号第一版可以只有一个拥有者；“切换 Linux 用户”表示这个拥有者切换自己有权使用的连接。它不等于允许其他网站用户随意切到这些 Linux 身份。数据模型保留网站账号所有者字段，为后续访问控制留接口。

### 0.3 复用现有环境

优先复用现有公网中转服务器、Tailscale、SSH 和 HTTPS。手机不要求安装 Tailscale。保留现有 code-server，不覆盖它的配置、认证信息、端口或 systemd 服务。

现有 user1／user5 等 Linux 用户可以共用获授权的项目目录，同时分别使用自己的 Codex 配置和登录。不要为了实现本项目而自动移动现有目录、修改整个 home 的权限或复制 AI 登录凭据。

这里的“远端执行”不代表模型离线推理：Codex 使用订阅服务时仍会访问其云端模型服务，相关上下文按工具和账户的数据政策处理。

---

## 1. 总体架构

采用三个部署组件，加一个 AI 适配层：

```text
手机 / 平板 / 电脑浏览器
          │ 同源 HTTPS：网页、请求、事件流、文件预览
          ▼
现有 Nginx → Gateway（统一入口，部署在公网中转服务器）
                   │
                   ├── SSH / Tailscale → 办公室主机，用户 user1
                   │                         └── Workspace Agent
                   │                               ├── 文件 / 预览服务
                   │                               ├── 会话 / 事件 / 任务管理
                   │                               └── Codex Adapter
                   │                                      └── codex app-server（stdio）
                   │                                             └── 实际项目和运行环境
                   │
                   ├── SSH / Tailscale → 办公室主机，用户 user5
                   │                         └── 独立 Workspace Agent 与本人 Codex
                   │
                   └── SSH → 其他获授权的 Linux 主机和用户
```

### 1.1 Web：展示与交互

浏览器只负责界面、流式消息渲染、文件预览和用户操作。它不持有 SSH 私钥、Agent 控制令牌或 Codex 登录令牌，不直接连接 OpenAI 模型接口，也不直接访问原始 Codex App Server。

### 1.2 Gateway：统一入口与连接管理

Gateway 负责网站登录、连接配置、SSH 连接池、访问授权、请求路由和流式转发。它保存连接元数据及必要的连接凭据，不运行用户项目，不执行编译，不作为项目文件的同步仓库。

所有浏览器请求必须先按网站登录身份校验它是否有权访问对应 connectionId；不能仅凭知道一个 ID 就读文件或操作任务。

### 1.3 Workspace Agent：每个远程 Linux 用户一个常驻服务

Agent 以真实目标用户身份运行，承担目录浏览、文件读取、文件变更监听、任务排队、会话持久化、事件回放及 AI 工具管理。

它由远端进程管理器独立托管。浏览器连接和 SSH 转发的生命周期不得决定 Agent 或 Codex 子进程的生死。

Agent 的文件接口独立于 Codex。即使 Codex 没登录、额度耗尽或暂时不可用，已连接服务器上的文件浏览与预览仍应可用。

### 1.4 Codex Adapter：唯一接触 Codex 协议的模块

使用官方 `codex app-server`，由 Agent 通过 stdio 驱动，转换成本项目内部的会话、任务和事件接口。[S1]

不使用普通聊天 API 重新实现文件编辑 Agent；不抓取 ChatGPT 网页；不从登录缓存提取令牌去构造非官方请求；不依靠解析终端 ANSI 画面实现核心交互。

### 1.5 数据经过网关的边界

项目权威副本、Codex 凭据和完整会话持久化留在目标电脑。预览内容和回复仍需要经过 Gateway 到达手机，Gateway 在转发时能够接触这些内容。因此此方案不声称网关对内容“零可见”。

默认不在网关持久缓存项目正文、PDF 或聊天内容；关闭相关请求体／响应体日志和反向代理磁盘缓冲。浏览器为了显示也会接收文件字节，不声称手机完全不接触文件内容。

---

## 2. 身份与核心数据模型

必须分清三种身份：网站登录账号、远程 Linux 用户、该 Linux 用户登录的 ChatGPT 账号。三者不可相互替代。

| 对象 | 关键字段／含义 |
|---|---|
| WebPrincipal | 网站使用者；V1 可仅有一个 owner |
| Host | 展示名称、地址、SSH 端口、经过验证的主机密钥 |
| ConnectionProfile | id、ownerId、hostId、SSH 用户、后端密钥引用、可选跳板配置 |
| AgentIdentity | 持久 agentId、服务版本、协议版本、实际 UID／用户名／HOME、机器标识摘要 |
| Workspace | 远端生成的 id、agentId、canonicalRoot、目录身份、执行配置 |
| Conversation | workspaceId、标题、创建时间、当前 providerSessionId |
| ProviderSession | providerId、conversationId、远端原生会话引用、账户上下文、创建时版本 |
| Run | 一次用户请求及其执行；状态、原生 turn 引用、模型、参数、时间与错误 |
| Interaction | 审批或用户输入请求；所属 run、有效期／版本、处理结果 |
| Event | agentId、单调序号、工作区／会话／任务标识、类型、负载、版本 |

### 2.1 连接切换

界面可以展示：

```text
办公室 · user1
办公室 · user5
计算服务器 · research
```

每一项是独立连接配置，不是在已有进程内执行 `su`，也不通过修改环境变量伪装成其他 Linux 用户。禁止用一个 root Agent 根据浏览器提供的 username 字段任意切换身份。

进入连接后必须读取 Agent 返回的实际身份，并与配置预期核对。身份不一致时阻止使用，不能只显示用户填写的标签。

### 2.2 工作区身份

一个工作区绑定一个已验证 Agent 身份和一个规范化远程目录。不要仅以 `/srv/projects/demo` 这个字符串识别项目。

同样路径在不同机器或不同 Linux 用户下是不同工作区。两个 SSH 别名连到同一个 Agent、同一个真实目录时，应识别为同一工作区，避免别名造成重复任务管理器。

会话绑定工作区，不在用户切换服务器时修改原会话的 cwd。不同连接之间不自动复制文件、登录或聊天上下文。

### 2.3 切换时的明确行为

切换连接或项目只切换前台视图。原任务按原状态继续执行；返回时恢复原会话和阅读位置。

输入草稿、文件预览和模型选择均按工作区保存。切换过程中暂停发送，等新连接身份确认后才允许新请求。一个已经提交的请求必须绑定提交瞬间的工作区，不能被之后的界面切换改投到别处。

顶部始终显示当前主机、Linux 用户和项目；账号详情内另外显示 Codex 认证身份，减少误操作。

---

## 3. SSH 连接与远端部署

### 3.1 推荐传输

Gateway 使用系统 OpenSSH，优先复用经过审核的 SSH alias／连接配置，不自己实现 SSH 协议。远端 Agent 监听目标用户私有运行目录中的 Unix socket；Gateway 通过 SSH 将它转发到自己的回环地址，再代理 Agent 的 HTTP 和事件流。

OpenSSH 支持把本地端口转发到远程 Unix socket。[S3]

示意而非可直接粘贴的部署命令：

```text
ssh -N -T \
  -o BatchMode=yes \
  -o ExitOnForwardFailure=yes \
  -o ForwardAgent=no \
  -o StrictHostKeyChecking=yes \
  -o ServerAliveInterval=20 \
  -o ServerAliveCountMax=3 \
  -L 127.0.0.1:<gateway-local-port>:/run/user/<remote-uid>/remote-workbench/agent.sock \
  <verified-ssh-alias>
```

实际路径、UID、端口由运行环境探测，不写死。进程用参数数组启动；不把主机名、路径或输入拼接成 shell 命令。初版只接受受控的连接字段；不提供任意 SSH 选项文本框。

Unix socket 目录权限设为 0700，socket 权限设为 0600。Gateway 本地转发只监听回环地址。Agent 还校验按连接授权的控制令牌，以免仅有网关本机访问权限的进程直接控制远端服务。

不得把原始 Codex App Server 暴露到公网。它的认证、协议和能力变化都留在 Adapter 内处理。

### 3.2 第一次连接流程

1. 选择预置密钥引用，填写主机与 Linux 用户，或选取后台配置的 SSH alias。
2. 首次连接展示主机密钥指纹，要求通过可信渠道核验；后续指纹变化必须阻止连接并给出明确错误。
3. 探测远端系统、实际 UID、HOME、运行目录、可用运行时、Codex 路径和版本、用户服务是否可用。
4. Agent 未安装时，显示待安装内容和路径，经过用户授权后上传带校验值的发行包并安装。
5. 启动目标用户自己的服务，读取 Agent 身份并配对控制令牌。
6. 获取允许浏览的根目录，进入项目文件夹选择器。

不得把 `ssh-keyscan` 返回的密钥直接当成已验证身份；不得使用 `StrictHostKeyChecking=no` 静默绕过检查。

### 3.3 用户级常驻服务

优先采用 `systemd --user`。需要退出 SSH 后继续运行、并在启动时运行用户服务的部署，应核验并按授权启用 linger；systemd 文档说明 linger 会使用户管理器在启动时创建，并在用户退出后保留。[S4]

安装器要给出确切缺失条件，不偷偷执行 sudo。无法建立可靠的用户级服务时，可提供管理员安装的固定 `User=` systemd 单元作为替代部署方式；最终 Agent 仍以目标普通用户运行。

不要将 Agent 作为普通 SSH 命令的临时子进程运行；不要依赖一个被浏览器控制的 tmux 窗口承担会话数据库职责。

### 3.4 凭据与环境

SSH 私钥只保存在 Gateway 受限目录或操作系统秘密存储中。配置数据库只存引用；网页不回显私钥。V1 优先后台预置密钥，不做浏览器粘贴私钥或保存 SSH 密码。

远端 Agent 控制令牌和状态数据用目标用户私有目录存储。每个 Linux 用户继续使用本人的 HOME、CODEX_HOME 和 Codex 登录缓存。Codex 官方支持在 CODEX_HOME 下存储凭据，也可能使用操作系统凭据存储；不能只检查有没有 auth.json 就判断登录。[S2]

诊断页显示：实际 UID、HOME、CODEX_HOME 路径、Codex 可执行文件路径／版本、项目路径、环境配置名称、网络诊断结果。不得展示凭据内容或带密码的代理 URL。

注意 systemd 的 PATH、代理环境、Python／Node／LaTeX 工具路径可能与交互终端不同。记录并核验远端可执行文件绝对路径，提供受控的用户／项目执行配置。不要将 Gateway 的环境变量传给远端工具。

Agent 私有数据显式创建为 0700／0600；项目文件权限遵从远端实际用户和项目约定。共享项目可配置任务 umask（例如 0002），但不全局修改用户 umask，不对项目进行递归 chmod。不要让私有凭据的权限策略破坏共享项目的新文件协作。

---

## 4. 界面与交互

### 4.1 桌面／平板

采用可折叠文件树＋文档主区域＋AI 对话侧栏。顶部是连接／项目切换，AI 面板上方提供工具、模型、推理强度、权限模式和账户状态。

不复制 OpenAI 标志或让用户误以为这是官方 Prism。文档区和聊天区是本项目自有组件。

### 4.2 手机竖屏

顶部固定简洁身份栏：

```text
办公室 · user5             切换
example-project              打开其他文件夹
Codex · 已登录            模型 / 额度
```

底部入口采用“对话／文件／预览／任务”。当前视图占据主要屏幕，不强行缩成三栏。文件树用抽屉，模型和额度用弹层。

任务列表可显示其他已授权连接上正在运行或等待确认的任务；远端不可达时标明“最后已知状态”，不能把缓存状态冒充实时结果。

### 4.3 对话

流式显示 AI 回复、命令输出摘要、文件改动、错误和确认请求；冗长输出折叠，完整内容按需展开。

提交按钮和取消按钮分离。默认 Enter 换行，通过明确按钮发送；正确处理中文输入法 composition。手机软键盘打开时输入区不能被遮挡。长列表虚拟化，增量渲染合并，避免每个字符触发整个聊天页面重绘。

会话内部模型变更默认对下一轮生效。运行中的任务明确显示它真正使用的模型；不假装点击下拉框就即时改造已在执行的请求。

### 4.4 文件与对话互联

AI 回复中的项目路径经 Agent 校验后可点击打开。文档中可以选择文字并“加入下一条指令”，生成可删除的上下文引用：路径、文件版本、行号／页码、选中文本。

只预览一个文件，不自动将它的全部内容发送给 AI。引用 PDF 页码也不等于模型已收到对应页面图像。V1 可附页码和用户选出的文本；复杂 PDF 页面提取或视觉输入作为后续能力，不能悄悄假装已完成。

切换对话与预览后，保留草稿、文件页码、缩放与阅读位置。服务端确认文件已经变化时，提示并刷新相关预览。

---

## 5. 远程文件夹与预览服务

### 5.1 “打开文件夹”语义

文件夹选择器显示远端文件系统，不调用手机的本地目录选择器。

支持当前用户 home、管理员允许的额外根目录、最近打开和收藏。目录逐层加载，支持输入完整远程路径；不把所有项目硬编码到一个固定目录，不要求是 Git 仓库。

允许根目录由远端策略约束，例如本人 home 和 `/srv/projects`；根据现有共享安排可显式增加其他项目路径。浏览器不能自行扩大允许范围。对于 home 下的敏感配置目录，文件服务仍应拒绝返回凭据。

第一次打开项目显示真实路径和读写权限，明确项目是否可信。项目配置、AGENTS.md、插件／MCP 等可能影响工具行为；不要自动把任意目录标为可信，也不要自动覆盖已有项目配置。

### 5.2 文件接口边界

项目打开后，前端主要提交 workspaceId 和相对路径。Agent 执行目录解析、范围校验和 Linux 权限校验。路径处理必须覆盖：`..`、空字节、重复编码、符号链接、目录替换、中文、空格、特殊文件名及同名前缀绕过。

不能只用字符串 `startsWith(root)` 判断范围。V1 默认拒绝指向授权范围外的符号链接；最终打开文件时也要检查，不能把一次 realpath 结果当成永久授权。安全打开需要防止路径解析与使用之间的竞态；采用经验证的受约束路径解析方式，必要时使用 Linux 安全路径打开辅助模块。

敏感文件和目录（例如 `.ssh`、`.codex`、工作台秘密存储）不能通过文件预览接口暴露；隐藏文件开关不能绕过这条规则。这个限制仅是文件服务边界，不代表同一 Linux 用户运行的任意命令天然无法读这些位置；AI 执行还必须受实际沙箱策略控制。

第一版文件树默认只读。主要文件写入由 Codex 完成；无需先实现一个完整手工代码编辑器。

### 5.3 Markdown

推荐使用 React Markdown 生态的渲染组件，支持 GFM、代码块、目录跳转、行内／块级数学公式和相对路径图片。公式渲染可用 KaTeX。

默认关闭不可信原始 HTML；对链接协议和资源路径做校验。远程图片默认不自动加载，以避免泄露访问行为。相对图片请求仍受项目文件权限限制。SVG 不当作可信 HTML 内联执行。

### 5.4 PDF

采用 PDF.js 进行浏览器预览。[S6]

必须支持分页、缩放、适应屏宽、全屏、页码跳转和文本选择。文件接口支持规范的 HTTP Range 请求及 206／416 响应，避免每翻一页都重新传输整个文件。

预览使用明确文件版本和校验标识。PDF 被重新编译时，不能把不同版本的字节范围拼接进同一个阅读实例。可以在远端为正在预览的 PDF 建立有大小上限和过期清理的只读快照；快照属于远端用户私有缓存，不同步到网关。

文件变更后提示“有新版本”，或在用户允许时自动刷新；尽量保持页码和缩放，页数减少时夹到有效范围。

### 5.5 其他文件与性能

图片用受限图片预览；文本和代码用只读高亮。未知二进制显示元数据和明确下载操作。HTML 默认显示源码，不在工作台同源页面直接运行。

对大文件设置可配置的预览上限；目录分页，按需展开。监听当前项目和实际打开的文件，排除无关依赖树；即使 PDF 在 build 子目录，打开后也要单独监听它，不能被全局忽略规则误伤。

PWA 的 Service Worker 只缓存静态应用资源；默认不离线缓存认证接口、项目正文或会话内容。

---

## 6. Codex 接入与订阅

### 6.1 实施前生成当前版本协议

先探测实际 `codex --version`，固定通过测试的版本，生成对应 TypeScript／JSON schema。官方提供的命令是：[S1]

```bash
codex app-server generate-ts --out ./generated/codex
codex app-server generate-json-schema --out ./generated/codex-json
```

协议类型不凭记忆手写，生成产物记录 CLI 版本、生成命令和时间。升级时重新生成并跑契约测试，不自动无条件追踪最新版。

### 6.2 最小官方接口映射

下列接口名称来自官方文档；具体参数、枚举和响应以选定版本生成的 schema 为准。[S1]

| 本项目需求 | Codex 接入点 |
|---|---|
| 建立协议连接 | initialize → initialized |
| 读取身份 | account/read |
| 登录 | account/login/start；优先设备码流程，支持时启用 |
| 模型与推理选项 | model/list |
| 额度 | account/rateLimits/read；对应 updated 通知 |
| 新建／继续会话 | thread/start、thread/resume |
| 历史读取 | thread/list、thread/read |
| 发起／停止任务 | turn/start、turn/interrupt |
| 流式输出与完成 | turn/*、item/* 通知 |
| 操作审批与问题 | 服务端发起的请求及对应响应 |

stdin／stdout 用于协议，stderr 用于独立诊断。完成 initialize 响应后发 initialized，再调用业务方法。JSON-RPC 的响应、通知和服务端主动请求必须正确区分，审批不能被当成普通日志丢弃。

浏览器只调用本项目自己的业务接口，不允许发送任意 upstream method。未知但不敏感的显示事件可降级；未知执行／审批请求必须失败关闭，不能自动同意。

### 6.3 运行时结构

每个 Linux 用户一个 Agent。Codex App Server 建议按工作区惰性启动，每个工作区的进程管理多个本工作区会话；设进程数上限，空闲后可卸载，运行或等待确认的任务不能因前台切换被卸载。

各进程继承该远端用户的 HOME／CODEX_HOME；cwd 和项目执行配置从已授权工作区确定。禁止对一个全局 Node 进程调用 process.chdir 来切换不同并发项目。

登录／注销按该用户的账户上下文串行处理。在存在活动任务时，不允许网页静默切换 Codex 登录；明确提示这可能同时影响该用户其他使用同一登录缓存的工具实例。

V1 只保证管理工作台自身创建的会话。读取和接续现有 CLI／IDE 会话是后续兼容性功能，不能默认宣称所有原版 VS Code 会话都可无损接管。

### 6.4 订阅认证

Codex 支持 ChatGPT 登录和 API Key 登录，两种计费方式不同。[S2]

本项目 V1 明确要求使用远端官方 Codex 的 ChatGPT 登录。启动任务前检查真实认证方式和有效模型提供方；发现 API Key 模式或不符的提供方时提示用户并阻止静默启动，不自动删除现有配置，也不回退到按量 API。

已有登录能用时直接复用。无头登录优先采用官方设备码方式；浏览器只显示授权地址和一次性用户码。设备码能力不可用时给出官方本机登录流程说明，不自行设计 OAuth 换票服务。[S2]

Codex Token 由官方工具保存和刷新。工作台不将其复制给 Gateway 或手机。

### 6.5 额度与费用边界

设计一个可容纳多个额度窗口的结构：窗口名称、已用百分比、窗口时长、重置时间、来源、更新时间、是否过期、可选账户／计量范围。按实际返回数据呈现，不把窗口固定成“5 小时＋7 天”。

可以由已用比例计算展示用剩余比例，但不能把它换算成精确“还能问多少次”。缺字段显示“暂无数据”；请求失败显示缓存及其时间，不生成假的满额或零额度。

额度按真实账户／计量范围理解，不把每个项目或每台服务器当成额外赠送的独立额度。相同账户在其他客户端的活动也可能影响本界面看到的状态。

分别显示“订阅额度”“会话上下文占用”“可用 credits／费用相关信息”。不把 token 计数标为实际账单。

本项目能保证不主动切换为 API Key、不调用充值接口，并可在检测到用尽时阻止新的请求；但账户已有 credits 如何消耗由服务端和账户设置决定，不能据此承诺绝对不会产生或消耗额外付费额度。官方定价页明确说明 included limits 和 credits 的区别。[S7]

### 6.6 模型选择

模型和推理选项从 Adapter 的实际能力输出生成。支持分页，正确处理失效模型和账号变化。显示名与实际模型 ID 分开。

每个 Run 记录实际使用的模型和参数。选择改变默认作用于下一轮；正在执行的轮次不改标。模型不支持某个选项时隐藏或禁用，并向用户说明。

### 6.7 沙箱与审批

第一版提供“只读检查”和“项目内编辑”两种用户可理解的权限模式，通过当前 Codex 支持的沙箱／审批参数实现。[S5]

不要仅以 cwd 或提示词作为安全边界。应检查最终生效的读、写、网络与审批策略；不能将“限制写入项目”误称为“只能读取项目”。额外读取根目录、网络访问、系统修改和高权限命令须按策略确认。

默认不启用 full access，不运行 root Codex，不开放绕过沙箱的通用命令 API。对已有插件／MCP 的能力，要么正确处理它们的审批和输入请求，要么在 V1 明确禁用不支持的能力。

审批卡片显示真实命令／资源、目录、原因和风险范围。支持当前请求允许的同意、拒绝或取消操作。未知权限请求不自动批准。

---

## 7. AI Provider 抽象：为未来扩展保留正确接口

只抽象工具差异，不制作通用模型代理平台。文件系统和 SSH 不放入 Provider。

以下是逻辑接口草图，具体类型由项目实现；它不是可独立编译的完整源码：

```ts
interface AIProviderAdapter {
  readonly id: string;
  capabilities(): ProviderCapabilities;

  getAccount(): Promise<AccountState>;
  listModels(): Promise<ModelInfo[]>;
  getQuota(): Promise<QuotaState | null>;
  beginLogin?(request: LoginRequest): Promise<LoginChallenge>;

  createSession(input: CreateSessionInput): Promise<ProviderSessionRef>;
  resumeSession(ref: ProviderSessionRef): Promise<ProviderSessionRef>;
  startRun(input: StartRunInput): Promise<ProviderRunRef>;
  interruptRun(ref: ProviderRunRef): Promise<void>;
  answerInteraction(input: InteractionAnswer): Promise<void>;

  subscribeEvents(handler: (event: ProviderEvent) => void): () => void;
}
```

capabilities 描述会话恢复、模型选择、推理选项、额度、审批、用户输入、取消和附件等能力。布尔值或枚举由真实工具支持情况决定，不给未来 Claude 填假数据。

统一事件至少覆盖：

```text
run.started / run.state_changed / run.completed / run.failed
message.delta / message.completed
tool.started / tool.output / tool.completed
interaction.required / interaction.resolved
files.changed / quota.updated / account.updated
provider.warning
```

原生会话 ID、审批 ID 和特定扩展放在受控 Provider 引用／元数据中；前端不遍布 Codex 专用字段。不要为了统一格式而丢弃审批或失败信息。

未来一个 Conversation 可拥有多个 ProviderSession，显示成有工具来源标记的连续对话。新增工具时建立新的原生会话，显式传递用户授权的交接上下文；不宣称复制一个 threadId 就完成迁移。V1 不实现跨工具切换，只验证这一数据结构和适配边界。

可以使用 Mock Provider 做契约测试，但生产界面只展示已经安装并通过探测的 Codex。

---

## 8. 任务、重连与可靠性

### 8.1 进程与观察者分离

Agent 持续监听 Codex 事件，浏览器只是事件订阅者。最后一个浏览器关闭时，不取消任务、不关闭 App Server、不释放正在运行任务的写锁。

Gateway 重启或 SSH 隧道重建也遵循同样规则。系统不依赖手机浏览器后台常驻或无限保活。

### 8.2 状态分离

连接状态独立维护：connecting、online、offline、identity_mismatch、auth_failed。

Run 状态建议为：

```text
queued → starting → running → waiting_approval / waiting_input
                         ↘ cancelling
最终状态：completed / failed / cancelled / interrupted / uncertain
```

网络断线只能导致“无法获取实时状态”；不能直接把远端任务标为 failed。上游确认取消后才标 cancelled；“发出了取消请求”不等于已成功停止全部外部进程。

远端 Agent、Codex 进程或整机真正重启时，不承诺正在执行的命令无缝继续。恢复历史后重新核对文件和任务状态，标为 interrupted 或 uncertain；不要自动重复执行可能有副作用的任务。

### 8.3 事件持久化与回放

Agent 在本地数据库中保存规范化事件，分配持久递增序号，先提交事件与状态更新，再向浏览器推送。

采用 HTTP POST 提交操作＋SSE 接收事件。SSE 通过 Gateway 原样流式转发，浏览器根据最后收到的 agentId／seq 恢复订阅。后端提供状态快照和历史分页；事件已清理时返回“需快照同步”，不能静默漏消息。

事件须包含正确工作区／会话／任务标识；界面按照这些标识分流，不能只按“当前打开哪个聊天”接收文本。

### 8.4 防止重复执行

每次发送、审批和取消操作带 clientRequestId。Agent 持久化去重记录，重复 ID＋相同负载返回同一结果，重复 ID＋不同负载返回冲突。

无法对上游外部副作用简单宣称 exactly-once。尤其在上游已经接受请求、但 Agent 尚未写入原生任务引用就崩溃的窗口，必须先对照原生会话历史进行恢复；无法确定时标记 uncertain，由用户决定下一步，不盲目重新发起。

重连默认只补拉状态和事件，不重发用户任务。手机草稿可保留，但离线期间不自动排队发送危险操作；恢复连接后重新确认目标连接。

### 8.5 审批恢复与竞争

每个 Interaction 绑定具体 Agent、Provider 进程代际、会话、任务和原生请求 ID。审批结果只提交一次；多设备重复点击返回已经处理的状态。

原进程重启后，旧审批必须失效，不能将一个旧的“同意”提交给新进程恰好同号的请求。断网待审批时保持等待；不为了无人值守自动批准。

### 8.6 同一目录的并发写入

V1 默认同一实际工作目录只有一个由工作台管理的写任务。可以有多个会话，但写任务排队；不同目录可并行。

共享项目同时由 user1 和 user5 的 Agent 打开时，启用同主机跨用户的协作式文件锁。锁数据放在专门的服务目录，不往项目里自动增加控制文件。锁名依据验证过的机器身份和目录真实身份生成，不能仅依据前端 workspaceId。

共享锁目录需要管理员按参与用户组正确授权，锁随远端执行生命周期持有，不能随 Gateway 离线释放。没有完成跨用户锁时，不允许宣称同目录并发已安全；应阻止该共享目录的第二个写任务或明确不开放此使用模式。

还须检测打开目录之间的包含关系：同一项目与它的子目录不应当作完全独立的并发写范围。第一版可以禁止重叠目录同时进入写任务。

这种锁只约束遵守协议的工作台 Agent，不能阻止外部 VS Code／终端修改文件。外部变化应提示并重新读取。强隔离并行工作可在后续使用不同 clone／Git worktree。

---

## 9. HTTP 接口与存储责任

### 9.1 对浏览器的接口草案

以下是本项目自定义接口，不是 OpenAI 官方 API。实现时输出 OpenAPI 文档并固定错误结构。

```text
POST /api/login
POST /api/logout
GET  /api/me

GET  /api/connections
POST /api/connections                         # owner 管理操作
POST /api/connections/:c/connect
GET  /api/connections/:c/identity
GET  /api/connections/:c/status

GET  /api/connections/:c/fs/roots
GET  /api/connections/:c/fs/directories        # 受限的远端目录选择器
POST /api/connections/:c/workspaces/open
GET  /api/connections/:c/workspaces

GET  /api/connections/:c/workspaces/:w/tree
GET  /api/connections/:c/workspaces/:w/file     # Range、版本、权限校验
GET  /api/connections/:c/workspaces/:w/changes

GET  /api/connections/:c/providers
GET  /api/connections/:c/providers/codex/account
GET  /api/connections/:c/providers/codex/models
GET  /api/connections/:c/providers/codex/quota
POST /api/connections/:c/providers/codex/login

POST /api/connections/:c/workspaces/:w/conversations
GET  /api/connections/:c/workspaces/:w/conversations
GET  /api/connections/:c/conversations/:id
POST /api/connections/:c/conversations/:id/runs
POST /api/connections/:c/runs/:id/cancel
POST /api/connections/:c/interactions/:id/answer

GET  /api/connections/:c/snapshot
GET  /api/connections/:c/events?afterSeq=...    # SSE
```

Agent 对 Gateway 暴露相似的受限业务接口。Gateway 路由要校验各个资源间真实关联，不能把 connectionId、workspaceId、conversationId 随意混搭。私有令牌放请求头，不放 URL、日志或浏览器存储。

统一错误类型至少包含：permission_denied、path_outside_workspace、connection_offline、identity_mismatch、auth_required、unsupported_feature、quota_unavailable、run_conflict、stale_interaction、uncertain_operation、file_changed。

浏览器不能通过请求参数指定任意转发 URL、任意主机端口或任意上游协议方法。

### 9.2 数据放在哪里

Gateway 的本地 SQLite：网站账号、连接配置、可信主机指纹、秘密引用、界面设置以及少量状态摘要。

每个远端用户的本地 SQLite：工作区、会话、Provider 引用、Run、Interaction、规范化事件、去重记录、阅读状态和必要快照元数据。数据库放用户私有服务目录，不放项目或共享 home 子目录；不放在 NFS 等未经验证的网络文件系统上。

Codex 的原生会话和凭据仍由其本人 CODEX_HOME 管理。工作台保存展示和可靠性所需的记录，不替代或擅自改写原生会话文件。

日志要脱敏，并设置保留、轮转和清理策略。实时数据库备份用正确的数据库备份机制，不能只复制正在写入的主文件而遗漏关联状态。

### 9.3 修改记录

有 Git 时显示 Git 状态和 diff；必须明确它可能包含任务开始前已有的改动。原生 AI 文件变更事件可作为“本任务报告的修改”，但不能因此断言捕获了所有命令产生的文件变化。

无 Git 时仍允许正常工作，并显示可捕获的文件变化。初版不承诺通用撤销。不要自动 git init、commit、stash、reset、clean 或覆盖原有改动。

后续恢复功能必须基于明确基线与当前文件校验；不能用 `git reset --hard` 作为取消任务的实现。

---

## 10. 安全与运维要求

### 10.1 最低安全配置

采用 HTTPS 和同源部署。登录使用安全密码哈希与 HttpOnly／Secure／SameSite 会话 Cookie；修改类请求校验 Origin／CSRF。公网上线前完成登录限速、会话失效、连接授权和敏感路径测试，不能将其留作上线后的优化。

Agent 绑定私有 socket，仅接受合法控制令牌；SSH 不转发代理、不默认允许 root、不关闭主机密钥检查。网站和 SSH 认证分开处理。

文件名、Markdown、AI 回复、错误信息和工具输出都按不可信内容展示。所有浏览器可见资源要防止 XSS、目录穿越和越权访问。

秘密存储要考虑 Gateway 被攻陷就可能拥有远端连接能力的风险；数据库加密并不能消除运行时网关被控制的威胁。采用独立服务账号、最小访问范围、可撤销密钥／令牌和必要审计。

### 10.2 非目标：替代强隔离安全系统

Linux 用户隔离、路径授权和 Codex 沙箱各有职责。项目可写用户、允许执行任意代码的服务和同 UID 凭据之间存在信任边界。本项目不能仅凭前端隐藏路径保证恶意项目永远无法触及凭据。

需要强隔离处理不可信仓库时，应后续增加专门执行用户、容器或其他隔离环境；不在 V1 宣称已达到这一等级。

### 10.3 部署形态

推荐 TypeScript 单仓库，Gateway 与 Agent 先使用原生 systemd 部署，便于复用宿主机已有 Codex 和项目环境。不要第一版就引入 Kubernetes、Redis、消息集群或复杂数据库服务。

网关使用新增的反代路径、端口或子域，按现有环境决定，不能覆盖已工作的 code-server 入口。Agent 用户服务采用独立名称和数据目录。

版本升级要先检查活动任务；不自动重启正在运行的 Codex。升级文档包含协议兼容、迁移、失败回退和日志位置。用户明确重启 Agent 时，说明正在执行的任务可能中断。

### 10.4 诊断

设置连接诊断页，分层展示“手机→Gateway”“Gateway→SSH”“SSH→Agent”“Agent→Codex”“Codex 登录／服务网络”。

办公室电脑睡眠、断电或到模型服务的网络不可用时，给出对应状态，不笼统显示 AI 卡住。代理、DNS、PATH、凭据存储不可访问等错误需有可定位信息，同时脱敏。

---

## 11. 技术栈与代码组织建议

采用 TypeScript 贯通前端、Gateway 和 Agent。前端 React＋Vite；后端 Fastify 或同等级轻量框架；数据库 SQLite；Markdown 用 React Markdown 生态与公式插件；PDF 用 PDF.js；远程连接使用系统 OpenSSH；测试使用单元／集成测试框架与 Playwright。

这些是本项目建议，不要求照搬某个未经核验的版本号。实施 AI 应选取互相兼容、维护中的依赖，固定 lockfile，检查安全公告并记录所选版本。不要拿此设计中的示例字段代替运行时 schema 验证。

```text
remote-workbench/
  apps/
    web/                       # 手机优先界面
    gateway/                   # 登录、连接与路由
    agent/                     # 远端常驻服务、文件、任务、事件
  packages/
    contracts/                 # 自有接口、事件、错误与运行时校验
    provider-core/             # Provider 接口和能力定义
    provider-codex/            # Codex 协议适配
    transport-ssh/             # Gateway 的 SSH 生命周期管理
  generated/
    codex/                     # 固定版本官方 schema 生成结果
  tests/
    contract/
    integration/
    e2e/
    security/
  deploy/
    gateway/
    agent-user-service/
    nginx/
  docs/
    architecture.md
    implementation-status.md
    protocol-compatibility.md
    deployment.md
    troubleshooting.md
```

禁止把身份验证、SSH、文件系统和 Codex 调用全部写进一个长文件。也不需要实现运行时插件市场；Provider 扩展先采用编译时注册即可。

---

## 12. 实施顺序与验收门槛

以下里程碑用于控制实施风险，不是工期估计。每一步交付可运行代码、测试方法和实测记录。

### M0：只读环境诊断与协议验证

探测现有服务与端口，不改动已有 code-server／Nginx／Tailscale。确认远端用户、HOME、CODEX_HOME、CLI 路径、版本、服务启动条件和项目权限。

生成当前 CLI schema，跑最小 App Server 客户端，验证账号、模型、额度与协议握手。记录支持和缺失的字段；不要伪造演示数据当实测结果。

门槛：明确所选版本可支持哪些必需能力；不支持的核心能力先解决或说明，不能进入只做 UI 的阶段。

### M1：单机单用户纵向打通

先实现 Agent＋Codex Adapter＋最小 Gateway／网页，在一个授权测试目录中完成真实任务、流式回复、至少一次确认请求及历史读取。

同时实现网站基本认证、身份显示、事件持久化与请求去重，不能把关键可靠性全留到最后。

门槛：手机输入后，实际远端文件发生预期修改；结果不是 Mock Provider 制造的演示。

### M2：SSH、多用户、多服务器

接入真实 SSH 传输、用户常驻服务、连接配置、远端目录选择和工作区绑定。实现身份核验、可信主机指纹与连接切换。

门槛：同一主机的两个用户可以独立登录和运行；可以打开不同目录；切换连接不取消原任务。至少用第二个真实或受控测试主机验证主机维度隔离。

### M3：文档工作流

完成手机优先布局、Markdown 公式与相对图片、PDF Range 和版本刷新、文件路径跳转、上下文引用、变化列表。

门槛：完成“修改文稿→远端生成或更新 PDF→手机查看新版本→继续发修改要求”的闭环。

### M4：断线、崩溃与共享目录

完成事件回放、任务快照、失效审批、取消确认、Agent 重启后的中断处理、跨用户共享目录锁与重叠目录冲突检查。

门槛：下表所有相关故障用例都有实测结果，未覆盖部分明确标注。

### M5：扩展边界与上线整理

用第二个 Mock Provider 跑契约测试，证明文件服务、SSH 和前端不绑定 Codex 结构；不实现 Claude。完善安全测试、部署脚本、升级／回退、诊断页及文档。

门槛：部署脚本幂等且不破坏现有服务；生产只显示真实可用 Provider。

---

## 13. 必须执行的验收用例

| 场景 | 通过条件 |
|---|---|
| 使用订阅 | 实际认证方式为 ChatGPT；无静默 API 回退；凭据未进入手机或网关正文日志 |
| 模型选择 | 来自当前工具能力；改变后下一轮记录实际模型；运行中任务不改标 |
| 额度缺失 | 显示未知／缓存时间；不显示伪造的剩余次数；不固定窗口时长 |
| 打开任意授权目录 | 从远程目录选择器打开；非 Git、中文和空格路径可用 |
| 两个 Linux 用户 | Agent 的 UID／HOME／CODEX_HOME 对应本人；不因共享项目切成对方账号 |
| 两台服务器同一路径 | 文件、任务和会话不混用；界面始终显示真实连接 |
| 切换工作区 | 原任务继续；草稿和预览位置按工作区恢复；待提交操作不串投 |
| 手机熄屏／关闭页面 | Agent 持续执行；重新打开可恢复事件和结果 |
| 切换 Wi-Fi／移动网络 | 不重复提交任务；重连后没有重复回复或丢失审批 |
| Gateway 重启／SSH 断开 | 远端任务不中断；恢复后从 Agent 读取真实状态 |
| Agent 或主机重启 | 不伪装任务持续成功；旧任务标中断或不确定；不自动重复副作用 |
| 重复点击发送 | 同一 clientRequestId 只形成一个本项目逻辑请求；不确定窗口有恢复策略 |
| 审批中断线 | 任务保持等待；拒绝能生效；旧进程的审批不能批准新进程请求 |
| 取消任务 | 先 cancelling 后确认最终状态；不自动回滚已写文件；异常时明确说明 |
| Markdown | 数学公式、相对图片可用；恶意 HTML／链接不能执行 |
| PDF | 大文件按需传输；重编译后不会混合新旧版本；阅读位置合理恢复 |
| 路径越权 | ../、符号链接越界、前缀绕过和敏感凭据路径不能通过文件接口读取 |
| 同目录并发 | 本工作台跨会话、别名及已配置共享用户的第二个写任务被排队或拒绝 |
| 重叠目录 | 项目根目录与其子目录的写任务冲突被检测 |
| 现有修改 | 不覆盖任务前已有变更；不自动 git reset／clean／commit |
| 隐私 | 网关／Service Worker 不持久缓存项目正文；Token、私钥不会出现在前端或日志 |
| 移动布局 | 手机竖屏可完成发送、审批、切换和阅读；键盘不遮挡输入；长输出不卡死 |
| 新增 Provider | Mock 实现通过契约测试，不修改 SSH 和文件预览模块；生产不冒充真实可用工具 |
| 安装升级 | 独立路径与服务；已存在代码服务不受影响；运行任务期间不自动升级重启 |

---

## 14. 交给编码 AI 的执行说明

请将本文作为实现规格。先阅读全文，再对实际环境执行安全诊断，列出已经具备和缺失的条件。保持现有 code-server、Nginx、Tailscale、用户权限和 Codex 登录不变；任何部署修改都应清楚记录，优先在独立目录和测试端口验证。

按 M0→M5 分阶段实现，每完成一个阶段更新 `docs/implementation-status.md`：已实现内容、实际执行过的测试、测试输出摘要、已知限制、下一步。不要一次铺出大量只有 TODO 的页面；优先证明手机指令能让远端真实 Codex 修改真实文件。

官方协议有疑问时，读取固定版本的 schema 和官方文档；不得凭空补接口或假设所有版本相同。Mock 只用于测试，不能替代生产接入；没有实际验证的项目标注“未验证”。

实现时优先保证：身份正确、凭据隔离、任务不会随手机断线消失、重连不会重复副作用、文件预览安全。然后完善 Prism 风格的文档／对话交互，最后验证 Provider 扩展边界。

最终交付可运行的完整仓库、锁定依赖、配置模板、部署与卸载脚本、协议兼容记录、验收测试和故障排查文档。首版只接 Codex，不增加 Claude 功能，不搭建通用 API Key 计费代理。

---

## 15. 核验参考

以下为本设计核验的官方文档／一手技术文档。接口应在实施时再次与选定版本核对。S1 的旧域名可能重定向到官方新文档域名。

```text
[S1] OpenAI Codex App Server
https://developers.openai.com/codex/app-server/

[S2] OpenAI Codex Authentication
https://developers.openai.com/codex/auth/

[S3] OpenBSD / OpenSSH ssh(1) manual
https://man.openbsd.org/ssh

[S4] systemd loginctl(1) manual, rendered at man7
https://man7.org/linux/man-pages/man1/loginctl.1.html

[S5] OpenAI Codex Sandboxing
https://developers.openai.com/codex/sandboxing/

[S6] Mozilla PDF.js
https://mozilla.github.io/pdf.js/

[S7] OpenAI Codex Pricing
https://developers.openai.com/codex/pricing/
```
