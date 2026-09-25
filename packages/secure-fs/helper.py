#!/usr/bin/env python3
"""Linux fd-relative file access. JSON in/out; never follows a symlink.

Every path component is opened with O_NOFOLLOW and ancestor descriptors remain
open until the operation completes. Directory identity is revalidated before
returning any bytes. This deliberately rejects all symlinks and hard-linked
regular files, including links which happen to stay inside an allowed root.
"""
import base64
import difflib
import errno
import hashlib
import json
import os
import stat
import subprocess
import sys
import time


class Denied(Exception):
    def __init__(self, code, message, status=403):
        self.code, self.message, self.status = code, message, status


def identity(info):
    return {"dev": str(info.st_dev), "ino": str(info.st_ino)}


def same(info, expected):
    return identity(info) == expected


def inside(candidate, root):
    return candidate == root or candidate.startswith(root.rstrip("/") + "/")


class Access:
    def __init__(self, request):
        self.request = request
        self.fds = []
        self.bound = []
        self.sensitive = request.get("sensitivePaths", [])

    def close(self):
        for fd in reversed(self.fds):
            os.close(fd)

    def deny(self, path):
        names = set(path.split("/"))
        if names & {".ssh", ".codex", ".git", ".gnupg", ".aws", ".azure", ".kube", ".git-credentials", ".netrc", ".npmrc", ".pypirc", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"} or any(name == ".env" or name.startswith(".env.") for name in names):
            raise Denied("permission_denied", "Sensitive paths cannot be previewed")
        if any(inside(path, secret) for secret in self.sensitive):
            raise Denied("permission_denied", "Sensitive paths cannot be previewed")

    def absolute(self, path, expected=None, check_sensitive=True):
        if not path.startswith("/") or "\x00" in path or any(p in (".", "..") for p in path.split("/")):
            raise Denied("path_outside_workspace", "Invalid absolute directory path")
        path = os.path.normpath(path)
        if check_sensitive:
            self.deny(path)
        fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        self.fds.append(fd)
        ancestors = [identity(os.fstat(fd))]
        private_ancestor = False
        for name in filter(None, path.split("/")):
            parent = fd
            fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
            self.fds.append(fd)
            self.bound.append((parent, name, fd))
            ancestor_info = os.fstat(fd)
            ancestors.append(identity(ancestor_info))
            # A private ancestor owned by this user prevents other UIDs from
            # reaching descendants. Otherwise even a 0755 project may contain
            # 0664 files writable by a second user's Agent (or ACL grants).
            if ancestor_info.st_uid == os.getuid() and not ancestor_info.st_mode & 0o011:
                private_ancestor = True
        info = os.fstat(fd)
        if expected is not None and not same(info, expected):
            raise Denied("file_changed", "Directory identity changed; reopen the workspace", 409)
        return fd, info, ancestors, private_ancestor

    def root(self):
        root = self.request["root"]
        return self.absolute(root["canonicalRoot"], root.get("directoryIdentity"))

    def relative(self, rootfd, relative, directory=False):
        if not isinstance(relative, str) or relative.startswith("/") or "\x00" in relative or "\\" in relative:
            raise Denied("path_outside_workspace", "Invalid relative path")
        parts = relative.split("/") if relative else []
        if any(p in ("", ".", "..") for p in parts):
            raise Denied("path_outside_workspace", "Invalid relative path")
        fullpath = os.path.join(self.request["root"]["canonicalRoot"], relative)
        self.deny(fullpath)
        fd = rootfd
        for index, name in enumerate(parts):
            parent = fd
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
            if directory or index != len(parts) - 1:
                flags |= os.O_DIRECTORY
            fd = os.open(name, flags, dir_fd=parent)
            self.fds.append(fd)
            self.bound.append((parent, name, fd))
        info = os.fstat(fd)
        if not stat.S_ISDIR(info.st_mode) and not stat.S_ISREG(info.st_mode):
            raise Denied("permission_denied", "Special files cannot be previewed")
        if stat.S_ISREG(info.st_mode) and info.st_nlink != 1:
            raise Denied("permission_denied", "Hard-linked files cannot be previewed")
        return fd, info

    def verify(self):
        # Recheck every relationship, not only the leaf, before returning data.
        for parent, name, fd in self.bound:
            try:
                current = os.stat(name, dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                raise Denied("file_changed", "Path changed while reading; retry", 409)
            if not same(current, identity(os.fstat(fd))) or stat.S_ISLNK(current.st_mode):
                raise Denied("file_changed", "Path changed while reading; retry", 409)


def stamp(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def run(request):
    access = Access(request)
    try:
        operation = request["operation"]
        fd, info, ancestors, private_ancestor = access.root()
        if operation in ("root", "validate"):
            result = {"canonicalRoot": request["root"]["canonicalRoot"], "directoryIdentity": identity(info),
                      "ancestors": ancestors, "readable": True,
                      "writable": os.access(".", os.W_OK, dir_fd=fd),
                      "shared": not private_ancestor,
                      "ownerUid": info.st_uid, "mode": stat.S_IMODE(info.st_mode)}
        elif operation == "mkdir":
            fd, info = access.relative(fd, request.get("path", ""), True)
            name = request.get("name", "")
            if not isinstance(name, str) or not name.strip() or name != name.strip() or name in (".", "..") or any(c in name for c in ("/", "\\")) or any(ord(c) < 32 or ord(c) == 127 for c in name) or len(name.encode("utf-8")) > 255:
                raise Denied("invalid_request", "请输入有效的文件夹名称。", 400)
            target = os.path.join(request["root"]["canonicalRoot"], request.get("path", ""), name)
            access.deny(target)
            access.verify()
            try:
                os.mkdir(name, mode=0o755, dir_fd=fd)
            except FileExistsError:
                raise Denied("already_exists", "同名文件或文件夹已存在，请换一个名称。", 409)
            result = {"path": target}
        elif operation == "list":
            fd, info = access.relative(fd, request.get("path", ""), True)
            entries = []
            for name in os.listdir(fd):
                if not request.get("hidden") and name.startswith("."):
                    continue
                try:
                    full = os.path.join(request["root"]["canonicalRoot"], request.get("path", ""), name)
                    access.deny(full)
                    item = os.stat(name, dir_fd=fd, follow_symlinks=False)
                    if not (stat.S_ISREG(item.st_mode) or stat.S_ISDIR(item.st_mode)):
                        continue
                    if request.get("directoriesOnly") and not stat.S_ISDIR(item.st_mode):
                        continue
                    if stat.S_ISREG(item.st_mode) and item.st_nlink != 1:
                        continue
                    entries.append({"name": name, "type": "directory" if stat.S_ISDIR(item.st_mode) else "file",
                                    "size": item.st_size, "modifiedAt": item.st_mtime_ns // 1000000})
                except (Denied, FileNotFoundError, PermissionError):
                    continue
            entries.sort(key=lambda entry: (entry["type"] != "directory", entry["name"]))
            start = int(request.get("offset", 0))
            limit = int(request.get("limit", 100))
            result = {"entries": entries[start:start + limit], "total": len(entries),
                      "nextOffset": start + limit if start + limit < len(entries) else None}
        elif operation == "snapshot":
            fd, info = access.relative(fd, request["path"])
            if not stat.S_ISREG(info.st_mode):
                raise Denied("permission_denied", "Only regular files can be previewed")
            if info.st_size > request["maxBytes"]:
                raise Denied("file_too_large", "File exceeds the configured preview limit", 413)
            target = request["snapshotPath"]
            output = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            digest = hashlib.sha256()
            size = 0
            try:
                with os.fdopen(output, "wb") as dest:
                    while True:
                        chunk = os.read(fd, 128 * 1024)
                        if not chunk:
                            break
                        size += len(chunk)
                        if size > request["maxBytes"]:
                            raise Denied("file_too_large", "File exceeds the configured preview limit", 413)
                        digest.update(chunk)
                        dest.write(chunk)
                if stamp(info) != stamp(os.fstat(fd)):
                    raise Denied("file_changed", "File changed while taking a snapshot; retry", 409)
                access.verify()
            except BaseException:
                os.unlink(target)
                raise
            result = {"size": size, "sha256": digest.hexdigest(), "modifiedAt": info.st_mtime_ns // 1000000}
        elif operation == "manage":
            from manage import operate
            result = operate(request, access, fd, Denied)
        elif operation.startswith("transfer-"):
            from transfers import operate
            result = operate(request, access, fd, Denied)
        elif operation.startswith("checkpoint-"):
            from checkpoints import operate
            result = operate(request, access, fd, Denied)
        elif operation == "git":
            result = git_changes(fd, request, access)
        else:
            raise Denied("invalid_request", "Unknown filesystem operation", 400)
        access.verify()
        return result
    finally:
        access.close()


def git_changes(fd, request, access):
    # Git receives no caller-selected arguments or environment. Prevent index
    # writes, hooks, textconv, external diff, lazy fetch and global config.
    env = {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "LC_ALL": "C.UTF-8",
           "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
           "GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0", "GIT_NO_LAZY_FETCH": "1"}
    base = ["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
            "-c", "diff.external=", "-c", "core.quotePath=false"]
    cwd = "/proc/self/fd/" + str(fd)

    def execute(args, maximum):
        # A capped temporary output file prevents unbounded Node/Python buffers.
        import tempfile
        import resource

        def limits():
            resource.setrlimit(resource.RLIMIT_FSIZE, (maximum, maximum))

        with tempfile.TemporaryFile() as out:
            process = subprocess.Popen(base + args, cwd=cwd, env=env, stdout=out, stderr=subprocess.DEVNULL,
                                       pass_fds=(fd,), preexec_fn=limits)
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                raise Denied("git_unavailable", "Git inspection timed out", 503)
            out.seek(0)
            data = out.read(maximum)
            return process.returncode, data.decode("utf-8", "replace"), len(data) >= maximum

    code, root, _ = execute(["rev-parse", "--show-toplevel"], 65536)
    if code != 0:
        return {"git": False, "entries": [], "diff": "", "notice": "No Git repository; change events are observational and do not provide undo."}
    root = root.strip()
    workspace_path = request["root"]["canonicalRoot"]
    # Git porcelain names are repository-relative even inside a subdirectory.
    # Explicit literal pathspecs below confine the diff to validated files.
    _, status, status_truncated = execute(["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--", "."], 256 * 1024)
    records = status.split("\x00")
    safe_status = []
    safe_paths = []
    safe_content = {}
    content_size = 0
    index = 0
    while index < len(records):
        record = records[index]
        index += 1
        if len(record) < 4:
            continue
        names = [record[3:]]
        if "R" in record[:2] or "C" in record[:2]:
            if index < len(records):
                names.append(records[index])
                index += 1
        relative_paths = []
        try:
            for name in names:
                full = os.path.normpath(os.path.join(root, name))
                if not inside(full, workspace_path):
                    raise Denied("permission_denied", "Outside workspace")
                access.deny(full)
                relative = os.path.relpath(full, workspace_path)
                try:
                    filefd, info = access.relative(fd, relative)
                    if stat.S_ISDIR(info.st_mode):
                        # Untracked directory summaries do not contain bytes.
                        continue
                    if content_size + info.st_size <= 512 * 1024:
                        content = os.read(filefd, info.st_size + 1)
                        if stamp(info) != stamp(os.fstat(filefd)):
                            raise Denied("file_changed", "File changed during Git inspection", 409)
                        content_size += len(content)
                        safe_content[relative] = content
                except FileNotFoundError:
                    # Deleted tracked files can only expose the repository's
                    # old content; their lexical sensitive-path check applies.
                    safe_content[relative] = b""
                relative_paths.append(relative)
            safe_status.append(record)
            if len(names) > 1:
                safe_status.append(names[1])
            safe_paths.extend(relative_paths)
        except (Denied, OSError):
            continue
    if safe_paths:
        # Bound argv too. Remaining paths remain visible as status metadata.
        safe_paths = list(dict.fromkeys(safe_paths))[:1000]
        specs = [":(literal)" + item for item in safe_paths]
        # Do not let Git reopen mutable worktree paths after our validation:
        # an attacker could swap a regular file for a credential hard link.
        # Build the unstaged diff from fd-read bytes and repository index blobs.
        pieces = []
        truncated = len(safe_content) < len(safe_paths)
        for relative in safe_paths[:100]:
            if relative not in safe_content:
                continue
            repo_relative = os.path.relpath(os.path.join(workspace_path, relative), root)
            code, before, cut = execute(["show", ":" + repo_relative], 256 * 1024)
            if code != 0:
                continue  # untracked files have status, not an invented baseline
            after = safe_content[relative].decode("utf-8", "replace")
            if "\x00" in before or "\x00" in after:
                if before != after:
                    pieces.append("Binary file changed: " + relative + "\n")
                continue
            pieces.extend(difflib.unified_diff(before.splitlines(True), after.splitlines(True),
                          fromfile="a/" + relative, tofile="b/" + relative))
            truncated = truncated or cut
        diff = "".join(pieces)
        if len(diff) > 512 * 1024:
            diff = diff[:512 * 1024]
            truncated = True
        _, staged, staged_truncated = execute(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-renames", "--"] + specs, 512 * 1024)
    else:
        diff, staged, truncated, staged_truncated = "", "", False, False
    return {"git": True, "status": "\x00".join(safe_status), "diff": diff, "stagedDiff": staged,
            "truncated": truncated or staged_truncated or status_truncated,
            "notice": "Git changes may include edits that existed before this task."}


if __name__ == "__main__":
    try:
        request = json.load(sys.stdin)
        print(json.dumps({"ok": True, "result": run(request)}, ensure_ascii=True))
    except Denied as exc:
        print(json.dumps({"ok": False, "error": {"code": exc.code, "message": exc.message, "statusCode": exc.status}}))
    except OSError as exc:
        code = "not_found" if exc.errno == errno.ENOENT else "permission_denied"
        status = 404 if exc.errno == errno.ENOENT else 403
        print(json.dumps({"ok": False, "error": {"code": code, "message": "Filesystem path is unavailable or unsafe", "statusCode": status}}))
