#!/usr/bin/env python3
"""Stand-in for parity/pf_parity.py in unit tests: echoes what it was given."""
import json
import os
import sys

req = json.loads(sys.stdin.read())
if req.get("pine") == "exit 3":
    sys.stderr.write("driver failed on purpose\n")
    sys.exit(3)
workdir = req.get("workdir")
print(json.dumps({
    "ok": True,
    "tier": "excellent",
    "keys": sorted(req),
    "ohlcv_csv_path": req.get("ohlcv_csv_path"),
    "bars_head": open(req["ohlcv_csv_path"]).readline().strip(),
    "workdir": workdir,
    "workdir_exists": bool(workdir) and os.path.isdir(workdir),
    "timeout_ms": os.environ.get("PF_PARITY_TIMEOUT_MS"),
    "request": {k: v for k, v in req.items() if k not in ("pine", "tradingview_trades_csv")},
}))
