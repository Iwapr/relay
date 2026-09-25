# 故障排查

先运行 `npm run diagnose`。诊断仅读取身份、运行时版本和服务可用性，不读取凭据正文。更多协议实测见 [protocol-compatibility.md](protocol-compatibility.md)。

| 现象                                                               | 检查与处理                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 网站打不开                                                         | 默认只监听回环地址；局域网访问先运行 `npm run lan` 并重启Gateway，再用 `.runtime/login.txt` 中的局域网地址。生产反代核对独立端口。                                                                                                          |
| Tailscale设备打不开                                                | 服务器先运行 `npm run tailscale`，任务空闲时重启开发服务；用 `.runtime/login.txt` 的Tailscale地址（HTTP、IP和端口）访问。原LAN地址仍保留。核对两端Tailscale连接状态及该端口的网络访问策略。                                                 |
| 反代提示 `Use the configured address for this workbench listener.` | 请求 Host 与该监听配置不匹配。云 Nginx 经 Tailscale 反代时，配置准确的 HTTPS `tailscaleProxyOrigin`，使用 `proxy_set_header Host $http_host;` 保留对外端口，然后只重启 Gateway。见[完整配置](deployment.md#云端-nginx-经-tailscale-反代)。  |
| 登录提示 Origin/CSRF                                               | 主监听的publicOrigin必须与地址栏一致，包括端口；Tailscale直连使用HTTP IP和端口，HTTPS反代使用准确的tailscaleProxyOrigin。只把Host改成上游IP不能解决浏览器Origin不匹配；反代应保留原始Host与Origin。修改请求需要登录返回的CSRF token。       |
| 系统Node18或 Vite native binding缺失                               | 用Node24执行 `npm ci`。若曾用旧Node安装，可在项目Node24 PATH下执行 `npm install --include=optional`；不要删除工作区或项目文件。                                                                                                             |
| SSH连接失败                                                        | 用相同服务用户核对绝对私钥路径、0600权限、已通过可信渠道核验的known_hosts；指纹变化必须调查，不能关闭StrictHostKeyChecking。                                                                                                                |
| Agent身份不一致                                                    | 核对目标实际UID/用户名/HOME和持久agentId/machineId。换机器或重装后不能自动接受新身份；先验证，再按部署文档更新固定记录。                                                                                                                    |
| Agent socket不存在                                                 | 检查目标用户独立systemd服务、RuntimePath和私有socket目录。SSH转发不会自动安装或启动Agent。                                                                                                                                                  |
| `Failed to connect to bus: No medium found`                        | 当前会话没有用户bus环境或用户管理器不可访问。检查目标机器的`loginctl`、`XDG_RUNTIME_DIR`和用户bus；需要管理员参与时明确申请，不自动sudo。不要把临时SSH子进程当常驻部署。                                                                    |
| Codex可执行文件找不到                                              | 检查 Agent 配置中的 `codexExecutable` 绝对路径；对该文件执行 `--version`，应为 `codex-cli 0.154.0-alpha.6.2`。systemd PATH 可能不同于终端，系统旧 CLI 版本不代表工作台版本。                                                                |
| Codex版本或ultra错误                                               | 当前固定 `0.154.0-alpha.6.2`，使用同版生成协议。首次配置可用 `npm run setup -- --codex /绝对路径/codex`；已有服务检查实际可执行文件配置并在任务空闲时重启 Agent。推理选项来自实际模型目录；不要只修改下拉框名称。                           |
| 模型最高仍只显示 GPT-5.5                                           | 核对 Agent 是否仍运行系统旧 Codex 0.133.0，而非配置的新版本。当前已验证目录 `.runtime/codex/0.154.0-alpha.6.2/codex` 返回 Astra、Sol、Terra、Luna 和5.5。切换配置后需在空闲时重启 Agent，再刷新模型列表；最终可用项以当前账号实际目录为准。 |
| 找不到 IDE 的 Codex 对话                                           | 点击顶部历史图标，选择“全部项目”并刷新；无需先打开原项目，选择会话后自动切回其目录。核对同机、同Linux用户、同 `CODEX_HOME`。允许根之外、敏感、已删除或被替换的目录及子代理不会列出；尚未开始首轮的会话可能未落盘。                          |
| IDE 最新回复未显示                                                 | 手动刷新共享会话，或切回浏览器让页面重新获得焦点。当前历史显示最近最多100轮和有界文本；截断不表示原生记录被删除。不同机器或不同 `CODEX_HOME` 不会云同步。                                                                                   |
| `SESSION_IN_USE` / `active writer`                                 | 同一原生会话仍由另一端持有。先在 IDE 或另一入口结束任务并关闭该会话，再回来重试；只让任务完成未必立即释放 IDE 的会话占用。不要删除锁或同时发送。工作台完成一轮后会释放自己的原生进程。                                                      |
| API Key/自定义Provider拒绝                                         | V1只接受官方ChatGPT认证。既有配置未修改；由用户在官方CLI管理目标用户配置，不删除别人的凭据、不回退API。                                                                                                                                     |
| 额度显示未知                                                       | API未返回或失败时显示真实未知/缓存时间。订阅额度、credits、token上下文占用不是同一概念。                                                                                                                                                    |
| 任务显示offline但不完成                                            | offline表示无法获取实时状态；先恢复SSH/Agent连接。不要重复发送。任务可能仍在执行。                                                                                                                                                          |
| interrupted/uncertain                                              | 先检查原生Codex会话、实际文件与外部进程；不自动重跑，不保证命令全部停止。不要用git reset/clean撤销。                                                                                                                                        |
| 任务长期queued                                                     | 检查其他会话及祖先/子目录任务、共享锁目录和不确定租约。必须确认没有存活执行后才能人工清除对应租约文件；不能只看网页离线就删除。                                                                                                             |
| shared_lock_required                                               | 共享项目需要所有Agent一致配置同一个管理员创建的2770锁目录和参与组。不要递归修改项目/home权限。                                                                                                                                              |
| 文件无法预览                                                       | 敏感路径、符号链接、硬链接、特殊文件默认拒绝；检查Linux读取权限、配置roots和sensitivePaths。默认单文件50MB。                                                                                                                                |
| 目录选择器总回到 home                                              | 当前版本记住已选项目，再次打开从项目目录开始；顶部入口也显示项目名。刷新页面加载新版界面，并确认选择的是当前连接下的项目。                                                                                                                  |
| PDF版本过期/409                                                    | 点击刷新创建新快照；旧新版本字节绝不混用。当前页码和缩放尽量保留。                                                                                                                                                                          |
| SSE反复重连                                                        | Nginx关闭proxy_buffering/proxy_cache、延长read_timeout；上游Agent身份改变或事件超出保留窗口需重新快照同步。                                                                                                                                 |

新任务出现 `Could not verify the effective turn policy ... list_turns is not supported yet` 时，检查 Agent 是否已加载当前适配器：新建线程应明确使用 `historyMode:"legacy"`，本轮权限优先依据经过校验的设置通知。更新代码后在 Relay 无活动任务时重启 Agent。旧的 uncertain 记录不会自动改成成功或重跑；若留下工作区保护锁，必须先核实对应进程已停止及已有执行记录，再处理该次锁。

共享会话显示“运行状态待确认”，表示读取到的是另一客户端尚未完成的历史，无法确认它当前是否仍在执行。可见页面会约每 5 秒刷新，不会为查看记录而接管或停止另一端。`notLoaded` 不是另一端已停止的证据。

开发账号随机密码在 `.runtime/login.txt`，不输出到日志。忘记生产密码时，在服务端使用 `hashPassword` 生成新 scrypt 哈希并更新私有配置，再按活动任务检查流程重启 Gateway；不需要重启远端 Agent。不要通过文件预览或诊断展示密码、Token、私钥或带凭据的代理 URL。

安装器默认只展示计划。执行前需明确 `--apply`，启动服务需 `--start`；不会偷偷sudo、重启活动服务或改现有反代。日志命令及回退步骤见部署文档。
