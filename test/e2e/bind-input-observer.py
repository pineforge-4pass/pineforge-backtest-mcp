#!/usr/bin/env python3
"""Observe live binds, then run real Docker with the same argv/stdin/stdout.

In the private-feed control case it also reads the engine's own live /in/ohlcv.csv
bind once, before the engine starts, by running the pinned image's own cat on it as
the container entrypoint (default user, no shell, no other command), and records that
read in a separate live-bind-probe-*.json receipt beside the engine trace. The probe
never reaches the engine's stdin, stdout, stderr, exit status or trace, and the bytes
cat writes are reduced to a count and a host-side SHA-256, never stored or printed.
"""

import errno
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import time

LIVE_TARGET = "/in/ohlcv.csv"
LIVE_SCHEMA = "pineforge-bind-live-probe/v2"
LIVE_PREFIX = "live-bind-probe-"
# The reader: the pinned image's own cat, started directly as the container entrypoint with the
# target as its only argument. No shell, no id and no hash tool run there; the observer hashes
# the bytes cat wrote, on the host.
LIVE_READER = "cat"


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


def live_outcome(kind, errno_name=None, sha256=None, reason=None):
    return dict(kind=kind, errno=errno_name, sha256=sha256, reason=reason)


def errno_named(text):
    # Name the errno whose strerror text the reader itself printed; None when no errno prints it.
    for code, name in errno.errorcode.items():
        if os.strerror(code) == text:
            return name
    return None


def live_text(raw):
    return (raw or b"").decode("utf-8", "backslashreplace")


def live_stdout(raw):
    # The container's stdout is reduced to its byte count and the SHA-256 of exactly those captured bytes,
    # both computed here on the observer host. The bytes themselves are never stored, printed or forwarded.
    data = raw or b""
    return len(data), hashlib.sha256(data).hexdigest()


def judge_live_read(run, staged_sha256):
    # Classify the probe's raw result strictly. Only the two documented outputs qualify; anything else is
    # invalid, including a Docker or setup failure, a missing cat, ENOENT, a wrong byte or a vacuous read.
    size, got, err, code = run["stdoutBytes"], run["stdoutSha256"], run["stderr"], run["exit"]
    if code == 0:
        if err != "":
            return live_outcome("invalid", reason="exit 0 with a diagnostic on stderr")
        if size == 0:
            return live_outcome("invalid", reason="exit 0 without reading any byte")
        if not staged_sha256 or got != staged_sha256:
            return live_outcome("invalid", reason="the bytes cat wrote do not hash to the staged copy")
        return live_outcome("read", sha256=got)
    denial = re.fullmatch("cat: " + re.escape(LIVE_TARGET) + ": (.+)\n", err)
    if code == 1 and size == 0 and denial:
        name = errno_named(denial.group(1))
        if name == "EACCES":
            return live_outcome("denied", errno_name=name)
        return live_outcome("invalid", errno_name=name,
                            reason="the read failed with " + (name or repr(denial.group(1))) + ", not EACCES")
    return live_outcome("invalid", reason=f"unexpected cat exit {code}, stdout or stderr")


def live_bind_probe(docker, args, chart):
    # One container read (the pinned image's own cat) of the engine's own live /in/ohlcv.csv bind, run
    # before the engine starts. It never raises, never prints, and never reaches the engine's stdio,
    # exit status or trace.
    pin = os.environ.get("PINEFORGE_IMAGE")
    source = chart["source"]
    live = dict(image=dict(pin=pin, engine=args[-1]), bind=None,
                source=dict(path=source["path"], engine=source, before=None, after=None, sha256=chart.get("sha256")),
                probe=dict(argv=None, exit=None, stdoutBytes=None, stdoutSha256=None, stderr=None,
                           startedNs=None, endedNs=None),
                outcome=live_outcome("invalid", reason="the probe did not run"))

    def refuse(reason):
        live["outcome"] = live_outcome("invalid", reason=reason)
        return live

    try:
        binds = [args[i + 1] for i, arg in enumerate(args[:-1])
                 if arg == "-v" and args[i + 1].split(":")[1:2] == [LIVE_TARGET]]
        if len(binds) != 1:
            return refuse(f"the engine argv has {len(binds)} binds to {LIVE_TARGET}, not one")
        live["bind"] = binds[0]
        if binds[0].split(":") != [source["path"], LIVE_TARGET, "ro"]:
            return refuse(f"the engine bind is not exactly SOURCE:{LIVE_TARGET}:ro")
        if not pin or not re.fullmatch(r".+@sha256:[0-9a-f]{64}", pin):
            return refuse("PINEFORGE_IMAGE is not a digest-pinned image reference")
        if args[-1] != pin:
            return refuse("the engine's image is not the pinned image")
        before = file_stat(source["path"])
        live["source"]["before"] = before
        if before != source or not before["regular"]:
            return refuse("the live source is not the regular file recorded for the engine bind")
        run = live["probe"]
        run["argv"] = [docker, "run", "--rm", "--pull=never", "--network=none", "--log-driver=none", "-e", "LC_ALL=C",
                       "-v", binds[0], "--entrypoint", LIVE_READER, pin, LIVE_TARGET]
        run["startedNs"] = time.time_ns()
        proc = subprocess.run(run["argv"], stdin=subprocess.DEVNULL, capture_output=True)
        ended = time.time_ns()
        size, sha = live_stdout(proc.stdout)
        run.update(endedNs=ended, exit=proc.returncode, stdoutBytes=size, stdoutSha256=sha,
                   stderr=live_text(proc.stderr))
        live["source"]["after"] = file_stat(source["path"])
        if live["source"]["after"] != before:
            return refuse("the live source changed while it was probed")
        live["outcome"] = judge_live_read(run, chart.get("sha256"))
    except Exception as exc:
        return refuse(f"{type(exc).__name__}: {exc}")
    return live


def record_live_bind(live, trace):
    # The probe's own receipt, beside the engine trace it belongs to. It never raises and never prints;
    # a failure leaves no receipt, which the verifier rejects.
    try:
        name = os.path.basename(trace)
        token = name[len("docker-"):-len(".json")]
        receipt = dict(live, schema=LIVE_SCHEMA, trace=dict(name=name, sha256=digest(trace)))
        path = os.path.join(os.path.dirname(trace), LIVE_PREFIX + token + ".json")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as handle:
            json.dump(receipt, handle, indent=2, sort_keys=True)
            handle.write("\n")
    except Exception:
        pass


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
    live = None
    if chart and os.environ.get("PF_BIND_CONTROL"):
        path = chart["source"]["path"]
        control = os.environ["PF_BIND_CONTROL"]
        event["privacy"] = dict(control=probe_as_other(control), input=probe_as_other(path),
                                controlStat=file_stat(control), controlParent=file_stat(os.path.dirname(control)))
        # Record again so ENOENT cannot masquerade as denial on a stale path.
        event["privacy"]["inputAfter"] = file_stat(path)
        # A separate receipt, never part of the engine trace: one real container read of this same live
        # bind, taken before the engine starts and written beside the trace once the engine has finished.
        live = live_bind_probe(docker, args, chart)

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
    if live is not None:
        record_live_bind(live, trace)
    return proc.returncode if proc.returncode >= 0 else 128 - proc.returncode


if __name__ == "__main__":
    if sys.argv[1] == "--probe":
        probe(sys.argv[2])
    else:
        sys.exit(observe(sys.argv[1:]))
