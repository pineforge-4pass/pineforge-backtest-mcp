"""Tests of pf_run_json.py: a recording fake `lib` for the C ABI calls, and a fake
image run_json.py driven through the shim as a subprocess, the way the entrypoint
runs it. Run: python3 -m unittest discover -s docker -p 'test_*.py' -v
"""
import ctypes
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SHIM = os.path.join(HERE, "pf_run_json.py")

spec = importlib.util.spec_from_file_location("pf_run_json_under_test", SHIM)
shim = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shim)

FULL = {
    "schema": "pineforge-instrument/v1", "resolved": True,
    "ticker": "BTCUSDT", "tickerid": "BINANCE:BTCUSDT", "type": "crypto",
    "currency": "USDT", "basecurrency": "BTC",
    "qty_step": 0.00001, "mincontract": 0.00001, "mintick": 0.01, "pointvalue": 1,
    "source": {"kind": "binance_exchange_info", "market": "spot", "symbol": "BTCUSDT"},
}


class Fn:
    """A C function stand-in: records its calls into the lib and takes argtypes/restype."""

    def __init__(self, lib, name, rc=None):
        self.lib, self.name, self.rc = lib, name, rc
        self.argtypes = None
        self.restype = "unset"

    def __call__(self, *args):
        self.lib.calls.append((self.name, *args))
        return self.rc


class FakeLib:
    SETTERS = ("strategy_set_syminfo_type", "strategy_set_syminfo_string",
               "strategy_set_syminfo_metadata", "strategy_set_syminfo_mintick",
               "strategy_set_syminfo_pointvalue")

    def __init__(self, missing=(), rc=None):
        self.calls = []
        for name in self.SETTERS:
            if name not in missing:
                setattr(self, name, Fn(self, name, rc.get(name) if rc else None))


