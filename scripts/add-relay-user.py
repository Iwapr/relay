#!/usr/bin/env python3
"""Add Relay to an existing Linux user. Preview by default; --apply creates and starts only that instance."""
import argparse
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import socket
import stat
import subprocess
import sys
from types import SimpleNamespace
from urllib.parse import urlsplit

spec = importlib.util.spec_from_file_location('relay_service', Path(__file__).with_name('relay-service.py'))
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)
shared_spec = importlib.util.spec_from_file_location('shared_projects', Path(__file__).with_name('shared-projects.py'))
shared = importlib.util.module_from_spec(shared_spec)
shared_spec.loader.exec_module(shared)


def public_settings(descriptor):
    # Read only public settings under the source user's identity, not root.
    script = '''import json,sys
c=json.load(open(sys.argv[1]))
print(json.dumps({k:c.get(k) for k in ['host','port','tailscaleHost','tailscaleProxyOrigin','trustedProxyIps']}))'''
    result = service.user_command(descriptor['user'], ['/usr/bin/python3', '-c', script, descriptor['gatewayConfig']], capture=True)
    return json.loads(result.stdout)


def validate_network(settings, descriptor):
    host, tail = settings['host'], settings['tailscaleHost']
    local = ipaddress.ip_address(host)
    if local.version != 4 or not any(local in ipaddress.ip_network(net) for net in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')):
        raise ValueError('Reference instance must have a private IPv4 LAN listener')
    if ipaddress.ip_address(tail) not in ipaddress.ip_network('100.64.0.0/10'):
        raise ValueError('Reference instance must have a Tailscale IPv4 listener')
    origin = descriptor.get('tailscaleProxyOrigin') or settings.get('tailscaleProxyOrigin')
    parsed = urlsplit(origin or '')
    if parsed.scheme != 'https' or not parsed.hostname or parsed.path not in ('', '/') or parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise ValueError('Reference instance must have a simple public HTTPS proxy origin')
    if not service.re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?', parsed.hostname):
        raise ValueError('Public hostname is invalid')
    trusted = settings.get('trustedProxyIps') or []
    if not trusted:
        raise ValueError('Configure trustedProxyIps on the reference instance before inheriting its proxy deployment')
    for value in trusted:
        ipaddress.ip_address(value)
    return host, tail, parsed.hostname, trusted


def free_port(port):
    try:
        # Conservative check: reject any local listener, including code-server/Tailscale.
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(('0.0.0.0', port))
        return True
    except OSError:
        return False


def choose_port(requested, reserved, public_reserved):
    candidates = [requested] if requested is not None else range(4080, 4580)
    for port in candidates:
        if not 1024 <= port <= 55535:
            raise ValueError('Relay port must be in 1024..55535 (public port = port + 10000)')
        if port not in reserved and port + 10000 not in public_reserved and free_port(port):
            return port
    raise ValueError('No free port found; choose another --port')


def nginx_config(hostname, tail, port):
    return f'''# Install on the cloud Nginx server. Requires the existing http-level relay_login zone.
server {{
    listen {port + 10000} ssl;
    server_name {hostname};
    ssl_certificate /etc/letsencrypt/live/{hostname}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/{hostname}/privkey.pem;
    client_max_body_size 24m;
    location / {{
        limit_req zone=relay_login burst=5 nodelay;
        limit_req_status 429;
        proxy_pass http://{tail}:{port};
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_read_timeout 3600;
        proxy_send_timeout 3600;
    }}
}}
'''


def add(args):
    if os.geteuid() != 0:
        raise ValueError('Run with sudo in an administrator terminal')
    account = service.account(args.user)
    source_config = service.trusted_json(service.CONFIG / 'source.json')
    source = Path(source_config['source'])
    # This entry targets the already-installed template service, not a first install.
    for target in (service.UNIT, service.HELPER):
        if not target.is_file():
            raise ValueError('Install the Relay template service first')
        service.managed_file(target, service.MARKER)
    registrations = shared.instances()
    if any(x['user'] == args.user for x in registrations):
        raise ValueError('Relay already registered for this user; refusing to replace credentials or configuration')
    reference_name = args.reference or source_config['buildUser']
    reference = next((x for x in registrations if x['user'] == reference_name), None)
    if not reference:
        raise ValueError('Reference instance is not registered')
    network = public_settings(reference)
    host, tail, hostname, trusted = validate_network(network, reference)
    settings = [(entry, public_settings(entry)) for entry in registrations]
    reserved = {int(value['port']) for _, value in settings}
    public_reserved = {urlsplit(entry.get('tailscaleProxyOrigin') or value.get('tailscaleProxyOrigin') or '').port or 443
                       for entry, value in settings}
    port = choose_port(args.port, reserved, public_reserved)
    group = shared.grp.getgrnam(shared.LOCK_GROUP)
    shared.trusted_directory(shared.PROJECTS)
    shared.trusted_directory(shared.LOCKS, allow_group_write=True)
    info = shared.LOCKS.stat()
    if info.st_gid != group.gr_gid or stat.S_IMODE(info.st_mode) != 0o2770:
        raise ValueError('Finish unified shared-project configuration before adding instances')
    config_dir = Path(account.pw_dir) / '.local/share/relay-instance'
    # Refuse partial/preexisting installs. Checked as the target user, not root.
    check = '''from pathlib import Path
import sys
p=Path(sys.argv[1])
if p.is_symlink() or (p.exists() and (not p.is_dir() or any(p.iterdir()))):
    raise SystemExit('Existing/partial instance directory: inspect it before retrying')
'''
    service.user_command(args.user, ['/usr/bin/python3', '-c', check, str(config_dir)])
    state = subprocess.run(['systemctl', 'is-active', f'relay@{args.user}.service'], capture_output=True, text=True)
    if state.stdout.strip() not in ('inactive', 'failed', 'unknown', ''):
        raise ValueError('An unregistered Relay service is already running for this user')
    print(f'User: {args.user}; LAN: http://{host}:{port}; Tailscale: http://{tail}:{port}', flush=True)
    print(f'Public URL after Nginx setup: https://{hostname}:{port + 10000}', flush=True)
    print('Roots: own home + /srv/projects; common relay-locks group; no project memberships granted.', flush=True)
    print('Code-server, Linux user, Codex login and existing Relay services are retained.', flush=True)
    if not args.apply:
        print('Preview only. Repeat with --apply to create a separate Relay login and start this instance.')
        return
    with service.build_lock():
        release = service.publish(source_config)
    # All validation precedes mutations. Keep a failed new install for inspection;
    # never delete the existing Linux user/home or rotate an existing Relay password.
    subprocess.run(['usermod', '-a', '-G', shared.LOCK_GROUP, args.user], check=True)
    service.user_command(args.user, [service.CODE / 'node/bin/node', '--import', 'tsx',
                                    release / 'scripts/setup-user-instance.ts', str(port), host, tail],
                         cwd=release, extra_env={'RELAY_SETUP_OPTIONS': json.dumps({'sharedProjects': True, 'trustedProxyIps': trusted})})
    service.install(SimpleNamespace(source=str(source), users=[args.user], public_host=hostname, port_offset=10000))
    nginx = service.CONFIG / 'nginx' / f'{args.user}.conf'
    service.atomic_write(nginx, nginx_config(hostname, tail, port))
    print('Relay ready. Password file (private, not printed): ' + str(config_dir / 'login.txt'))
    print('Cloud Nginx snippet: ' + str(nginx))
    print('Add the cloud TCP port/firewall rule, test nginx -t, then reload Nginx. No cloud settings were changed here.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('user', help='existing ordinary Linux user, e.g. alice')
    parser.add_argument('--port', type=int, help='local Relay port; automatically selected if omitted')
    parser.add_argument('--reference', help='existing Relay instance for network settings; default: registered source owner')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    os.umask(0o022)
    add(args)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Relay add-user stopped: ' + str(error), file=sys.stderr)
        print('No Linux account/home/code-server was deleted. Inspect any partial new Relay install before retrying.', file=sys.stderr)
        sys.exit(1)
