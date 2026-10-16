"""CI only: verify immutable inputs before materializing the vendored resampler."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess

root = Path.cwd()
inventory = json.loads((root / "test/fixtures/release/runtime-inventory.json").read_text())
corpus = root / ".release-ci/corpus"
actual = subprocess.check_output(["git", "-C", str(corpus), "rev-parse", "HEAD"], text=True).strip()
if actual != inventory["corpus_commit"]:
    raise ValueError("wrong corpus commit")
for slug in inventory["required_probes"]:
    for name in ("strategy.pine", "tv_trades.csv"):
        if not (corpus / "validation" / slug / name).read_text().strip():
            raise ValueError(f"empty required probe {slug}/{name}")
feed = corpus / "data/ohlcv_ETH-USDT-USDT_1m.csv"
if hashlib.sha256(feed.read_bytes()).hexdigest() != inventory["feed_1m_sha256"]:
    raise ValueError("wrong/unsmudged corpus feed")
syminfo = Path(os.environ.get("PF_E2E_SYMINFO_CSV") or root / "test/fixtures/syminfo/btcusdt-4h-2188.csv")
data = syminfo.read_bytes()
if hashlib.sha256(data).hexdigest() != inventory["syminfo_feed_sha256"]:
    raise ValueError("wrong frozen syminfo feed bytes")
if len(data.splitlines()) - 1 != inventory["syminfo_bars"]:
    raise ValueError("wrong syminfo bar count")
spec = importlib.util.spec_from_file_location("derive", root / "parity/vendor/derive_corpus_feeds.py")
derive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(derive)
derive.REPO_ROOT = root / ".release-ci"
derive.SOURCE_1M = feed
derive.DERIVED_DIR = corpus / "data/derived"
derive.DERIVED_15M = derive.DERIVED_DIR / "ohlcv_ETH-USDT-USDT_15m.csv"
derive.DERIVED_15M_WINDOW = derive.DERIVED_DIR / "ohlcv_ETH-USDT-USDT_15m_window.csv"
derive.DERIVATION_STAMP = derive.DERIVED_DIR / ".derive_corpus_feeds.version"
derive.ensure_derived(verbose=True)