class ApplyInstrument(unittest.TestCase):
    def test_exact_setter_sequence(self):
        lib = FakeLib()
        applied = shim.apply_instrument(lib, "STATE", FULL)
        self.assertEqual(lib.calls, [
            ("strategy_set_syminfo_type", "STATE", b"crypto"),
            ("strategy_set_syminfo_string", "STATE", b"ticker", b"BTCUSDT"),
            ("strategy_set_syminfo_string", "STATE", b"tickerid", b"BINANCE:BTCUSDT"),
            ("strategy_set_syminfo_string", "STATE", b"currency", b"USDT"),
            ("strategy_set_syminfo_string", "STATE", b"basecurrency", b"BTC"),
            ("strategy_set_syminfo_metadata", "STATE", b"qty_step", 0.00001),
            ("strategy_set_syminfo_metadata", "STATE", b"mincontract", 0.00001),
            ("strategy_set_syminfo_mintick", "STATE", 0.01),
            ("strategy_set_syminfo_pointvalue", "STATE", 1.0),
        ])
        self.assertEqual(list(applied), [
            "schema", "resolved", "qty_step", "mincontract", "mintick", "pointvalue", "type",
            "ticker", "tickerid", "currency", "basecurrency", "source"])
        self.assertIs(applied["resolved"], True)
        self.assertEqual(applied["qty_step"], 0.00001)
        self.assertEqual(applied["source"], FULL["source"])
        self.assertNotIn("skipped", applied)

    def test_argtypes_are_declared(self):
        lib = FakeLib()
        shim.apply_instrument(lib, "S", FULL)
        P, S, D = ctypes.c_void_p, ctypes.c_char_p, ctypes.c_double
        self.assertEqual(lib.strategy_set_syminfo_metadata.argtypes, [P, S, D])
        self.assertEqual(lib.strategy_set_syminfo_string.argtypes, [P, S, S])
        self.assertEqual(lib.strategy_set_syminfo_string.restype, ctypes.c_int)
        self.assertEqual(lib.strategy_set_syminfo_type.argtypes, [P, S])
        self.assertEqual(lib.strategy_set_syminfo_mintick.argtypes, [P, D])
        self.assertEqual(lib.strategy_set_syminfo_pointvalue.argtypes, [P, D])

    def test_unresolved_instrument_sets_nothing_and_says_why(self):
        lib = FakeLib()
        applied = shim.apply_instrument(lib, "S", shim.unresolved("no symbol, syminfo or sidecar"))
        self.assertEqual(lib.calls, [])
        self.assertEqual(applied, {"schema": "pineforge-instrument/v1", "resolved": False,
                                   "reason": "no symbol, syminfo or sidecar"})

    def test_missing_qty_step_still_applies_the_rest_and_stays_unresolved(self):
        lib = FakeLib()
        partial = {"schema": FULL["schema"], "resolved": False, "reason": "no lot size", "mintick": 0.5, "pointvalue": 2}
        applied = shim.apply_instrument(lib, "S", partial)
        self.assertEqual(lib.calls, [("strategy_set_syminfo_mintick", "S", 0.5),
                                     ("strategy_set_syminfo_pointvalue", "S", 2.0)])
        self.assertIs(applied["resolved"], False)
        self.assertEqual(applied["reason"], "no lot size")
        self.assertEqual((applied["mintick"], applied["pointvalue"]), (0.5, 2.0))

    def test_invalid_values_are_not_applied(self):
        bad = {
            "schema": FULL["schema"], "resolved": True,
            "qty_step": float("nan"), "mincontract": -1, "mintick": 0, "pointvalue": 1e13,
            "type": "cryépto", "ticker": "x" * 65, "tickerid": "", "currency": True, "basecurrency": 5,
        }
        lib = FakeLib()
        applied = shim.apply_instrument(lib, "S", bad)
        self.assertEqual(lib.calls, [])
        self.assertIs(applied["resolved"], False)
        for key in ("qty_step", "mincontract", "mintick", "pointvalue", "type", "ticker"):
            self.assertNotIn(key, applied)

    def test_number_bounds_are_inclusive(self):
        lib = FakeLib()
        shim.apply_instrument(lib, "S", {"schema": FULL["schema"], "qty_step": 1e-12, "mintick": 1e12})
        self.assertEqual([c[-1] for c in lib.calls], [1e-12, 1e12])
        self.assertIsNone(shim.clean_number(1e-13))
        self.assertIsNone(shim.clean_number("0.01"))
        self.assertIsNone(shim.clean_number(float("inf")))

    def test_string_rules(self):
        self.assertEqual(shim.clean_string("a" * 64), "a" * 64)
        self.assertIsNone(shim.clean_string("a" * 65))
        self.assertIsNone(shim.clean_string("tab\there"))
        self.assertIsNone(shim.clean_string("new\nline"))
        self.assertEqual(shim.clean_string("BINANCE:BTCUSDT.P"), "BINANCE:BTCUSDT.P")

    def test_library_without_a_setter_is_named_not_faked(self):
        lib = FakeLib(missing=("strategy_set_syminfo_metadata", "strategy_set_syminfo_type"))
        applied = shim.apply_instrument(lib, "S", FULL)
        self.assertNotIn("qty_step", applied)
        self.assertNotIn("type", applied)
        self.assertEqual(applied["skipped"], ["type", "qty_step", "mincontract"])
        self.assertIs(applied["resolved"], False)
        self.assertIn("lot grid", applied["reason"])
        self.assertEqual(applied["mintick"], 0.01)

    def test_engine_refusing_a_string_is_named(self):
        lib = FakeLib(rc={"strategy_set_syminfo_string": -1})
        applied = shim.apply_instrument(lib, "S", FULL)
        for key in ("ticker", "tickerid", "currency", "basecurrency"):
            self.assertNotIn(key, applied)
        self.assertEqual(applied["skipped"], ["ticker", "tickerid", "currency", "basecurrency"])
        self.assertIs(applied["resolved"], True)

    def test_source_is_reduced_to_known_clean_keys(self):
        source = {"kind": "user", "market": "usdt_perp", "symbol": "BTCUSDT", "via": "sidecar",
                  "dropped": ["mintick", 3, "x" * 99], "overridden": ["qty_step"],
                  "base": {"kind": "binance_exchange_info", "evil": "x", "symbol": "BTCUSDT"},
                  "fetched_at": "2026-10-04T00:00:00.000Z", "path": "/home/someone/file.csv"}
        cleaned = shim.clean_source(source)
        self.assertEqual(cleaned, {
            "kind": "user", "market": "usdt_perp", "symbol": "BTCUSDT", "via": "sidecar",
            "dropped": ["mintick"], "overridden": ["qty_step"],
            "base": {"kind": "binance_exchange_info", "symbol": "BTCUSDT"}})
        self.assertEqual(shim.clean_source("not a dict"), {})


