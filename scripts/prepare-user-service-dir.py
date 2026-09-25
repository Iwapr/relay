#!/usr/bin/env python3
"""Repair only the three service-directory ancestors, never user files or subtrees."""
import os
import pwd
import stat
import sys


def prepare(home, uid, gid):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    directory = os.open(home, flags)
    try:
        if os.fstat(directory).st_uid != uid:
            raise RuntimeError('HOME is not owned by the intended user')
        for name in ('.config', 'systemd', 'user'):
            try:
                os.mkdir(name, 0o700, dir_fd=directory)
            except FileExistsError:
                pass
            child = os.open(name, flags, dir_fd=directory)
            os.close(directory)
            directory = child
            info = os.fstat(directory)
            if info.st_uid not in (0, uid):
                raise RuntimeError('Service directory belongs to another ordinary user; inspect manually')
            if info.st_uid == 0 and uid != 0:
                os.fchown(directory, uid, gid)
                print(f'Repaired directory owner: {name} -> uid {uid}')
            mode = stat.S_IMODE(os.fstat(directory).st_mode)
            if mode & 0o700 != 0o700:
                os.fchmod(directory, mode | 0o700)
                print(f'Repaired owner access: {name}')
    finally:
        os.close(directory)


if __name__ == '__main__':
    if os.geteuid() != 0:
        raise SystemExit('Run through the administrator deployment script')
    account = pwd.getpwnam(sys.argv[1])
    if account.pw_uid == 0:
        raise SystemExit('Refusing root user service installation')
    prepare(account.pw_dir, account.pw_uid, account.pw_gid)
