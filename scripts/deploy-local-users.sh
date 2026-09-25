#!/usr/bin/env bash
# Legacy user-service provisioning. All deployment-specific settings are explicit.
set -euo pipefail
usage() {
  cat <<'USAGE'
Usage: deploy-local-users.sh --lan IPV4 --tailscale IPV4 --release /opt/RELEASE \
  --codex-dir /absolute/CODEX_DIRECTORY --instance USER:PORT [--instance USER:PORT ...] [--check]

--check validates arguments only; it does not check users, interfaces, files or provision services.
Run without --check as root only after reviewing the selected users and addresses.
USAGE
}
lan= tailnet= release= codex_dir=
check=false
users=()
ports=()
while (($#)); do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --check) check=true; shift ;;
    --lan|--tailscale|--release|--codex-dir|--instance)
      (($# >= 2)) && [[ -n "$2" && "$2" != --* ]] || { echo "Missing value for $1" >&2; exit 1; }
      case "$1" in
        --lan) lan=$2 ;;
        --tailscale) tailnet=$2 ;;
        --release) release=$2 ;;
        --codex-dir) codex_dir=$2 ;;
        --instance)
          [[ "$2" == *:* ]] || { echo 'Use --instance USER:PORT' >&2; exit 1; }
          users+=("${2%%:*}"); ports+=("${2#*:}") ;;
      esac
      shift 2 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done
[[ -n "$lan" && -n "$tailnet" && -n "$release" && -n "$codex_dir" && ${#users[@]} -gt 0 ]] || { usage >&2; exit 1; }
instances=()
for i in "${!users[@]}"; do instances+=("${users[$i]}:${ports[$i]}"); done
python3 - "$lan" "$tailnet" "$release" "$codex_dir" "${instances[@]}" <<'VALIDATE'
import ipaddress, re, sys
from pathlib import PurePosixPath
try:
    lan, tailnet, release, codex, *instances = sys.argv[1:]
    address = ipaddress.IPv4Address(lan)
    if not any(address in ipaddress.IPv4Network(net) for net in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')):
        raise ValueError('LAN must be a literal RFC1918 IPv4 address')
    if ipaddress.IPv4Address(tailnet) not in ipaddress.IPv4Network('100.64.0.0/10'):
        raise ValueError('Tailscale must be a literal address in 100.64.0.0/10')
    if not re.fullmatch(r'/opt/[a-zA-Z0-9][a-zA-Z0-9._-]*', release):
        raise ValueError('Release must be a named directory immediately under /opt')
    if not PurePosixPath(codex).is_absolute() or '..' in PurePosixPath(codex).parts or any(ord(c) < 32 for c in codex):
        raise ValueError('Codex directory must be an absolute path without traversal or control characters')
    users, ports = set(), set()
    for entry in instances:
        user, port = entry.split(':', 1)
        if not re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}', user) or user == 'root':
            raise ValueError('Instance user must be an ordinary Linux username')
        if not re.fullmatch(r'[1-9][0-9]{0,4}', port) or not 1024 <= int(port) <= 65535:
            raise ValueError('Instance port must be an integer from 1024 to 65535')
        if user in users or port in ports:
            raise ValueError('Instance users and ports must be unique')
        users.add(user); ports.add(port)
except ValueError as error:
    sys.exit(str(error))
VALIDATE
if "$check"; then echo 'Arguments valid; no users, interfaces, files or services were changed.'; exit 0; fi
if [[ $EUID != 0 ]]; then echo 'Run this script via sudo in an administrator terminal.' >&2; exit 1; fi
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
[[ -d "$codex_dir" && -x "$codex_dir/codex" ]] || { echo 'Codex directory must contain the supported executable and its runtime files' >&2; exit 1; }
# Verify assigned addresses before creating accounts' configuration or enabling services.
python3 - "$lan" "$tailnet" <<'INTERFACES'
import json, subprocess, sys
interfaces = json.loads(subprocess.check_output(['ip', '-j', '-4', 'addr', 'show']))
assigned = {address['local'] for interface in interfaces for address in interface.get('addr_info', [])}
if not set(sys.argv[1:]).issubset(assigned):
    sys.exit('Both selected IPv4 addresses must be assigned to this server')
INTERFACES
for user in "${users[@]}"; do
  getent passwd "$user" >/dev/null
  [[ $(id -u "$user") != 0 ]] || { echo "Refusing a UID 0 instance: $user" >&2; exit 1; }
  user_home=$(getent passwd "$user" | cut -d: -f6)
  [[ -d "$user_home" ]] || { echo "Missing HOME for $user" >&2; exit 1; }
  # Legacy code-server setup may have left .config owned by root.
  # Repair only directory ancestors; preserve all existing application files.
  python3 "$source_dir/scripts/prepare-user-service-dir.py" "$user"
  for component in agent gateway; do
    unit="$user_home/.config/systemd/user/remote-workbench-$component.service"
    if [[ -e "$unit" ]] && ! grep -q '^# Managed by Remote Workbench install-service.ts;' "$unit"; then
      echo "Refusing unrelated service: $unit" >&2; exit 1
    fi
  done
done
# Freeze a shared release. Only program files, dependencies, and pinned binaries are copied.
if [[ ! -e "$release" ]]; then
  staging=$(mktemp -d /opt/relay-users-staging.XXXXXX)
  for item in apps packages generated scripts node_modules package.json package-lock.json tsconfig.json; do
    cp -a -- "$source_dir/$item" "$staging/$item"
  done
  cp -a -- "$codex_dir" "$staging/codex"
  chown -hR root:root "$staging"
  chmod -R a+rX,go-w "$staging"
  printf 'relay-users-release\n' > "$staging/.relay-release"
  mv -T -- "$staging" "$release"
fi
[[ ! -L "$release" && $(stat -c %u "$release") == 0 && -f "$release/.relay-release" ]] || { echo 'Invalid shared release' >&2; exit 1; }
node="$release/node_modules/.bin/node"
for i in "${!users[@]}"; do
  user=${users[$i]}; port=${ports[$i]}
  uid=$(id -u "$user")
  user_home=$(getent passwd "$user" | cut -d: -f6)
  # Existing complete installs may be rerun. A fresh install must have a free port.
  if [[ ! -f "$user_home/.local/share/relay-instance/instance.json" ]] && ss -H -ltn "sport = :$port" | grep -q .; then
    echo "Port $port is occupied; no instance created for $user" >&2; exit 1
  fi
  loginctl enable-linger "$user"
  systemctl start "user@$uid.service"
  as_user() {
    runuser -u "$user" -- env -i HOME="$user_home" USER="$user" LOGNAME="$user" \
      PATH="$release/node_modules/.bin:/usr/local/bin:/usr/bin:/bin" \
      XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" "$@"
  }
  cd "$release"
  as_user "$node" --import tsx scripts/setup-user-instance.ts "$port" "$lan" "$tailnet"
  for component in agent gateway; do
    as_user "$node" --import tsx scripts/install-service.ts --component "$component" \
      --config "$user_home/.local/share/relay-instance/$component.json" --node "$node" --apply --start
  done
  for host in "$lan" "$tailnet"; do
    healthy=false
    for attempt in {1..30}; do
      if curl --noproxy '*' --silent --fail "http://$host:$port/health" >/dev/null; then healthy=true; break; fi
      sleep 1
    done
    "$healthy" || { echo "Health check failed: $user $host:$port" >&2; exit 1; }
  done
  as_user systemctl --user is-active remote-workbench-agent remote-workbench-gateway
  echo "$user ready: http://$tailnet:$port ; credentials: $user_home/.local/share/relay-instance/login.txt"
done
