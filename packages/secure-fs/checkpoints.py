"""Private, bounded working-tree checkpoints. No git reset and no symlink traversal."""
import hashlib
import json
import os
import re
import stat
import uuid


def operate(request, access, rootfd, Denied):
    def fail(message, code="rollback_conflict"):
        raise Denied(code, message, 409)

    base = request["checkpointDirectory"]
    os.makedirs(base, mode=0o700, exist_ok=True)
    storefd = os.open(base, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    info = os.fstat(storefd)
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        os.close(storefd)
        fail("恢复点目录权限不正确")

    def name(value):
        if not isinstance(value, str) or not re.fullmatch(r"[a-zA-Z0-9-]{1,100}", value):
            fail("恢复点标识无效")
        return value

    def read_json(key):
        fd = os.open(name(key) + ".json", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=storefd)
        with os.fdopen(fd) as stream:
            result = json.load(stream)
        if result.get("root") != request["root"]["directoryIdentity"]:
            fail("项目目录已被替换")
        return result

    def write_json(key, value):
        target = name(key) + ".json"
        tmp = str(uuid.uuid4()) + ".tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=storefd)
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, target, src_dir_fd=storefd, dst_dir_fd=storefd)
        os.fsync(storefd)

    def stamp(s):
        return [s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_mode, s.st_nlink]

    def excluded(rel):
        full = os.path.join(request["root"]["canonicalRoot"], rel)
        # Agent state and Git bookkeeping are not working-tree files.
        return ".git" in rel.split("/") or any(
            full == p or full.startswith(p.rstrip("/") + "/") for p in request.get("sensitivePaths", [])
        )

    visited = 0
    total = 0
    directory_ids = {}

    def opaque(fd, depth=0):
        nonlocal visited
        if depth > 64:
            fail("目录过深，无法建立完整恢复点")
        values = []
        for item in sorted(os.listdir(fd)):
            visited += 1
            if visited > 200000:
                fail("项目文件过多，无法建立完整恢复点")
            s = os.stat(item, dir_fd=fd, follow_symlinks=False)
            child = None
            if stat.S_ISDIR(s.st_mode):
                childfd = os.open(item, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    child = opaque(childfd, depth + 1)
                finally:
                    os.close(childfd)
            values.append([item, stamp(s), child])
        return hashlib.sha256(json.dumps(values).encode()).hexdigest()

    def scan(save=False):
        nonlocal visited, total
        visited = total = 0
        directory_ids.clear()
        entries = {}

        def walk(fd, prefix="", depth=0):
            nonlocal visited, total
            if depth > 64:
                fail("目录过深，无法建立完整恢复点")
            initial = os.fstat(fd)
            for item in sorted(os.listdir(fd)):
                rel = prefix + item
                if excluded(rel):
                    continue
                visited += 1
                if visited > 200000 or len(entries) >= 12000:
                    fail("项目文件过多，无法建立完整恢复点")
                s = os.stat(item, dir_fd=fd, follow_symlinks=False)
                hidden = item in {"node_modules", ".venv", "venv", ".cache"}
                try:
                    access.deny(os.path.join(request["root"]["canonicalRoot"], rel))
                except Denied:
                    hidden = True
                mode = stat.S_IMODE(s.st_mode)
                hidden = hidden or s.st_uid != os.getuid() or s.st_gid != os.getgid()
                # Preserve ownership and ACL/xattr semantics by refusing automatic replacement.
                if stat.S_ISDIR(s.st_mode) or stat.S_ISREG(s.st_mode):
                    checkfd = os.open(item, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                    try:
                        hidden = hidden or bool(os.listxattr(checkfd))
                    finally:
                        os.close(checkfd)
                if stat.S_ISDIR(s.st_mode):
                    child = os.open(item, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    try:
                        if stamp(s) != stamp(os.fstat(child)):
                            fail("目录在快照过程中发生变化")
                        if hidden:
                            entries[rel] = {"type": "opaque", "stamp": stamp(s), "digest": opaque(child)}
                        else:
                            directory_ids[rel] = [s.st_dev, s.st_ino]
                            entries[rel] = {"type": "directory", "mode": mode}
                            walk(child, rel + "/", depth + 1)
                    finally:
                        os.close(child)
                elif hidden or not stat.S_ISREG(s.st_mode) or s.st_nlink != 1:
                    entries[rel] = {"type": "opaque", "stamp": stamp(s)}
                else:
                    if s.st_size > 64 * 1024 * 1024:
                        fail("存在超过64 MiB的文件，无法建立完整恢复点")
                    total += s.st_size
                    if total > 256 * 1024 * 1024:
                        fail("项目内容超过256 MiB，无法建立完整恢复点")
                    source = os.open(item, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                    try:
                        if stamp(s) != stamp(os.fstat(source)):
                            fail("文件在快照过程中发生变化")
                        data = bytearray()
                        while True:
                            chunk = os.read(source, 128 * 1024)
                            if not chunk:
                                break
                            data.extend(chunk)
                            if len(data) > 64 * 1024 * 1024:
                                fail("文件在快照过程中增长过大")
                        if stamp(s) != stamp(os.fstat(source)):
                            fail("文件在快照过程中发生变化")
                    finally:
                        os.close(source)
                    digest = hashlib.sha256(data).hexdigest()
                    entries[rel] = {"type": "file", "hash": digest, "mode": mode, "size": len(data)}
                    if save:
                        try:
                            blob_tmp = str(uuid.uuid4()) + ".tmp"
                            blob = os.open(blob_tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=storefd)
                        except FileExistsError:
                            pass
                        else:
                            with os.fdopen(blob, "wb") as stream:
                                stream.write(data)
                                stream.flush()
                                os.fsync(stream.fileno())
                            os.replace(blob_tmp, digest + ".blob", src_dir_fd=storefd, dst_dir_fd=storefd)
            current = os.fstat(fd)
            if (initial.st_dev, initial.st_ino, initial.st_mtime_ns) != (current.st_dev, current.st_ino, current.st_mtime_ns):
                fail("目录在快照过程中发生变化")
        walk(rootfd)
        access.verify()
        return entries

    def compare(before, after):
        changed = sorted(p for p in before.keys() | after.keys() if before.get(p) != after.get(p))
        if len(changed) > 1000:
            fail("修改超过1000个路径，不能自动回滚")
        for p in changed:
            a, b = before.get(p), after.get(p)
            if (a and a["type"] == "opaque") or (b and b["type"] == "opaque"):
                fail("依赖、链接、特殊文件、受保护文件或带特殊属性的文件发生了变化，不能完整回滚")
            if a and a["type"] == "directory" and a["mode"] & 0o700 != 0o700:
                fail("恢复涉及不可写目录，请手动检查权限")
            if a and b and a["type"] != b["type"]:
                fail("文件与目录类型发生改变，不能自动回滚")
        return changed

    def root_metadata():
        s = os.fstat(rootfd)
        attrs = {key: hashlib.sha256(os.getxattr(rootfd, key)).hexdigest() for key in os.listxattr(rootfd)}
        return {"mode": stat.S_IMODE(s.st_mode), "uid": s.st_uid, "gid": s.st_gid, "attributes": attrs}

    def plan():
        before_manifest = read_json(request["before"])
        before = before_manifest["entries"]
        after_manifest = read_json(request["after"])
        after = after_manifest["entries"]
        if before_manifest["rootMetadata"] != after_manifest["rootMetadata"] or root_metadata() != after_manifest["rootMetadata"]:
            fail("项目根目录权限或属性已改变，不能自动回滚")
        changed = compare(before, after)
        current = scan()
        for p in changed:
            ancestors = [p.rsplit("/", i)[0] for i in range(1, p.count("/") + 1)]
            if after.get(p, {}).get("type") == "directory":
                ancestors.append(p)
            for ancestor in ancestors:
                if ancestor in after_manifest["directories"] and directory_ids.get(ancestor) != after_manifest["directories"][ancestor]:
                    fail("任务结束后目录已被替换：" + ancestor)
            if current.get(p) != after.get(p):
                fail("文件在任务结束后又被修改，回滚已停止：" + p)
            # Removing a new directory must never remove unrelated later files.
            if not before.get(p) and after.get(p, {}).get("type") == "directory":
                if any(q.startswith(p + "/") and q not in changed for q in current):
                    fail("目录包含后续新增内容，回滚已停止：" + p)
        token = hashlib.sha256(json.dumps([request["before"], request["after"], changed, before, after], sort_keys=True).encode()).hexdigest()
        return before, after, changed, token

    def target(rel):
        nf, nb = len(access.fds), len(access.bound)
        try:
            fd, info = access.relative(rootfd, rel)
            access.verify()
            if stat.S_ISDIR(info.st_mode):
                return {"type": "directory", "mode": stat.S_IMODE(info.st_mode)}
            digest = hashlib.sha256()
            while True:
                chunk = os.read(fd, 128 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
            if stamp(info) != stamp(os.fstat(fd)):
                fail("文件在回滚过程中发生变化")
            access.verify()
            return {"type": "file", "mode": stat.S_IMODE(info.st_mode), "size": info.st_size, "hash": digest.hexdigest()}
        except FileNotFoundError:
            return None
        finally:
            for fd in reversed(access.fds[nf:]):
                os.close(fd)
            del access.fds[nf:]
            del access.bound[nb:]

    def set_entry(rel, desired, expected):
        nf, nb = len(access.fds), len(access.bound)
        try:
            if target(rel) != expected:
                fail("文件在回滚过程中发生变化：" + rel)
            mutate(rel, desired, expected)
            access.verify()
        finally:
            for fd in reversed(access.fds[nf:]):
                os.close(fd)
            del access.fds[nf:]
            del access.bound[nb:]

    def mutate(rel, desired, expected):
        # Reopen and retain the complete parent descriptor chain for every mutation.
        prefix, leaf = os.path.split(rel)
        parent, _ = access.relative(rootfd, prefix, True)
        access.verify()
        if desired and desired["type"] == "directory":
            if expected is None:
                os.mkdir(leaf, 0o700, dir_fd=parent)
            fd = os.open(leaf, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            try:
                os.fchmod(fd, desired["mode"])
            finally:
                os.close(fd)
        elif desired:
            blob = os.open(desired["hash"] + ".blob", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=storefd)
            with os.fdopen(blob, "rb") as source:
                data = source.read(64 * 1024 * 1024 + 1)
            if hashlib.sha256(data).hexdigest() != desired["hash"]:
                fail("恢复点内容校验失败")
            tmp = ".relay-restore-" + str(uuid.uuid4())
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            try:
                with os.fdopen(fd, "wb") as stream:
                    stream.write(data)
                    os.fchmod(stream.fileno(), desired["mode"])
                    stream.flush()
                    os.fsync(stream.fileno())
                access.verify()
                if expected is None:
                    os.link(tmp, leaf, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
                    os.unlink(tmp, dir_fd=parent)
                else:
                    os.replace(tmp, leaf, src_dir_fd=parent, dst_dir_fd=parent)
            finally:
                try:
                    os.unlink(tmp, dir_fd=parent)
                except FileNotFoundError:
                    pass
        elif expected["type"] == "directory":
            os.rmdir(leaf, dir_fd=parent)
        else:
            os.unlink(leaf, dir_fd=parent)
        os.fsync(parent)

    try:
        operation = request["operation"]
        if operation == "checkpoint-capture":
            if sum(e.stat(follow_symlinks=False).st_size for e in os.scandir(base) if e.is_file(follow_symlinks=False)) > (2 * 1024 - 256) * 1024 * 1024:
                fail("恢复点存储达到2 GiB上限")
            entries = scan(True)
            if entries != scan():
                fail("快照过程中项目发生变化，请稍后重试")
            write_json(request["id"], {"root": request["root"]["directoryIdentity"], "entries": entries, "directories": dict(directory_ids), "rootMetadata": root_metadata()})
            return {"files": len(entries)}
        before, after, changed, token = plan()
        files = [{"path": p, "action": "remove" if p not in before else "restore" if p in after else "recreate"} for p in changed]
        if operation == "checkpoint-preview":
            return {"token": token, "files": files}
        if operation != "checkpoint-restore" or request.get("token") != token:
            fail("恢复计划已失效，请重新预览")
        journal = {"root": request["root"]["directoryIdentity"], "state": "applying", "before": request["before"], "after": request["after"], "applied": []}
        journal_id = "restore-" + name(request["operationId"])
        try:
            os.stat(journal_id + ".json", dir_fd=storefd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            fail("此次恢复已有执行记录，请检查恢复结果，不会重复执行")
        write_json(journal_id, journal)
        order = sorted(changed, key=lambda p: (0 if before.get(p, {}).get("type") == "directory" else 2 if after.get(p, {}).get("type") == "directory" else 1, -p.count("/") if p not in before else p.count("/")))
        try:
            for p in order:
                # Check again immediately before applying each path, not just at preview time.
                if target(p) != after.get(p):
                    fail("文件在回滚过程中发生变化：" + p)
                set_entry(p, before.get(p), after.get(p))
                journal["applied"].append(p)
                write_json(journal_id, journal)
            journal["state"] = "completed"
            write_json(journal_id, journal)
        except BaseException:
            compensated = True
            for p in reversed(journal["applied"]):
                try:
                    set_entry(p, after.get(p), before.get(p))
                except BaseException:
                    compensated = False
                    break
            journal["state"] = "compensated" if compensated else "incomplete"
            write_json(journal_id, journal)
            if compensated:
                raise Denied("rollback_conflict", "回滚中止，已恢复本次操作前的文件；请刷新检查后重试", 409)
            # Immutable before/after blobs and the durable journal remain for recovery.
            raise Denied("rollback_incomplete", "文件恢复未全部完成；前后备份和恢复日志已保留，请勿重复操作", 409)
        return {"files": files}
    finally:
        os.close(storefd)
