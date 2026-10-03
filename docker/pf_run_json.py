#!/usr/bin/env python3
"""run_json.py of the pineforge-release image, with the instrument's grid applied.

The MCP runs this file in place of ${PINEFORGE_PREFIX}/bin/run_json.py (a prefix
overlay, see src/overlay.ts; the image's entrypoint.sh still does the compile and
passes `--syminfo <instrument.json>`). The image's own `apply_syminfo` sets only
mintick, pointvalue, timezone and session; the lot grid (`qty_step`), `mincontract`,
`type` and the string members of `syminfo` need the engine's C ABI directly. Without
a lot grid a 100%-of-equity order can overshoot margin by a hair and the engine books
a sub-lot margin-call row that TradingView does not.

What this file does, nothing more:
  1. loads the image's run_json.py from ${REAL_PREFIX:-/opt/pineforge}/bin and checks
     that apply_syminfo, build_report_dict and main are there. An image whose run_json.py
     lacks them is run as it is, with a note on stderr: its report has no
     applied_runtime.syminfo, which the MCP reports as a warning; without a main() there
     is nothing to run (exit 2). (An image whose engine library predates the lot grid does
     have them: the setter is accepted and ignored, which only the trade quantities show.)
  2. replaces its apply_syminfo with `apply_instrument` below;
  3. wraps its build_report_dict so the report's applied_runtime gets a "syminfo"
     object holding what was applied. The image builds the fingerprint from the same
     dict afterwards, so the instrument is part of fingerprint.provenance.runtime;
  4. runs the image's main() with the command line it was given.

The instrument file is JSON, schema "pineforge-instrument/v1". Numbers must be finite
and within 1e-12..1e12, strings at most 64 printable ASCII characters; a value that is
not is not applied. The call order is that of the engine harness (scripts/run_strategy.py):
type, currency, basecurrency, qty_step, mincontract, mintick, pointvalue. `ticker`,
`tickerid`, `timezone` and `session` are not applied: the engine keeps its own defaults
for them, whatever the file holds. Python 3.11, standard library only.
"""
from __future__ import annotations

import ctypes
import importlib.util
import inspect
import json
import math
import os
import runpy
import sys

SCHEMA = "pineforge-instrument/v1"
NUMBER_MIN = 1e-12
NUMBER_MAX = 1e12
STRING_MAX = 64
REASON_MAX = 200
STRING_KEYS = ("currency", "basecurrency")
# Order of the keys in applied_runtime["syminfo"].
REPORT_KEYS = ("qty_step", "mincontract", "mintick", "pointvalue", "type", "currency", "basecurrency")
SOURCE_STRING_KEYS = ("kind", "market", "symbol", "venue", "manifest_version",
                      "syminfo_schema", "via")
SOURCE_LIST_KEYS = ("dropped", "overridden")
SOURCE_LIST_MAX = 16
REQUIRED = ("apply_syminfo", "build_report_dict", "main")

# Why the report says nothing was applied when the image never called apply_syminfo (its entrypoint
# ignores PINEFORGE_SYMINFO, or --syminfo was not passed).
NOT_GIVEN = "run_json.py was not given the instrument file (--syminfo)"

# What apply_instrument applied in this process, for the build_report_dict wrapper.
_applied: dict | None = None


