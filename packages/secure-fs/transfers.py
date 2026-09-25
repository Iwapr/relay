"""Bounded transfers using the same fd-relative boundary as previews."""
import os
import stat
import uuid
import zipfile


def operate(request, access, rootfd, Denied):
    from helper import stamp

    if request['operation'] == 'transfer-upload':
        relative = request['path']
        # Validate all components and sensitive paths before creating anything.
        parts = relative.split('/')
        if not relative or len(parts) > 64 or any(not p or p in ('.', '..') or '\\' in p or '\x00' in p for p in parts):
            raise Denied('invalid_request', '无效的上传路径', 400)
        access.deny(os.path.join(request['root']['canonicalRoot'], relative))
        os.umask(int(request['umask'], 8))
        parent = rootfd
        for index, name in enumerate(parts[:-1]):
            access.verify()
            try:
                os.mkdir(name, mode=0o777, dir_fd=parent)
            except FileExistsError:
                pass
            parent, _ = access.relative(rootfd, '/'.join(parts[:index + 1]), True)
        temporary = '.relay-upload-' + str(uuid.uuid4())
        output = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o666, dir_fd=parent)
        try:
            source = os.open(request['source'], os.O_RDONLY | os.O_NOFOLLOW)
            try:
                info = os.fstat(source)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size != request['size']:
                    raise Denied('file_changed', '上传内容不完整', 409)
                with os.fdopen(output, 'wb') as dest:
                    output = None
                    while True:
                        data = os.read(source, 128 * 1024)
                        if not data:
                            break
                        dest.write(data)
                    dest.flush()
                    os.fsync(dest.fileno())
            finally:
                os.close(source)
            access.verify()
            # link is atomic and refuses to overwrite any existing file or link.
            try:
                os.link(temporary, parts[-1], src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
            except FileExistsError:
                raise Denied('already_exists', '同名文件已存在，未覆盖；请重命名后上传。', 409)
            os.unlink(temporary, dir_fd=parent)
            os.fsync(parent)
            return {'path': relative, 'size': request['size']}
        finally:
            if output is not None:
                os.close(output)
            try:
                os.unlink(temporary, dir_fd=parent)
            except FileNotFoundError:
                pass

    output = request['output']
    size = 0
    count = 0
    skipped = 0
    visited = set()

    def visit(relative, archive, dest=None, nested=False, depth=0):
        nonlocal size, count, skipped
        if relative in visited:
            return
        visited.add(relative)
        count += 1
        if count > 10000 or depth > 64:
            raise Denied('file_too_large', '打包最多包含 10000 项、64 层目录', 413)
        mark, bound = len(access.fds), len(access.bound)
        try:
            try:
                fd, info = access.relative(rootfd, relative)
            except (OSError, Denied):
                if not nested:
                    raise
                skipped += 1
                return
            if stat.S_ISDIR(info.st_mode):
                if archive is None:
                    raise Denied('invalid_request', '文件夹需要打包下载', 400)
                if relative:
                    archive.writestr(relative + '/', b'')
                for name in sorted(os.listdir(fd)):
                    visit(relative + '/' + name if relative else name, archive, nested=True, depth=depth + 1)
            else:
                if size + info.st_size > request['maxBytes']:
                    raise Denied('file_too_large', '下载内容超过 256 MiB 限制，请分批下载', 413)
                target = archive.open(relative, 'w', force_zip64=True) if archive else dest
                try:
                    while True:
                        data = os.read(fd, 128 * 1024)
                        if not data:
                            break
                        size += len(data)
                        if size > request['maxBytes']:
                            raise Denied('file_too_large', '下载内容超过 256 MiB 限制，请分批下载', 413)
                        target.write(data)
                    if stamp(info) != stamp(os.fstat(fd)):
                        raise Denied('file_changed', '文件在打包期间发生变化，请重试', 409)
                finally:
                    if archive:
                        target.close()
            access.verify()
        finally:
            for fd in reversed(access.fds[mark:]):
                os.close(fd)
            del access.fds[mark:]
            del access.bound[bound:]

    try:
        with open(output, 'xb') as dest:
            os.chmod(output, 0o600)
            if request['archive']:
                with zipfile.ZipFile(dest, 'w', compression=zipfile.ZIP_STORED) as archive:
                    for relative in request['paths']:
                        visit(relative, archive)
            else:
                visit(request['paths'][0], None, dest)
        return {'size': os.stat(output).st_size, 'skipped': skipped}
    except BaseException:
        try:
            os.unlink(output)
        except FileNotFoundError:
            pass
        raise
