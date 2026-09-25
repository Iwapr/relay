"""Workspace mutations using validated directory descriptors, without overwrites."""
import ctypes
import errno
import os
import stat


def operate(request, access, root, Denied):
    action = request['action']
    source = request.get('path', '')
    target = request.get('target', '')

    def parent(relative):
        parts = relative.split('/')
        if not relative or any(p in ('', '.', '..') for p in parts) or relative.startswith('/') or '\\' in relative or any(ord(c) < 32 for c in relative):
            raise Denied('invalid_request', '文件路径或名称无效', 400)
        access.deny(os.path.join(request['root']['canonicalRoot'], relative))
        fd, _ = access.relative(root, '/'.join(parts[:-1]), True)
        return fd, parts[-1]

    def inspect(relative, depth=0):
        if depth > 100:
            raise Denied('invalid_request', '目录层级过深', 400)
        fd, info = access.relative(root, relative)
        children = []
        if stat.S_ISDIR(info.st_mode):
            for name in os.listdir(fd):
                children.append((name, inspect(relative + '/' + name, depth + 1)))
        return fd, info, children

    def copy(node, dest, name):
        fd, info, children = node
        if stat.S_ISDIR(info.st_mode):
            os.mkdir(name, 0o755, dir_fd=dest)
            out = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dest)
            try:
                for child, item in children:
                    copy(item, out, child)
            finally:
                os.close(out)
        else:
            out = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, stat.S_IMODE(info.st_mode) & 0o777, dir_fd=dest)
            with os.fdopen(out, 'wb') as stream:
                while True:
                    data = os.read(fd, 128 * 1024)
                    if not data:
                        break
                    stream.write(data)

    def delete(node, parentfd, name):
        fd, info, children = node
        if stat.S_ISDIR(info.st_mode):
            for child, item in children:
                delete(item, fd, child)
            os.rmdir(name, dir_fd=parentfd)
        else:
            os.unlink(name, dir_fd=parentfd)

    try:
        if action in ('file', 'directory'):
            dest, name = parent(target)
            access.verify()
            if action == 'directory':
                os.mkdir(name, 0o755, dir_fd=dest)
            else:
                os.close(os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=dest))
        else:
            src, name = parent(source)
            node = inspect(source)
            if action != 'delete':
                if target == source or target.startswith(source + '/'):
                    raise Denied('invalid_request', '不能选择原位置或自身子目录', 400)
                dest, newname = parent(target)
                try:
                    os.stat(newname, dir_fd=dest, follow_symlinks=False)
                except FileNotFoundError:
                    pass
                else:
                    raise FileExistsError()
            access.verify()
            if action == 'copy':
                copy(node, dest, newname)
            elif action in ('move', 'rename'):
                libc = ctypes.CDLL(None, use_errno=True)
                if libc.renameat2(src, os.fsencode(name), dest, os.fsencode(newname), 1) != 0:
                    err = ctypes.get_errno()
                    raise OSError(err, os.strerror(err))
            elif action == 'delete':
                delete(node, src, name)
            # Source bindings intentionally change after rename/delete.
            if action in ('move', 'rename', 'delete'):
                def descriptors(item):
                    return {item[0]}.union(*(descriptors(child) for _, child in item[2]))
                changed = descriptors(node)
                access.bound = [binding for binding in access.bound if binding[2] not in changed]
        return {'path': target or source}
    except FileExistsError:
        raise Denied('already_exists', '同名文件或文件夹已存在，请换一个名称或位置。', 409)
    except OSError as exc:
        if exc.errno == errno.EXDEV:
            raise Denied('invalid_request', '不能跨文件系统移动，请先复制再删除。', 400)
        raise