def clean_number(value):
    """The value as a float when it is a finite number within range, else None."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        number = float(value)
    except OverflowError:  # an integer too large for a float
        return None
    if not math.isfinite(number) or not NUMBER_MIN <= number <= NUMBER_MAX:
        return None
    return number


def clean_string(value, limit=STRING_MAX):
    """The value when it is 1..limit (default 64) printable ASCII characters, else None."""
    if not isinstance(value, str) or not 0 < len(value) <= limit:
        return None
    return value if all(0x20 <= ord(c) < 0x7F for c in value) else None


def clean_source(source) -> dict:
    """The informational `source` block, reduced to its known keys and clean strings."""
    out: dict = {}
    if not isinstance(source, dict):
        return out
    for key in SOURCE_STRING_KEYS:
        text = clean_string(source.get(key))
        if text is not None:
            out[key] = text
    for key in SOURCE_LIST_KEYS:
        items = source.get(key)
        if isinstance(items, list):
            names = [t for t in (clean_string(i) for i in items[:SOURCE_LIST_MAX]) if t is not None]
            if names:
                out[key] = names
    base = source.get("base")
    if isinstance(base, dict):
        base = clean_source(base)
        if base:
            out["base"] = base
    return out


def unresolved(reason: str, source=None) -> dict:
    out = {"schema": SCHEMA, "resolved": False, "reason": reason}
    if source:
        out["source"] = source
    return out


def declare(lib) -> None:
    """ctypes argtypes of the setters this file calls; an older library may lack some."""
    declared = {
        "strategy_set_syminfo_type": ([ctypes.c_void_p, ctypes.c_char_p], None),
        "strategy_set_syminfo_string": ([ctypes.c_void_p, ctypes.c_char_p, ctypes.c_char_p], ctypes.c_int),
        "strategy_set_syminfo_metadata": ([ctypes.c_void_p, ctypes.c_char_p, ctypes.c_double], None),
        "strategy_set_syminfo_mintick": ([ctypes.c_void_p, ctypes.c_double], None),
        "strategy_set_syminfo_pointvalue": ([ctypes.c_void_p, ctypes.c_double], None),
    }
    for name, (argtypes, restype) in declared.items():
        fn = getattr(lib, name, None)
        if fn is not None:
            fn.argtypes = argtypes
            fn.restype = restype


def apply_instrument(lib, state, spec: dict) -> dict:
    """Set the instrument on a strategy state through the C ABI; return what was applied.

    Each value is set only when it is present and valid and the library has its setter;
    one the library lacks or the engine refuses is named under "skipped". The returned
    dict is the report's applied_runtime["syminfo"].
    """
    declare(lib)
    applied: dict = {}
    skipped: list[str] = []

    def setter(name: str):
        return getattr(lib, name, None)

    type_ = clean_string(spec.get("type"))
    if type_ is not None:
        if setter("strategy_set_syminfo_type"):
            lib.strategy_set_syminfo_type(state, type_.encode())
            applied["type"] = type_
        else:
            skipped.append("type")
    for key in STRING_KEYS:
        text = clean_string(spec.get(key))
        if text is None:
            continue
        if setter("strategy_set_syminfo_string") and lib.strategy_set_syminfo_string(
                state, key.encode(), text.encode()) in (0, None):
            applied[key] = text
        else:
            skipped.append(key)
    for key in ("qty_step", "mincontract"):
        number = clean_number(spec.get(key))
        if number is None:
            continue
        if setter("strategy_set_syminfo_metadata"):
            lib.strategy_set_syminfo_metadata(state, key.encode(), number)
            applied[key] = number
        else:
            skipped.append(key)
    for key, name in (("mintick", "strategy_set_syminfo_mintick"),
                      ("pointvalue", "strategy_set_syminfo_pointvalue")):
        number = clean_number(spec.get(key))
        if number is None:
            continue
        if setter(name):
            getattr(lib, name)(state, number)
            applied[key] = number
        else:
            skipped.append(key)

    report: dict = {"schema": SCHEMA, "resolved": "qty_step" in applied}
    if not report["resolved"]:
        report["reason"] = clean_string(spec.get("reason"), REASON_MAX) or (
            "the engine library cannot set the lot grid" if "qty_step" in skipped
            else "no valid qty_step in the instrument")
    for key in REPORT_KEYS:
        if key in applied:
            report[key] = applied[key]
    source = clean_source(spec.get("source"))
    if source:
        report["source"] = source
    if skipped:
        report["skipped"] = skipped
    return report


def load_instrument(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            spec = json.load(handle)
    except (OSError, ValueError) as err:
        sys.stderr.write(f"[pineforge] cannot read the instrument file {path}: {err}\n")
        sys.exit(2)
    if not isinstance(spec, dict) or spec.get("schema") != SCHEMA:
        sys.stderr.write(f"[pineforge] {path} is not a {SCHEMA} instrument\n")
        sys.exit(2)
    return spec


def apply_syminfo(lib, strat, syminfo_path):
    """Stands in for the image's apply_syminfo(lib, strat, syminfo_path)."""
    global _applied
    _applied = apply_instrument(lib, strat, load_instrument(syminfo_path))


def wrap_build_report_dict(original):
    """build_report_dict, with the applied instrument added to applied_runtime first."""
    signature = inspect.signature(original)

    def build_report_dict(*args, **kwargs):
        bound = signature.bind(*args, **kwargs)
        runtime = bound.arguments.get("applied_runtime")
        if not isinstance(runtime, dict):
            runtime = {}
            bound.arguments["applied_runtime"] = runtime
        runtime["syminfo"] = _applied if _applied is not None else unresolved(NOT_GIVEN)
        return original(*bound.args, **bound.kwargs)

    return build_report_dict


def real_run_json_path() -> str:
    return os.path.join(os.environ.get("REAL_PREFIX") or "/opt/pineforge", "bin", "run_json.py")


def load_real(path: str):
    """The image's run_json module, and what it lacks of what this file hooks into."""
    if not os.path.isfile(path):
        sys.stderr.write(f"[pineforge] {path} not found; REAL_PREFIX must name the pineforge-release prefix\n")
        sys.exit(2)
    sys.dont_write_bytecode = True  # keep the image's prefix free of __pycache__
    name = "pineforge_image_run_json"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    # Registered before it runs, as import does: a module that defines a dataclass under
    # `from __future__ import annotations` looks itself up in sys.modules.
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(name, None)
        raise
    missing = [name for name in REQUIRED if not callable(getattr(module, name, None))]
    if not missing and "applied_runtime" not in inspect.signature(module.build_report_dict).parameters:
        missing = ["build_report_dict(applied_runtime=...)"]
    return module, missing


def main() -> int:
    path = real_run_json_path()
    real, missing = load_real(path)
    if missing:
        if "main" in missing:
            sys.stderr.write(f"[pineforge] cannot run {path}: it has no main()\n")
            sys.exit(2)
        sys.stderr.write(
            f"[pineforge] {path} lacks {', '.join(missing)}: running it without the instrument grid\n")
        sys.argv[0] = path
        runpy.run_path(path, run_name="__main__")  # ends in its own sys.exit(main())
        return 0
    real.apply_syminfo = apply_syminfo
    real.build_report_dict = wrap_build_report_dict(real.build_report_dict)
    sys.argv[0] = path
    return real.main()


if __name__ == "__main__":
    sys.exit(main())
