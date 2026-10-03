#!/usr/bin/env python3
"""Grade a TradingView "List of trades" export against PineForge's run of the
same Pine script, with the grader behind the published corpus figures.

Reads one JSON request on stdin and writes one JSON response on stdout. Exit 0
for every answer, including user errors ({"ok": false, ...}); non-zero only
when the driver itself fails.

The run is the corpus gate's: the script is transpiled and compiled the way
the release image's entrypoint.sh does it, then driven by the vendored
run_strategy.py (ctypes runner) in a subprocess, which windows the run on the
TradingView tape. vendor/verify_corpus.py analyze_strategy() grades it.
See README.md.
"""
from __future__ import annotations

import csv
import io
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
VENDOR = HERE / "vendor"
sys.path.insert(0, str(VENDOR))

import verify_corpus as vc  # noqa: E402
from run_strategy import _VALIDATION_META_KEYS  # noqa: E402

GRADER_SHA256 = "de84d5150ac0a29b67906f1f8b6fe1f1f13ac66ed36be88ea2bc63d7280ed298"
GRADER_SOURCE = "pineforge-engine v1.0.1 scripts/verify_corpus.py"

PREFIX = Path(os.environ.get("PINEFORGE_PREFIX", "/opt/pineforge"))
DEFAULT_TIMEOUT_MS = 600_000
OUTPUT_CAP = 64 * 1024
MAX_PINE_BYTES = 256 * 1024
MAX_TRADES_CSV_BYTES = 32 * 1024 * 1024
MAX_MISMATCHES = 50
TV_TIME_FORMAT = "%Y-%m-%d %H:%M"

# Keys of inputs.json that the harness or the grader reads. A Pine input with
# one of these titles would set a tier, a trim, a profile, a feed or a window.
RESERVED_INPUTS = frozenset(_VALIDATION_META_KEYS) | {
    "expected_tier", "validation_overrides", "parity_profile", "trim_bars",
    "warmup_bars", "notes", "tv_metrics_json", "ohlcv_end_ms",
    "runtime_overrides", "syminfo_overrides", "strategy_overrides",
    "engine_chart_timezone", "bar_ms", "_comment",
}
RUNTIME_KEYS = {"input_tf", "script_tf", "bar_magnifier", "magnifier_samples", "magnifier_dist"}
# The instrument spec the Worker resolves from the data API's catalog
# (pineforge-instrument/v1) and where each field goes in runtime_overrides; the
# harness (vendor/run_strategy.py inputs_run_kwargs) applies them in its own order.
# The response echoes the spec as applied_instrument: the image build checks that
# the engine library has every setter the harness applies it with.
INSTRUMENT_SCHEMA = "pineforge-instrument/v1"
INSTRUMENT_NUMBERS = ("qty_step", "mincontract", "mintick", "pointvalue")
INSTRUMENT_STRINGS = ("type", "currency", "basecurrency", "reason")
INSTRUMENT_SOURCE_STRINGS = ("kind", "venue", "symbol", "manifest_version", "syminfo_schema")
MAGNIFIER_DISTS = {"uniform", "cosine", "triangle", "endpoints", "front_loaded", "back_loaded"}
TIMEFRAME = re.compile(r"^(?:[1-9][0-9]{0,4}|[1-9][0-9]{0,3}[SDWM]|[SDWM])$")
# Environment the harness reads; the caller's values never reach the run.
HARNESS_ENV = ("PINEFORGE_RUN_MAGNIFIER_FEED", "PINEFORGE_RUN_MAGNIFIER_FEED_SHA256",
               "PINEFORGE_VERIFY_QTY_STEP", "PINEFORGE_RUN_SESSION_CALENDAR",
               "PINEFORGE_RUN_SESSION_CALENDAR_SHA256", "PINEFORGE_REQUESTS_ROOT")

TIER_MEANING = {
    "excellent": "PineForge reproduces TradingView's trades: every gate passes.",
    "strong": "Close to TradingView: small differences in count or prices.",
    "moderate": "Most trades reproduce, with real differences in some.",
    "weak": "Some trades reproduce; many differ or are missing.",
    "minimal": "Almost nothing lines up with TradingView's trades.",
    "anomaly": "A declared TradingView-side anomaly (test data only).",
    "engine_only": "Declared engine-only (test data only).",
    "missing": "A trade list was missing, so nothing was graded.",
}

# Zones tried by the timezone check: cities first, then whole-hour fixed offsets.
CANDIDATE_ZONES = (
    "UTC", "Europe/London", "Europe/Berlin", "Europe/Athens", "Europe/Moscow",
    "Asia/Dubai", "Asia/Tehran", "Asia/Kabul", "Asia/Karachi", "Asia/Kolkata",
    "Asia/Kathmandu", "Asia/Dhaka", "Asia/Yangon", "Asia/Bangkok", "Asia/Taipei",
    "Asia/Shanghai", "Asia/Hong_Kong", "Asia/Singapore", "Asia/Tokyo", "Asia/Seoul",
    "Australia/Darwin", "Australia/Adelaide", "Australia/Brisbane", "Australia/Sydney",
    "Pacific/Auckland", "America/St_Johns", "America/Halifax", "America/Sao_Paulo",
    "America/Argentina/Buenos_Aires", "America/New_York", "America/Chicago",
    "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage",
    "Pacific/Honolulu", "Pacific/Marquesas",
) + tuple(f"Etc/GMT{'+' if h > 0 else '-'}{abs(h)}" for h in range(-14, 13) if h)


class UserError(Exception):
    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind
        self.message = message


# --- request ------------------------------------------------------------

def _int(value, name: str, *, minimum: int | None = None) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) \
            or int(value) != value:
        raise UserError("bad_request", f"{name} must be an integer.")
    if minimum is not None and value < minimum:
        raise UserError("bad_request", f"{name} must be at least {minimum}.")
    return int(value)


def _fmt_ms(ms: int | None, tz=timezone.utc) -> str | None:
    if ms is None:
        return None
    return datetime.fromtimestamp(ms / 1000, tz=tz).strftime(TV_TIME_FORMAT)


