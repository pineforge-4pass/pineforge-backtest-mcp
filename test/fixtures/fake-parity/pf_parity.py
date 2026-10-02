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
orphan = None
if req.get("pine") == "orphan":
    # A grandchild in its own session, left running in the jail when the driver exits.
    import subprocess
    orphan = subprocess.Popen(["sleep", "60"], cwd=workdir, start_new_session=True,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).pid
print(json.dumps({
    "ok": True,
    "tier": "excellent",
    "keys": sorted(req),
    "ohlcv_csv_path": req.get("ohlcv_csv_path"),
    "bars_head": open(req["ohlcv_csv_path"]).readline().strip(),
    "workdir": workdir,
    "workdir_exists": bool(workdir) and os.path.isdir(workdir),
    "timeout_ms": os.environ.get("PF_PARITY_TIMEOUT_MS"),
    "marked": bool(os.environ.get("PF_PARITY_REQUEST")),
    "orphan": orphan,
    "request": {k: v for k, v in req.items() if k not in ("pine", "tradingview_trades_csv")},
}))
