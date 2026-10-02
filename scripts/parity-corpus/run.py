#!/usr/bin/env python3
"""Grade the published corpus through parity/pf_parity.py and compare tiers.

Runs inside the pineforge-release image (python3, g++, the engine under
$PINEFORGE_PREFIX). For each probe under <corpus>/validation it builds the
driver request the corpus gate's run corresponds to:

  pine              strategy.pine
  tv trades         the tape inputs.json names (tv_trades.csv by default)
  chart timezone    inputs.json tv_trades_csv_tz (absent: the grader's default, Asia/Taipei)
  timeframe         inputs.json script_tf / input_tf, else 15
  range start       inputs.json ohlcv_start_ms, else the feed's first bar
  range end         omitted (the corpus gate had no metrics.json)
  bars              the corpus feed inputs.json names (15m derived feed by default)
  meta_passthrough  the probe's inputs.json ({} when it has none)

runs the driver, and compares the tier with validation_report.md.

  python3 run.py --corpus DIR --feed-15m CSV --feed-1m CSV [--driver PATH]
                 [--jobs N] [--only SLUG ...] [--sample N] [--out JSONL]

Prints one line per probe, then AGREEMENT n/N, per-category counts and every
failure. Exit 0 only when every graded probe agrees.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_DRIVER = HERE.parent.parent / "parity" / "pf_parity.py"

# Not in the 309: the supervisor's design, section 7.
EXCLUDED = {
    "analyzer-self-test-multi-mode-01",
    "bracket-rivet-calc-on-fill-01",
    "order-switchback-all-in-reversal-01",
}

TZ_ALIASES = {"asia_taipei": "Asia/Taipei", "utc_plus_8": "Asia/Taipei", "utc": "UTC"}

ROW = re.compile(
    r"^\| \[`(?P<slug>[^`]+)`\]\([^)]*\) \| `(?P<cat>[^`]+)` \| (?P<tier>[a-z_]+) \| "
    r"`(?P<profile>[a-z]+)` \| (?P<tv>\d+) \| (?P<eng>\d+) \| (?P<matched>\d+) \|")


def published_tiers(report: Path) -> dict[str, dict]:
    out = {}
    for line in report.read_text(encoding="utf-8").splitlines():
        m = ROW.match(line)
        if m:
            out[m["slug"]] = {
                "category": m["cat"], "tier": m["tier"], "profile": m["profile"],
                "tv": int(m["tv"]), "eng": int(m["eng"]), "matched": int(m["matched"]),
            }
    return out


def first_bar_ms(feed: Path) -> int:
    with feed.open(encoding="utf-8") as f:
        f.readline()
        return int(f.readline().split(",", 1)[0])


def build_request(probe: Path, feed_15m: Path, feed_1m: Path) -> dict:
    meta_path = probe / "inputs.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.is_file() else {}
    tape = probe / str(meta.get("tv_trades_csv", "tv_trades.csv"))
    feed_name = str(meta.get("ohlcv_csv", ""))
    feed = feed_1m if "_1m" in feed_name else feed_15m
    tz_raw = str(meta.get("tv_trades_csv_tz", "")).strip()
    chart_tz = TZ_ALIASES.get(tz_raw.lower(), tz_raw) or "Asia/Taipei"
    start = meta.get("ohlcv_start_ms")
    return {
        "pine": (probe / "strategy.pine").read_text(encoding="utf-8"),
        "tradingview_trades_csv": tape.read_text(encoding="utf-8-sig"),
        "chart_timezone": chart_tz,
        "timeframe": str(meta.get("script_tf") or meta.get("input_tf") or "15"),
        "range_start_ms": int(start) if start is not None else first_bar_ms(feed),
        "range_end_ms": None,
        "ohlcv_csv_path": str(feed),
        "max_mismatches": 5,
        "meta_passthrough": meta,
    }


def run_probe(probe: Path, args) -> dict:
    started = time.time()
    try:
        request = build_request(probe, args.feed_15m, args.feed_1m)
    except Exception as e:  # a probe the runner cannot read is a failure, not a crash
        return {"slug": probe.name, "ok": False, "error": "runner", "message": str(e),
                "seconds": 0.0}
    try:
        proc = subprocess.run(
            [sys.executable, str(args.driver)], input=json.dumps(request),
            capture_output=True, text=True, timeout=args.timeout)
    except subprocess.TimeoutExpired:
        return {"slug": probe.name, "ok": False, "error": "runner_timeout",
                "message": f"driver ran past {args.timeout}s", "seconds": time.time() - started}
    seconds = time.time() - started
    try:
        response = json.loads(proc.stdout)
    except ValueError:
        return {"slug": probe.name, "ok": False, "error": "driver_exit",
                "message": f"exit {proc.returncode}: {(proc.stderr or proc.stdout)[-600:].strip()}",
                "seconds": seconds}
    response["slug"] = probe.name
    response["seconds"] = seconds
    return response


def category(slug: str) -> str:
    return slug.split("-", 1)[0]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--corpus", type=Path, required=True,
                    help="tree holding validation/ and validation_report.md")
    ap.add_argument("--feed-15m", type=Path, required=True)
    ap.add_argument("--feed-1m", type=Path, required=True)
    ap.add_argument("--driver", type=Path, default=DEFAULT_DRIVER)
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--timeout", type=int, default=1800, help="seconds per probe")
    ap.add_argument("--only", nargs="*", default=None, help="probe slugs")
    ap.add_argument("--sample", type=int, default=0,
                    help="take N probes spread across categories")
    ap.add_argument("--out", type=Path, default=None, help="write each response as JSONL")
    args = ap.parse_args()

    published = published_tiers(args.corpus / "validation_report.md")
    probes = sorted(p for p in (args.corpus / "validation").iterdir()
                    if (p / "strategy.pine").is_file() and p.name not in EXCLUDED)
    if args.only:
        probes = [p for p in probes if p.name in set(args.only)]
    elif args.sample:
        by_cat: dict[str, list[Path]] = {}
        for p in probes:
            by_cat.setdefault(category(p.name), []).append(p)
        picked: list[Path] = []
        while len(picked) < args.sample and any(by_cat.values()):
            for cat in sorted(by_cat):
                if by_cat[cat] and len(picked) < args.sample:
                    picked.append(by_cat[cat].pop(0))
        probes = sorted(picked)

    out = args.out.open("w", encoding="utf-8") if args.out else None
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        futures = {pool.submit(run_probe, p, args): p for p in probes}
        for fut in concurrent.futures.as_completed(futures):
            r = fut.result()
            pub = published.get(r["slug"])
            expected = pub["tier"] if pub else "unpublished"
            got = r.get("tier") if r.get("ok") else f"error:{r.get('error')}"
            r["expected"] = expected
            r["agree"] = got == expected
            counts = ""
            if r.get("ok"):
                m = r.get("metrics", {})
                counts = f" tv={m.get('tv')} eng={m.get('eng')} matched={m.get('matched')}"
                if pub:
                    counts += f" (published {pub['tv']}/{pub['eng']}/{pub['matched']})"
            else:
                counts = f" {r.get('message', '')[:300]}"
            print(f"{'OK  ' if r['agree'] else 'FAIL'} {r['slug']} expected={expected} "
                  f"got={got}{counts} {r.get('seconds', 0):.1f}s", flush=True)
            results.append(r)
            if out:
                out.write(json.dumps(r) + "\n")
                out.flush()
    if out:
        out.close()

    agree = sum(1 for r in results if r["agree"])
    print(f"\nAGREEMENT {agree}/{len(results)}")
    cats: dict[str, list[int]] = {}
    for r in results:
        c = cats.setdefault(category(r["slug"]), [0, 0])
        c[0] += r["agree"]
        c[1] += 1
    print("per category: " + ", ".join(f"{k} {v[0]}/{v[1]}" for k, v in sorted(cats.items())))
    failures = sorted((r for r in results if not r["agree"]), key=lambda r: r["slug"])
    if failures:
        print("\nfailures:")
        for r in failures:
            got = r.get("tier") if r.get("ok") else f"error:{r.get('error')}"
            print(f"  {r['slug']}: expected {r['expected']}, got {got}: "
                  f"{r.get('message') or json.dumps(r.get('metrics', {}))[:400]}")
    return 0 if results and not failures else 1


if __name__ == "__main__":
    sys.exit(main())
