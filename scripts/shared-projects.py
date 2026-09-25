#!/usr/bin/env python3
"""Administrator provisioning for Relay shared projects. Preview unless --apply.

Never stops services, deletes leases, recursively changes project permissions, or
reads user credentials. User-owned configuration and databases are read/updated
under that user's identity, including when this script is invoked as root.
"""
import argparse
import grp
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import stat
import subprocess
import sys

INSTANCES = Path('/etc/relay/instances')
PROJECTS = Path('/srv/projects')
LOCKS = Path('/var/lib/relay/shared-workspace-locks')
LOCK_GROUP = 'relay-locks'

USER_CONFIG = r'''
import json, os, sqlite3, stat, sys, tempfile
from pathlib import Path
from datetime import datetime, timezone
p = Path(sys.argv[1])
info = p.lstat()
if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
    raise RuntimeError('Agent config must be an ordinary file owned by its service user')
original = p.read_bytes()
c = json.loads(original)
if not isinstance(c.get('roots'), list) or not all(isinstance(x, str) for x in c['roots']):
    raise RuntimeError('Invalid roots')
state = Path(c['stateDir'])
# Named account task databases must also be idle, not just the default account.
dbs = [state / 'agent.sqlite', *state.glob('accounts/*/state/agent.sqlite')]
for database in dbs:
    if not database.exists():
        continue
    with sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True) as db:
        for (data,) in db.execute("SELECT data FROM objects WHERE kind='run'"):
            if json.loads(data)['state'] not in ('completed', 'failed', 'cancelled', 'interrupted', 'uncertain'):
                raise RuntimeError('Active/queued task exists; finish tasks before migration')
old = Path(c.get('sharedLockDirectory') or state / 'locks')
try:
    entries = list(old.iterdir())
except FileNotFoundError:
    entries = []
if any(x.name.endswith('.lease') for x in entries):
    raise RuntimeError('Existing lease records require inspection; no leases will be deleted')
roots = list(dict.fromkeys([*c['roots'], '/srv/projects']))
changed = roots != c['roots'] or c.get('sharedLockDirectory') != sys.argv[2] or c.get('taskUmask') != '0002'
c.update(roots=roots, sharedLockDirectory=sys.argv[2], taskUmask='0002')
if sys.argv[3] == 'apply' and changed:
    os.umask(0o077)
    backup = p.with_name(p.name + '.before-shared-projects-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
    with backup.open('xb') as stream:
        stream.write(original)
    fd, temporary = tempfile.mkstemp(prefix=p.name + '.', dir=p.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(c, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, p)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)
    print('Backup: ' + str(backup))
print(json.dumps({'roots': roots, 'sharedLockDirectory': c['sharedLockDirectory'], 'taskUmask': c['taskUmask'], 'changed': changed}))
'''


def run(*args, capture=False):
    return subprocess.run([str(x) for x in args], check=True, text=True,
                          stdout=subprocess.PIPE if capture else None)


def user(name):
    if not re.fullmatch(r'[a-z_][a-z0-9_-]*', name):
        raise ValueError('Invalid system username: ' + name)
    value = pwd.getpwnam(name)
    if value.pw_uid == 0:
        raise ValueError('Root cannot be a Relay/project participant')
    return value


def trusted_directory(path, allow_group_write=False):
    info = path.lstat()
    forbidden = 0o002 if allow_group_write else 0o022
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & forbidden:
        raise ValueError(f'Expected a root-owned real directory with no untrusted writes: {path}')


def instances():
    for directory in (Path('/etc'), Path('/etc/relay'), INSTANCES):
        trusted_directory(directory)
    result = []
    for file in sorted(INSTANCES.glob('*.json')):
        info = file.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('Untrusted instance descriptor: ' + str(file))
        spec = json.loads(file.read_text())
        account = user(spec['user'])
        if file.stem != account.pw_name:
            raise ValueError('Instance filename and user differ')
        config = Path(spec['agentConfig'])
        if not config.is_absolute() or not config.is_relative_to(account.pw_dir):
            raise ValueError('Agent configuration must be inside its service user home')
        result.append(spec)
    if not result:
        raise ValueError('No registered Relay instances found')
    return result


def config_operation(spec, apply=False):
    return run('/usr/sbin/runuser', '-u', spec['user'], '--', '/usr/bin/python3', '-c',
               USER_CONFIG, spec['agentConfig'], LOCKS, 'apply' if apply else 'preview', capture=True).stdout.strip()


def inspect_locks():
    if not LOCKS.exists() and not LOCKS.is_symlink():
        return
    trusted_directory(LOCKS, allow_group_write=True)
    # Only the cooperative registry may remain. Never erase uncertain leases.
    for entry in LOCKS.iterdir():
        info = entry.lstat()
        if entry.name != 'registry.lock' or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError(f'Inspect existing lock record before migration: {entry}')


