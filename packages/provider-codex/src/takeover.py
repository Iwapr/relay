"""Inspect native writer locks; only signal an explicitly confirmed Codex owner.

Never unlink locks, rewrite native data, signal process groups, or trust a stored PID.
The confirmation fingerprint is rechecked while holding a Linux pidfd.
"""
import hashlib
import json
import os
import re
import select
import signal
import stat
import sys


def fail(message):
    raise ValueError(message)


def locks():
    result = []
    with open('/proc/locks') as source:
        for line in source:
            fields = line.split()
            if len(fields) == 8 and fields[1:4] == ['FLOCK', 'ADVISORY', 'WRITE']:
                major, minor, inode = fields[5].split(':')
                result.append((int(fields[4]), (int(major, 16), int(minor, 16), int(inode))))
    return result


def file_key(info):
    return (os.major(info.st_dev), os.minor(info.st_dev), info.st_ino)


def snapshot(home, thread):
    directory = os.open(os.path.join(home, 'thread-writer-locks'), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(directory)
        if info.st_uid != os.getuid() or info.st_mode & 0o022:
            fail('会话锁目录的所有者或权限不符合要求，不能接管。')
        info = os.stat(thread + '.lock', dir_fd=directory, follow_symlinks=False)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
            fail('无法验证会话锁文件，不能接管。')
        key = file_key(info)
        held = locks()
        owners = [pid for pid, identity in held if identity == key]
        if len(owners) != 1 or owners[0] <= 1:
            fail('该会话已不再被占用，请直接继续发送；如仍有冲突，请刷新后重试。')
        pid = owners[0]
        # Never stop this helper, its Agent, or an ancestor hosting the current operation.
        ancestor = os.getpid()
        while ancestor > 1:
            if ancestor == pid:
                fail('不能接管执行当前操作的进程。')
            with open(f'/proc/{ancestor}/stat') as source:
                ancestor = int(source.read().rsplit(')', 1)[1].split()[1])
        if os.stat(f'/proc/{pid}').st_uid != os.getuid():
            fail('只能接管当前 Linux 用户的会话。')
        executable = os.readlink(f'/proc/{pid}/exe')
        if os.path.basename(executable) != 'codex':
            fail('占用者不是可验证的 Codex 进程，不能接管。')
        with open(f'/proc/{pid}/stat') as source:
            started = source.read().rsplit(')', 1)[1].split()[19]
        sessions = []
        for name in os.listdir(directory):
            if not re.fullmatch(r'[a-zA-Z0-9_-]{1,200}\.lock', name):
                continue
            entry = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if (pid, file_key(entry)) in held:
                sessions.append(name[:-5])
        if thread not in sessions:
            fail('会话锁已变化，请刷新后重试。')
        identity = [pid, started, executable, key, sorted(sessions)]
        return {'pid': pid, 'sessions': sorted(sessions), 'fingerprint': hashlib.sha256(json.dumps(identity).encode()).hexdigest()}
    finally:
        os.close(directory)


def main():
    request = json.load(sys.stdin)
    thread = request['threadId']
    if not re.fullmatch(r'[a-zA-Z0-9_-]{1,200}', thread):
        fail('无效的会话标识。')
    home = request['home']
    plan = snapshot(home, thread)
    if request['action'] == 'preview':
        return plan
    if request['action'] != 'stop' or plan['fingerprint'] != request.get('fingerprint'):
        fail('会话占用者已改变，请重新点击接管并确认。')
    descriptor = os.pidfd_open(plan['pid'])
    try:
        if snapshot(home, thread) != plan:
            fail('会话占用者已改变，请重新点击接管并确认。')
        signal.pidfd_send_signal(descriptor, signal.SIGTERM)
        poll = select.poll()
        poll.register(descriptor, select.POLLIN)
        if not poll.poll(5000):
            fail('已请求结束占用进程，但尚未确认退出。请稍后刷新；不会强制删除会话锁。')
        # A supervised client may already have reopened the thread; never kill the replacement.
        try:
            snapshot(home, thread)
        except FileNotFoundError:
            return {'stopped': True}
        except ValueError as error:
            if '已不再被占用' in str(error):
                return {'stopped': True}
            raise
        fail('原进程已退出，但会话被重新占用。请在原客户端关闭该会话后重试。')
    finally:
        os.close(descriptor)


try:
    print(json.dumps({'result': main()}))
except (OSError, ValueError, AttributeError, KeyError) as error:
    message = str(error) if isinstance(error, ValueError) else '无法验证会话占用进程或当前系统不支持安全接管，请在原窗口释放会话。'
    print(json.dumps({'error': message}))
