"""Linux PTY bridge: JSON commands on stdin, terminal bytes on stdout."""
import errno
import fcntl
import json
import os
import pty
import selectors
import signal
import struct
import sys
import termios

shell, cwd, cols, rows = sys.argv[1:]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', int(rows), int(cols), 0, 0))
signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGINT})
pid = os.fork()
if pid == 0:
    signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGTERM, signal.SIGINT})
    os.close(master)
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    for fd in (0, 1, 2):
        os.dup2(slave, fd)
    if slave > 2:
        os.close(slave)
    os.chdir(cwd)
    os.environ['TERM'] = 'xterm-256color'
    os.execv(shell, [shell, '-i'])
os.close(slave)

def stop(*_):
    raise SystemExit(0)

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
selector = selectors.DefaultSelector()
selector.register(master, selectors.EVENT_READ)
selector.register(0, selectors.EVENT_READ)
pending = b''
writing = b''
os.set_blocking(master, False)
try:
    signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGTERM, signal.SIGINT})
    while True:
        for key, mask in selector.select():
            if key.fd == master and mask & selectors.EVENT_WRITE:
                try:
                    writing = writing[os.write(master, writing):]
                except BlockingIOError:
                    pass
                if not writing:
                    selector.modify(master, selectors.EVENT_READ)
                if len(writing) < 65536 and 0 not in selector.get_map():
                    selector.register(0, selectors.EVENT_READ)
            if key.fd == master and mask & selectors.EVENT_READ:
                try:
                    data = os.read(master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        data = b''
                    else:
                        raise
                if not data:
                    _, status = os.waitpid(pid, 0)
                    sys.exit(os.waitstatus_to_exitcode(status))
                while data:
                    data = data[os.write(1, data):]
            elif key.fd == 0:
                data = os.read(0, 65536)
                if not data:
                    sys.exit(0)
                pending += data
                while b'\n' in pending:
                    line, pending = pending.split(b'\n', 1)
                    command = json.loads(line)
                    if command['type'] == 'input':
                        writing += command['data'].encode('utf-8')
                        selector.modify(master, selectors.EVENT_READ | selectors.EVENT_WRITE)
                    elif command['type'] == 'resize':
                        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', command['rows'], command['cols'], 0, 0))
                if len(writing) >= 65536:
                    selector.unregister(0)
finally:
    # Include the foreground job (which may have its own process group).
    try:
        foreground = os.tcgetpgrp(master)
        if foreground > 0 and foreground != os.getpgrp():
            os.killpg(foreground, signal.SIGKILL)
    except (OSError, ProcessLookupError):
        pass
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os.close(master)
    selector.close()
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
