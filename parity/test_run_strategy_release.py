"""Execution-harness regressions with explicit library and Docker stand-ins.

These call the vendored Strategy.run and Docker adapter, not a native engine
or a release image. PF_HARNESS_TEST_PATH selects the old vendor for RED proof.
"""
from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

HARNESS_PATH = Path(os.environ.get(
    "PF_HARNESS_TEST_PATH", str(Path(__file__).parent / "vendor" / "run_strategy.py")))
HARNESS_SPEC = importlib.util.spec_from_file_location("harness_regression_target", HARNESS_PATH)
HARNESS = importlib.util.module_from_spec(HARNESS_SPEC)
sys.modules[HARNESS_SPEC.name] = HARNESS
HARNESS_SPEC.loader.exec_module(HARNESS)


class LibraryStandIn:
    """Deterministic ABI boundary; no compiled strategy or engine is loaded."""

    def __init__(self, code=b"", status=0):
        self.code = code
        self.status = status
        self.runs = 0
        self.report_frees = 0
        self.state_frees = 0
        self.loaded_bars = []

    def strategy_create(self, params_json):
        self.params_json = params_json
        return 1

    def run_backtest_full(self, state, bars, count, *arguments):
        self.runs += 1
        self.loaded_bars = [(bars[index].timestamp, bars[index].close) for index in range(count)]

    def strategy_get_last_error(self, state):
        return b""

    def strategy_get_last_error_code(self, state):
        return self.code

    def strategy_get_last_error_args(self, state):
        return b"{}"

    def strategy_last_run_status(self, state):
        return self.status

    def report_free(self, report):
        self.report_frees += 1

    def strategy_free(self, state):
        self.state_frees += 1


def strategy_for(library):
    strategy = HARNESS.Strategy.__new__(HARNESS.Strategy)
    strategy.lib = library
    return strategy


class HarnessReleaseRegressions(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="pf-harness-fixture-")
        self.directory = Path(self.temporary.name)
        self.bars = self.directory / "bars.csv"
        self.bars.write_text(
            "timestamp,open,high,low,close,volume\n"
            "1743379200000,100,102,99,101,10\n", encoding="utf-8")

    def tearDown(self):
        self.temporary.cleanup()

    def assert_run_boundary(self, library):
        self.assertEqual(library.runs, 1)
        self.assertEqual(library.loaded_bars, [(1743379200000, 101.0)])
        self.assertEqual(library.report_frees, 1)
        self.assertEqual(library.state_frees, 1)

    def test_empty_runtime_error_is_a_coded_failure_not_a_report(self):
        successful = LibraryStandIn()
        self.assertEqual(strategy_for(successful).run(self.bars)["trades"], [])
        self.assert_run_boundary(successful)
        library = LibraryStandIn(code=b"strategy_runtime_error", status=1)
        callbacks = []
        with self.assertRaises(RuntimeError) as raised:
            strategy_for(library).run(self.bars, on_report=callbacks.append)
        self.assertEqual(str(raised.exception), "pineforge engine rejected run: ")
        self.assertEqual(raised.exception.run_failure_code, "strategy_runtime_error")
        self.assertEqual(raised.exception.run_failure_args, "{}")
        self.assertEqual(callbacks, [])
        self.assert_run_boundary(library)

    def test_status_only_failure_is_not_a_successful_report(self):
        library = LibraryStandIn(status=1)
        callbacks = []
        with self.assertRaises(RuntimeError) as raised:
            strategy_for(library).run(self.bars, on_report=callbacks.append)
        self.assertEqual(str(raised.exception),
                         "pineforge engine rejected run: "
                         "the run did not complete and the engine reported no error")
        self.assertFalse(hasattr(raised.exception, "run_failure_code"))
        self.assertEqual(callbacks, [])
        self.assert_run_boundary(library)

    def test_docker_adapter_serializes_override_values_to_strings(self):
        (self.directory / "generated.cpp").write_text("int main() { return 0; }\n", encoding="utf-8")
        captured = []
        backend = types.ModuleType("pf_release_run")

        def run_release(cpp_path, bars_path, **arguments):
            captured.append((cpp_path, bars_path, arguments))
            self.assertTrue(all(isinstance(value, str) for value in arguments["overrides"].values()),
                            "Docker stand-in accepts string settings only")
            return {"summary": {"net_pnl": 12.5},
                    "diagnostics": {"input_bars_processed": 1}, "trades": []}

        backend.run_release = run_release
        backend.report_trades_to_runstrategy_shape = lambda report: report["trades"]
        overrides = {"process_orders_on_close": False, "initial_capital": 10000,
                     "commission_value": 0.04, "close_entries_rule": "FIFO"}
        with patch.dict(sys.modules, {"pf_release_run": backend}):
            result = HARNESS._run_via_docker(
                self.directory, self.bars, {"Fast Length": 8},
                {"strategy_overrides": overrides}, None, image="fixture-not-a-real-image")
        self.assertEqual(len(captured), 1)
        self.assertEqual(captured[0][0], self.directory / "generated.cpp")
        self.assertEqual(captured[0][1], self.bars)
        self.assertEqual(captured[0][2]["overrides"],
                         {"process_orders_on_close": "False", "initial_capital": "10000",
                          "commission_value": "0.04", "close_entries_rule": "FIFO"})
        self.assertEqual(captured[0][2]["inputs"], {"Fast Length": "8"})
        self.assertEqual(result["net_profit"], 12.5)
        self.assertEqual(result["input_bars_processed"], 1)
        self.assertEqual(overrides["process_orders_on_close"], False)


if __name__ == "__main__":
    unittest.main(verbosity=2)
