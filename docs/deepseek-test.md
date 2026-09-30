# DeepSeek（测试）

Relay 使用 DeepSeek 官方开源 Harness（`@deepseek-ai/dsh`，固定 `0.2.0-rc.2`）与官方 API。模型的推理、工具执行、上下文压缩及会话持久化均由官方 Harness 完成，Relay 通过官方 ACP v1 协议接入。

## 安装与使用

以运行 Relay 的 Linux 用户安装：

```bash
npm run install:deepseek
```

安装位置为 `~/.local/share/relay/deepseek/0.2.0-rc.2/`，独立于 Relay 发布目录。运行时使用 Node.js 24。需要覆盖路径时，在 Agent 配置中设置 `deepseekExecutable`。

更新并重启 Relay 后，进入 **账号管理 → 添加 AI 账号 → DeepSeek（测试）**，填写官方平台创建的 API Key，点击 **验证并保存 API Key**。模型列表读取官方 `/models`，余额读取 `/user/balance`；推理请求交给官方 Harness 的 DeepSeek Messages 适配器，访问 `https://api.deepseek.com/anthropic`。

每个连接最多添加 8 个 DeepSeek 配置，各自隔离密钥、Harness home 和会话。多个 Key 若属于同一个 DeepSeek 平台账号，可能共享余额，并不产生独立额度。模型 API 按量计费，浏览器订阅登录不适用于此接入。

密钥通过现有带身份认证和 CSRF 保护的 POST 接口提交，先验证后以 `0600` 权限原子保存；校验失败保留原配置。浏览器不会收到已保存的明文密钥。账号目录为 `0700`，文件浏览器禁止访问。任务运行或恢复点保存期间不能更换或移除密钥。

## 权限

**当前仅提供完全访问。** 输入区始终显示“完全访问 · 无审批”，不显示可选权限下拉框，后端也拒绝只读和审批模式。

官方 Harness 使用 `danger-full-access`：可以读写运行 Relay 的 Linux 用户有权访问的文件，并执行命令；不局限于项目目录，不进行逐次审批，不会因此获得 root 身份。任务恢复点只覆盖项目内受恢复机制管理的文件，无法撤销项目外的改动或外部操作。

## 已接入

- 独立 API Key 配置、验证、替换、移除与账号切换。
- 官方模型列表、推理强度选择和 API 余额显示。
- 官方完整 Harness 的文件与命令工具、上下文压缩。
- 对话及工具结果按模型步骤更新、Relay 历史查看。
- 原生会话 ID 持久映射，ACP `session/resume` 跨进程续聊。
- 任务排队、取消、失败提示；关闭会话、停止运行进程后再释放项目锁。
- 仅恢复项目文件并新建会话；不宣称回退模型记忆。
- 默认折叠的使用说明，手机输入区不被长说明遮挡。

## 当前边界

- 暂不接入图片、交互式问答卡片、规划模式和逐次审批；不要选择不存在的权限模式。对应不可交互的 Harness 插件在 Relay 配置中关闭。
- ACP 发送已提交的模型消息，并非逐 token 输出；长推理时可能较久才出现文字。当前未展示思考内容和 token 成本明细。
- 仅展示 Relay 管理的历史；未接入外部 `dsh` 会话导入、完整原生历史重放或原生分支。
- API 余额查询失败会显示暂无数据，不伪造订阅剩余次数。
- Harness 仍是开发者预览，固定版本避免自动升级改变协议。升级需重新验证。

## 验证

自动化覆盖 API Key 校验及失败保护、凭据隔离、路由限制、服务重启后的续聊、任务排队与取消、权限不可降级伪装、文件恢复点及桌面/手机浏览器流程。

安装官方 Harness 时，额外运行真实 ACP 进程，连接本地模拟 Messages 服务，验证工具执行、项目外写入、跨进程恢复和命令取消。该测试不访问付费推理服务。真实官方 API 端到端调用仍需用户提供有效 Key 后验证，不能把本地模型服务测试视为线上可用性保证。

官方资料：[仓库](https://github.com/deepseek-ai/deepseek-harness)、[ACP 协议](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md)、[API Key 管理](https://platform.deepseek.com/api_keys)。
