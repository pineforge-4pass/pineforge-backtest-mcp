/**
 * Corpus probes as public check_tradingview_parity inputs, for the stdio E2E.
 *
 * A probe's inputs.json is mapped to the inputs a user can pass (no
 * meta_passthrough). A probe whose meta needs a knob the public tool does not
 * have is left out, with the reason.
 *
 * Env:
 *   PF_E2E_CORPUS    pineforge-corpus tree at a35c7c4 (validation/, validation_report.md)
 *   PF_E2E_FEED_15M  the derived full-history 15m feed (derive_corpus_feeds.py)
 *   PF_E2E_FEED_1M   the committed 1m feed (sha256 db8c1332...)
 */

import { readFileSync, readdirSync, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";

export const EXCLUDED_FROM_309 = new Set([
  "analyzer-self-test-multi-mode-01",
  "bracket-rivet-calc-on-fill-01",
  "order-switchback-all-in-reversal-01",
]);

// inputs.json keys the harness or grader reads; everything else is a Pine input.
const META_KEYS = new Set([
  "tv_trades_csv_tz", "tv_trades_csv", "runtime_overrides", "strategy_overrides",
  "validation_overrides", "ohlcv_csv", "aux_security_ohlcv_csv", "aux_security_input_tf",
  "native_security_feeds", "ohlcv_start_ms", "script_tf", "input_tf", "chart_timezone",
  "engine_chart_timezone", "expected_tier", "notes", "syminfo_overrides", "trim_bars",
  "warmup_bars", "parity_profile",
]);

export interface Probe {
  slug: string;
  category: string;
  dir: string;
  meta: Record<string, unknown>;
  expectedTier: string;
}

export interface ProbeCall {
  args: Record<string, unknown>;
  bars: string;
}

export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`set ${name}`);
  return v;
}

export function readReportTiers(corpus: string): Map<string, string> {
  const md = readFileSync(join(corpus, "validation_report.md"), "utf8");
  const out = new Map<string, string>();
  const re = /^\| \[`([^`]+)`\]\([^)]*\) \| `[^`]+` \| (\w+) \| `\w+` \|/gm;
  for (const m of md.matchAll(re)) out.set(m[1]!, m[2]!);
  return out;
}

export function listProbes(corpus: string): Probe[] {
  const tiers = readReportTiers(corpus);
  const root = join(corpus, "validation");
  const probes: Probe[] = [];
  for (const slug of readdirSync(root).sort()) {
    const dir = join(root, slug);
    if (slug === "symbol-specified" || !statSync(dir).isDirectory()) continue;
    const metaPath = join(dir, "inputs.json");
    const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : {};
    const expectedTier = tiers.get(slug);
    if (!expectedTier) throw new Error(`${slug} is not in validation_report.md`);
    probes.push({ slug, category: slug.split("-")[0]!, dir, meta, expectedTier });
  }
  return probes;
}

/** Why the public inputs cannot express this probe, or null when they can. */
export function exclusionReason(p: Probe): string | null {
  if (EXCLUDED_FROM_309.has(p.slug)) return "not in the 309 (excluded from the corpus gate)";
  const m = p.meta;
  if ("expected_tier" in m) return "declares expected_tier (reachable only through meta_passthrough)";
  if ("syminfo_overrides" in m) return "needs syminfo_overrides";
  if ("chart_timezone" in m) return "sets the engine chart_timezone (the public chart_timezone is only the export's timezone)";
  if ("aux_security_ohlcv_csv" in m || "native_security_feeds" in m) return "needs an auxiliary request.security feed";
  const vo = m.validation_overrides as Record<string, unknown> | undefined;
  if (vo && vo.expect_tv_match === false) return "declares expect_tv_match=false";
  const ro = (m.runtime_overrides ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(ro)) {
    if (k === "syminfo_metadata") return "needs runtime_overrides.syminfo_metadata";
    if (k === "magnifier_volume_weighted") return "needs runtime_overrides.magnifier_volume_weighted";
    if (k !== "bar_magnifier" && k !== "magnifier_distribution" && k !== "magnifier_samples") {
      return `needs runtime_overrides.${k}`;
    }
  }
  return null;
}

const TZ: Record<string, string> = { asia_taipei: "Asia/Taipei", utc_plus_8: "Asia/Taipei", utc: "UTC" };

