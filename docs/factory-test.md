# Factory Droid（测试）

Relay 使用 Factory 官方 Droid CLI `0.232.0` 和官方 TypeScript SDK `0.9.1`。模型请求、工具执行、上下文管理及原生会话持久化由 Droid 完成；使用 Factory 提供的模型，不把 Factory Key 转接到 Claude Code。

## 安装与使用

以运行 Relay 的 Linux 用户执行：

```bash
npm run install:factory
```

安装位置为 `~/.local/share/relay/factory/0.232.0/`，独立于 Relay 发布目录。安装脚本从官方 npm registry 获取固定版本并验证可执行文件。需要覆盖路径时，在 Agent 配置中设置 `factoryExecutable`。

更新并重启 Relay 后，进入 **账号管理 → 添加 AI 账号 → Droid（测试）**，填写 [Factory API Key](https://app.factory.ai/settings/api-keys)，点击 **保存 API Key**。需要的是 Factory 的 Key，不能填 Anthropic/OpenAI 的 Key。使用量及费用以 Factory 账号套餐为准，多个 Key 属于同一账号时仍可能共享额度。

每个连接最多添加 8 个 Droid 配置。密钥和 Droid HOME 按账号隔离；不读取系统中另一个 Droid 账号的登录。保存时只检查密钥格式，不发送验证请求或付费推理。密钥有效性和模型权限由首次实际 Droid 任务验证；界面明确显示尚未验证。公共 Sessions API 的访问权限不是本地 Droid 推理的前提，网关 403 或诊断告警不能作为密钥无效的证据。格式检查失败保留原配置。API Key 不回显，以 `0600` 权限原子保存，账号目录为 `0700`，文件浏览器禁止访问。活动任务期间拒绝替换或移除密钥。

模型、推理强度、图片能力读取官方 CLI 目录；过滤停用及本机自定义 BYOK 模型。目录展示不保证每个模型均有账号权益，实际调用仍由 Factory 校验。Opus 等模型可在下拉框选择，名称和可用性随官方目录变化。

## 权限

- **规划（Plan）**：Droid Spec 模式。不是操作系统只读沙箱；明确批准计划后可继续执行。
- **工具审批**：Droid Auto 模式、Autonomy Off。Droid 请求审批时显示 Relay 审批卡片；读取等操作是否要求审批由 Droid 决定。
- **自动批准（Factory 策略仍生效）**：Autonomy High，自动批准 Droid 提供的单次允许选项。不能绕过 Factory 组织策略、工具限制或操作系统权限；若账号明确禁止 High，任务会失败并提示改选权限。

执行范围由运行 Relay 的 Linux 用户权限及 Droid 策略决定，不应把规划或审批理解为项目文件沙箱。

## 已接入

- 多账号配置、切换、密钥保存、替换和移除。
- 官方模型与推理强度选择；支持图片的模型可上传图片。
- 增量回复、工具进度与结果、审批及单选/多选/自由文字提问。
- Relay 历史、跨进程和服务重启后的原生会话续聊。
- 任务排队、取消；运行进程退出并清理进程组后释放项目锁。
- 项目文件恢复点；恢复文件后新建会话，不回退 Droid 的模型记忆。
- 手机输入区使用折叠说明，避免遮住最后一行。

## 当前边界与验证

- 账号额度通过与固定版本 Droid `/limits` 相同的 `/api/billing/limits` 查询，显示 Standard/Core 的 5 小时、每周、每月剩余比例与重置时间，以及额外用量 USD 余额。最多每分钟查询一次；403、超时或格式变化显示不可用，不阻止任务。该接口是 CLI 内部接口，尚未取得此服务器上成功返回的真实数据；已保存 Key 的只读查询目前返回 403。
- 每次新任务保存 SDK 返回的输入、输出、缓存 token 及 `factoryCredits`；回复下方可展开查看，账号管理显示 Relay 已记录的累计消耗。只统计有官方返回用量的保留任务，失败或取消时未返回的消耗、旧记录以及其他客户端用量不计入。不把任务 token 数或本地累计当作剩余额度，也不把缺失 credits 显示为零。
- 当前只展示 Relay 发起的历史；未接入外部 Droid 会话导入、完整原生历史重放、原生分支或上下文回退。
- 执行中发送的新指令排队到下一轮；未接入原地 steer、Factory Missions 专属界面或独立 MCP 管理界面。
- Factory 的策略或授权错误会显示脱敏提示；不会把完整底层错误或密钥写入界面。

自动化通过真实 SDK 连接模拟 Droid JSON-RPC 进程，覆盖账号隔离、无公共 API 依赖的密钥保存与格式错误保护、续聊、审批、问答、排队、取消和桌面/手机流程；运行层测试覆盖图片传递与会话目录核验。另已用真实官方 CLI 验证版本和模型目录读取。真实付费调用仍需有效 Factory Key 验证，模拟协议测试不能证明线上额度和模型权益。

官方资料：[SDK](https://docs.factory.com/sdk/typescript)、[CLI](https://docs.factory.com/droid-cli/cli-reference)、[自动执行](https://docs.factory.com/droid-exec/overview)。