FAKE_RUN_JSON = textwrap.dedent('''
    """A stand-in for the image's run_json.py: same shape, no engine."""
    import argparse, json, sys

    class Lib:
        def __init__(self):
            self.calls = []
            for name in ("strategy_set_syminfo_type", "strategy_set_syminfo_string",
                         "strategy_set_syminfo_metadata", "strategy_set_syminfo_mintick",
                         "strategy_set_syminfo_pointvalue"):
                setattr(self, name, self._make(name))
        def _make(self, name):
            lib = self
            class F:
                argtypes = None
                restype = None
                def __call__(self, *a):
                    lib.calls.append([name] + [x if not isinstance(x, bytes) else x.decode() for x in a])
                    return 0
            return F()

    def apply_syminfo(lib, strat, syminfo_path):
        raise SystemExit("the image's own apply_syminfo must not run")

    def build_report_dict(report, ohlcv_path, n_bars, first_ts, last_ts, elapsed, applied_inputs,
                          applied_overrides, applied_runtime=None, trade_entry_incarnations=None):
        return {"applied_runtime": applied_runtime or {}, "bars": n_bars}

    def build_provenance(runtime):
        return {"runtime": runtime}

    def main():
        ap = argparse.ArgumentParser(description=__doc__)
        ap.add_argument("--so")
        ap.add_argument("--syminfo")
        args = ap.parse_args()
        lib = Lib()
        if args.syminfo:
            apply_syminfo(lib, "STATE", args.syminfo)
        applied_runtime = {"input_tf": ""}
        out = build_report_dict(None, "x.csv", 3, 1, 2, 0.5, {}, {}, applied_runtime, None)
        out["fingerprint"] = build_provenance(applied_runtime)
        out["calls"] = lib.calls
        out["prog"] = ap.prog
        print(json.dumps(out))
        return 0

    if __name__ == "__main__":
        sys.exit(main())
''')