def resolve_timezone(name) -> tuple[str, object]:
    """The zone the grader is handed for `name`, and zoneinfo's own reading.

    The grader understands utc / utc_plus_8 / asia_taipei and names holding a
    "/"; anything else silently becomes Asia/Taipei, so other spellings are
    mapped here or refused."""
    from zoneinfo import ZoneInfo
    if not isinstance(name, str) or not name.strip():
        raise UserError("bad_timezone", "chart_timezone is required: the IANA name of the "
                        "timezone TradingView printed the trade times in, e.g. Asia/Taipei.")
    name = name.strip()
    try:
        zone = ZoneInfo(name)
    except Exception:
        raise UserError("bad_timezone", f"'{name}' is not an IANA timezone name "
                        "(for example UTC, Asia/Taipei, America/New_York).")
    if name.lower() in vc.TV_TZ_BY_NAME or "/" in name:
        return name, zone
    probe = datetime(2024, 1, 1, tzinfo=timezone.utc)
    if all(zone.utcoffset(probe + timedelta(days=d)) == timedelta(0) for d in (0, 91, 182, 273)):
        return "utc", zone
    raise UserError("bad_timezone", f"Give '{name}' as an Area/City name "
                    "(for example Asia/Tokyo rather than Japan).")


def check_grader_zone(form: str, zone, instants: list[int]) -> None:
    """The grader's reading of `form` must have zoneinfo's UTC offsets at every
    row of the tape and every day of its span."""
    graded = vc.tv_tzinfo({"tv_trades_csv_tz": form})
    lo, hi = min(instants) - 86400, max(instants) + 86400
    for ts in sorted(set(instants) | set(range(lo - lo % 86400, hi + 86400, 86400))):
        at = datetime.fromtimestamp(ts, tz=timezone.utc)
        if graded.utcoffset(at) != zone.utcoffset(at):
            raise UserError("bad_timezone", f"The grader would read '{form}' with a different "
                            f"UTC offset than the timezone database at {at:%Y-%m-%d %H:%M} UTC.")


def grader_numeric_columns(header: list[str]) -> list[str]:
    """The columns verify_corpus.parse_trades reads with float(): size, P&L,
    P&L %, favorable and adverse excursion, in every spelling it accepts."""
    exact = {"Position size (qty)", "Size (qty)", "Qty", "Net P&L %", "Net PnL %", "MFE", "MAE"}
    prefixes = ("Net P&L", "Net PnL", "Favorable excursion", "Adverse excursion")
    return [h for h in header if h in exact or (
        not h.endswith(" %") and any(h == p or h.startswith(p + " ") for p in prefixes))]


def read_trades_csv(text) -> list[dict]:
    """Rows of a TradingView List of trades CSV, checked for what the grader reads."""
    if not isinstance(text, str) or not text.strip():
        raise UserError("bad_trades_csv", "tradingview_trades_csv is empty.")
    if len(text.encode("utf-8")) > MAX_TRADES_CSV_BYTES:
        raise UserError("bad_trades_csv", "The trade list is larger than 32 MiB.")
    reader = csv.DictReader(io.StringIO(text.lstrip("﻿")))
    header = [h for h in (reader.fieldnames or []) if h is not None]
    missing = []
    if "Trade #" not in header and "Trade number" not in header:
        missing.append("'Trade #' (or 'Trade number')")
    for col in ("Type", "Date and time"):
        if col not in header:
            missing.append(f"'{col}'")
    if not any(h == "Price" or h.startswith("Price ") for h in header):
        missing.append("'Price'")
    if missing:
        raise UserError("bad_trades_csv", "The trade list is missing these columns: " + ", ".join(missing)
                        + ". Export it from TradingView's Strategy Tester, List of trades, as CSV.")
    price_col = next(h for h in header if h == "Price" or h.startswith("Price "))
    numeric_cols = grader_numeric_columns(header)
    rows = []
    for line, row in enumerate(reader, start=2):
        if None in row or any(v is None for v in row.values()):
            raise UserError("bad_trades_csv", f"Row {line} does not have one cell per column.")
        number = row.get("Trade #") or row.get("Trade number")
        kind = str(row.get("Type") or "")
        try:
            n = int(number)
        except (TypeError, ValueError):
            raise UserError("bad_trades_csv", f"Row {line}: trade number '{number}' is not a whole number.")
        if not (kind.startswith("Entry") or kind.startswith("Exit")):
            raise UserError("bad_trades_csv", f"Row {line}: type '{kind}' is neither an Entry nor an Exit.")
        stamp = str(row.get("Date and time") or "")
        try:
            when = datetime.strptime(stamp, TV_TIME_FORMAT)
        except ValueError:
            raise UserError("bad_trades_csv", f"Row {line}: time '{stamp}' is not YYYY-MM-DD HH:MM.")
        if not 1900 <= when.year <= 2200:
            raise UserError("bad_trades_csv", f"Row {line}: time '{stamp}' is outside 1900-2200.")
        try:
            price = float(row[price_col])
        except (TypeError, ValueError):
            raise UserError("bad_trades_csv", f"Row {line}: price '{row[price_col]}' is not a number.")
        if not math.isfinite(price):
            raise UserError("bad_trades_csv", f"Row {line}: price '{row[price_col]}' is not a number.")
        for col in numeric_cols:
            raw = row.get(col)
            if raw is None or str(raw).strip() == "":
                continue
            try:
                value = float(raw)
            except (TypeError, ValueError):
                raise UserError("bad_trades_csv", f"Row {line}: {col} '{raw}' is not a number.")
            if not math.isfinite(value):
                raise UserError("bad_trades_csv", f"Row {line}: {col} '{raw}' is not a finite number.")
        rows.append({"n": n, "entry": kind.startswith("Entry"), "time": stamp})
    entries = {r["n"] for r in rows if r["entry"]}
    exits = {r["n"] for r in rows if not r["entry"]}
    if not entries & exits:
        raise UserError("no_closed_trades", "The trade list has no trade with both an entry and an exit row.")
    return rows


