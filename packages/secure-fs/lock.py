#!/usr/bin/env python3
"""Cooperative per-host locks, held by a helper for a run's entire lifetime.

The directory is an administrator provisioned, group-writable private service
directory for shared projects. A record left after an unclean shutdown is an
uncertain execution marker, never automatically reclaimed by PID checks.
"""
import fcntl
import hashlib
import json
import os
import stat
import sys
import time
import uuid


def reply(value):
    print(json.dumps(value), flush=True)


def overlap(left, right):
    left_id = left["directoryIdentity"]
    right_id = right["directoryIdentity"]
    return left_id in right["ancestors"] or right_id in left["ancestors"]


def main():
    request = json.loads(sys.stdin.readline())
    os.umask(0o007 if request["shared"] else 0o077)
    directory = os.open(request["directory"], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    mode = 0o660 if request["shared"] else 0o600
    gate = os.open("registry.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, mode, dir_fd=directory)
    if not stat.S_ISREG(os.fstat(gate).st_mode):
        raise ValueError("invalid registry lock")
    fcntl.flock(gate, fcntl.LOCK_EX)
    try:
        for name in os.listdir(directory):
            if not name.endswith(".lease"):
                continue
            old = os.open(name, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            try:
                info = os.fstat(old)
                if not stat.S_ISREG(info.st_mode) or info.st_size > 65536:
                    raise ValueError("invalid lease record")
                record = json.loads(os.read(old, 65536))
                if record["machineId"] != request["machineId"] or not overlap(record, request["workspace"]):
                    continue
                active = True
                try:
                    fcntl.flock(old, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    active = False
                    fcntl.flock(old, fcntl.LOCK_UN)
                except BlockingIOError:
                    pass
                reply({"ok": False, "error": {"code": "run_conflict" if active else "uncertain_operation",
                       "statusCode": 409, "message": "Workspace overlaps an active write task" if active else
                       "A previous execution may still be running; an administrator must verify and clear its lease"}})
                return
            finally:
                os.close(old)
        # IDs use verified machine and directory identity, never browser IDs.
        identity = request["workspace"]["directoryIdentity"]
        prefix = hashlib.sha256((request["machineId"] + ":" + identity["dev"] + ":" + identity["ino"]).encode()).hexdigest()
        name = prefix + "-" + str(uuid.uuid4()) + ".lease"
        record = {**request["workspace"], "machineId": request["machineId"], "runId": request["runId"],
                  "ownerUid": os.getuid(), "pid": os.getpid(), "createdAt": int(time.time() * 1000)}
        lease = os.open(name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=directory)
        fcntl.flock(lease, fcntl.LOCK_EX)
        os.write(lease, json.dumps(record).encode())
        os.fsync(lease)
        os.fsync(directory)
    finally:
        fcntl.flock(gate, fcntl.LOCK_UN)
    reply({"ok": True, "lease": name})
    command = sys.stdin.readline()
    # EOF / crash keeps a durable uncertain marker, even when the kernel drops
    # this helper's flock. Never infer that an orphaned command stopped.
    if command:
        instruction = json.loads(command)
        if instruction.get("release") and not instruction.get("uncertain"):
            fcntl.flock(gate, fcntl.LOCK_EX)
            try:
                os.unlink(name, dir_fd=directory)
                os.fsync(directory)
            finally:
                fcntl.flock(gate, fcntl.LOCK_UN)
    os.close(lease)
    os.close(gate)
    os.close(directory)


try:
    main()
except Exception:
    reply({"ok": False, "error": {"code": "lock_unavailable", "statusCode": 503,
                                  "message": "The cooperative lock directory is unavailable or unsafe"}})