class Subprocess(unittest.TestCase):
    """The shim as the entrypoint runs it: python3 <overlay>/bin/run_json.py --so .. --syminfo .."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.real = os.path.join(self.tmp.name, "real")
        os.makedirs(os.path.join(self.real, "bin"))
        self.write_real(FAKE_RUN_JSON)

    def write_real(self, text):
        with open(os.path.join(self.real, "bin", "run_json.py"), "w") as handle:
            handle.write(text)

    def spec_file(self, spec):
        path = os.path.join(self.tmp.name, "instrument.json")
        with open(path, "w") as handle:
            handle.write(spec if isinstance(spec, str) else json.dumps(spec))
        return path

    def run_shim(self, *argv, real=None):
        env = dict(os.environ, REAL_PREFIX=real or self.real)
        return subprocess.run([sys.executable, SHIM, "--so", "s.so", *argv], env=env,
                              capture_output=True, text=True, timeout=60)

    def test_full_flow_reports_the_applied_instrument_in_report_and_fingerprint(self):
        done = self.run_shim("--syminfo", self.spec_file(FULL))
        self.assertEqual(done.returncode, 0, done.stderr)
        out = json.loads(done.stdout)
        applied = out["applied_runtime"]["syminfo"]
        self.assertIs(applied["resolved"], True)
        self.assertEqual(applied["qty_step"], 0.00001)
        self.assertEqual(applied["tickerid"], "BINANCE:BTCUSDT")
        self.assertEqual(out["applied_runtime"]["input_tf"], "")
        # build_provenance got the very dict the wrapper added to
        self.assertEqual(out["fingerprint"]["runtime"]["syminfo"], applied)
        self.assertEqual([c[0] for c in out["calls"]], [
            "strategy_set_syminfo_type", "strategy_set_syminfo_string", "strategy_set_syminfo_string",
            "strategy_set_syminfo_string", "strategy_set_syminfo_string", "strategy_set_syminfo_metadata",
            "strategy_set_syminfo_metadata", "strategy_set_syminfo_mintick", "strategy_set_syminfo_pointvalue"])

    def test_the_images_own_apply_syminfo_is_replaced(self):
        done = self.run_shim("--syminfo", self.spec_file(FULL))
        self.assertEqual(done.returncode, 0, done.stderr)

    def test_unresolved_instrument_is_in_the_report(self):
        done = self.run_shim("--syminfo", self.spec_file(shim.unresolved("no symbol, syminfo or sidecar")))
        self.assertEqual(done.returncode, 0, done.stderr)
        out = json.loads(done.stdout)
        self.assertEqual(out["applied_runtime"]["syminfo"],
                         {"schema": "pineforge-instrument/v1", "resolved": False,
                          "reason": "no symbol, syminfo or sidecar"})
        self.assertEqual(out["calls"], [])
        self.assertEqual(out["fingerprint"]["runtime"]["syminfo"]["resolved"], False)

    def test_no_syminfo_flag_says_so(self):
        done = self.run_shim()
        self.assertEqual(done.returncode, 0, done.stderr)
        applied = json.loads(done.stdout)["applied_runtime"]["syminfo"]
        self.assertEqual(applied["resolved"], False)
        self.assertEqual(applied["reason"], "no instrument was supplied")

    def test_argv0_is_the_images_file(self):
        done = self.run_shim("--syminfo", self.spec_file(FULL))
        self.assertEqual(json.loads(done.stdout)["prog"], "run_json.py")

    def test_image_without_a_required_function_exits_2_and_names_it(self):
        for name in ("apply_syminfo", "build_report_dict", "main"):
            self.write_real(FAKE_RUN_JSON.replace(f"def {name}(", f"def not_{name}("))
            done = self.run_shim("--syminfo", self.spec_file(FULL))
            self.assertEqual(done.returncode, 2, name)
            self.assertIn(name, done.stderr)
            self.assertIn("cannot apply the instrument grid", done.stderr)
            self.assertEqual(done.stdout, "")

    def test_build_report_dict_without_applied_runtime_exits_2(self):
        self.write_real(FAKE_RUN_JSON.replace("applied_runtime=None,", "runtime=None,"))
        done = self.run_shim("--syminfo", self.spec_file(FULL))
        self.assertEqual(done.returncode, 2)
        self.assertIn("applied_runtime", done.stderr)

    def test_missing_real_run_json_exits_2(self):
        done = self.run_shim("--syminfo", self.spec_file(FULL), real=os.path.join(self.tmp.name, "nowhere"))
        self.assertEqual(done.returncode, 2)
        self.assertIn("REAL_PREFIX", done.stderr)

    def test_unreadable_or_foreign_instrument_file_exits_2(self):
        for content in ("{not json", json.dumps({"schema": "something-else"}), json.dumps([1])):
            done = self.run_shim("--syminfo", self.spec_file(content))
            self.assertEqual(done.returncode, 2, content)
            self.assertIn("instrument", done.stderr)
        done = self.run_shim("--syminfo", os.path.join(self.tmp.name, "absent.json"))
        self.assertEqual(done.returncode, 2)

    def test_real_prefix_defaults_to_the_image_prefix(self):
        saved = os.environ.pop("REAL_PREFIX", None)
        try:
            self.assertEqual(shim.real_run_json_path(), "/opt/pineforge/bin/run_json.py")
        finally:
            if saved is not None:
                os.environ["REAL_PREFIX"] = saved


if __name__ == "__main__":
    unittest.main()
