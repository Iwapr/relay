# 统一共享项目

文中的域名、IP、用户名和路径均为示例，请替换为自己的配置。

项目放在 `/srv/projects/<项目名>`。父目录 root 所有、0755，所有用户可以列出项目名称；每个项目使用独立组、2770 和默认 ACL，非成员无法进入。Relay 的允许根目录统一包含 `/srv/projects`，仍由文件服务与 Linux 权限约束实际访问。现有敏感路径限制不变。

所有已注册 Relay 实例使用同一个 `sharedLockDirectory=/var/lib/relay/shared-workspace-locks`，其所属组为 `relay-locks`，权限 2770。锁组只授予锁目录访问权，不授予项目权限。默认 `taskUmask=0002` 仅影响 Codex 子进程，秘密文件仍由对应代码明确设置私有权限。命名 Codex 账号继承其根 Agent 的配置，不需要逐个修改。

## 一次性配置或迁移

在真实服务器的管理员终端，从 Relay 源码目录执行。脚本自动发现 `/etc/relay/instances/*.json`；实际用户以注册文件为准。脚本不停止或启动任何服务，默认只预览。之后新增实例使用 [新增 Relay 用户实例](add-relay-user.md) 入口，会自动纳入同一配置和锁组，无需重新迁移全部实例。

先等所有实例（含各命名 Codex 账号）的任务完成，避免迁移中出现旧锁、新锁同时保护同一项目的情况。预览会检查数据库中未结束的任务和旧锁目录的租约记录：

```bash
cd /home/operator/Documents/relay
sudo python3 scripts/shared-projects.py configure
```

预览通过后，暂停接收新任务，并停止全部相关实例：

```bash
sudo systemctl stop relay@operator.service relay@user1.service relay@user2.service relay@user3.service relay@user4.service
```

应用时会再次检查任务、旧锁记录以及所有实例确实已停止。每份有改动的 Agent 配置旁保存 `agent.json.before-shared-projects-<UTC时间>` 备份，并以原服务用户身份写入新文件。保留所有已有字段、原有 roots 和敏感路径，仅追加 `/srv/projects` 并设置统一锁目录及 umask；不修改 Gateway 配置，不改变现有项目权限或成员，不创建额外的 Relay 实例。

```bash
sudo python3 scripts/shared-projects.py configure --apply
```

只有应用成功后，再启动服务；启动器也会发布当前源码中的更新：

```bash
sudo systemctl start relay@operator.service relay@user1.service relay@user2.service relay@user3.service relay@user4.service
```

刷新各自网页，打开 `/srv/projects` 或完整项目路径。已有项目的协作者和权限保持不变。其他 Relay 用户只能看到其名称，能否进入由已有项目权限决定。

如果脚本报 active/queued task 或 `.lease` 记录，先排查，不要删除租约或强行绕过。若应用中途失败，相关服务保持停止：修复原因后重跑（配置迁移可重复执行），或在服务全部停止时统一恢复配置备份及原锁目录的组/模式。不要只恢复部分实例后混用不同锁目录。

## 新建空项目

例如新建 `newproject`，协作者为 operator、user2：

```bash
sudo python3 scripts/shared-projects.py create newproject --members operator user2
sudo python3 scripts/shared-projects.py create newproject --members operator user2 --apply
```

先预览、再应用。脚本创建 `project-newproject` 组和 `/srv/projects/newproject`，设置组继承及默认 ACL，并以追加方式添加成员，不替换用户原有组。不接管同名目录或同名组，也不会递归修改已有文件。需要系统已有 `setfacl`（Ubuntu 包名 `acl`）。

新组成员身份需要重新启动对应进程才能生效。等相关用户的任务结束，再重启其 Relay 实例：

```bash
sudo systemctl restart relay@operator.service relay@user2.service
```

外部终端或编辑器需要建立新的登录会话；长期运行的 code-server 等进程也需在适当时机重新启动。之后两人分别在 Relay 打开 `/srv/projects/newproject`。无需再修改 roots 或新增锁目录。

该命令只创建空项目，不初始化 Git 仓库、不复制内容、不创建 Codex 会话。后续增加已有项目成员可由管理员追加到对应项目组，并让相关服务在空闲时重新加载组身份。

## 协作边界

同一项目或重叠目录的 Relay 任务互斥，等待者稍后重试；不保证跨实例严格先到先执行。不重叠项目可以并行。普通终端、VS Code 等外部工具不遵守这个协作锁，需要人为协调写入。目录权限和默认 ACL 能维持常规协作，但程序显式创建 0600 文件或修改权限时仍可能限制其他成员。

共享文件不共享登录、Relay 对话或任务记录。建议用 Git 保存修改记录，但不要为了 Git 操作方便而全局设置 `safe.directory=*`。大量并行开发可使用独立工作目录或 worktree，再审阅合并。
