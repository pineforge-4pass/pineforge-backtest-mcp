"""Real parity CLI JSON failure witnesses with compiled synthetic ABI fixtures.

No native release-image, Pine transpiler, or corpus qualification is claimed.
The actual parity runner, compiler subprocess, vendored harness, failure capture
and JSON serialization execute without monkeypatches.
"""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from release_boundary_fixture import DRIVER, EXPECTED_TEXT, environment, prepare, request


class ParityBoundaryReleaseWitnesses(unittest.TestCase):
    # Correct committed expectation. The separate RED entrypoint deliberately
    # changes this expectation only, never the actual response or production code.
    expected_ok = False

    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="pf-boundary-release-")
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.directory = Path(cls.temporary.name)
        cls.fixture = prepare(cls.directory)
        print(json.dumps({"stand_in": "compiled synthetic C ABI and codegen boundary",
                          "compiler_receipts": cls.fixture["compiler_receipts"]}), flush=True)

    def check_response(self, case: str):
        abi_log = self.directory / (case + ".abi.log")
        result = subprocess.run(
            [sys.executable, str(DRIVER)], input=json.dumps(request(self.fixture, case)),
            capture_output=True, text=True, timeout=40,
            env=environment(self.fixture, case, abi_log))
        print(json.dumps({"case": case, "argv": [sys.executable, str(DRIVER)],
                          "exit": result.returncode, "stdout": result.stdout,
                          "stderr": result.stderr}), flush=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stderr, "")
        response = json.loads(result.stdout)
        # Preconditions reject setup/import/feed/compiler failures before the
        # deliberate wrong-expectation RED assertion is allowed to execute.
        self.assertEqual(response["error"], "backtest", response)
        self.assertIn(EXPECTED_TEXT[case], response["message"])
        self.assertTrue(response["message"].startswith("The backtest failed: "))
        expected_events = ["create"]
        if case == "refused":
            expected_events.append("setting_refused:Period=0")
        expected_events += ["run:3_bars", "report_free", "state_free"]
        self.assertEqual(abi_log.read_text().splitlines(), expected_events)
        print(json.dumps({"case": case, "abi_events": expected_events,
                          "boundary_preconditions": "reached actual backtest failure JSON"}),
              flush=True)
        self.assertIs(response["ok"], self.expected_ok,
                      f"{case}: emitted JSON ok expectation")
        self.assertNotIn("tier", response)

    def test_empty_runtime_error_reaches_parity_json(self):
        self.check_response("empty")

    def test_status_only_failure_reaches_parity_json(self):
        self.check_response("status")

    def test_refused_setting_reaches_parity_json(self):
        self.check_response("refused")


if __name__ == "__main__":
    unittest.main(verbosity=2)
