#!/usr/bin/env python3
"""Observe live binds, then run real Docker with the same argv/stdin/stdout."""

import errno
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def file_stat(path):
    st = os.lstat(path)
    return dict(path=path, mode=stat.S_IMODE(st.st_mode), uid=st.st_uid, gid=st.st_gid,
                dev=st.st_dev, ino=st.st_ino, regular=stat.S_ISREG(st.st_mode),
                directory=stat.S_ISDIR(st.st_mode))


def process_status():
    return dict(line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines())


def probe(path):
    # This branch runs as the alternate host account. Never emit fixture bytes.
    status = process_status()
    result = dict(path=path, uids=[int(x) for x in status["Uid"].split()],
                  caps={k: int(status[k], 16) for k in ("CapEff", "CapPrm", "CapAmb")})
    try:
        with open(path, "rb") as handle:
            result.update(digest=hashlib.sha256(handle.read()).hexdigest(), errno=None)
    except OSError as exc:
        result["errno"] = errno.errorcode[exc.errno]
    print(json.dumps(result))


def probe_as_other(path):
    argv = ["sudo", "-n", "-u", os.environ["PF_BIND_OTHER_USER"], "--",
            str(Path(sys.executable).resolve(strict=True)), "-I",
            str(Path(__file__).resolve(strict=True)), "--probe", path]
    proc = subprocess.run(argv, cwd="/", capture_output=True, text=True, check=True)
    return dict(json.loads(proc.stdout), argv=argv)


def observe(args):
    docker = os.environ["PF_BIND_REAL_DOCKER"]
    if os.environ.get("PF_BIND_FORBID_DOCKER") == "1":
        Path(os.environ["PF_BIND_TRACE"], "docker-unexpected").touch()
        raise SystemExit("local runner attempted Docker")
    if args[0] != "run":
        os.execv(docker, [docker, *args])
    event = dict(argv=args, uid=os.getuid(), gid=os.getgid(), umask=process_status()["Umask"].strip(), mounts={})
    for i, arg in enumerate(args):
        if arg != "-v":
            continue
        source, target, *flags = args[i + 1].split(":")
        mount = dict(source=file_stat(source), parent=file_stat(os.path.dirname(source)), flags=flags)
        if mount["source"]["regular"]:
            mount["sha256"] = digest(source)
        if target == "/opt/pineforge-overlay":
            mount["children"] = [file_stat(os.path.join(source, p))
                                 for p in ("bin", "bin/run_json.py", "instrument.json")]
        if target == "/jail":
            mount["work"] = file_stat(os.path.join(source, "work"))
        event["mounts"][target] = mount

    chart = event["mounts"].get("/in/ohlcv.csv")
    if chart and os.environ.get("PF_BIND_CONTROL"):
        path = chart["source"]["path"]
        control = os.environ["PF_BIND_CONTROL"]
        event["privacy"] = dict(control=probe_as_other(control), input=probe_as_other(path),
                                controlStat=file_stat(control), controlParent=file_stat(os.path.dirname(control)))
        # Record again so ENOENT cannot masquerade as denial on a stale path.
        event["privacy"]["inputAfter"] = file_stat(path)

    cpp = event["mounts"].get("/in/strategy.cpp")
    if cpp and os.environ.get("PF_BIND_TEST_TAMPER") == "1":
        # Only the dedicated negative test touches its own disposable staged C++.
        path = cpp["source"]["path"]
        with open(path, "ab") as handle:
            handle.write(b"\n// change one vouched mount after the MCP has hashed it\n")
        event["tamperedSha256"] = digest(path)

    fd, trace = tempfile.mkstemp(prefix="docker-", suffix=".json", dir=os.environ["PF_BIND_TRACE"])
    with os.fdopen(fd, "w") as handle:
        proc = subprocess.run([docker, *args], stderr=subprocess.PIPE)
        event.update(exit=proc.returncode, stderr=os.fsdecode(proc.stderr))
        json.dump(event, handle)
    sys.stderr.buffer.write(proc.stderr)
    sys.stderr.flush()
    return proc.returncode if proc.returncode >= 0 else 128 - proc.returncode


if __name__ == "__main__":
    if sys.argv[1] == "--probe":
        probe(sys.argv[2])
    else:
        sys.exit(observe(sys.argv[1:]))
