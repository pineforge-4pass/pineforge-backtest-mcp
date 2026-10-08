"""Exercise compiler absence in an isolated child PATH without changing tools."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

with tempfile.TemporaryDirectory(prefix="pf-no-compiler-") as empty_path:
    command = [sys.executable, str(Path(__file__).with_name("test_parity_boundary_release.py"))]
    result = subprocess.run(command, capture_output=True, text=True, timeout=20,
                            env={**os.environ, "PATH": empty_path})
    output = result.stdout + result.stderr
    print(json.dumps({"argv": command, "isolated_path": empty_path,
                      "exit": result.returncode, "stdout": result.stdout,
                      "stderr": result.stderr}), flush=True)
    assert result.returncode != 0, output
    assert "required compiler tool not found: cc; release boundary gate never skips" in output, output
    assert "FAILED (errors=1)" in output, output
    assert "skipped=" not in output, output
    print("PASS: absent cc fails the release witness gate; no system compiler changed")