def configure(apply):
    specs = instances()
    for directory in (Path('/srv'), Path('/var'), Path('/var/lib'), Path('/var/lib/relay')):
        trusted_directory(directory)
    if PROJECTS.exists() or PROJECTS.is_symlink():
        trusted_directory(PROJECTS)
    inspect_locks()
    # Complete preflight for every instance before changing any configuration.
    for spec in specs:
        name = spec['user']
        state = run('systemctl', 'show', f'relay@{name}.service', '-p', 'ActiveState', '--value', capture=True).stdout.strip()
        print(f'{name}: service={state}; {config_operation(spec)}', flush=True)
        if apply and state != 'inactive':
            raise ValueError('Stop every listed instance after tasks finish; no services are stopped automatically')
    names = [x['user'] for x in specs]
    print(f'Plan: /srv/projects mode 0755; {LOCKS} root:{LOCK_GROUP} mode 2770')
    print('Lock group members to add: ' + ', '.join(names))
    print('Existing project permissions and project group membership will not change.')
    if not apply:
        print('Preview only. Stop idle instances, then repeat with --apply.')
        return
    try:
        group = grp.getgrnam(LOCK_GROUP)
    except KeyError:
        run('groupadd', '--system', LOCK_GROUP)
        group = grp.getgrnam(LOCK_GROUP)
    for name in names:
        run('usermod', '-a', '-G', LOCK_GROUP, name)
    if not PROJECTS.exists():
        PROJECTS.mkdir(mode=0o755)
    # Limit this change to the namespace directory; never chmod project children.
    os.chmod(PROJECTS, 0o755)
    if not LOCKS.exists():
        LOCKS.mkdir(mode=0o700)
    # Existing registry can be owned by another instance; adopt only this known regular file.
    gate = LOCKS / 'registry.lock'
    if gate.exists() or gate.is_symlink():
        fd = os.open(gate, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise ValueError('Unsafe registry file')
            os.fchown(fd, 0, group.gr_gid)
            os.fchmod(fd, 0o660)
        finally:
            os.close(fd)
    os.chown(LOCKS, 0, group.gr_gid)
    os.chmod(LOCKS, 0o2770)
    for spec in specs:
        print(spec['user'] + ': ' + config_operation(spec, apply=True))
    print('Configured. Services remain stopped. Start: sudo systemctl start ' + ' '.join(f'relay@{n}.service' for n in names))


def create_project(name, members, apply):
    if not re.fullmatch(r'[a-z][a-z0-9_-]{0,23}', name):
        raise ValueError('Project name: lowercase letter followed by at most 23 lowercase letters/digits/_/-')
    members = list(dict.fromkeys(members))
    for member in members:
        user(member)
    for directory in (Path('/srv'), PROJECTS):
        trusted_directory(directory)
    if not shutil.which('setfacl'):
        raise ValueError('setfacl is required (Ubuntu: sudo apt install acl)')
    destination = PROJECTS / name
    group_name = 'project-' + name
    if destination.exists() or destination.is_symlink():
        raise ValueError('Existing project is never overwritten: ' + str(destination))
    try:
        grp.getgrnam(group_name)
    except KeyError:
        pass
    else:
        raise ValueError('Project group already exists; inspect it instead of implicitly reusing it')
    print(f'Create {destination} root:{group_name} 2770 with default ACL; members: {", ".join(members)}')
    if not apply:
        print('Preview only. Repeat with --apply.')
        return
    run('groupadd', '--system', group_name)
    destination.mkdir(mode=0o700)
    os.chown(destination, 0, grp.getgrnam(group_name).gr_gid)
    # Access + default ACL: collaborators rwx, everyone else none.
    run('setfacl', '-m', 'u::rwx,g::rwx,m::rwx,o::---,d:u::rwx,d:g::rwx,d:m::rwx,d:o::---', destination)
    os.chmod(destination, 0o2770)
    for member in members:
        run('usermod', '-a', '-G', group_name, member)
    print('Created. New group membership requires restarting affected idle Relay instances and new terminal/editor sessions.')
    print('Open in Relay: ' + str(destination))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    setup = commands.add_parser('configure', help='configure all registered Relay instances; requires idle tasks, and stopped services for --apply')
    setup.add_argument('--apply', action='store_true')
    project = commands.add_parser('create', help='create a new empty project and its dedicated permission group')
    project.add_argument('name')
    project.add_argument('--members', nargs='+', required=True)
    project.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Run with sudo in an administrator terminal; this environment cannot elevate itself')
    os.umask(0o022)
    if args.command == 'configure':
        configure(args.apply)
    else:
        create_project(args.name, args.members, args.apply)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError, OSError, KeyError, subprocess.CalledProcessError) as error:
        print('STOP: ' + str(error), file=sys.stderr)
        print('No services were started/stopped; do not delete lease records or recursively change project permissions.', file=sys.stderr)
        sys.exit(1)