def read_bars(path, start_ms: int | None, end_ms: int | None) -> dict:
    """Header check and the bars inside [start, end] of the OHLCV CSV the run reads."""
    if not isinstance(path, str) or not path:
        raise UserError("no_bars", "ohlcv_csv_path is required.")
    p = Path(path)
    if not p.is_file():
        raise UserError("no_bars", f"No OHLCV file at {path}.")
    with p.open(encoding="utf-8", newline="") as f:
        header = f.readline().strip().split(",")
        need = ("timestamp", "open", "high", "low", "close", "volume")
        if any(c not in header for c in need):
            raise UserError("no_bars", "The OHLCV CSV header must hold "
                            "timestamp,open,high,low,close,volume (timestamp in epoch ms).")
        ti = header.index("timestamp")
        first = second = last = None
        count = 0
        for line in f:
            if not line.strip():
                continue
            try:
                ts = int(line.split(",")[ti])
            except (ValueError, IndexError):
                raise UserError("no_bars", f"OHLCV timestamp '{line.strip()[:40]}' is not epoch ms.")
            if (start_ms is not None and ts < start_ms) or (end_ms is not None and ts > end_ms):
                continue
            if first is None:
                first = ts
            elif second is None:
                second = ts
            last = ts
            count += 1
    if not count:
        raise UserError("no_bars", "The OHLCV file has no bar inside the requested range.")
    return {"first_ms": first, "last_ms": last, "count": count,
            "interval_ms": (second - first) if second is not None else None}


def _instrument_string(value, field: str, allow_empty: bool = False) -> None:
    if (not isinstance(value, str) or len(value) > 64 or (not value and not allow_empty)
            or any(not 0x20 <= ord(c) <= 0x7E for c in value)):
        raise UserError("bad_request", f"instrument.{field} must be 1-64 printable ASCII characters.")


def check_instrument(spec) -> dict | None:
    """Validate the request's instrument spec; None when there is none."""
    if spec is None:
        return None
    if not isinstance(spec, dict) or spec.get("schema") != INSTRUMENT_SCHEMA \
            or not isinstance(spec.get("resolved"), bool):
        raise UserError("bad_request", f"instrument must be a {INSTRUMENT_SCHEMA} object.")
    for key, value in spec.items():
        if key in ("schema", "resolved"):
            continue
        if key in INSTRUMENT_NUMBERS:
            if (isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
                    or not 1e-12 <= value <= 1e12):
                raise UserError("bad_request", f"instrument.{key} must be a finite number within 1e-12..1e12.")
        elif key in INSTRUMENT_STRINGS:
            _instrument_string(value, key)
        elif key == "source":
            if not isinstance(value, dict):
                raise UserError("bad_request", "instrument.source must be an object.")
            for sk, sv in value.items():
                if sk in INSTRUMENT_SOURCE_STRINGS:
                    _instrument_string(sv, f"source.{sk}", allow_empty=sk == "manifest_version")
                elif sk == "dropped":
                    if not isinstance(sv, list) or len(sv) > 16:
                        raise UserError("bad_request", "instrument.source.dropped must be a list of field names.")
                    for d in sv:
                        _instrument_string(d, "source.dropped[]")
                else:
                    raise UserError("bad_request", f"instrument.source.{sk} is not a known field.")
        else:
            raise UserError("bad_request", f"instrument.{key} is not a known field.")
    if spec["resolved"] and "qty_step" not in spec:
        raise UserError("bad_request", "instrument.qty_step is required when resolved.")
    return spec


def instrument_overrides(spec: dict | None) -> dict:
    """runtime_overrides entries for the instrument's grid, tick, point value, type and
    currencies (no ticker / tickerid: the engine keeps its own defaults for them)."""
    if not spec:
        return {}
    ro = {k: spec[k] for k in ("qty_step", "mintick", "pointvalue", "type", "currency", "basecurrency")
          if k in spec}
    if "mincontract" in spec:
        ro["syminfo_metadata"] = {"mincontract": spec["mincontract"]}
    return ro


def build_meta(req: dict, grader_tz: str) -> dict:
    inputs = req.get("inputs") or {}
    if not isinstance(inputs, dict):
        raise UserError("bad_request", "inputs must be an object of Pine input title -> value.")
    for key, value in inputs.items():
        if key.startswith("tv_") or key in RESERVED_INPUTS:
            raise UserError("reserved_input_name", f"An input named '{key}' cannot be set here: "
                            "the grading harness reads that name itself.")
        if isinstance(value, (dict, list)) or value is None:
            raise UserError("bad_request", f"Input '{key}' must be a string, number or boolean.")
    overrides = req.get("strategy_overrides") or {}
    if not isinstance(overrides, dict):
        raise UserError("bad_request", "strategy_overrides must be an object.")
    runtime = req.get("runtime") or {}
    if not isinstance(runtime, dict):
        raise UserError("bad_request", "runtime must be an object.")
    unknown = sorted(set(runtime) - RUNTIME_KEYS)
    if unknown:
        raise UserError("bad_request", f"Unknown runtime setting(s): {', '.join(unknown)}.")
    timeframe = req.get("timeframe")
    if not isinstance(timeframe, str) or not TIMEFRAME.match(timeframe.strip()):
        raise UserError("bad_request", "timeframe must be a TradingView resolution such as 15, 60 or 1D.")
    meta = dict(inputs)
    meta["tv_trades_csv"] = "tv_trades.csv"
    meta["tv_trades_csv_tz"] = grader_tz
    meta["input_tf"] = str(runtime.get("input_tf") or timeframe.strip())
    meta["script_tf"] = str(runtime.get("script_tf") or timeframe.strip())
    meta["ohlcv_start_ms"] = req["range_start_ms"]
    if overrides:
        meta["strategy_overrides"] = dict(overrides)
    ro = {}
    if "bar_magnifier" in runtime:
        ro["bar_magnifier"] = bool(runtime["bar_magnifier"])
    if "magnifier_samples" in runtime:
        ro["magnifier_samples"] = _int(runtime["magnifier_samples"], "runtime.magnifier_samples", minimum=2)
    if "magnifier_dist" in runtime:
        dist = str(runtime["magnifier_dist"]).lower()
        if dist not in MAGNIFIER_DISTS:
            raise UserError("bad_request", f"runtime.magnifier_dist must be one of {', '.join(sorted(MAGNIFIER_DISTS))}.")
        ro["magnifier_distribution"] = dist.upper()
    ro.update(instrument_overrides(check_instrument(req.get("instrument"))))
    if ro:
        meta["runtime_overrides"] = ro
    return meta


