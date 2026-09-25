"""Copy legacy rollouts under native writer locks; never merge auth or SQLite files."""
import fcntl
import hashlib
import json
import os
import pathlib
import re
import shutil
import stat
import sys
import tempfile


def digest(path):
    with open(path, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def lock(home, thread):
    directory = home / 'thread-writer-locks'
    directory.mkdir(mode=0o700, exist_ok=True)
    if directory.is_symlink():
        raise ValueError('Unsafe writer lock directory')
    fd = os.open(directory / (thread + '.lock'), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BaseException:
        os.close(fd)
        raise
    return fd


def migrate(source, target):
    source, target = pathlib.Path(source), pathlib.Path(target)
    target.mkdir(mode=0o700, parents=True, exist_ok=True)
    if source.resolve() == target.resolve():
        raise ValueError('Authorization and execution homes must differ')
    manifest = source / 'relay-shared-history.json'
    previous = json.loads(manifest.read_text()) if manifest.exists() else {}
    if previous and previous.get('target') != str(target.resolve()):
        raise ValueError('Migration target changed')
    entries = previous.get('entries', {})
    copied = 0
    for category in ['sessions', 'archived_sessions']:
        directory = source / category
        if not directory.exists():
            continue
        for folder, dirs, files in os.walk(directory, followlinks=False):
            if pathlib.Path(folder).is_symlink() or any((pathlib.Path(folder)/d).is_symlink() for d in dirs):
                raise ValueError('Symlink in legacy history')
            for name in sorted(files):
                if not name.endswith('.jsonl'):
                    continue
                old = pathlib.Path(folder) / name
                if old.is_symlink() or not stat.S_ISREG(old.stat().st_mode):
                    raise ValueError('Unsafe legacy rollout')
                with old.open() as stream:
                    first = stream.readline(1024 * 1024)
                meta = json.loads(first)
                thread = meta.get('payload', {}).get('id')
                if meta.get('type') != 'session_meta' or not isinstance(thread, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,200}', thread):
                    raise ValueError('Unsupported legacy rollout metadata')
                a = lock(source, thread)
                b = None
                temp = None
                try:
                    relative = str(old.relative_to(source))
                    checksum = digest(old)
                    if relative in entries:
                        if entries[relative] != checksum:
                            raise ValueError('Legacy history changed after migration')
                        continue
                    b = lock(target, thread)
                    new = target / relative
                    # Reject the same native ID at a different rollout path too.
                    collisions = list((target/'sessions').rglob('*' + thread + '*.jsonl')) + list((target/'archived_sessions').rglob('*' + thread + '*.jsonl'))
                    if any(p != new for p in collisions):
                        raise ValueError('Conflicting native thread ID')
                    for ancestor in [new.parent, *new.parent.parents]:
                        if ancestor == target:
                            break
                        if ancestor.is_symlink():
                            raise ValueError('Symlink in shared history')
                    new.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                    if new.exists():
                        if new.is_symlink() or digest(new) != checksum:
                            raise ValueError('Conflicting shared history')
                    else:
                        fd, temp = tempfile.mkstemp(prefix='.relay-history-', dir=new.parent)
                        with os.fdopen(fd, 'wb') as out, old.open('rb') as inp:
                            shutil.copyfileobj(inp, out)
                            out.flush()
                            os.fsync(out.fileno())
                        if digest(old) != checksum or digest(temp) != checksum:
                            raise ValueError('Legacy history changed during migration')
                        os.link(temp, new)  # Atomic publication, never overwrite.
                        copied += 1
                    entries[relative] = checksum
                    fd, state = tempfile.mkstemp(prefix='.relay-migration-', dir=source)
                    with os.fdopen(fd, 'w') as out:
                        json.dump({'target': str(target.resolve()), 'entries': entries}, out)
                        out.flush()
                        os.fsync(out.fileno())
                    os.replace(state, manifest)
                finally:
                    if temp:
                        os.unlink(temp)
                    if b is not None:
                        os.close(b)
                    os.close(a)
    return copied


if __name__ == '__main__':
    try:
        request = json.load(sys.stdin)
        print(json.dumps({'copied': migrate(request['source'], request['target'])}))
    except BlockingIOError:
        print(json.dumps({'error': '旧历史或目标会话仍在运行，请结束占用后重试。'}))
        sys.exit(1)
    except Exception:
        print(json.dumps({'error': '历史迁移遇到冲突或不支持的记录，原文件已保留，请检查后重试。'}))
        sys.exit(1)
