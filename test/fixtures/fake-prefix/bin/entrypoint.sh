#!/usr/bin/env bash
set -euo pipefail
IN_DIR="${PINEFORGE_IN_DIR:?}"
if [[ "${PINEFORGE_TRANSPILE_ONLY:-}" == "1" ]]; then
  printf '// transpiled\n%s\n' "$(cat "${IN_DIR}/strategy.pine")"
  exit 0
fi
[[ -f "${IN_DIR}/strategy.cpp" ]] || { echo "missing cpp" >&2; exit 2; }
[[ -f "${IN_DIR}/ohlcv.csv"   ]] || { echo "missing csv" >&2; exit 2; }
printf '{"ok":true,"inputs":%s,"overrides":%s,"input_tf":"%s"}\n' \
  "${PINEFORGE_INPUTS:-null}" "${PINEFORGE_OVERRIDES:-null}" "${PINEFORGE_INPUT_TF:-}"
