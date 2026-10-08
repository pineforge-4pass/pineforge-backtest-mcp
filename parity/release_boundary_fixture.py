"""Prepare compiled ABI fixtures for the real parity CLI and MCP wrapper.

Only engine/codegen boundaries are synthetic. pf_parity.py, its child-process
capture, the vendored harness and emitted JSON are never replaced or patched.
Requires Python 3.12 plus cc, g++ and ar; missing tools are gate failures.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "test" / "fixtures" / "parity-release-boundary"
DRIVER = ROOT / "parity" / "pf_parity.py"
PINE = '//@version=6\nstrategy("REL140 boundary C ABI stand-in")\n'
TAPE = (
    "Trade #,Type,Signal,Date and time,Price USDT,Position size (qty),Net PnL USDT\n"
    "1,Exit long,exit,2025-03-31 00:02,102,1,1\n"
    "1,Entry long,entry,2025-03-31 00:01,101,1,1\n"
)
BARS = (
    "timestamp,open,high,low,close,volume\n"
    "1743379200000,100,102,99,101,10\n"
    "1743379260000,101,103,100,102,10\n"
    "1743379320000,102,104,101,103,10\n"
)
EXPECTED_TEXT = {
    "empty": "RuntimeError: pineforge engine rejected run",
    "status": "RuntimeError: pineforge engine rejected run: "
              "the run did not complete and the engine reported no error",
    "refused": "RuntimeError: pineforge engine rejected run: "
               "input Period: value 0 is below minimum 1",
}


def require_compilers() -> dict[str, str]:
    tools = {}
    for name in ("cc", "g++", "ar"):
        executable = shutil.which(name)
        if executable is None:
            raise RuntimeError(
                f"required compiler tool not found: {name}; release boundary gate never skips")
        tools[name] = executable
    return tools


def prepare(directory: Path) -> dict:
    tools = require_compilers()
    directory = directory.resolve()
    prefix = directory / "prefix"
    (prefix / "lib").mkdir(parents=True)
    (prefix / "include").mkdir()
    obj = directory / "abi_stand_in.o"
    commands = [
        [tools["cc"], "-std=c11", "-Wall", "-Wextra", "-Werror", "-fPIC", "-c",
         str(FIXTURES / "abi_stand_in.c"), "-o", str(obj)],
        [tools["ar"], "rcs", str(prefix / "lib" / "libpineforge.a"), str(obj)],
    ]
    receipts = []
    for command in commands:
        result = subprocess.run(command, capture_output=True, text=True, timeout=30)
        receipts.append({"argv": command, "exit": result.returncode,
                         "stdout": result.stdout, "stderr": result.stderr})
        if result.returncode:
            raise RuntimeError("fixture compilation failed: " + json.dumps(receipts))
    bars = directory / "bars.csv"
    bars.write_text(BARS, encoding="utf-8")
    return {"prefix": str(prefix), "bars": str(bars), "pine": PINE, "trades": TAPE,
            "pythonpath": str(FIXTURES), "driver": str(DRIVER),
            "expected_text": EXPECTED_TEXT, "compiler_receipts": receipts}


def request(fixture: dict, case: str) -> dict:
    if case not in EXPECTED_TEXT:
        raise ValueError(case)
    return {
        "pine": PINE, "tradingview_trades_csv": TAPE, "chart_timezone": "UTC",
        "timeframe": "1", "range_start_ms": 1743379200000,
        "range_end_ms": 1743379320000, "ohlcv_csv_path": fixture["bars"],
        "inputs": {"Period": 0} if case == "refused" else {},
    }


def environment(fixture: dict, case: str, abi_log: Path) -> dict:
    return {**os.environ, "PINEFORGE_PREFIX": fixture["prefix"],
            "PYTHONPATH": fixture["pythonpath"], "PYTHONDONTWRITEBYTECODE": "1",
            "PF_BOUNDARY_CASE": case, "PF_BOUNDARY_ABI_LOG": str(abi_log),
            "PF_PARITY_TIMEOUT_MS": "30000"}


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] != "prepare":
        raise SystemExit("usage: release_boundary_fixture.py prepare DIRECTORY")
    print(json.dumps(prepare(Path(sys.argv[2]))))
