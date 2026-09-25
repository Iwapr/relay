#!/usr/bin/python3
# Managed by Relay template service.
"""Install relay@user once; each restart builds and pins a current shared release."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time

CODE = Path('/opt/relay')
STATE = Path('/var/lib/relay')
CONFIG = Path('/etc/relay')
HELPER = Path('/usr/local/libexec/relay-service')
UNIT = Path('/etc/systemd/system/relay@.service')
GROUP_UNIT = Path('/etc/systemd/system/relay.service')
MARKER = '# Managed by Relay template service.'
OLD_MARKER = '# Managed by Remote Workbench install-service.ts;'
COMPONENTS = ('remote-workbench-agent.service', 'remote-workbench-gateway.service')
PROGRAM_DIRS = ('apps', 'packages', 'generated', 'scripts')
PROGRAM_FILES = ('package.json', 'package-lock.json', 'tsconfig.json')
TERMINAL = {'completed', 'failed', 'cancelled', 'interrupted', 'uncertain'}


def account(name):
    if not re.fullmatch(r'[a-z_][a-z0-9_-]*', name):
        raise ValueError('Use an ordinary Linux username')
    user = pwd.getpwnam(name)
    if user.pw_uid == 0:
        raise ValueError('Relay instances and builds must not run as root')
    return user


def atomic_write(path, data, mode=0o644):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    fd, temporary = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def write_json(path, value, mode=0o644):
    atomic_write(path, json.dumps(value, ensure_ascii=False, indent=2) + '\n', mode)


def trusted_json(path):
    path = Path(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise ValueError(f'Expected an administrator-owned configuration: {path}')
    return json.loads(path.read_text())


def user_command(name, args, *, cwd=None, extra_env=None, capture=False, check=True):
    user = account(name)
    env = {
        'HOME': user.pw_dir, 'USER': name, 'LOGNAME': name, 'LANG': 'C.UTF-8',
        'PATH': f'{CODE}/node/bin:/usr/local/bin:/usr/bin:/bin',
        'XDG_RUNTIME_DIR': f'/run/user/{user.pw_uid}',
        'DBUS_SESSION_BUS_ADDRESS': f'unix:path=/run/user/{user.pw_uid}/bus',
    }
    env.update(extra_env or {})
    argv = [str(a) for a in args]
    if os.geteuid() != user.pw_uid:
        argv = ['/usr/sbin/runuser', '-u', name, '--', *argv]
    return subprocess.run(argv, cwd=cwd, env=env, check=check, text=True,
                          stdout=subprocess.PIPE if capture else None,
                          stderr=subprocess.PIPE if capture else None)


def fingerprint(source):
    source = Path(source)
    digest = hashlib.sha256()
    # Generated output and caches cannot make every subsequent restart rebuild.
    for directory in (*PROGRAM_DIRS, 'tests'):
        root = source / directory
        if not root.exists():
            continue
        for current, dirs, files in os.walk(root, followlinks=False):
            dirs[:] = sorted(d for d in dirs if d not in ('dist', '__pycache__', 'node_modules'))
            for name in sorted(files):
                path = Path(current) / name
                digest.update(str(path.relative_to(source)).encode() + b'\0')
                if path.is_symlink():
                    digest.update(os.readlink(path).encode())
                else:
                    digest.update(path.read_bytes())
    for name in (*PROGRAM_FILES, 'playwright.config.ts'):
        path = source / name
        if path.exists():
            digest.update(name.encode() + b'\0' + path.read_bytes())
    return digest.hexdigest()


def freeze_tree(root):
    """Make copied program files readable, preserving executable bits, never follow links."""
    root = Path(root)
    for current, dirs, files in os.walk(root, followlinks=False):
        os.chmod(current, 0o755)
        for name in (*dirs, *files):
            path = Path(current) / name
            if path.is_symlink():
                # npm .bin links are relative and internal to its dependency tree.
                if Path(os.readlink(path)).is_absolute() or not path.resolve().is_relative_to(root.resolve()):
                    raise ValueError(f'Program symlink escapes its package: {path}')
                continue
            if path.is_file():
                os.chmod(path, 0o755 if path.stat().st_mode & 0o111 else 0o644)


def copy_package(source, destination, *, dependencies=False):
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix='.staging-', dir=destination.parent))
    try:
        # node-gyp creates node_gyp_bins/python3 as an absolute build-time link.
        # Compiled addons do not use this cache at runtime; never publish it.
        ignored = ['__pycache__', '.cache']
        if dependencies:
            ignored.append('node_gyp_bins')
        shutil.copytree(source, temporary, dirs_exist_ok=True, symlinks=True,
                        ignore=shutil.ignore_patterns(*ignored))
        freeze_tree(temporary)
        os.rename(temporary, destination)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def publish(source_config):
    """Serialized by the caller. Source builds run as its owner, never as root."""
    source = Path(source_config['source'])
    builder = source_config['buildUser']
    if source.stat().st_uid != account(builder).pw_uid:
        raise ValueError('The source directory owner has changed; reinstall its source registration')
    revision = fingerprint(source)
    release = CODE / 'releases' / revision
    if (release / 'release.json').is_file():
        return release
    lock_hash = hashlib.sha256((source / 'package-lock.json').read_bytes()).hexdigest()
    dependency_stamp = STATE / 'dependency-lock'
    previous = dependency_stamp.read_text().strip() if dependency_stamp.exists() else None
    modules = source / 'node_modules'
    if not (modules / '.bin/tsx').exists() or (previous is not None and previous != lock_hash):
        print('Relay: installing dependencies as ' + builder, flush=True)
        user_command(builder, [CODE / 'node/bin/node', source_config['npm'], 'ci'], cwd=source)
    print('Relay: building updated source as ' + builder, flush=True)
    user_command(builder, [CODE / 'node/bin/node', source_config['npm'], 'run', 'build'], cwd=source)
    if fingerprint(source) != revision:
        raise RuntimeError('Source changed during the build; restart again after saving your changes')
    if not (source / 'apps/web/dist/index.html').is_file():
        raise RuntimeError('Build did not produce the web application')
    # Node resolves transitive imports through an ancestor named node_modules.
    # A bare hash directory behind a symlink breaks tsx -> esbuild resolution.
    dependencies = CODE / 'dependencies' / lock_hash / 'node_modules'
    if not dependencies.exists():
        copy_package(modules, dependencies, dependencies=True)
    version = json.loads((source / 'generated/manifest.json').read_text())['codexVersion']
    if not re.fullmatch(r'[0-9A-Za-z._-]+', version):
        raise ValueError('Invalid pinned Codex version')
    codex = CODE / 'codex' / version
    if not codex.exists():
        binary_dir = source / '.runtime/codex' / version
        if not (binary_dir / 'codex').is_file():
            raise RuntimeError(f'Pinned Codex binary is missing: {binary_dir}/codex')
        copy_package(binary_dir, codex)
    release.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix='.staging-', dir=release.parent))
    try:
        for directory in PROGRAM_DIRS:
            shutil.copytree(source / directory, staging / directory, symlinks=True,
                            ignore=shutil.ignore_patterns('__pycache__', '.cache'))
        for name in PROGRAM_FILES:
            shutil.copyfile(source / name, staging / name)
        freeze_tree(staging)
        (staging / 'node_modules').symlink_to(dependencies, target_is_directory=True)
        (staging / 'codex').symlink_to(codex, target_is_directory=True)
        write_json(staging / 'release.json', {'revision': revision, 'builtAt': time.time()})
        os.rename(staging, release)
        atomic_write(dependency_stamp, lock_hash + '\n')
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    print('Relay: published ' + revision[:12], flush=True)
    return release


def build_lock():
    STATE.mkdir(parents=True, exist_ok=True, mode=0o755)
    stream = open(STATE / 'build.lock', 'a')
    fcntl.flock(stream, fcntl.LOCK_EX)
    return stream


def descriptor_path(name):
    account(name)
    return CONFIG / 'instances' / (name + '.json')


def check_instance(name, spec, release):
    user_command(name, [CODE / 'node/bin/node', '--import', 'tsx',
                       release / 'scripts/serve-instance.ts', '--check'], cwd=release,
                 extra_env={'RELAY_INSTANCE': str(spec)})


def pin_instance(name, release):
    atomic_write(STATE / 'instances' / (name + '.release'), str(release) + '\n')


def prepare(name):
    spec = descriptor_path(name)
    trusted_json(spec)
    with build_lock():
        release = publish(trusted_json(CONFIG / 'source.json'))
        check_instance(name, spec, release)
        pin_instance(name, release)


def run_instance(name):
    user = account(name)
    if os.geteuid() != user.pw_uid:
        raise ValueError('The systemd instance must run as its named Linux user')
    spec = descriptor_path(name)
    trusted_json(spec)
    release = Path((STATE / 'instances' / (name + '.release')).read_text().strip())
    if not release.resolve().is_relative_to((CODE / 'releases').resolve()):
        raise ValueError('Invalid published release')
    os.chdir(release)
    os.environ.update(HOME=user.pw_dir, USER=name, LOGNAME=name,
                      PATH=f'{CODE}/node/bin:{release}/node_modules/.bin:/usr/local/bin:/usr/bin:/bin',
                      RELAY_INSTANCE=str(spec))
    os.execv(CODE / 'node/bin/node', [str(CODE / 'node/bin/node'), '--import', 'tsx',
                                   str(release / 'scripts/serve-instance.ts')])


def locate_instance(source, name, public_host=None, port_offset=10000):
    user = account(name)
    home = Path(user.pw_dir)
    directory = home / '.local/share/relay-instance'
    if source.stat().st_uid == user.pw_uid and (source / '.runtime/agent.json').is_file():
        directory = source / '.runtime'
    result = {'user': name, 'agentConfig': str(directory / 'agent.json'),
              'gatewayConfig': str(directory / 'gateway.json')}
    for key in ('agentConfig', 'gatewayConfig'):
        info = Path(result[key]).lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != user.pw_uid or info.st_mode & 0o077:
            raise ValueError(f'{name}: configuration is missing or not private: {result[key]}')
    gateway = json.loads(Path(result['gatewayConfig']).read_text())
    if public_host:
        if not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?', public_host):
            raise ValueError('--public-host must be a DNS hostname without scheme or port')
        port = int(gateway['port']) + port_offset
        if not 1 <= port <= 65535:
            raise ValueError('Public port is out of range')
        result['tailscaleProxyOrigin'] = f'https://{public_host}:{port}'
    elif descriptor_path(name).exists():
        prior = trusted_json(descriptor_path(name))
        if prior.get('tailscaleProxyOrigin'):
            result['tailscaleProxyOrigin'] = prior['tailscaleProxyOrigin']
    return result


def ensure_idle(spec):
    config = json.loads(Path(spec['agentConfig']).read_text())
    database = Path(config['stateDir']) / 'agent.sqlite'
    if not database.exists():
        return
    with sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True) as db:
        for (data,) in db.execute("SELECT data FROM objects WHERE kind='run'"):
            run = json.loads(data)
            if run['state'] not in TERMINAL:
                raise RuntimeError(f"{spec['user']}: Relay has an active or queued task; finish it before migration")


def managed_file(path, marker):
    if path.exists() and (path.is_symlink() or marker not in path.read_text().splitlines()[:2]):
        raise ValueError(f'Refusing to replace an unrelated file: {path}')


def group_unit_text(users):
    names = sorted(set(users))
    for name in names:
        account(name)
    instances = ' '.join(f'relay@{name}.service' for name in names)
    return f'''{MARKER}
[Unit]
Description=All registered Relay instances
Wants={instances}
After={instances}

[Service]
Type=oneshot
ExecStart=/usr/bin/true
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
'''


def install_group():
    """Add the management entry to an existing template install without restarting it."""
    if not UNIT.exists():
        raise ValueError('relay@.service is not installed; use install for initial setup')
    managed_file(UNIT, MARKER)
    managed_file(GROUP_UNIT, MARKER)
    dropin = UNIT.parent / 'relay@.service.d/relay-group.conf'
    managed_file(dropin, MARKER)
    names = []
    for path in sorted((CONFIG / 'instances').glob('*.json')):
        descriptor = trusted_json(path)
        if descriptor.get('user') != path.stem:
            raise ValueError(f'Instance descriptor username does not match: {path}')
        account(path.stem)
        names.append(path.stem)
    if not names:
        raise ValueError('No registered Relay instances; use install for initial setup')
    group = group_unit_text(names)
    membership = f'{MARKER}\n[Unit]\nPartOf=relay.service\n'
    # Validate before changing the systemd configuration.
    with tempfile.TemporaryDirectory(prefix='relay-group-verify-') as temporary:
        staged = Path(temporary)
        (staged / 'relay.service').write_text(group)
        (staged / 'relay@.service').write_text(UNIT.read_text())
        (staged / 'relay@.service.d').mkdir()
        (staged / 'relay@.service.d/relay-group.conf').write_text(membership)
        subprocess.run(['systemd-analyze', 'verify', str(staged / 'relay.service'),
                        str(staged / 'relay@.service')], check=True)
    saved = {path: path.read_text() if path.exists() else None for path in (GROUP_UNIT, dropin)}
    was_enabled = subprocess.run(['systemctl', 'is-enabled', 'relay.service'],
                                 capture_output=True).returncode == 0
    try:
        atomic_write(GROUP_UNIT, group)
        atomic_write(dropin, membership)
        subprocess.run(['systemctl', 'daemon-reload'], check=True)
        subprocess.run(['systemctl', 'enable', 'relay.service'], check=True)
    except Exception:
        if not was_enabled:
            subprocess.run(['systemctl', 'disable', 'relay.service'], check=False)
        for path, content in saved.items():
            if content is None:
                path.unlink(missing_ok=True)
            else:
                atomic_write(path, content)
        subprocess.run(['systemctl', 'daemon-reload'], check=False)
        raise
    print('Installed relay.service for: ' + ', '.join(names))
    print('No instances were started, stopped, restarted, rebuilt, or migrated.')
    print('When tasks are idle, update one: sudo systemctl restart relay@USER')
    print('When all tasks are idle, update all: sudo systemctl restart relay')


def install(args):
    source = Path(args.source).resolve()
    builder = pwd.getpwuid(source.stat().st_uid).pw_name
    account(builder)
    for path in (UNIT, GROUP_UNIT, HELPER):
        managed_file(path, MARKER)
    specs = [locate_instance(source, name, args.public_host, args.port_offset) for name in dict.fromkeys(args.users)]
    old_units = {}
    for spec in specs:
        ensure_idle(spec)
        name = spec['user']
        home = Path(account(name).pw_dir)
        old_units[name] = []
        for unit in COMPONENTS:
            path = home / '.config/systemd/user' / unit
            if path.exists():
                if path.is_symlink() or not path.read_text().startswith(OLD_MARKER):
                    raise ValueError(f'Refusing to stop an unrelated user service: {path}')
                old_units[name].append(unit)
    STATE.mkdir(parents=True, exist_ok=True, mode=0o755)
    backup = STATE / 'install-backups' / str(time.time_ns())
    backup.mkdir(parents=True, mode=0o700)
    saved = {}

    def save(path):
        path = Path(path)
        if path not in saved:
            saved[path] = path.read_bytes() if path.exists() else None
            if saved[path] is not None:
                target = backup / str(path).lstrip('/')
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                target.write_bytes(saved[path])

    for path in (UNIT, GROUP_UNIT, HELPER, CONFIG / 'source.json'):
        save(path)
    for spec in specs:
        save(descriptor_path(spec['user']))
        save(STATE / 'instances' / (spec['user'] + '.release'))
    node = CODE / 'node/bin/node'
    if not node.exists():
        candidate = source / 'node_modules/node/bin/node'
        version = user_command(builder, [candidate, '--version'], capture=True).stdout.strip()
        if not version.startswith('v24.'):
            raise ValueError('Build the initial checkout with its Node 24 runtime first')
        node.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(candidate, node)
        node.chmod(0o755)
    source_config = {'source': str(source), 'buildUser': builder,
                     'npm': str(Path(shutil.which('npm') or '/usr/bin/npm').resolve())}
    old_states = []
    activated = []
    group_enable_attempted = False
    group_was_enabled = False
    try:
        with build_lock():
            release = publish(source_config)
        for spec in specs:
            path = descriptor_path(spec['user'])
            write_json(path, spec)
            check_instance(spec['user'], path, release)
        for spec in specs:
            ensure_idle(spec)
        atomic_write(HELPER, Path(__file__).read_text(), 0o755)
        atomic_write(UNIT, (source / 'deploy/systemd/relay@.service').read_text())
        # Include earlier registrations when installing only an additional user.
        registered = [path.stem for path in (CONFIG / 'instances').glob('*.json')]
        atomic_write(GROUP_UNIT, group_unit_text(registered))
        write_json(CONFIG / 'source.json', source_config)
        subprocess.run(['systemd-analyze', 'verify', str(UNIT), str(GROUP_UNIT)], check=True)
        subprocess.run(['systemctl', 'daemon-reload'], check=True)
        for spec in specs:
            name = spec['user']
            unit_name = f'relay@{name}.service'
            # User managers already exist for migrated installs. Start if needed so
            # managed legacy units can be disabled rather than resurrecting at login.
            subprocess.run(['systemctl', 'start', f'user@{account(name).pw_uid}.service'], check=True)
            for old in reversed(old_units[name]):
                enabled = user_command(name, ['systemctl', '--user', 'is-enabled', old], capture=True, check=False).returncode == 0
                active = user_command(name, ['systemctl', '--user', 'is-active', old], capture=True, check=False).returncode == 0
                old_states.append((name, old, enabled, active))
                user_command(name, ['systemctl', '--user', 'disable', '--now', old])
            enabled = subprocess.run(['systemctl', 'is-enabled', unit_name], capture_output=True).returncode == 0
            active = subprocess.run(['systemctl', 'is-active', unit_name], capture_output=True).returncode == 0
            activated.append((unit_name, enabled, active))
            subprocess.run(['systemctl', 'enable', unit_name], check=True)
            subprocess.run(['systemctl', 'restart', unit_name], check=True)
            print(f'Ready: {unit_name}' + (f" — {spec['tailscaleProxyOrigin']}" if spec.get('tailscaleProxyOrigin') else ''), flush=True)
        group_was_enabled = subprocess.run(['systemctl', 'is-enabled', 'relay.service'], capture_output=True).returncode == 0
        group_enable_attempted = True
        subprocess.run(['systemctl', 'enable', 'relay.service'], check=True)
    except Exception:
        if group_enable_attempted and not group_was_enabled:
            subprocess.run(['systemctl', 'disable', 'relay.service'], check=False)
        for unit, _, _ in reversed(activated):
            subprocess.run(['systemctl', 'disable', '--now', unit], check=False)
        for path, content in saved.items():
            if content is None:
                path.unlink(missing_ok=True)
            else:
                atomic_write(path, content.decode(), 0o755 if path == HELPER else 0o644)
        subprocess.run(['systemctl', 'daemon-reload'], check=False)
        for unit, enabled, active in activated:
            if enabled:
                subprocess.run(['systemctl', 'enable', unit], check=False)
            if active:
                # Best effort for a previously installed template instance.
                subprocess.run(['systemctl', 'start', unit], check=False)
        for name, old, enabled, active in reversed(old_states):
            if enabled:
                user_command(name, ['systemctl', '--user', 'enable', old], check=False)
            if active:
                user_command(name, ['systemctl', '--user', 'start', old], check=False)
        raise
    print('Migration complete. Update all: sudo systemctl restart relay; one user: sudo systemctl restart relay@USER')
    print('Installation backup: ' + str(backup))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    setup = sub.add_parser('install', help='one-time migration of existing Relay instances')
    setup.add_argument('--source', default=str(Path(__file__).resolve().parent.parent))
    setup.add_argument('--users', nargs='+', required=True)
    setup.add_argument('--public-host', help='HTTPS hostname; public port = existing port + offset')
    setup.add_argument('--port-offset', type=int, default=10000)
    sub.add_parser('install-group', help='add relay.service to an existing install without restarting instances')
    for command in ('prepare', 'run'):
        sub.add_parser(command).add_argument('user')
    args = parser.parse_args()
    if args.command != 'run' and os.geteuid() != 0:
        parser.error('Administrator privileges are required; run this command with sudo')
    if args.command != 'run':
        # ExecStartPre inherits the service's private umask. Published code and
        # non-secret descriptors must remain readable by ordinary service users.
        os.umask(0o022)
    if args.command == 'install':
        install(args)
    elif args.command == 'install-group':
        install_group()
    elif args.command == 'prepare':
        prepare(args.user)
    else:
        run_instance(args.user)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Relay service: ' + str(error), file=sys.stderr)
        sys.exit(1)
