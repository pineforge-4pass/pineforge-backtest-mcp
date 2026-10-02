#!/usr/bin/env python3
"""Negative cases for parity/pf_parity.py on real corpus probes.

Runs inside the pineforge-release image. Every request goes through the public
request path (no meta_passthrough): the probe's script and TradingView tape,
chart timezone Asia/Taipei, timeframe 15, range start = the 15m feed's first
bar (the corpus gate's run for these probes), and one change per case:

  base  the unchanged tape                        -> excellent
  a     one exit price moved 1 %                  -> tier drops, that trade listed with its delta
  b     one entry price moved 1 %                 -> unmatched on both sides; the grader's tier reported
  c     one trade's rows dropped                  -> one unmatched PineForge trade listed
  d     chart timezone UTC, tape printed in +8    -> tier collapses, timezone.better names the zone
  e     chart timezone 1 h off                    -> warning: every match sits 1 h off
  f     malformed CSV                             -> ok:false with a plain message
  g     a Pine input named expected_tier          -> refused

  python3 negative.py --corpus DIR --feed-15m CSV [--driver PATH]
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_DRIVER = HERE.parent.parent / "parity" / "pf_parity.py"
SMALL = "risk-max-contracts-held-gate-pyramid-01"   # 5 trades
LARGE = "analyzer-anvil-percent-costs-01"           # 325 trades


def tape_rows(text: str) -> tuple[list[str], list[dict]]:
    reader = csv.DictReader(io.StringIO(text.lstrip("﻿")))
    return list(reader.fieldnames), list(reader)


def tape_text(header: list[str], rows: list[dict]) -> str:
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=header, lineterminator="\n")
    w.writeheader()
    w.writerows(rows)
    return buf.getvalue()


def moved(text: str, trade: str, kind: str, factor: float) -> str:
    header, rows = tape_rows(text)
    price = next(h for h in header if h == "Price" or h.startswith("Price "))
    num = "Trade #" if "Trade #" in header else "Trade number"
    for r in rows:
        if r[num] == trade and r["Type"].startswith(kind):
            r[price] = f"{float(r[price]) * factor:.2f}"
    return tape_text(header, rows)


def dropped(text: str, trade: str) -> str:
    header, rows = tape_rows(text)
    num = "Trade #" if "Trade #" in header else "Trade number"
    return tape_text(header, [r for r in rows if r[num] != trade])


def request(corpus: Path, slug: str, feed: Path, **over) -> dict:
    probe = corpus / "validation" / slug
    with feed.open() as f:
        f.readline()
        first = int(f.readline().split(",", 1)[0])
    req = {
        "pine": (probe / "strategy.pine").read_text(encoding="utf-8"),
        "tradingview_trades_csv": (probe / "tv_trades.csv").read_text(encoding="utf-8-sig"),
        "chart_timezone": "Asia/Taipei", "timeframe": "15", "range_start_ms": first,
        "range_end_ms": None, "ohlcv_csv_path": str(feed), "max_mismatches": 5,
    }
    req.update(over)
    return req


def drive(driver: Path, req: dict) -> dict:
    proc = subprocess.run([sys.executable, str(driver)], input=json.dumps(req),
                          capture_output=True, text=True, timeout=1800)
    if proc.returncode != 0:
        return {"ok": False, "error": "driver_exit", "message": proc.stderr[-800:]}
    return json.loads(proc.stdout)


def show(name: str, r: dict) -> None:
    print(f"== {name}")
    if not r.get("ok"):
        print(f"   ok:false error={r.get('error')} message={r.get('message')}")
        return
    print(f"   tier={r['tier']} profile={r['profile']} matched={r['matched']} "
          f"unmatched_tradingview={r['unmatched_tradingview']} "
          f"unmatched_pineforge={r['unmatched_pineforge']} deviating_pairs={r['deviating_pairs']}")
    for c in r["checks"]:
        print(f"   check {c['name']}: value={c['value']} pass_excellent={c['pass_excellent']}")
    for m in r["mismatches"]:
        tv, pf = m.get("tradingview"), m.get("pineforge")
        side = lambda t: (f"#{t['trade']} {t['side']} {t['entry_time']} @{t['entry_price']} -> "
                          f"{t['exit_time']} @{t['exit_price']} pnl={t['pnl']}") if t else "-"
        print(f"   {m['kind']}: TV {side(tv)} | PF {side(pf)}")
        if m.get("deltas"):
            print(f"      deltas {json.dumps(m['deltas'])}")
        if m.get("hint"):
            print(f"      hint: {m['hint']}")
    print(f"   timezone {json.dumps(r['timezone'])}")
    for w in r["warnings"]:
        print(f"   warning: {w}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--corpus", type=Path, required=True)
    ap.add_argument("--feed-15m", type=Path, required=True)
    ap.add_argument("--driver", type=Path, default=DEFAULT_DRIVER)
    args = ap.parse_args()
    c, f, d = args.corpus, args.feed_15m, args.driver
    small_tape = (c / "validation" / SMALL / "tv_trades.csv").read_text(encoding="utf-8-sig")
    results = []

    def case(name, req, verdict):
        r = drive(d, req)
        show(name, r)
        ok, why = verdict(r)
        print(f"   -> {'PASS' if ok else 'FAIL'}: {why}")
        results.append((name, ok))

    case(f"base {SMALL} unchanged", request(c, SMALL, f),
         lambda r: (r.get("tier") == "excellent", f"tier {r.get('tier')}"))
    case(f"a {SMALL}: trade 3 exit price +1 %",
         request(c, SMALL, f, tradingview_trades_csv=moved(small_tape, "3", "Exit", 1.01)),
         lambda r: (r.get("tier") not in (None, "excellent")
                    and any(m["kind"] == "deviating_pair" and m["tradingview"]["trade"] == 3
                            and abs(m["deltas"]["exit"] - 0.0099) < 0.0005 for m in r["mismatches"]),
                    f"tier {r.get('tier')}, trade 3 listed with its exit delta"))
    case(f"b {SMALL}: trade 3 entry price +1 %",
         request(c, SMALL, f, tradingview_trades_csv=moved(small_tape, "3", "Entry", 1.01)),
         lambda r: (r.get("unmatched_tradingview") == 1 and r.get("unmatched_pineforge") == 1,
                    f"unmatched {r.get('unmatched_tradingview')}/{r.get('unmatched_pineforge')}, "
                    f"grader tier {r.get('tier')}"))
    case(f"c {SMALL}: trade 3 rows dropped",
         request(c, SMALL, f, tradingview_trades_csv=dropped(small_tape, "3")),
         lambda r: (r.get("unmatched_pineforge") == 1 and r.get("unmatched_tradingview") == 0
                    and r.get("tier") != "excellent",
                    f"unmatched PineForge {r.get('unmatched_pineforge')}, tier {r.get('tier')}"))
    case(f"d {LARGE}: chart timezone UTC (tape printed in Asia/Taipei)",
         request(c, LARGE, f, chart_timezone="UTC"),
         lambda r: (r.get("tier") in ("weak", "minimal")
                    and (r.get("timezone", {}).get("better") or {}).get("zone") in ("Asia/Taipei", "Asia/Shanghai",
                                                                                  "Asia/Hong_Kong", "Asia/Singapore",
                                                                                  "Etc/GMT-8"),
                    f"tier {r.get('tier')}, better {r.get('timezone', {}).get('better')}"))
    case(f"e {LARGE}: chart timezone Asia/Tokyo (1 h off)",
         request(c, LARGE, f, chart_timezone="Asia/Tokyo"),
         lambda r: (abs(r.get("timezone", {}).get("offset_mode_seconds", 0)) == 3600
                    and any("1 h" in w for w in r.get("warnings", [])),
                    f"offset mode {r.get('timezone', {}).get('offset_mode_seconds')}, "
                    f"share {r.get('timezone', {}).get('offset_mode_share')}, tier {r.get('tier')}"))
    case("f malformed CSV (semicolon-separated)",
         request(c, SMALL, f, tradingview_trades_csv=small_tape.replace(",", ";")),
         lambda r: (r.get("ok") is False and r.get("error") == "bad_trades_csv", r.get("message")))
    case("g a Pine input named expected_tier",
         request(c, SMALL, f, inputs={"expected_tier": "excellent"}),
         lambda r: (r.get("ok") is False and r.get("error") == "reserved_input_name", r.get("message")))

    failed = [n for n, ok in results if not ok]
    print(f"\nNEGATIVE {len(results) - len(failed)}/{len(results)} as expected")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
