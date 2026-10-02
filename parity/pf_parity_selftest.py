#!/usr/bin/env python3
"""Self-test of pf_parity.py request validation and timezone handling.

Needs no engine: every case here is refused before the jail is built, or
exercises the timezone helpers directly. Run: python3 parity/pf_parity_selftest.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import pf_parity as pf  # noqa: E402

TAPE = ("Trade #,Type,Signal,Date and time,Price USDT,Position size (qty),Net PnL USDT\n"
        "1,Exit long,,2025-04-02 10:00,1810.5,1,10.5\n"
        "1,Entry long,L,2025-04-02 08:00,1800,1,10.5\n")
BARS = "timestamp,open,high,low,close,volume\n" + "".join(
    f"{1743465600000 + i * 900000},1800,1801,1799,1800,1\n" for i in range(200))

failures = []


def check(name: str, cond: bool, detail: str = "") -> None:
    print(f"{'ok  ' if cond else 'FAIL'} {name}{': ' + detail if detail and not cond else ''}")
    if not cond:
        failures.append(name)


def refused(name: str, req: dict, kind: str) -> None:
    try:
        pf.grade(req)
    except pf.UserError as e:
        check(name, e.kind == kind, f"got {e.kind}: {e.message}")
        print(f"     {e.kind}: {e.message}")
        return
    except Exception as e:  # anything else is a driver bug
        check(name, False, f"raised {type(e).__name__}: {e}")
        return
    check(name, False, "was accepted")


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="pf-parity-selftest-"))
    bars = tmp / "bars.csv"
    bars.write_text(BARS)
    base = {"pine": "//@version=6\nstrategy('x')\n", "tradingview_trades_csv": TAPE,
            "chart_timezone": "UTC", "timeframe": "15", "range_start_ms": 1743465600000,
            "ohlcv_csv_path": str(bars)}

    # request validation
    refused("missing pine", {**base, "pine": ""}, "bad_request")
    refused("csv without the grader's columns", {**base, "tradingview_trades_csv": "a,b\n1,2\n"},
            "bad_trades_csv")
    refused("csv with a bad time", {**base, "tradingview_trades_csv": TAPE.replace("2025-04-02 10:00", "02/04/2025")},
            "bad_trades_csv")
    refused("csv with a year out of range", {**base, "tradingview_trades_csv": TAPE.replace("2025-04-02 10:00", "9999-12-31 23:59")},
            "bad_trades_csv")
    refused("csv with a bad price", {**base, "tradingview_trades_csv": TAPE.replace("1810.5", "abc")},
            "bad_trades_csv")
    refused("csv with a ragged row", {**base, "tradingview_trades_csv": TAPE + "2,Entry long\n"},
            "bad_trades_csv")
    refused("csv with only an entry", {**base, "tradingview_trades_csv": TAPE.splitlines()[0] + "\n" + TAPE.splitlines()[2] + "\n"},
            "no_closed_trades")
    for name in ("expected_tier", "tv_trades_csv_tz", "trim_bars", "parity_profile", "ohlcv_start_ms",
                 "validation_overrides", "runtime_overrides", "tv_anything"):
        refused(f"input named {name}", {**base, "inputs": {name: "1"}}, "reserved_input_name")
    refused("unknown runtime key", {**base, "runtime": {"syminfo_metadata": {}}}, "bad_request")
    refused("bad timeframe", {**base, "timeframe": "15 minutes"}, "bad_request")
    refused("trades before the range start", {**base, "range_start_ms": 1743584400000},
            "trades_before_range_start")
    march = tmp / "march.csv"
    march.write_text("timestamp,open,high,low,close,volume\n1740787200000,1,1,1,1,1\n")
    refused("no bars in range", {**base, "ohlcv_csv_path": str(march)}, "no_bars")
    refused("missing bars file", {**base, "ohlcv_csv_path": str(tmp / "nope.csv")}, "no_bars")
    refused("bars with another header", {**base, "ohlcv_csv_path": str(HERE / "pf_parity.py")}, "no_bars")
    refused("range end before start", {**base, "range_end_ms": 1743465600000}, "bad_request")

    # timezone resolution
    refused("unknown timezone", {**base, "chart_timezone": "Mars/Olympus"}, "bad_timezone")
    refused("alias the grader would read as Taipei", {**base, "chart_timezone": "Japan"}, "bad_timezone")
    refused("no timezone", {**base, "chart_timezone": ""}, "bad_timezone")
    for given, form in (("UTC", "UTC"), ("Etc/UTC", "Etc/UTC"), ("GMT", "utc"), ("Asia/Taipei", "Asia/Taipei"),
                        ("America/New_York", "America/New_York")):
        got, _ = pf.resolve_timezone(given)
        check(f"timezone {given} -> grader form {form}", got == form, f"got {got}")
    # the grader's own reading must match zoneinfo over the tape's span, DST included
    from zoneinfo import ZoneInfo
    span = (int(datetime(2025, 1, 1, tzinfo=timezone.utc).timestamp()),
            int(datetime(2025, 12, 31, tzinfo=timezone.utc).timestamp()))
    for name in ("America/New_York", "Europe/London", "Asia/Taipei", "UTC"):
        form, zone = pf.resolve_timezone(name)
        try:
            pf.check_grader_zone(form, zone, span)
            check(f"grader offsets match zoneinfo for {name}", True)
        except pf.UserError as e:
            check(f"grader offsets match zoneinfo for {name}", False, e.message)
    try:
        pf.check_grader_zone("Japan", ZoneInfo("Asia/Tokyo"), span)
        check("a name the grader falls back on is caught", False, "accepted")
    except pf.UserError as e:
        check("a name the grader falls back on is caught", e.kind == "bad_timezone", e.kind)

    # the process contract: JSON in, JSON out, exit 0 on user errors
    proc = subprocess.run([sys.executable, str(HERE / "pf_parity.py")], input="not json",
                          capture_output=True, text=True)
    out = json.loads(proc.stdout)
    check("non-JSON request -> ok:false, exit 0", proc.returncode == 0 and out == {
        "ok": False, "error": "bad_request", "message": out.get("message")} and not out["ok"])
    proc = subprocess.run([sys.executable, str(HERE / "pf_parity.py")],
                          input=json.dumps({**base, "inputs": {"expected_tier": "excellent"}}),
                          capture_output=True, text=True)
    out = json.loads(proc.stdout)
    check("reserved input over stdin -> ok:false, exit 0",
          proc.returncode == 0 and out.get("error") == "reserved_input_name", proc.stdout)
    print(f"     {proc.stdout.strip()}")
    leftovers = [p for p in Path(tempfile.gettempdir()).glob("pf-parity-*") if p.name != tmp.name
                 and p.stat().st_mtime > os.path.getmtime(bars) - 1]
    check("refused requests leave no jail behind", not leftovers, str(leftovers))

    print(f"\n{'PASS' if not failures else 'FAIL'}: {len(failures)} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
