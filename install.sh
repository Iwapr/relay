#!/usr/bin/env bash
# Local bootstrap: no global Node/npm packages and no automatic sudo.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if [[ ${1:-} == --help || ${1:-} == -h ]]; then
  cat <<'HELP'
Relay installer: ./install.sh [--yes] [--foreground] [--host LAN_IP] [--port PORT]
                              [--root PROJECT_ROOT] [--codex ABSOLUTE_EXECUTABLE]
Installs private Node 24 and the supported Codex CLI when needed, builds Relay,
and configures LAN access. Run as an ordinary Linux user. No automatic sudo.
--yes uses defaults; multiple LAN interfaces still require --host.
--foreground skips systemd setup. Start with ./relay start after installation.
HELP
  exit 0
fi
[[ $(uname -s) == Linux ]] || { echo '目前支持 Linux。Windows 请在 WSL2 中部署。' >&2; exit 1; }
[[ $EUID != 0 ]] || { echo '请用普通 Linux 用户执行 ./install.sh，不要加 sudo。' >&2; exit 1; }
# A repeated install never replaces dependencies beneath a running instance.
if [[ -f .runtime/agent.json && -f .runtime/gateway.json ]]; then
  echo 'Relay 已初始化，保留现有配置与依赖。使用 ./relay status 或 ./relay start。'
  echo '升级步骤见 docs/quickstart.md。'
  exit 0
fi
for tool in python3 curl tar xz sha256sum; do
  command -v "$tool" >/dev/null || {
    echo "缺少 $tool。Ubuntu / Debian 可先执行：sudo apt-get install -y python3 curl xz-utils ca-certificates" >&2
    exit 1
  }
done
umask 077
mkdir -p .runtime/bootstrap
# Serialize installation so concurrent npm ci/configuration cannot collide.
command -v flock >/dev/null || { echo '请安装 util-linux（需要 flock）。' >&2; exit 1; }
exec 9>.runtime/bootstrap/install.lock
flock -n 9 || { echo '另一个安装进程正在运行，请稍后重试。' >&2; exit 1; }
if command -v node >/dev/null && [[ $(node --version) == v24.* ]] && command -v npm >/dev/null; then
  relay_node=$(command -v node)
elif [[ -x .runtime/bootstrap/node/bin/node && $(.runtime/bootstrap/node/bin/node --version) == v24.* ]]; then
  relay_node="$PWD/.runtime/bootstrap/node/bin/node"
else
  case $(uname -m) in
    x86_64) relay_arch=x64 ;;
    aarch64|arm64) relay_arch=arm64 ;;
    *) echo '自动下载 Node 仅支持 Linux x64 / arm64，请自行安装 Node.js 24。' >&2; exit 1 ;;
  esac
  relay_tmp=$(mktemp -d "$PWD/.runtime/bootstrap/download.XXXXXX")
  trap 'rm -rf -- "$relay_tmp"' EXIT
  echo '正在从 nodejs.org 下载 Node.js 24，并校验 SHA-256…'
  curl --proto '=https' --tlsv1.2 -fsSL --retry 2 --max-time 300 https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$relay_tmp/SHASUMS256.txt"
  relay_archive=$(awk -v arch="$relay_arch" '$2 ~ ("^node-v24\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$") {print $2}' "$relay_tmp/SHASUMS256.txt")
  [[ $relay_archive =~ ^node-v24\.[0-9]+\.[0-9]+-linux-(x64|arm64)\.tar\.xz$ ]] || { echo 'Node 下载清单不符合预期。' >&2; exit 1; }
  curl --proto '=https' --tlsv1.2 -fsSL --retry 2 --max-time 300 "https://nodejs.org/dist/latest-v24.x/$relay_archive" -o "$relay_tmp/$relay_archive"
  (cd "$relay_tmp"; awk -v name="$relay_archive" '$2 == name' SHASUMS256.txt | sha256sum --check --strict)
  mkdir "$relay_tmp/node"
  tar -xJf "$relay_tmp/$relay_archive" -C "$relay_tmp/node" --strip-components=1
  [[ $("$relay_tmp/node/bin/node" --version) == v24.* ]] || exit 1
  [[ ! -e .runtime/bootstrap/node ]] || { echo '已有不完整 Node 目录，请检查 .runtime/bootstrap/node 后重试。' >&2; exit 1; }
  mv "$relay_tmp/node" .runtime/bootstrap/node
  relay_node="$PWD/.runtime/bootstrap/node/bin/node"
fi
export PATH="$(dirname -- "$relay_node"):$PATH"
echo '正在安装项目依赖…'
npm ci --no-audit --no-fund
# The wizard handles build/configuration/startup and propagates all failures.
if [[ -n ${relay_tmp:-} ]]; then rm -rf -- "$relay_tmp"; trap - EXIT; fi
exec node_modules/node/bin/node --import tsx scripts/install.ts "$@"