# --- subprocess ---------------------------------------------------------

# Every child runs in its own session, so its whole subtree (g++ and its
# compilers, the harness and the user's .so inside it) is one process group the
# driver can kill. The driver kills and reaps those groups when it is told to
# stop (SIGTERM, SIGINT, SIGHUP) and on every exit path; on Linux each child also
# gets SIGKILL if the driver dies without doing so (PR_SET_PDEATHSIG).
_CHILDREN: set = set()
_PR_SET_PDEATHSIG = 1


def _prctl_pdeathsig(sig: int) -> None:
    if not sys.platform.startswith("linux"):
        return
    try:
        import ctypes
        ctypes.CDLL(None, use_errno=True).prctl(_PR_SET_PDEATHSIG, int(sig), 0, 0, 0)
    except Exception:
        pass


def _child_setup() -> None:
    _prctl_pdeathsig(signal.SIGKILL)


def kill_children() -> None:
    for proc in list(_CHILDREN):
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    for proc in list(_CHILDREN):
        try:
            proc.wait(timeout=10)
        except Exception:
            pass
        _CHILDREN.discard(proc)


def _stop(signum, _frame) -> None:
    kill_children()
    raise SystemExit(128 + signum)


def run_capped(cmd: list[str], *, timeout_s: float, cwd: Path, env: dict | None = None,
               stdin_text: str | None = None) -> tuple[int | None, str]:
    """Run `cmd` in its own process group; keep the last OUTPUT_CAP bytes of its
    output; SIGKILL the group past `timeout_s`. Returns (exit code or None on timeout, output)."""
    proc = subprocess.Popen(cmd, cwd=str(cwd), env=env, start_new_session=True,
                            preexec_fn=_child_setup,
                            stdin=subprocess.PIPE if stdin_text is not None else subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    _CHILDREN.add(proc)
    try:
        return _capture(proc, timeout_s, stdin_text)
    finally:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        proc.wait()
        _CHILDREN.discard(proc)


def _capture(proc, timeout_s: float, stdin_text: str | None) -> tuple[int | None, str]:
    tail = bytearray()

    def pump():
        while True:
            chunk = proc.stdout.read(65536)
            if not chunk:
                return
            tail.extend(chunk)
            if len(tail) > OUTPUT_CAP:
                del tail[:len(tail) - OUTPUT_CAP]

    reader = threading.Thread(target=pump, daemon=True)
    reader.start()
    if stdin_text is not None:
        try:
            proc.stdin.write(stdin_text.encode("utf-8"))
            proc.stdin.close()
        except BrokenPipeError:
            pass
    try:
        code = proc.wait(timeout=max(1.0, timeout_s))
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()
        code = None
    reader.join(timeout=5)
    return code, tail.decode("utf-8", "replace")


# The transpile step of the release image's entrypoint.sh, verbatim.
TRANSPILE = """\
import sys
from pineforge_codegen import transpile
from pineforge_codegen.errors import CompileError

pine, out = sys.argv[1], sys.argv[2]
try:
    cpp = transpile(open(pine).read(), filename="strategy.pine")
except CompileError as e:
    sys.stderr.write(f"[pineforge] transpile error: {e}\\n"); sys.exit(5)
except Exception as e:  # syntax / unexpected — still a transpile failure
    sys.stderr.write(f"[pineforge] transpile error: {e}\\n"); sys.exit(5)
if out == "-":
    sys.stdout.write(cpp)
else:
    open(out, "w").write(cpp)
"""


def compile_command(src: Path, so: Path) -> list[str]:
    """The compile line of the release image's entrypoint.sh."""
    return ["g++", "-std=c++17", "-O2", "-ffp-contract=off", "-fPIC", "-shared",
            f"-I{PREFIX}/include", "-I/usr/include/eigen3", str(src),
            "-Wl,--whole-archive", str(PREFIX / "lib" / "libpineforge.a"), "-Wl,--no-whole-archive",
            "-o", str(so)]


def last_lines(text: str, n: int = 12) -> str:
    return "\n".join(text.strip().splitlines()[-n:])


# --- mismatches -----------------------------------------------------------

def replay(jail: Path, meta: dict, tz, eng_raw_all=None) -> dict:
    """analyze_strategy's pairing steps, with its own functions."""
    tv_raw_all = vc.parse_trades(jail / str(meta.get("tv_trades_csv", "tv_trades.csv")), tz=tz)
    if eng_raw_all is None:
        eng_raw_all = vc.parse_trades(jail / "engine_trades.csv", tz=timezone.utc)
    distinct = vc.distinct_entry_fill_keys(tv_raw_all)
    marks, tv_raw, eng_raw = vc.pair_range_end_marks(tv_raw_all, eng_raw_all)
    tv = vc.consolidate_fragments(list(tv_raw), preserve_entry_keys=distinct)
    eng = vc.consolidate_fragments(list(eng_raw), preserve_entry_keys=distinct,
                                   identity_field="entry_identity")
    matched = vc.align_by_time(tv, eng)
    tv_cmp, eng_cmp = vc.trim_to_common_match_window(tv, eng, matched + marks)
    matched = vc.align_by_time(tv_cmp, eng_cmp)
    return {"tv": tv, "eng": eng, "matched": matched, "marks": marks,
            "tv_raw_all": tv_raw_all}


def matched_count_under(jail: Path, meta: dict, tz, eng_raw_all) -> tuple[int, int]:
    """Trades matched with the tape read in `tz`, and how many of them enter at
    the same minute on both sides (the match window absorbs a 1-hour error)."""
    r = replay(jail, meta, tz, list(eng_raw_all))
    pairs = r["matched"] + r["marks"]
    return len(pairs), sum(1 for t, e in pairs if t.entry_time == e.entry_time)


def trade_view(t, tz) -> dict:
    return {
        "trade": t.trade_num, "side": t.direction,
        "entry_time": datetime.fromtimestamp(t.entry_time, tz=tz).strftime(TV_TIME_FORMAT),
        "entry_price": t.entry_price,
        "exit_time": datetime.fromtimestamp(t.exit_time, tz=tz).strftime(TV_TIME_FORMAT),
        "exit_price": t.exit_price, "qty": t.qty, "pnl": t.pnl,
        "signal": t.entry_signal or None,
        "open_at_range_end": bool(t.open_mark),
    }


def pair_deltas(t, e, pnl_delta) -> dict:
    return {
        "entry": vc.relative_max(t.entry_price, e.entry_price),
        "exit": vc.relative_max(t.exit_price, e.exit_price),
        "pnl": pnl_delta,
        "qty": vc.relative_max(t.qty, e.qty),
        "entry_seconds": e.entry_time - t.entry_time,
        "exit_abs": e.exit_price - t.exit_price,
        "pnl_abs": e.pnl - t.pnl,
    }


def build_mismatches(result, rep: dict, thresh: dict, display_tz, edges: dict,
                     better: dict | None, eng_by_better: list | None) -> tuple[list, dict, list]:
    warnings = []
    matched = rep["matched"]
    expected = result.matched_count - result.open_mark_pairs
    if len(matched) != expected:
        return [], {}, [f"The mismatch listing is left out: replaying the grader matched "
                        f"{len(matched)} trades, the grade matched {expected}."]
    tv_ids = {id(t) for t, _ in matched}
    eng_ids = {id(e) for _, e in matched}

    def key(t, e):
        return (t.trade_num, t.entry_time, e.trade_num, e.entry_time)

    # The grader's own per-pair P&L deltas (qty-normalized, exit-coupled), keyed
    # by trade: result.matched holds the grader's objects, not the replay's.
    pnl_by_pair = {}
    eligible = [(t, e) for t, e in result.matched if abs(t.pnl) >= vc.PNL_NEAR_ZERO_USD]
    if len(eligible) == len(result.pnl_deltas):
        pnl_by_pair = {key(t, e): d for (t, e), d in zip(eligible, result.pnl_deltas)}
    items = []
    for t in rep["tv"]:
        if id(t) not in tv_ids:
            items.append({"kind": "unmatched_tradingview", "at": t.entry_time,
                          "tradingview": trade_view(t, display_tz), "pineforge": None,
                          "deltas": None, "hint": hint_unmatched(t, "tradingview", edges, better, eng_by_better)})
    for e in rep["eng"]:
        if id(e) not in eng_ids:
            items.append({"kind": "unmatched_pineforge", "at": e.entry_time,
                          "tradingview": None, "pineforge": trade_view(e, display_tz),
                          "deltas": None, "hint": hint_unmatched(e, "pineforge", edges, None, None)})
    deviating = 0
    for t, e in matched:
        pd = pnl_by_pair.get(key(t, e))
        if pd is None and abs(t.pnl) >= vc.PNL_NEAR_ZERO_USD:
            pd = abs(t.pnl - e.pnl) / abs(t.pnl)
        d = pair_deltas(t, e, pd)
        if d["entry"] >= thresh["entry"] or d["exit"] >= thresh["exit"] or (pd or 0.0) >= thresh["pnl"]:
            deviating += 1
            items.append({"kind": "deviating_pair", "at": t.entry_time,
                          "tradingview": trade_view(t, display_tz), "pineforge": trade_view(e, display_tz),
                          "deltas": d, "hint": hint_pair(t, e, d, thresh)})
    items.sort(key=lambda m: m["at"])
    for m in items:
        del m["at"]
    counts = {
        "unmatched_tradingview": sum(1 for m in items if m["kind"] == "unmatched_tradingview"),
        "unmatched_pineforge": sum(1 for m in items if m["kind"] == "unmatched_pineforge"),
        "deviating_pairs": deviating,
    }
    return items, counts, warnings


def hint_unmatched(t, side: str, edges: dict, better: dict | None, eng_by_better: list | None) -> str | None:
    ms = t.entry_time * 1000
    bar = edges.get("interval_ms") or 0
    if t.open_mark:
        return ("Still open at the range end on TradingView; PineForge has no open position "
                "to pair it with." if side == "tradingview" else
                "Still open at PineForge's last bar; TradingView has no open position to pair it with.")
    if bar and edges.get("first_ms") is not None and ms <= edges["first_ms"] + 3 * bar:
        return "Entered within three bars of the range start: more history before the range may be needed."
    if edges.get("last_ms") is not None and ms > edges["last_ms"]:
        return "Entered after PineForge's last bar."
    if better and eng_by_better is not None:
        shift = better["shift_seconds"]
        for e in eng_by_better:
            if (e.direction == t.direction and abs(e.entry_time - (t.entry_time + shift)) <= vc.MATCH_WINDOW_SECONDS
                    and abs(e.entry_price - t.entry_price) <= vc.ENTRY_PRICE_GATE):
                return f"Lines up with a PineForge trade when the times are read in {better['zone']}."
    return None


def hint_pair(t, e, d: dict, thresh: dict) -> str | None:
    if t.qty > 1e-9 and e.qty > 1e-9 and abs(t.qty / e.qty - 1.0) > vc.QTY_NORM_BAND:
        return (f"Position size differs by {abs(t.qty / e.qty - 1.0):.1%}: check the order size, "
                "initial capital and pyramiding settings.")
    if d["entry"] < thresh["entry"] and d["exit"] < thresh["exit"] and (d["pnl"] or 0.0) >= thresh["pnl"]:
        return "Same prices and size but the P&L differs: check commission and slippage."
    return None


# --- timezone -------------------------------------------------------------

def timezone_check(jail: Path, meta: dict, given_name: str, rep: dict, tv_count: int) -> tuple[dict, list]:
    warnings = []
    offsets = Counter(t.entry_time - e.entry_time for t, e in rep["matched"])
    out = {"given": given_name, "offset_mode_seconds": 0, "offset_mode_share": None,
           "better": None, "note": None}
    given_matched = len(rep["matched"]) + len(rep["marks"])
    if offsets:
        mode, n = offsets.most_common(1)[0]
        share = n / sum(offsets.values())
        out["offset_mode_seconds"] = mode
        out["offset_mode_share"] = share
        if mode != 0 and share > 0.5 and given_matched >= tv_count / 2:
            hours = mode / 3600
            out["note"] = (f"{'Every' if share == 1 else f'{share:.0%} of the'} matched trade"
                           f"{'' if share == 1 else 's'} sit{'s' if share == 1 else ''} "
                           f"{abs(hours):g} h {'later' if mode > 0 else 'earlier'} on TradingView than on "
                           f"PineForge: the chart timezone is probably off by {abs(hours):g} h.")
    # A candidate counts only when it matches `margin` more trades than the
    # given zone; when fewer than that are unmatched no zone can.
    margin = max(2, math.ceil(0.05 * tv_count))
    if tv_count - given_matched < margin and out["offset_mode_seconds"] == 0:
        return out, warnings
    from zoneinfo import ZoneInfo
    eng_raw_all = vc.parse_trades(jail / "engine_trades.csv", tz=timezone.utc)
    best = None
    for zone_name in CANDIDATE_ZONES:
        if zone_name == given_name:
            continue
        try:
            n, exact = matched_count_under(jail, meta, ZoneInfo(zone_name), eng_raw_all)
        except Exception:
            continue
        if best is None or (n, exact) > (best[1], best[2]):
            best = (zone_name, n, exact)
    if out["note"] and best and best[1] >= given_matched and best[2] > offsets.get(0, 0):
        out["note"] += f" Read in {best[0]}, {best[2]} trades enter at the same minute on both sides."
    if out["note"]:
        warnings.append(out["note"])
    if best and best[1] >= given_matched + margin:
        # Seconds to add to a time read in the given zone to read it in the better one.
        wall = datetime.fromtimestamp(rep["tv_raw_all"][0].entry_time, tz=timezone.utc).replace(tzinfo=None) \
            if rep["tv_raw_all"] else datetime.now(timezone.utc).replace(tzinfo=None)
        shift = int((vc.tv_tzinfo(meta).utcoffset(wall) - ZoneInfo(best[0]).utcoffset(wall)).total_seconds())
        out["better"] = {"zone": best[0], "matched": best[1], "matched_given": given_matched,
                         "shift_seconds": shift}
        warnings.append(f"Read in {best[0]}, {best[1]} trades match instead of {given_matched}: "
                        f"TradingView may have printed the times in {best[0]}. The tier above uses {given_name}.")
    return out, warnings


# --- checks ---------------------------------------------------------------

def pct(x: float) -> str:
    return f"{x * 100:g}%"


# Statistics the grader computes only when at least one trade lines up; its
# no-alignment return leaves them at their zero defaults, which are not measurements.
UNMEASURED_WITHOUT_ALIGNMENT = (
    "entry_p90", "exit_p90", "pnl_p90", "coverage", "unmatched_total", "coverage_tv_count",
    "gating_matched_count", "tv_gate_count", "eng_gate_count", "unmatched_in_window",
    "open_mark_pairs", "open_mark_pnl_cent_exact", "open_mark_pnl_max_abs_usd", "entry_p100",
    "exit_p100", "pnl_p100", "qty_p100", "pnlpct_p100", "mfe_p90", "mae_p90",
    "distinct_entry_mismatches",
)
NOT_MEASURED = "not measured: no trade lined up"


def build_checks(r, thresh: dict) -> list[dict]:
    if r.no_aligned_trades:
        # The grader's no-alignment branch fills tv_count / eng_count (its common
        # window), count_delta and count_abs_delta, and nothing else.
        count = {"name": "trade count", "tradingview": r.tv_count, "pineforge": r.eng_count,
                 "value": r.count_delta, "abs": r.count_abs_delta,
                 "excellent": "exact (0)", "strong": f"< {pct(vc.STRONG_COUNT_DELTA)}",
                 "pass_excellent": r.count_ok, "pass_strong": r.count_delta < vc.STRONG_COUNT_DELTA}
        return [count] + [{"name": name, "value": None, "note": NOT_MEASURED}
                          for name in ("coverage", "entry price p90", "exit price p90", "P&L p90")]
    return [
        {"name": "trade count", "tradingview": r.tv_gate_count, "pineforge": r.eng_gate_count,
         "value": r.count_delta, "abs": r.count_abs_delta,
         "excellent": "exact (0)", "strong": f"< {pct(vc.STRONG_COUNT_DELTA)}",
         "pass_excellent": r.count_ok, "pass_strong": r.count_delta < vc.STRONG_COUNT_DELTA},
        {"name": "coverage", "value": r.coverage, "unmatched": r.unmatched_total,
         "of": r.coverage_tv_count,
         "excellent": f">= {pct(vc.COVERAGE_EXCELLENT)} or <= 1 unmatched",
         "strong": f">= {pct(vc.COVERAGE_STRONG)} or <= 1 unmatched",
         "moderate": f">= {pct(vc.COVERAGE_MODERATE)}",
         "pass_excellent": r.coverage_ok,
         "pass_strong": r.coverage >= vc.COVERAGE_STRONG or r.unmatched_total <= 1},
        {"name": "entry price p90", "value": r.entry_p90,
         "excellent": f"< {pct(thresh['entry'])}", "strong": f"< {pct(vc.STRONG_ENTRY_DELTA)}",
         "pass_excellent": r.entry_ok, "pass_strong": r.entry_p90 < vc.STRONG_ENTRY_DELTA},
        {"name": "exit price p90", "value": r.exit_p90,
         "excellent": f"< {pct(thresh['exit'])}", "strong": f"< {pct(vc.STRONG_EXIT_DELTA)}",
         "pass_excellent": r.exit_ok, "pass_strong": r.exit_p90 < vc.STRONG_EXIT_DELTA},
        {"name": "P&L p90", "value": r.pnl_p90,
         "excellent": f"< {pct(thresh['pnl'])}", "strong": f"< {pct(vc.STRONG_PNL_DELTA)}",
         "pass_excellent": r.pnl_ok, "pass_strong": r.pnl_p90 < vc.STRONG_PNL_DELTA},
        {"name": "distinct entries", "value": r.distinct_entry_mismatches,
         "excellent": "0 mismatches", "pass_excellent": r.distinct_entry_identity_ok},
    ]


def build_metrics(r) -> dict:
    row = r.report_row()
    out = {k: v for k, v in row.items() if isinstance(v, (int, float)) and not isinstance(v, bool)}
    for k in ("coverage", "unmatched_total", "coverage_tv_count", "gating_matched_count",
              "tv_gate_count", "eng_gate_count", "tv_raw_count", "eng_raw_count",
              "unmatched_in_window", "open_mark_pairs", "open_mark_pnl_cent_exact",
              "open_mark_pnl_max_abs_usd", "entry_p100", "exit_p100", "pnl_p100", "qty_p100",
              "pnlpct_p100", "mfe_p90", "mae_p90"):
        out[k] = getattr(r, k)
    if r.no_aligned_trades:
        for k in UNMEASURED_WITHOUT_ALIGNMENT:
            if k in out:
                out[k] = None
    return out


def versions() -> dict:
    try:
        from importlib import metadata
        codegen = metadata.version("pineforge-codegen")
    except Exception:
        codegen = os.environ.get("PINEFORGE_CODEGEN_VERSION") or "unknown"
    return {"engine": os.environ.get("PINEFORGE_ENGINE_VERSION") or "unknown",
            "codegen": codegen, "grader": GRADER_SOURCE, "grader_sha256": GRADER_SHA256}


# --- main -----------------------------------------------------------------

def grade(req: dict) -> dict:
    if not isinstance(req, dict):
        raise UserError("bad_request", "The request must be a JSON object.")
    deadline = time.monotonic() + int(os.environ.get("PF_PARITY_TIMEOUT_MS") or DEFAULT_TIMEOUT_MS) / 1000
    pine = req.get("pine")
    if not isinstance(pine, str) or not pine.strip():
        raise UserError("bad_request", "pine is required: the Pine v6 source.")
    if len(pine.encode("utf-8")) > MAX_PINE_BYTES:
        raise UserError("bad_request", "The Pine source is larger than 256 KiB.")
    tv_text = req.get("tradingview_trades_csv")
    rows = read_trades_csv(tv_text)
    given_name, zone = resolve_timezone(req.get("chart_timezone"))
    passthrough = req.get("meta_passthrough")
    if passthrough is not None and not isinstance(passthrough, dict):
        raise UserError("bad_request", "meta_passthrough must be an object or null.")
    max_mm = req.get("max_mismatches", 10)
    max_mm = 10 if max_mm is None else min(MAX_MISMATCHES, _int(max_mm, "max_mismatches", minimum=0))
    range_end = req.get("range_end_ms")
    range_end = None if range_end is None else _int(range_end, "range_end_ms", minimum=1)
    warnings: list[str] = []

    if passthrough is None:
        if req.get("range_start_ms") is None:
            raise UserError("bad_request", "range_start_ms is required: the first bar of the backtest.")
        req = dict(req, range_start_ms=_int(req["range_start_ms"], "range_start_ms", minimum=1))
        meta = build_meta(req, given_name)
    else:
        meta = dict(passthrough)
        for key in ("aux_security_ohlcv_csv", "native_security_feeds", "tv_metrics_json"):
            if meta.get(key):
                raise UserError("bad_request", f"meta_passthrough key {key} is not supported.")
        meta["tv_trades_csv"] = "tv_trades.csv"
    grader_tz = vc.tv_tzinfo(meta)
    span_rows = [int(datetime.strptime(r["time"], TV_TIME_FORMAT).replace(tzinfo=grader_tz).timestamp())
                 for r in rows]
    check_grader_zone(meta["tv_trades_csv_tz"] if passthrough is None else
                      str(meta.get("tv_trades_csv_tz", "")) or "asia_taipei",
                      zone if passthrough is None else grader_tz, span_rows)
    first_entry_ms = min(int(datetime.strptime(r["time"], TV_TIME_FORMAT)
                             .replace(tzinfo=grader_tz).timestamp()) * 1000 for r in rows if r["entry"])
    start_ms = meta.get("ohlcv_start_ms")
    start_ms = None if start_ms is None else int(start_ms)
    if range_end is not None and start_ms is not None and range_end <= start_ms:
        raise UserError("bad_request", "range_end_ms must be after range_start_ms.")
    if start_ms is not None and first_entry_ms < start_ms:
        message = (f"TradingView's first entry ({_fmt_ms(first_entry_ms, grader_tz)} {given_name}) is before "
                   f"the range start ({_fmt_ms(start_ms, grader_tz)} {given_name}): set the range start to the first "
                   "bar of the TradingView backtest.")
        if passthrough is None:
            raise UserError("trades_before_range_start", message)
        warnings.append(message)
    bars_path = req.get("ohlcv_csv_path")
    bars = read_bars(bars_path, start_ms, range_end)
    magnifier = req.get("magnifier_ohlcv_csv_path")
    if magnifier is not None and (not isinstance(magnifier, str) or not Path(magnifier).is_file()):
        raise UserError("no_bars", "magnifier_ohlcv_csv_path names no file.")

    workdir = req.get("workdir")
    jail = Path(tempfile.mkdtemp(prefix="pf-parity-", dir=workdir or None))
    try:
        meta["ohlcv_csv"] = str(Path(bars_path).resolve())
        (jail / "strategy.pine").write_text(pine, encoding="utf-8")
        (jail / "tv_trades.csv").write_text(tv_text.lstrip("﻿"), encoding="utf-8")
        (jail / "inputs.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
        if range_end is not None:
            (jail / "metrics.json").write_text(json.dumps(
                {"wsProvenance": {"requestedRange": {"to": range_end}}}), encoding="utf-8")
        try:
            vc.parse_trades(jail / "tv_trades.csv", tz=grader_tz)
        except Exception as e:
            raise UserError("bad_trades_csv", f"The grader cannot read the trade list: {e}.")

        env = {k: v for k, v in os.environ.items() if k not in HARNESS_ENV}
        code, out = run_capped([sys.executable, "-c", TRANSPILE, str(jail / "strategy.pine"),
                                str(jail / "generated.cpp")], timeout_s=deadline - time.monotonic(),
                               cwd=jail, env=env)
        if code is None:
            raise UserError("timeout", "Transpiling the script ran out of time.")
        if code != 0:
            raise UserError("transpile", last_lines(out).replace("[pineforge] ", "") or "Transpile failed.")
        code, out = run_capped(compile_command(jail / "generated.cpp", jail / "strategy.so"),
                               timeout_s=deadline - time.monotonic(), cwd=jail, env=env)
        if code is None:
            raise UserError("timeout", "Compiling the script ran out of time.")
        if code != 0:
            raise UserError("compile", "The generated C++ did not compile: " + last_lines(out, 8))
        if magnifier is not None:
            env["PINEFORGE_RUN_MAGNIFIER_FEED"] = str(Path(magnifier).resolve())
        code, run_log = run_capped([sys.executable, str(VENDOR / "run_strategy.py"), str(jail),
                                    "--so-name", "strategy.so", "--ohlcv", meta["ohlcv_csv"]],
                                   timeout_s=deadline - time.monotonic(), cwd=jail, env=env)
        if code is None:
            raise UserError("timeout", "The backtest ran out of time.")
        if code != 0:
            raise UserError("backtest", "The backtest failed: " + last_lines(run_log, 8))

        result = vc.analyze_strategy(jail)
        thresh = vc.parity_for_profile(result.profile)
        display_tz = zone
        rep = replay(jail, meta, grader_tz)
        tz_info, tz_warnings = timezone_check(jail, meta, given_name, rep, len(rep["tv"]) + len(rep["marks"]))
        warnings += tz_warnings
        import run_strategy as rs
        range_end_found = rs._load_tv_range_end(jail, meta)
        eng_shifted = rep["eng"] if tz_info["better"] else None
        last_ms = bars["last_ms"] if range_end_found is None else min(bars["last_ms"], range_end_found[0])
        edges = {"first_ms": bars["first_ms"], "last_ms": last_ms, "interval_ms": bars["interval_ms"]}
        items, counts, mm_warnings = build_mismatches(result, rep, thresh, display_tz, edges,
                                                      tz_info["better"], eng_shifted)
        warnings += mm_warnings
        if passthrough is not None:
            warnings.append("meta_passthrough: graded with the given inputs.json (test only).")
        window_log = [ln.strip() for ln in run_log.splitlines()
                      if ln.strip().startswith(("range-end:", "emit-window:", "magnifier:"))]
        report_start = first_entry_ms - (bars["interval_ms"] or 0)
        last_entry_ms = max(int(datetime.strptime(r["time"], TV_TIME_FORMAT)
                                .replace(tzinfo=grader_tz).timestamp()) * 1000 for r in rows if r["entry"])
        return {
            "ok": True,
            "tier": result.label,
            "tier_meaning": TIER_MEANING.get(result.label, ""),
            "profile": result.profile,
            "checks": build_checks(result, thresh),
            "metrics": build_metrics(result),
            "matched": result.matched_count,
            "unmatched_tradingview": counts.get("unmatched_tradingview"),
            "unmatched_pineforge": counts.get("unmatched_pineforge"),
            "deviating_pairs": counts.get("deviating_pairs"),
            "mismatches": items[:max_mm],
            "timezone": tz_info,
            "window": {
                "range_start": _fmt_ms(bars["first_ms"]),
                "range_end": _fmt_ms(range_end_found[0]) if range_end_found else None,
                "range_end_source": range_end_found[1] if range_end_found else None,
                "report_window": [_fmt_ms(report_start), _fmt_ms(last_entry_ms)],
                "timezone_of_times": "UTC",
                "harness_log": window_log,
            },
            "versions": versions(),
            "applied_instrument": check_instrument(req.get("instrument")) if passthrough is None else None,
            "warnings": warnings,
        }
    finally:
        shutil.rmtree(jail, ignore_errors=True)


def main() -> int:
    import hashlib
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, _stop)
    # Linux: if whoever started the driver dies, the driver is told to stop.
    _prctl_pdeathsig(signal.SIGTERM)
    actual = hashlib.sha256((VENDOR / "verify_corpus.py").read_bytes()).hexdigest()
    if actual != GRADER_SHA256:
        sys.stderr.write(f"pf_parity: vendor/verify_corpus.py sha256 {actual} is not {GRADER_SHA256}\n")
        return 2
    try:
        req = json.loads(sys.stdin.read())
    except ValueError as e:
        print(json.dumps({"ok": False, "error": "bad_request", "message": f"The request is not JSON: {e}."}))
        return 0
    try:
        response = grade(req)
    except UserError as e:
        response = {"ok": False, "error": e.kind, "message": e.message}
    finally:
        kill_children()
    try:
        text = json.dumps(response, allow_nan=False)
    except ValueError:
        # A non-finite number reached the response: report it, never print NaN.
        text = json.dumps({"ok": False, "error": "internal",
                           "message": "The grade holds a value that is not a finite number."})
    sys.stdout.write(text + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
