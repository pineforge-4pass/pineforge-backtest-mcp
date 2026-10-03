#!/usr/bin/env bash
# A stand-in for the release image's entrypoint.sh that reports what an overlay
# looks like from where the real one runs: the prefix it is given, whether
# include/ and lib/ resolve through it, which run_json.py it would run and the
# instrument file it is told about.
set -euo pipefail
PREFIX="${PINEFORGE_PREFIX:-/opt/pineforge}"
python3 - "$PREFIX" <<'PY'
import json, os, sys
prefix = sys.argv[1]
syminfo = os.environ.get("PINEFORGE_SYMINFO", "")
run_json = os.path.join(prefix, "bin", "run_json.py")
print(json.dumps({
    "prefix": prefix,
    "syminfo_path": syminfo,
    "real_prefix": os.environ.get("REAL_PREFIX"),
    "lib_resolves": os.path.isfile(os.path.join(prefix, "lib", "libpineforge.a")),
    "include_resolves": os.path.isfile(os.path.join(prefix, "include", "pineforge", "x.h")),
    "run_json_is_link": os.path.islink(run_json),
    "run_json_head": open(run_json).readline().strip() if os.path.exists(run_json) else None,
    "entries": sorted(os.listdir(prefix)),
    "bin_entries": sorted(os.listdir(os.path.join(prefix, "bin"))),
    "instrument": json.load(open(syminfo)) if syminfo else None,
    "inputs": os.environ.get("PINEFORGE_INPUTS"),
}))
PY
