#!/usr/bin/env python3
"""Kill test of pf_parity.py: stopping or killing the driver mid-run leaves no
descendant running (Linux, inside the release image; run with docker --init).

A Pine script with an endless loop keeps the harness (run_strategy.py, with the
user's .so loaded in it) busy. Once it runs, the driver is stopped three ways:

  term    SIGTERM to the driver's process group (a runner's first signal)
  kill    SIGKILL to the driver alone (a crash)
  parent  SIGKILL to the process that started the driver (the MCP server dying)

Each case passes when, within a few seconds, the driver and every process whose
command line names the case's work folder are gone.

Run: docker run --rm --init --entrypoint python3 <image> /app/parity/pf_parity_killtest.py
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
DRIVER = HERE / "pf_parity.py"

PINE = """//@version=6
strategy("loop forever", overlay = true)
var int n = 0
while true
    n += 1
if n > 0
    strategy.entry("L", strategy.long)
"""


def request(work: Path) -> str:
    start = 1743379200000  # 2025-03-31 00:00 UTC
    bars = ["timestamp,open,high,low,close,volume"]
    for i in range(400):
        p = 100 + (i % 7)
        bars.append(f"{start + i * 900_000},{p},{p + 1},{p - 1},{p + 0.5},10")
    (work / "bars.csv").write_text("\n".join(bars) + "\n")
    trades = ("Trade number,Type,Date and time,Signal,Price USDT,Size (qty),Net PnL USDT\n"
              "1,Exit long,2025-03-31 10:00,x,103,1,1\n"
              "1,Entry long,2025-03-31 05:00,L,102,1,1\n")
    return json.dumps({
        "pine": PINE, "tradingview_trades_csv": trades, "chart_timezone": "UTC", "timeframe": "15",
        "range_start_ms": start, "range_end_ms": None, "ohlcv_csv_path": str(work / "bars.csv"),
        "max_mismatches": 1, "workdir": str(work / "jail"),
    })


def pids_naming(marker: str) -> list[int]:
    out = []
    for d in os.listdir("/proc"):
        if not d.isdigit() or int(d) == os.getpid():
            continue
        try:
            cmd = Path(f"/proc/{d}/cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8", "replace")
            state = Path(f"/proc/{d}/stat").read_text().rsplit(")", 1)[1].split()[0]
        except OSError:
            continue
        if marker in cmd and state != "Z":
            out.append(int(d))
    return out


def alive(pid: int) -> bool:
    try:
        state = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
    except OSError:
        return False
    return state != "Z"


def wait_for(pred, timeout: float) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(0.2)
    return pred()


def harness_running(marker: str) -> list[int]:
    return [p for p in pids_naming(marker)
            if "run_strategy.py" in Path(f"/proc/{p}/cmdline").read_bytes().decode("utf-8", "replace")]


def run_case(how: str) -> tuple[bool, str]:
    work = Path(tempfile.mkdtemp(prefix=f"pf-killtest-{how}-"))
    (work / "jail").mkdir()
    marker = str(work)
    req = request(work)
    env = dict(os.environ, PF_PARITY_TIMEOUT_MS="300000")
    if how == "parent":
        starter = ("import subprocess, sys, time\n"
                   f"p = subprocess.Popen([sys.executable, {str(DRIVER)!r}], stdin=subprocess.PIPE, "
                   "stdout=subprocess.DEVNULL)\n"
                   "p.stdin.write(sys.stdin.buffer.read()); p.stdin.close()\n"
                   "print(p.pid, flush=True)\n"
                   "time.sleep(3600)\n")
        top = subprocess.Popen([sys.executable, "-c", starter], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, env=env, start_new_session=True)
        top.stdin.write(req.encode()); top.stdin.close()
        driver_pid = int(top.stdout.readline())
    else:
        top = subprocess.Popen([sys.executable, str(DRIVER)], stdin=subprocess.PIPE,
                               stdout=subprocess.DEVNULL, env=env, start_new_session=True)
        top.stdin.write(req.encode()); top.stdin.close()
        driver_pid = top.pid
    if not wait_for(lambda: harness_running(marker), 120):
        top.kill()
        return False, "the harness never started"
    seen = sorted(set(pids_naming(marker)) | {driver_pid})
    t0 = time.monotonic()
    if how == "term":
        os.killpg(top.pid, signal.SIGTERM)
    elif how == "kill":
        os.kill(driver_pid, signal.SIGKILL)
    else:
        os.kill(top.pid, signal.SIGKILL)
    gone = wait_for(lambda: not pids_naming(marker) and not alive(driver_pid), 15)
    secs = time.monotonic() - t0
    try:
        top.wait(timeout=5)
    except subprocess.TimeoutExpired:
        top.kill()
    left = pids_naming(marker) + ([driver_pid] if alive(driver_pid) else [])
    for p in left:  # leave nothing behind for the next case
        try:
            os.kill(p, signal.SIGKILL)
        except OSError:
            pass
    return gone, f"watched pids {seen}; still running after {secs:.1f} s: {left or 'none'}"


def main() -> int:
    if not sys.platform.startswith("linux"):
        print("skip: Linux only")
        return 0
    failures = 0
    for how in ("term", "kill", "parent"):
        ok, detail = run_case(how)
        failures += not ok
        print(f"{'ok  ' if ok else 'FAIL'} {how}: {detail}", flush=True)
    print(f"\n{'PASS' if not failures else 'FAIL'}: {failures} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
