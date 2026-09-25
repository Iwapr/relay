# Codex 协议兼容性与实测

当前固定版本为 **codex-cli 0.154.0-alpha.6.2**，平台为 Linux，与本机 IDE 扩展携带的 Codex 版本一致。2026-09-19 使用该用户已有的 ChatGPT 登录完成了升级探测。此前 0.133.0 的验证记录在下文单独标为历史证据。版本不匹配时 Adapter 拒绝启动任务；升级必须重新生成协议、运行契约测试并复查权限。

本机将 IDE 扩展的完整原生运行目录复制到 `.runtime/codex/0.154.0-alpha.6.2/`，使用其中 `codex` 的绝对路径，不依赖之后可能被替换的扩展目录，也不改系统 CLI、登录缓存或用户配置。

协议来自本机官方 CLI，而不是手写接口推测：

```bash
export WORKBENCH_CODEX_EXECUTABLE=/绝对路径/codex
"$WORKBENCH_CODEX_EXECUTABLE" --version
"$WORKBENCH_CODEX_EXECUTABLE" app-server generate-ts --out ./generated/codex
"$WORKBENCH_CODEX_EXECUTABLE" app-server generate-json-schema --out ./generated/codex-json
```

生成日期为 2026-09-19；1016 个生成产物位于 `generated/codex` 与 `generated/codex-json`，版本及 SHA-256 记录在 `generated/manifest.json`，已逐文件核对一致。运行时 Ajv 使用这些 JSON schema 校验请求、业务响应以及处理的事件。导入的 TypeScript 类型与同版本产物对应。官方参考：[App Server](https://developers.openai.com/codex/app-server/)、[配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。文档可能随新版本变化，本项目固定 schema 和实测行为优先。

## 已实现的映射

| 内部能力 | 官方接口／事件                                                                                           | 当前边界                                                                                   |
| -------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 进程连接 | `initialize` → `initialized`                                                                             | stdio 单行 JSON；stdout 协议和 stderr 诊断分离；不暴露原始 App Server                      |
| 账号     | `account/read`、`account/updated`                                                                        | 只接已有 ChatGPT 登录；API Key、非 OpenAI 提供方和自定义端点被阻止                         |
| 登录     | `account/login/start`，`chatgptDeviceCode`                                                               | 网页仅接收授权地址／用户码；已登录或运行中不切换账号；实测没有改变登录                     |
| 模型     | 分页 `model/list`                                                                                        | 使用 `model` 字段作为执行 ID，分别保留显示名称和推理选项                                   |
| 额度     | `account/rateLimits/read`、`account/rateLimits/updated`                                                  | 多计量范围、多窗口；保留实际时长和重置时刻；失败只显示缓存／未知状态                       |
| 会话     | `thread/start`、`thread/resume`、`thread/read`、`thread/list`、`thread/turns/list`、`thread/unsubscribe` | 同机、同用户、同 CODEX_HOME 的可访问项目顶层 OpenAI 会话可共享；原生 writer 锁拒绝并发接管 |
| 任务     | `turn/start`、`turn/interrupt`、`turn/started`、`turn/completed`                                         | 取消须等上游 interrupted；进程丢失标 interrupted；超时和权限核验失败可标 uncertain         |
| 流式内容 | `item/agentMessage/delta`、`item/completed`                                                              | 消息、工具输出、修改 diff、上下文 token 各自归类                                           |
| 审批     | commandExecution、fileChange、permissions 的 requestApproval                                             | 每次决定绑定进程 generation 和原生 ID；无自动批准；扩展权限只允许 turn 范围                |
| 用户问题 | `item/tool/requestUserInput`                                                                             | 按 question ID 映射答案；不传输 secret 问题；未知 server request 返回错误                  |

## 权限与本机兼容问题

提供只读、项目内编辑和完全访问三种模式。新建线程／新进程恢复线程使用只读沙箱；每轮通过生成的 `turn/start.sandboxPolicy` 显式提交该轮选择。项目内编辑允许当前目录，关闭工具网络，排除 `/tmp` 和 `TMPDIR` 的默认写权限。完全访问使用 `dangerFullAccess`，仍受运行用户的 Linux 权限约束。只读不表示只能读取项目：默认可读范围仍由官方 Linux 沙箱决定。网页不得将其描述为文件读取隔离。

只读和项目内编辑要求 `approvalPolicy=on-request`；用户选择完全访问时，本轮使用 `approvalPolicy=never`。所有模式均核验 `approvalsReviewer=user`。配置覆盖只在子进程／线程内生效，不重写用户配置。外部 MCP、apps、plugins、hooks、browser/computer tools、multi-agent 与 memories 在该工作台线程关闭；未知执行请求失败关闭，防止未实现的外部能力绕过展示。

0.133.0 的历史探测暴露了以下差异，当前适配器继续保留显式权限设置及核验：

1. 用户当前配置中的推理强度 `ultra` 不被 0.133.0 接受。App Server 在创建线程之前解析该配置，因此 Adapter 以进程参数 `-c model_reasoning_effort="medium"` 建立可用基础，线程再使用模型目录返回的默认值，每轮使用用户实际选择。没有修改原配置文件。
2. 0.133.0 的 workspace-write **线程初始化**会额外加入 `$CODEX_HOME/memories` 写根，即使 memories 已关闭。Adapter 创建／恢复只读线程，再显式设置每轮策略，避开这项默认扩权。开启该版本的 `experimentalApi` 能力以收到 `thread/settings/updated`；每轮还通过不携带覆盖的 `thread/resume` 检查已加载线程的实际模型、提供方、cwd、审批和沙箱。非预期权限会立即停止该进程并标为 uncertain。真实返回的 writableRoots 可以为空，因为 cwd 是隐含写根；并不代表没有项目写权限。

已加载的原生线程忽略 `thread/resume` 配置覆盖，所以 Adapter 直接复用它，并在下一轮重新显式设置权限。新建线程在首轮之前可能尚未落盘，`thread/read` 会返回 “no rollout found”。Adapter 对自己刚创建的线程不先读取磁盘，已有持久会话才先校验其 cwd 后恢复。

0.154.0-alpha.6.2 在本机默认将非临时新线程设为 `paginated`，运行中恢复可能返回 `-32601: list_turns is not supported yet`，即使已设置 `excludeTurns:true`。创建时明确传入 `historyMode:"legacy"`，并检查返回格式。该实验字段由同版本 `app-server generate-ts --experimental` 核实；Adapter 用已有 `ThreadHistoryMode` 类型扩展创建参数，固定内部常量，不修改用户的全局配置或旧会话格式。

每轮权限核验优先采用发出本次 `turn/start` 后收到的、同线程且通过 schema 和精确权限检查的 `thread/settings/updated`，不再为已有核验结果重复恢复线程。没有本轮有效通知时仍用不带覆盖的 `thread/resume` 复查；无法核验则停止并标记 uncertain。前一轮缓存、其他线程通知、无效或不安全通知均不能作为成功依据，后续安全通知也不能覆盖已观察到的权限异常。

0.154.0-alpha.6.2 的 `config/read` 自动返回官方默认 `chatgpt_base_url=https://chatgpt.com/backend-api/`。适配器仅接受这个确切官方默认端点（含无尾斜杠形式）；其他端点、API Key、OpenAI provider 覆盖仍被拒绝。新版结构化问题增加 `isBlocking`、`autoResolutionMs`，线程和额度也有新增字段，均由重新生成的 schema 校验。

## 原生会话共享

“全部项目”查询的 `thread/list` 不传 cwd，指定 `modelProviders=["openai"]` 和 CLI／VS Code／App Server 等顶层来源；“当前项目”查询才传规范目录。Provider 排除其他提供方与子代理，Agent 在返回标题前用文件服务检查允许根、敏感目录及目录身份，过滤已删除或被替换的项目。未选工作区也可通过 `/providers/codex/sessions` 浏览。

读取历史先调用不带 turns 的 `thread/read`，再以 `thread/turns/list` 按时间倒序分页，最多取最近 100 轮、总文本 262144 字符且单段不超过 32768 字符，返回时按时间正序展示。显示用户、助手与已支持工具的摘要，不显示 reasoning；凭据模式做脱敏。历史达到限制时返回截断标记，原生文件保持完整。

导入先读取不带 turns 的元数据，按其原始 cwd 打开项目并返回 `{workspace, conversation}`；不接受浏览器自报目录，项目无需额外的信任确认。继续使用原始 thread ID，不复制会话或改写 Codex 数据库。恢复前重新核验目录与提供方；`thread/resume` 的 `already has an active writer` 映射为 `SESSION_IN_USE`，不强行接管。工作台每轮结束且启动结果确认后释放原生进程；IDE 端需结束任务并关闭占用会话后再切换。

IDE 和 Agent 必须使用同一机器、同一 Linux 用户与同一 `CODEX_HOME`；例如示例用户 `operator` 使用 `/home/operator/.codex`。默认 IDE interactive 列表已实测能发现工作台创建的会话。网页提供手动刷新，并在重新获得焦点时更新共享历史；可见页面也会在每次读取结束后约 5 秒刷新，隐藏页面暂停轮询。不提供不同机器之间的云同步，浏览器草稿及阅读位置也不属于原生会话共享。

`notLoaded` 只说明当前 app-server 没有加载该线程，不代表其他客户端已经停止。读取另一客户端的未完成历史时，本版本可能返回 `interrupted` 但没有 `completedAt`；这种记录显示“运行状态待确认”，保留内容并继续只读刷新。只有上游明确返回执行中或有结束证据时才显示对应状态。观察历史不会恢复、接管或中断原生会话；运行状态未知的轮次不能用作已结束的分支／回滚依据。

Codex 子进程通过固定 Python 3 包装器设置独立任务 umask：默认 `0022`，共享项目可显式选择 `0002`。包装器用参数数组执行 `os.execvp`，不拼接 shell，也不改变 Agent 的全局 umask；私有状态仍显式使用 0700／0600。

共享 Codex 数据目录中的默认账号的 `auth.json` 不由 Relay 读取或重写。命名账号的 Broker 读取其专属授权缓存中的访问令牌，通过 `chatgptAuthTokens` 注入 ephemeral 执行进程；刷新仍使用官方 managed `account/read(refreshToken=true)`，不自行实现 OAuth refresh grant，不调用充值接口。模型服务仍需要访问云端；关闭的是沙箱工具网络，不是 Codex 与官方服务之间的通信。额度展示不把 credits 当作免费赠送额度，也不承诺服务端绝对不消耗已有 credits。

## 验证命令与记录

```bash
# npm 脚本使用项目 Node 24；以下显式命令同样固定 Node 24。
export WORKBENCH_CODEX_EXECUTABLE=/绝对路径/codex
node_modules/.bin/node --import tsx --test tests/provider/codex.test.ts
node_modules/.bin/node --import tsx scripts/probe-codex.ts
node_modules/.bin/node --import tsx scripts/probe-codex.ts --write
node_modules/.bin/node --import tsx scripts/probe-codex.ts --approval
node_modules/.bin/node --import tsx scripts/probe-codex.ts --cancel
# 可选完整闭环；需要系统 pdfinfo 检查生成 PDF
node_modules/.bin/node --import tsx scripts/smoke-live.ts --run
```

默认 probe 仅读取身份、模型和额度。`--write` 在 `.runtime/probe/probe-result.txt` 创建一份固定内容的文本；`--approval` 从只读模式请求 `.runtime/probe/approval-result.txt`，仅当审批的真实 patch 恰好对应这个文件且没有 grantRoot 时同意一次，其他审批一律拒绝。若目标已存在，探测停止；不会覆盖既有文件。`--cancel` 发出一条不读写文件的请求后立即取消，并确认上游最终状态。任务探测完成后还可验证停止原进程再恢复原生会话。

真实验证应在独立测试目录执行，检查认证、模型和额度读取、受限沙箱、原生历史冷恢复、active writer 锁、审批与取消。报告保留在操作者自己的 `.runtime` 中，不将账号套餐、会话统计、项目正文或测试产生的真实标识提交到仓库。模拟测试通过不代表目标账号或公网环境已验收。

当前契约测试覆盖握手顺序、动态模型 ID、中文流式内容、完成、历史读取、API Key／自定义提供方／非官方端点／不安全沙箱拒绝、分页循环、额度读取失败、过期审批、重复审批、结构化用户答案、未知服务端请求拒绝、进程退出、已加载线程续写、最终沙箱扩权拒绝、子进程 umask、设备码登录、上游确认取消及启动结果不明时先停止原生进程。新增覆盖 IDE 会话发现、目录／提供方／子代理隔离、历史顺序／脱敏／上限、占用冲突与释放后重新恢复。设备码登录和人工自由输入使用生成协议及模拟协议测试；没有为验证而替换本机账号。浏览器／Gateway 断线恢复、持久去重和跨用户锁由 Agent／Gateway 测试负责，不由 Adapter 单独宣称通过。
