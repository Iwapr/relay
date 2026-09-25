# 简易安装

## 首次安装

需要 Linux x64 / arm64 和普通用户账号。Ubuntu / Debian 缺少基础工具时，先安装：

```bash
sudo apt-get update
sudo apt-get install -y git python3 curl xz-utils ca-certificates util-linux
```

在 clone 得到的项目目录执行：

```bash
./install.sh
```

安装器依次完成：

1. 复用已有 Node.js 24，或从 nodejs.org 下载官方 Node 24 并核对 SHA-256。下载版本由官方 `latest-v24.x` 清单确定。
2. 使用锁文件安装项目依赖。Codex CLI 优先复用兼容版本，否则从官方 npm 仓库安装项目要求的固定版本到 `.runtime/tools/codex`；不替换全局 CLI。
3. 选择局域网网卡，检查可用端口（默认从 4080 到 4100），构建并生成随机密码。
4. 在 systemd 用户管理器可用时安装两个用户服务并启动；否则完成配置后提示使用前台启动。

项目数据、私有工具和下载缓存都位于 `.runtime`；依赖位于 `node_modules`。源码、工具、配置和服务使用当前普通用户，不自动执行 sudo，也不修改系统防火墙或公开公网端口。

安装完成后，终端会显示访问地址及对应运行模式的启动、关闭、重启和日志操作。随时可用 `./relay help` 再次查看。

终端显示访问地址。执行 `./relay info` 查看网站账号密码。登录后，在右上角「账号管理」添加并授权自己的 AI 账号；无需先手动运行 Codex 登录。默认项目允许根目录是当前用户的 home，敏感目录仍拒绝访问。

## 退出终端后继续运行

systemd 用户服务已安装时，安装器会检查 linger。未开启则按提示执行：

```bash
sudo loginctl enable-linger "$(id -un)"
```

这是一次性的系统账户设置，允许用户服务在退出登录后继续运行并在开机时启动。它需要管理员权限，因此安装器只给出命令。

没有 systemd 的容器等环境：

```bash
./relay start
```

这是前台运行，退出终端会停止。可以使用自己的进程管理器；不要同时启动两套服务。WSL2 的访问地址和 Windows 防火墙需按自己的网络环境配置。

## 可选参数

```bash
./install.sh --root /absolute/projects --host 192.168.10.20 --port 4080
./install.sh --codex /absolute/path/to/codex
./install.sh --foreground
./install.sh --yes --host 192.168.10.20
```

- `--root`：已存在的项目允许根目录，默认当前用户 home。
- `--host`：本机实际拥有的私有 IPv4；`127.0.0.1` 为仅本机模式。多网卡且没有交互终端时必须指定。
- `--port`：1024–65535 的空闲端口；明确指定后不会自动更换。
- `--codex`：已安装的兼容 Codex CLI 绝对路径；版本不符会报错。
- `--foreground`：不安装后台服务，之后使用 `./relay start`。
- `--yes`：使用默认值；不会猜测多网卡，也不会跳过兼容性校验。

## 管理命令

| 命令              | 用途                                     |
| ----------------- | ---------------------------------------- |
| `./relay help`    | 显示当前运行模式的管理命令               |
| `./relay info`    | 显示地址、账号、密码；请勿公开输出       |
| `./relay status`  | 查看当前项目服务状态                     |
| `./relay start`   | 启动已安装的后台服务；未安装则前台运行   |
| `./relay stop`    | 停止后台服务；前台模式用 Ctrl+C          |
| `./relay restart` | 重启后台服务；先等活动任务结束           |
| `./relay logs`    | 跟踪后台服务日志                         |
| `./relay service` | 为已初始化的项目安装、启用并启动用户服务 |

同名服务属于另一份项目时，命令会拒绝覆盖或停止它。多用户场景使用 [部署文档](deployment.md) 的实例管理方式。

## 安装中断或重复安装

安装器保留现有配置、账号密码和数据。重复执行不会在正在运行的实例下重装依赖。

- 下载 / npm 失败且尚未生成配置：修复联网或磁盘问题后重新运行 `./install.sh`。
- 已有完整配置，但后台服务安装中断：用 `./relay service` 补全，然后 `./relay status` 检查。
- 只有部分配置文件：先检查 `.runtime/agent.json`、`gateway.json`、`agent.token` 和 `login.txt`。不要盲目删除；按 [故障排查](troubleshooting.md) 修复或恢复私有备份。
- 已有同名用户服务：在原项目目录管理旧服务；新项目可使用 `--foreground`，或明确卸载不再使用的旧服务后安装。
- 无法从手机访问：检查所选地址、同一局域网、Wi-Fi 客户端隔离和主机防火墙。安装器不会自动修改防火墙。

## 升级

仅适用于此简易安装器创建的独立用户服务。多用户 `relay@用户` 部署按其原管理方式更新。

先等待任务结束，备份配置和数据库（见 [备份说明](deployment.md#备份升级与回退)），然后在项目目录执行：

```bash
./relay stop
git pull --ff-only
export PATH="$PWD/.runtime/bootstrap/node/bin:$PATH"
node --version  # 应为 v24.x；使用系统 Node 的用户需保留 Node 24
npm ci
npm run build
./relay start
```

前台模式先在运行终端按 Ctrl+C。不要删除 `.runtime`，也不需要重新初始化账号。`npm ci` 或构建失败时保持服务停止，修复后再启动。协议版本变化时按发布说明升级对应 CLI。

## 手动部署与完整功能

旧的 `npm run setup`、`npm run dev`、服务安装命令仍可使用。账号、终端、文件传输、预览、分支和回滚的完整说明保存在 [使用手册](manual.md)，远程云端步骤仍由网页「远程管理」生成。