export function firstBarIso(csvPath: string): string {
  const fd = openSync(csvPath, "r");
  try {
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const line = buf.subarray(0, n).toString("utf8").split(/\r?\n/)[1] ?? "";
    return new Date(Number(line.split(",")[0])).toISOString();
  } finally {
    closeSync(fd);
  }
}

/** The public tool call for a probe (bars passed by path). */
export function probeCall(p: Probe, feed15m: string, feed1m: string, mapPath: (s: string) => string = (s) => s): ProbeCall {
  const m = p.meta;
  const ohlcv = typeof m.ohlcv_csv === "string" ? m.ohlcv_csv : "";
  let bars = feed15m;
  if (ohlcv.endsWith("ohlcv_ETH-USDT-USDT_1m.csv")) bars = feed1m;
  else if (ohlcv && !ohlcv.endsWith("derived/ohlcv_ETH-USDT-USDT_15m.csv")) {
    bars = join(p.dir, ohlcv);
  }
  const tvName = typeof m.tv_trades_csv === "string" ? m.tv_trades_csv : "tv_trades.csv";
  const tz = String(m.tv_trades_csv_tz ?? "asia_taipei");
  const inputTf = m.input_tf === undefined ? undefined : String(m.input_tf);
  const scriptTf = m.script_tf === undefined ? undefined : String(m.script_tf);
  const timeframe = scriptTf ?? inputTf ?? "15";

  const runtime: Record<string, unknown> = {};
  if (inputTf !== undefined && inputTf !== timeframe) runtime.input_tf = inputTf;
  if (scriptTf !== undefined && inputTf !== undefined && scriptTf !== inputTf) runtime.script_tf = scriptTf;
  const ro = (m.runtime_overrides ?? {}) as Record<string, unknown>;
  if (typeof ro.bar_magnifier === "boolean") runtime.bar_magnifier = ro.bar_magnifier;
  if (typeof ro.magnifier_distribution === "string") runtime.magnifier_dist = ro.magnifier_distribution.toLowerCase();
  if (typeof ro.magnifier_samples === "number") runtime.magnifier_samples = ro.magnifier_samples;

  const inputs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) {
    if (META_KEYS.has(k) || k.startsWith("_") || k.startsWith("tv_")) continue;
    inputs[k] = v;
  }

  const args: Record<string, unknown> = {
    pine: readFileSync(join(p.dir, "strategy.pine"), "utf8"),
    tradingview_trades: readFileSync(join(p.dir, tvName), "utf8"),
    symbol: "BINANCE:ETHUSDT.P",
    timeframe,
    range_start: typeof m.ohlcv_start_ms === "number"
      ? new Date(m.ohlcv_start_ms).toISOString()
      : firstBarIso(bars),
    chart_timezone: TZ[tz.toLowerCase()] ?? tz,
    ohlcv_csv_path: mapPath(bars),
  };
  if (Object.keys(inputs).length) args.inputs = inputs;
  if (m.strategy_overrides) args.strategy_overrides = m.strategy_overrides;
  if (Object.keys(runtime).length) args.runtime = runtime;
  return { args, bars };
}

// mulberry32: a small seeded PRNG so the sample is the same on every run.
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** n probes stratified by category: largest-remainder allocation, seeded draw. */
export function stratifiedSample(probes: Probe[], n: number, seed: number): Probe[] {
  const byCat = new Map<string, Probe[]>();
  for (const p of probes) {
    const list = byCat.get(p.category) ?? [];
    list.push(p);
    byCat.set(p.category, list);
  }
  const cats = [...byCat.keys()].sort();
  const total = probes.length;
  const quota = cats.map((c) => {
    const exact = (byCat.get(c)!.length * n) / total;
    return { c, take: Math.floor(exact), rem: exact - Math.floor(exact) };
  });
  let left = n - quota.reduce((s, q) => s + q.take, 0);
  for (const q of [...quota].sort((a, b) => b.rem - a.rem || a.c.localeCompare(b.c))) {
    if (left <= 0) break;
    q.take += 1;
    left -= 1;
  }
  const rand = rng(seed);
  const out: Probe[] = [];
  for (const q of quota) {
    const list = [...byCat.get(q.c)!];
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [list[i], list[j]] = [list[j]!, list[i]!];
    }
    out.push(...list.slice(0, q.take));
  }
  return out;
}
