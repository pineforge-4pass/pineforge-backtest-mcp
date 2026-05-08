#!/usr/bin/env node
/**
 * @pineforge/codegen-mcp — local stdio MCP server.
 *
 * Bridges an AI agent to the hosted PineForge codegen API (transpile,
 * quota), to the user's local Docker daemon (backtest runner + grid
 * sweep), and to Binance public market-data endpoints (OHLCV CSV
 * export, symbol lookup). Runs on the user's machine so OHLCV files
 * never leave it; only the Pine source travels to the codegen API.
 *
 * Auth: PINEFORGE_API_KEY env var (required).
 * Gateway override: PINEFORGE_GATEWAY env var (default: production URL).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, isAbsolute, dirname } from "node:path";
import { VERSION } from "./version.js";

// ─── Config ───────────────────────────────────────────────────────────────

const GATEWAY = process.env.PINEFORGE_GATEWAY ?? "https://codegen.pineforge.dev";
const API_KEY = process.env.PINEFORGE_API_KEY ?? "";
const DEFAULT_IMAGE = "ghcr.io/fullpass-4pass/pineforge-engine:latest";
const ALLOW_ANYWHERE = process.env.PINEFORGE_ALLOW_ANYWHERE === "1";
const DOCKER_TIMEOUT_MS = Number(process.env.PINEFORGE_DOCKER_TIMEOUT_MS ?? 120_000);

const BINANCE_SPOT_BASE = "https://api.binance.com";
const BINANCE_FAPI_BASE = "https://fapi.binance.com";
const BINANCE_KLINES_LIMIT = 1000;
const BINANCE_PAGE_DELAY_MS = 200;

if (!API_KEY) {
  console.error("[pineforge-mcp] PINEFORGE_API_KEY env var is required");
  process.exit(2);
}

// ─── Codegen API ──────────────────────────────────────────────────────────

interface Quota { used: number; limit: number; period: string; refunded: boolean; }

async function callTranspile(source: string): Promise<{ cpp: string; quota: Quota }> {
  const resp = await fetch(`${GATEWAY}/transpile`, {
    method: "POST",
    headers: { "x-api-key": API_KEY, "content-type": "text/plain" },
    body: source,
  });
  const text = await resp.text();
  const quota: Quota = {
    used: Number(resp.headers.get("x-quota-used") ?? 0),
    limit: Number(resp.headers.get("x-quota-limit") ?? 0),
    period: resp.headers.get("x-quota-period") ?? "",
    refunded: resp.headers.get("x-quota-refunded") === "1",
  };
  if (!resp.ok) throw new Error(`transpile failed (${resp.status}): ${text}`);
  return { cpp: text, quota };
}

async function callGetQuota(): Promise<unknown> {
  const resp = await fetch(`${GATEWAY}/quota`, {
    method: "GET",
    headers: { "x-api-key": API_KEY },
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`get_quota failed (${resp.status}): ${text}`);
  return JSON.parse(text);
}

// ─── Backtest (single + grid) ─────────────────────────────────────────────

type ParamMap = Record<string, string | number | boolean>;
type ParamGrid = Record<string, Array<string | number | boolean>>;

interface RuntimeArgsLike {
  input_tf?: string;
  script_tf?: string;
  bar_magnifier?: boolean;
  magnifier_samples?: number;
  magnifier_dist?: string;
}

interface BacktestArgs {
  source: string;
  ohlcv_csv_path: string;
  image?: string;
  inputs?: ParamMap;
  overrides?: ParamMap;
  runtime?: RuntimeArgsLike;
}

interface BacktestGridArgs {
  source: string;
  ohlcv_csv_path: string;
  image?: string;
  inputs?: ParamGrid;
  overrides?: ParamGrid;
  fixed_inputs?: ParamMap;
  fixed_overrides?: ParamMap;
  runtime?: RuntimeArgsLike;
  max_combinations?: number;
  concurrency?: number;
  include_trades?: boolean;
  sort_by?: "net_pnl" | "win_rate_pct" | "max_drawdown" | "total_trades";
}

async function runBacktest(args: BacktestArgs): Promise<unknown> {
  const csvPath = await resolveCsvPath(args.ohlcv_csv_path);
  const image = args.image ?? DEFAULT_IMAGE;
  const { cpp } = await callTranspile(args.source);

  const tmp = await mkdtemp(join(tmpdir(), "pineforge-bt-"));
  const cppPath = join(tmp, "strategy.cpp");
  await writeFile(cppPath, cpp, "utf8");

  try {
    const report = await dockerBacktest({
      image,
      cppPath,
      csvPath,
      inputs: args.inputs,
      overrides: args.overrides,
      runtime: args.runtime,
    });
    return { ...(report as object), _meta: { strategy_cpp_bytes: cpp.length, image } };
  } finally {
    rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runBacktestGrid(args: BacktestGridArgs): Promise<unknown> {
  const csvPath = await resolveCsvPath(args.ohlcv_csv_path);
  const image = args.image ?? DEFAULT_IMAGE;
  const includeTrades = args.include_trades === true;
  const sortBy = args.sort_by ?? "net_pnl";
  const maxCombos = args.max_combinations ?? 64;
  const concurrency = Math.max(1, Math.min(args.concurrency ?? 1, 8));

  const combos = buildCombinations(
    args.inputs,
    args.overrides,
    args.fixed_inputs,
    args.fixed_overrides,
  );
  if (combos.length === 0) {
    throw new Error("no parameter combinations produced — provide at least one inputs/overrides axis");
  }
  if (combos.length > maxCombos) {
    throw new Error(
      `${combos.length} combinations exceeds max_combinations=${maxCombos}. ` +
      `Either reduce the grid or raise max_combinations.`
    );
  }

  const { cpp } = await callTranspile(args.source);
  const tmp = await mkdtemp(join(tmpdir(), "pineforge-grid-"));
  const cppPath = join(tmp, "strategy.cpp");
  await writeFile(cppPath, cpp, "utf8");

  try {
    type Row = {
      ok: boolean;
      inputs: Record<string, string>;
      overrides: Record<string, string>;
      summary?: Record<string, unknown>;
      applied_inputs?: unknown;
      applied_overrides?: unknown;
      elapsed_seconds?: number;
      trades?: unknown[];
      error?: string;
    };

    const rows = await pMap<typeof combos[number], Row>(
      combos, concurrency,
      async (combo) => {
        try {
          const report = await dockerBacktest({
            image, cppPath, csvPath,
            inputs: combo.inputs, overrides: combo.overrides,
            runtime: args.runtime,
          }) as { summary?: Record<string, unknown>; applied_inputs?: unknown;
                  applied_overrides?: unknown; elapsed_seconds?: number; trades?: unknown[] };
          return {
            ok: true,
            inputs: combo.inputs,
            overrides: combo.overrides,
            summary: report.summary,
            applied_inputs: report.applied_inputs,
            applied_overrides: report.applied_overrides,
            elapsed_seconds: report.elapsed_seconds,
            ...(includeTrades ? { trades: report.trades } : {}),
          };
        } catch (e) {
          return {
            ok: false,
            inputs: combo.inputs,
            overrides: combo.overrides,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      },
    );

    const succeeded = rows.filter(r => r.ok);
    const failed = rows.filter(r => !r.ok);

    const sortValue = (r: Row): number => {
      if (!r.ok || !r.summary) return -Infinity;
      const v = r.summary[sortBy];
      return typeof v === "number" ? v : -Infinity;
    };
    succeeded.sort((a, b) => sortValue(b) - sortValue(a));

    return {
      total_combinations: combos.length,
      succeeded: succeeded.length,
      failed: failed.length,
      sort_by: sortBy,
      image,
      _meta: { strategy_cpp_bytes: cpp.length, concurrency },
      best: succeeded[0] ?? null,
      results: [...succeeded, ...failed],
    };
  } finally {
    rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function pullImage(image: string): Promise<{ image: string; pulled: boolean; output: string }> {
  const child = spawn("docker", ["pull", image], { stdio: ["ignore", "pipe", "pipe"] });
  const { stdout, stderr, code } = await collectChild(child, DOCKER_TIMEOUT_MS);
  if (code !== 0) throw new Error(`docker pull failed (${code}): ${stderr.slice(-1024)}`);
  return { image, pulled: true, output: (stdout + stderr).trim().slice(-2048) };
}

// ─── Param-grid helpers ───────────────────────────────────────────────────

function stringifyParams(p?: ParamMap): Record<string, string> {
  if (!p) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(p)) out[k] = String(v);
  return out;
}

function cartesianProduct(grid: Record<string, Array<string | number | boolean>>): Record<string, string>[] {
  const keys = Object.keys(grid);
  if (keys.length === 0) return [{}];
  let acc: Record<string, string>[] = [{}];
  for (const k of keys) {
    const values = grid[k] ?? [];
    const next: Record<string, string>[] = [];
    for (const partial of acc) {
      for (const v of values) {
        next.push({ ...partial, [k]: String(v) });
      }
    }
    acc = next;
  }
  return acc;
}

function buildCombinations(
  inputsGrid?: ParamGrid,
  overridesGrid?: ParamGrid,
  fixedInputs?: ParamMap,
  fixedOverrides?: ParamMap,
): Array<{ inputs: Record<string, string>; overrides: Record<string, string> }> {
  const inputCombos = cartesianProduct(inputsGrid ?? {});
  const overrideCombos = cartesianProduct(overridesGrid ?? {});
  const fixIn = stringifyParams(fixedInputs);
  const fixOv = stringifyParams(fixedOverrides);
  const out: Array<{ inputs: Record<string, string>; overrides: Record<string, string> }> = [];
  for (const i of inputCombos) {
    for (const o of overrideCombos) {
      out.push({ inputs: { ...fixIn, ...i }, overrides: { ...fixOv, ...o } });
    }
  }
  return out;
}

async function pMap<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return results;
}

// ─── Path / CSV helpers ───────────────────────────────────────────────────

function resolveScopedPath(p: string, label: string): string {
  const abs = isAbsolute(p) ? p : resolve(process.cwd(), p);
  if (!ALLOW_ANYWHERE && !abs.startsWith(process.cwd() + "/") && abs !== process.cwd()) {
    throw new Error(
      `${label} path '${abs}' is outside cwd '${process.cwd()}'. ` +
      `Set PINEFORGE_ALLOW_ANYWHERE=1 to override.`
    );
  }
  return abs;
}

async function resolveCsvPath(p: string): Promise<string> {
  const abs = resolveScopedPath(p, "OHLCV");
  const st = await stat(abs).catch(() => null);
  if (!st || !st.isFile()) throw new Error(`OHLCV file not found: ${abs}`);
  const head = (await readFile(abs, "utf8")).slice(0, 200).split(/\r?\n/)[0] ?? "";
  const expected = ["timestamp", "open", "high", "low", "close", "volume"];
  const cols = head.toLowerCase().split(",").map((s) => s.trim());
  if (expected.some((c, i) => cols[i] !== c)) {
    throw new Error(
      `OHLCV header mismatch. Expected: ${expected.join(",")}\nGot: ${head}`
    );
  }
  return abs;
}

// ─── Docker backtest invocation ───────────────────────────────────────────

interface DockerResult { stdout: string; stderr: string; code: number; }

async function dockerBacktest(args: {
  image: string;
  cppPath: string;
  csvPath: string;
  inputs?: ParamMap | Record<string, string>;
  overrides?: ParamMap | Record<string, string>;
  runtime?: RuntimeArgsLike;
}): Promise<unknown> {
  const dockerArgs: string[] = [
    "run", "--rm",
    "--network=none",
  ];
  const inputsObj = stringifyParams(args.inputs as ParamMap | undefined);
  const overridesObj = stringifyParams(args.overrides as ParamMap | undefined);
  if (Object.keys(inputsObj).length) {
    dockerArgs.push("-e", `PINEFORGE_INPUTS=${JSON.stringify(inputsObj)}`);
  }
  if (Object.keys(overridesObj).length) {
    dockerArgs.push("-e", `PINEFORGE_OVERRIDES=${JSON.stringify(overridesObj)}`);
  }
  const r = args.runtime ?? {};
  if (r.input_tf !== undefined && r.input_tf !== "") {
    dockerArgs.push("-e", `PINEFORGE_INPUT_TF=${r.input_tf}`);
  }
  if (r.script_tf !== undefined && r.script_tf !== "") {
    dockerArgs.push("-e", `PINEFORGE_SCRIPT_TF=${r.script_tf}`);
  }
  if (r.bar_magnifier !== undefined) {
    dockerArgs.push("-e", `PINEFORGE_BAR_MAGNIFIER=${r.bar_magnifier ? "true" : "false"}`);
  }
  if (r.magnifier_samples !== undefined) {
    dockerArgs.push("-e", `PINEFORGE_MAGNIFIER_SAMPLES=${r.magnifier_samples}`);
  }
  if (r.magnifier_dist !== undefined) {
    dockerArgs.push("-e", `PINEFORGE_MAGNIFIER_DIST=${r.magnifier_dist}`);
  }
  dockerArgs.push(
    "-v", `${args.cppPath}:/in/strategy.cpp:ro`,
    "-v", `${args.csvPath}:/in/ohlcv.csv:ro`,
    args.image,
  );

  const child = spawn("docker", dockerArgs, { stdio: ["ignore", "pipe", "pipe"] });
  const { stdout, stderr, code } = await collectChild(child, DOCKER_TIMEOUT_MS);
  if (code !== 0) {
    throw new Error(
      `docker exited ${code}\n` +
      `stderr (last 2KB):\n${stderr.slice(-2048)}`
    );
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(
      `backtest produced non-JSON output (first 500B):\n${stdout.slice(0, 500)}`
    );
  }
}

function collectChild(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<DockerResult> {
  return new Promise<DockerResult>((resolveP, rejectP) => {
    let stdout = "", stderr = "";
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectP(new Error(`docker timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", (e) => { clearTimeout(timer); rejectP(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ stdout, stderr, code: code ?? 1 });
    });
  });
}

// ─── Binance public-API client ────────────────────────────────────────────

const BINANCE_INTERVAL_MS: Record<string, number> = {
  "1s": 1_000,
  "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
  "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "6h": 21_600_000,
  "8h": 28_800_000, "12h": 43_200_000,
  "1d": 86_400_000, "3d": 259_200_000,
  "1w": 604_800_000,
  "1M": 30 * 86_400_000, // approximate
};

const BINANCE_INTERVALS = Object.keys(BINANCE_INTERVAL_MS) as [string, ...string[]];

type BinanceMarket = "spot" | "usdt_perp";

function binanceKlinesUrl(market: BinanceMarket): string {
  return market === "spot"
    ? `${BINANCE_SPOT_BASE}/api/v3/klines`
    : `${BINANCE_FAPI_BASE}/fapi/v1/klines`;
}

function binanceExchangeInfoUrl(market: BinanceMarket): string {
  return market === "spot"
    ? `${BINANCE_SPOT_BASE}/api/v3/exchangeInfo`
    : `${BINANCE_FAPI_BASE}/fapi/v1/exchangeInfo`;
}

async function binanceGet(url: string): Promise<unknown> {
  const resp = await fetch(url, {
    headers: { "user-agent": `pineforge-codegen-mcp/${VERSION}` },
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Binance ${resp.status} for ${url}: ${text.slice(0, 500)}`);
  }
  try { return JSON.parse(text); }
  catch { throw new Error(`Binance non-JSON response: ${text.slice(0, 200)}`); }
}

type Kline = [
  number, string, string, string, string, string, // open_time, o, h, l, c, v
  number, string, number, string, string, string  // close_time, qv, n, takerBuyBase, takerBuyQuote, ignore
];

async function fetchKlinesPage(
  market: BinanceMarket,
  symbol: string,
  interval: string,
  startTime: number | undefined,
  endTime: number | undefined,
  limit: number,
): Promise<Kline[]> {
  const params = new URLSearchParams({
    symbol: symbol.toUpperCase(),
    interval,
    limit: String(limit),
  });
  if (startTime !== undefined) params.set("startTime", String(startTime));
  if (endTime !== undefined) params.set("endTime", String(endTime));
  const url = `${binanceKlinesUrl(market)}?${params.toString()}`;
  const data = await binanceGet(url) as Kline[];
  if (!Array.isArray(data)) throw new Error(`Binance unexpected klines payload: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

interface FetchOhlcvArgs {
  symbol: string;
  interval: string;
  market: BinanceMarket;
  limit: number;
  start_time?: number;
  end_time?: number;
  output_path: string;
}

async function fetchBinanceOhlcv(args: FetchOhlcvArgs): Promise<unknown> {
  const intervalMs = BINANCE_INTERVAL_MS[args.interval];
  if (intervalMs === undefined) {
    throw new Error(
      `Unknown interval '${args.interval}'. Valid: ${Object.keys(BINANCE_INTERVAL_MS).join(", ")}`
    );
  }
  if (args.limit <= 0) throw new Error("limit must be > 0");
  if (args.limit > 100_000) throw new Error("limit must be ≤ 100000 (sanity cap)");

  const outAbs = resolveScopedPath(args.output_path, "output");
  await mkdir(dirname(outAbs), { recursive: true });

  const now = Date.now();
  const endTime = args.end_time ?? now;
  const startTime = args.start_time ?? Math.max(0, endTime - args.limit * intervalMs);

  const collected: Kline[] = [];
  let cursor = startTime;
  let pages = 0;
  while (collected.length < args.limit && cursor <= endTime) {
    const remaining = args.limit - collected.length;
    const pageLimit = Math.min(BINANCE_KLINES_LIMIT, remaining);
    const page = await fetchKlinesPage(
      args.market, args.symbol, args.interval, cursor, endTime, pageLimit,
    );
    pages++;
    if (page.length === 0) break;

    // Dedup against previous tail (Binance is inclusive on startTime).
    const tail = collected[collected.length - 1];
    const lastSeen = tail ? tail[0] : -1;
    for (const k of page) {
      if (k[0] > lastSeen) collected.push(k);
    }
    if (page.length < pageLimit) break;
    const lastPage = page[page.length - 1]!;
    cursor = lastPage[0] + intervalMs;
    if (collected.length < args.limit && cursor <= endTime) {
      await sleep(BINANCE_PAGE_DELAY_MS);
    }
  }

  if (collected.length === 0) {
    throw new Error(`Binance returned 0 bars for ${args.symbol} ${args.interval} (${args.market})`);
  }

  const lines: string[] = ["timestamp,open,high,low,close,volume"];
  for (const k of collected) {
    const ts = Number(k[0]);
    if (!Number.isFinite(ts)) continue;
    const o = sanitizeNumeric(k[1]);
    const h = sanitizeNumeric(k[2]);
    const l = sanitizeNumeric(k[3]);
    const c = sanitizeNumeric(k[4]);
    const v = sanitizeNumeric(k[5]);
    lines.push(`${ts},${o},${h},${l},${c},${v}`);
  }
  const csv = lines.join("\n") + "\n";
  await writeFile(outAbs, csv, "utf8");

  const first = collected[0]!;
  const last = collected[collected.length - 1]!;
  return {
    output_path: outAbs,
    market: args.market,
    symbol: args.symbol.toUpperCase(),
    interval: args.interval,
    bars: collected.length,
    pages,
    first_open_time: first[0],
    last_open_time: last[0],
    first_open_iso: new Date(first[0]).toISOString(),
    last_open_iso: new Date(last[0]).toISOString(),
    bytes: Buffer.byteLength(csv, "utf8"),
  };
}

function sanitizeNumeric(raw: unknown): string {
  // Binance returns numeric strings; we keep them as strings to avoid
  // float round-trip loss but reject anything non-numeric so the CSV
  // stays parseable downstream.
  const s = String(raw);
  if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s)) {
    throw new Error(`Non-numeric kline field: ${s}`);
  }
  return s;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Cache exchangeInfo for 5 min — symbol list rarely changes.
const SYMBOL_CACHE_TTL_MS = 5 * 60_000;
const symbolCache: Map<BinanceMarket, { ts: number; symbols: BinanceSymbol[] }> = new Map();

interface BinanceSymbol {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  contractType?: string; // futures only
}

async function listBinanceSymbols(market: BinanceMarket): Promise<BinanceSymbol[]> {
  const now = Date.now();
  const cached = symbolCache.get(market);
  if (cached && now - cached.ts < SYMBOL_CACHE_TTL_MS) return cached.symbols;

  const data = await binanceGet(binanceExchangeInfoUrl(market)) as { symbols: BinanceSymbol[] };
  if (!Array.isArray(data?.symbols)) {
    throw new Error("Binance exchangeInfo: unexpected payload shape");
  }
  symbolCache.set(market, { ts: now, symbols: data.symbols });
  return data.symbols;
}

interface SymbolsArgs {
  market: BinanceMarket;
  query?: string;
  quote_asset?: string;
  base_asset?: string;
  status?: string;
  contract_type?: string;
  limit?: number;
}

async function binanceSymbols(args: SymbolsArgs): Promise<unknown> {
  const all = await listBinanceSymbols(args.market);
  const limit = Math.max(1, Math.min(args.limit ?? 200, 2000));
  const q = args.query?.toUpperCase();
  const quote = args.quote_asset?.toUpperCase();
  const base = args.base_asset?.toUpperCase();
  const status = args.status?.toUpperCase();
  const ct = args.contract_type?.toUpperCase();

  const filtered = all.filter((s) => {
    if (q && !s.symbol.toUpperCase().includes(q)) return false;
    if (quote && s.quoteAsset?.toUpperCase() !== quote) return false;
    if (base && s.baseAsset?.toUpperCase() !== base) return false;
    if (status && s.status?.toUpperCase() !== status) return false;
    if (ct && s.contractType?.toUpperCase() !== ct) return false;
    return true;
  });

  const truncated = filtered.length > limit;
  const slice = filtered.slice(0, limit).map((s) => ({
    symbol: s.symbol,
    base: s.baseAsset,
    quote: s.quoteAsset,
    status: s.status,
    ...(s.contractType ? { contract_type: s.contractType } : {}),
  }));

  return {
    market: args.market,
    total_symbols: all.length,
    matched: filtered.length,
    returned: slice.length,
    truncated,
    symbols: slice,
  };
}

// ─── MCP server wiring ────────────────────────────────────────────────────

const asTextResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

const ParamMapSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);
const ParamGridSchema = z.record(
  z.string(),
  z.array(z.union([z.string(), z.number(), z.boolean()])).min(1),
);
const MarketSchema = z.enum(["spot", "usdt_perp"]);
const IntervalSchema = z.enum(BINANCE_INTERVALS);

// ─── strategy() header overrides ──────────────────────────────────────────
//
// The pineforge-engine runtime accepts a fixed set of strategy(...) header
// overrides via PINEFORGE_OVERRIDES. Enumerating them here (instead of an
// opaque ParamMap) gives the agent the exact keys, value types, and enum
// values it can pass — and lets list_strategy_overrides expose the same
// catalog at runtime.
const COMMISSION_TYPES = ["percent", "cash_per_order", "cash_per_contract"] as const;
const QTY_TYPES = ["fixed", "percent_of_equity", "cash"] as const;
const CLOSE_ENTRIES_RULES = ["ANY", "FIFO"] as const;

interface OverrideSpec {
  type: "number" | "integer" | "boolean" | "enum";
  enum?: readonly string[];
  description: string;
}

const STRATEGY_OVERRIDES_CATALOG: Record<string, OverrideSpec> = {
  initial_capital: {
    type: "number",
    description:
      "Starting equity in account currency. Mirrors `strategy(initial_capital=...)`.",
  },
  pyramiding: {
    type: "integer",
    description:
      "Maximum same-direction entries before further entries are blocked. " +
      "0 = single position. Mirrors `strategy(pyramiding=...)`.",
  },
  slippage: {
    type: "integer",
    description:
      "Per-fill slippage in ticks (mintick units). Mirrors `strategy(slippage=...)`.",
  },
  commission_value: {
    type: "number",
    description:
      "Commission magnitude. Units depend on commission_type. " +
      "Mirrors `strategy(commission_value=...)`.",
  },
  commission_type: {
    type: "enum",
    enum: COMMISSION_TYPES,
    description:
      "Commission units. 'percent' = percent of trade value, " +
      "'cash_per_order' = fixed cash per order, " +
      "'cash_per_contract' = fixed cash per contract. " +
      "Mirrors `strategy(commission_type=...)`.",
  },
  default_qty_value: {
    type: "number",
    description:
      "Default order size, interpreted per default_qty_type. " +
      "Mirrors `strategy(default_qty_value=...)`.",
  },
  default_qty_type: {
    type: "enum",
    enum: QTY_TYPES,
    description:
      "Default order sizing mode. 'fixed' = contracts/shares, " +
      "'percent_of_equity' = percent of current equity, " +
      "'cash' = fixed cash amount per order. " +
      "Mirrors `strategy(default_qty_type=...)`.",
  },
  process_orders_on_close: {
    type: "boolean",
    description:
      "When true, market orders submitted on a bar fill at that bar's close " +
      "instead of waiting for the next bar's open. " +
      "Mirrors `strategy(process_orders_on_close=...)`.",
  },
  close_entries_rule: {
    type: "enum",
    enum: CLOSE_ENTRIES_RULES,
    description:
      "How `strategy.close(id)` resolves which entries to close. " +
      "'FIFO' = first-in-first-out (default). " +
      "'ANY' = match all entries with the same id. " +
      "Mirrors `strategy(close_entries_rule=...)`.",
  },
};

const StrategyOverridesSchema = z.object({
  initial_capital: z.number().describe(STRATEGY_OVERRIDES_CATALOG.initial_capital!.description).optional(),
  pyramiding: z.number().int().min(0).describe(STRATEGY_OVERRIDES_CATALOG.pyramiding!.description).optional(),
  slippage: z.number().int().min(0).describe(STRATEGY_OVERRIDES_CATALOG.slippage!.description).optional(),
  commission_value: z.number().min(0).describe(STRATEGY_OVERRIDES_CATALOG.commission_value!.description).optional(),
  commission_type: z.enum(COMMISSION_TYPES).describe(STRATEGY_OVERRIDES_CATALOG.commission_type!.description).optional(),
  default_qty_value: z.number().describe(STRATEGY_OVERRIDES_CATALOG.default_qty_value!.description).optional(),
  default_qty_type: z.enum(QTY_TYPES).describe(STRATEGY_OVERRIDES_CATALOG.default_qty_type!.description).optional(),
  process_orders_on_close: z.boolean().describe(STRATEGY_OVERRIDES_CATALOG.process_orders_on_close!.description).optional(),
  close_entries_rule: z.enum(CLOSE_ENTRIES_RULES).describe(STRATEGY_OVERRIDES_CATALOG.close_entries_rule!.description).optional(),
}).strict();

const StrategyOverridesGridSchema = z.object({
  initial_capital: z.array(z.number()).min(1).optional(),
  pyramiding: z.array(z.number().int().min(0)).min(1).optional(),
  slippage: z.array(z.number().int().min(0)).min(1).optional(),
  commission_value: z.array(z.number().min(0)).min(1).optional(),
  commission_type: z.array(z.enum(COMMISSION_TYPES)).min(1).optional(),
  default_qty_value: z.array(z.number()).min(1).optional(),
  default_qty_type: z.array(z.enum(QTY_TYPES)).min(1).optional(),
  process_orders_on_close: z.array(z.boolean()).min(1).optional(),
  close_entries_rule: z.array(z.enum(CLOSE_ENTRIES_RULES)).min(1).optional(),
}).strict();

// ─── Runtime args (run_backtest_full args, NOT strategy() header) ─────────
//
// These are passed to pineforge-engine's run_backtest_full() rather than the
// per-strategy override table. They control how the engine consumes input
// bars (timeframe semantics, bar magnifier sub-bar sampling) and never
// appear in the Pine source. The engine validates them and surfaces any
// mismatch (e.g. script_tf finer than input_tf) through
// strategy_get_last_error() — agents see that as
// {"engine":"pineforge","error":"..."} on stdout, exit code 1.
const MAGNIFIER_DISTS = [
  "uniform", "cosine", "triangle", "endpoints", "front_loaded", "back_loaded",
] as const;

interface RuntimeSpec extends OverrideSpec {}

const RUNTIME_ARGS_CATALOG: Record<string, RuntimeSpec> = {
  input_tf: {
    type: "enum",
    description:
      "Chart bar timeframe — the resolution of the OHLCV CSV being fed in. " +
      "Use Pine timeframe strings: '1', '5', '15', '60', '240' (minutes), " +
      "'D', '1D', 'W', '1W', 'M', '1M'. Empty / omitted = the engine " +
      "auto-detects the timeframe from the gap between the first two bars. " +
      "Set explicitly when the CSV's resolution is ambiguous, when fewer " +
      "than 2 bars are present, or when registering request.security() " +
      "evaluators that need the chart TF stated up front.",
  },
  script_tf: {
    type: "enum",
    description:
      "Strategy / script timeframe — the resolution at which the strategy's " +
      "on_bar() runs. Empty / omitted = same as input_tf (no aggregation). " +
      "Set to a coarser timeframe (e.g. input_tf='5', script_tf='60') to " +
      "have the engine aggregate the input bars into higher-TF script bars " +
      "before invoking the strategy. MUST be coarser than or equal to " +
      "input_tf — finer values are rejected with the error " +
      "'script timeframe must be coarser than or equal to input timeframe'. " +
      "When the Pine source uses request.security() to pull a higher TF, " +
      "leave script_tf empty (the security TF is encoded inside the Pine " +
      "source, not here).",
  },
  bar_magnifier: {
    type: "boolean",
    description:
      "When true, the engine samples each input bar's price path at " +
      "magnifier_samples sub-points and walks stop / limit / trailing " +
      "orders against the sub-bars instead of the bar's OHLC corners. " +
      "Improves intra-bar fill realism for strategies that hinge on " +
      "wick fills, but multiplies engine work by ~magnifier_samples. " +
      "Default false. Most useful when input_tf is coarse (15m+) and " +
      "the strategy uses tight intra-bar exits.",
  },
  magnifier_samples: {
    type: "integer",
    description:
      "Sub-bar sample count when bar_magnifier=true. Minimum 2 " +
      "(open + close); typical range 4–16. Higher values give smoother " +
      "intra-bar fill simulation at linear cost. Ignored when " +
      "bar_magnifier=false. Default 4.",
  },
  magnifier_dist: {
    type: "enum",
    enum: MAGNIFIER_DISTS,
    description:
      "Distribution of sub-bar samples along the OHLC path when " +
      "bar_magnifier=true. 'endpoints' (default) always includes the " +
      "exact O/H/L/C corners and uniformly fills between them — best for " +
      "TradingView parity. 'uniform' = equal spacing. 'cosine' = denser " +
      "near segment endpoints. 'triangle' = denser near segment midpoints. " +
      "'front_loaded' / 'back_loaded' = denser near open / close, " +
      "simulating opening- or closing-impulse price action.",
  },
};

const RuntimeArgsSchema = z.object({
  input_tf: z.string().describe(RUNTIME_ARGS_CATALOG.input_tf!.description).optional(),
  script_tf: z.string().describe(RUNTIME_ARGS_CATALOG.script_tf!.description).optional(),
  bar_magnifier: z.boolean().describe(RUNTIME_ARGS_CATALOG.bar_magnifier!.description).optional(),
  magnifier_samples: z.number().int().min(2).describe(RUNTIME_ARGS_CATALOG.magnifier_samples!.description).optional(),
  magnifier_dist: z.enum(MAGNIFIER_DISTS).describe(RUNTIME_ARGS_CATALOG.magnifier_dist!.description).optional(),
}).strict();

type RuntimeArgs = z.infer<typeof RuntimeArgsSchema>;

const server = new McpServer(
  { name: "pineforge-codegen-mcp", version: VERSION },
  { capabilities: { tools: {} } }
);

server.registerTool(
  "transpile_pine",
  {
    description:
      "Transpile PineScript v6 source to a C++ translation unit using the hosted " +
      "PineForge codegen API. Compile failures DO NOT consume the monthly quota — " +
      "only successful 200 responses count. Use backtest_pine if you also want to " +
      "run the strategy locally.",
    inputSchema: {
      source: z.string().describe("PineScript v6 source (must include //@version=6)."),
    },
  },
  async ({ source }) => asTextResult(await callTranspile(source)),
);

server.registerTool(
  "get_quota",
  {
    description:
      "Return the current calendar month's API quota usage for the configured key: " +
      "{used, limit, period, expires_at, tier}. Free — does not consume quota.",
    inputSchema: {},
  },
  async () => asTextResult(await callGetQuota()),
);

server.registerTool(
  "backtest_pine",
  {
    description:
      "Transpile a PineScript v6 strategy and run it against an OHLCV CSV via the " +
      "pineforge-engine Docker image on the user's local machine. The OHLCV file " +
      "stays on the user's box; only the Pine source travels over the network. " +
      "Optional `inputs` overrides input.*() named values from the Pine source " +
      "(keys = the second arg of input.*(...) calls, e.g. 'Fast Length'). " +
      "Optional `overrides` overrides strategy(...) header fields " +
      "(initial_capital, commission_value, default_qty_value, pyramiding, " +
      "slippage, default_qty_type, commission_type, process_orders_on_close). " +
      "Returns the parsed JSON report (summary, trades, applied_inputs, " +
      "applied_overrides, elapsed_seconds). Use backtest_pine_grid for sweeps.",
    inputSchema: {
      source: z.string().describe("PineScript v6 source."),
      ohlcv_csv_path: z.string().describe(
        "Absolute or cwd-relative path to OHLCV CSV with header " +
        "'timestamp,open,high,low,close,volume' (timestamp = UNIX ms UTC)."
      ),
      image: z.string().optional().describe(
        `Docker image override. Defaults to ${DEFAULT_IMAGE}.`
      ),
      inputs: ParamMapSchema.optional().describe(
        "Map of Pine input.*() names → value (string/number/bool). " +
        "Sent as PINEFORGE_INPUTS env var to the runtime."
      ),
      overrides: StrategyOverridesSchema.optional().describe(
        "strategy(...) header overrides. Each key maps to a single argument " +
        "of the Pine `strategy()` call; only the keys you set are applied. " +
        "Sent as PINEFORGE_OVERRIDES env var. Call list_engine_params " +
        "for the full catalog with types and enum values."
      ),
      runtime: RuntimeArgsSchema.optional().describe(
        "Engine runtime args (NOT strategy() header) controlling timeframe " +
        "semantics and intra-bar fill simulation. input_tf / script_tf set " +
        "the chart and strategy timeframes — script_tf must be coarser " +
        "than or equal to input_tf or the engine rejects the run. " +
        "bar_magnifier + magnifier_samples + magnifier_dist enable sub-bar " +
        "price-path sampling for tighter stop / limit fills. Each field is " +
        "optional and only forwarded to the container when set. Call " +
        "list_engine_params for the full catalog."
      ),
    },
  },
  async ({ source, ohlcv_csv_path, image, inputs, overrides, runtime }) =>
    asTextResult(await runBacktest({ source, ohlcv_csv_path, image, inputs, overrides, runtime })),
);

server.registerTool(
  "backtest_pine_grid",
  {
    description:
      "Run a parameter sweep: transpile the Pine source ONCE (single quota hit), " +
      "then re-run the same compiled strategy against the OHLCV CSV across the " +
      "cartesian product of `inputs` × `overrides` grids. Returns a ranked list " +
      "of {inputs, overrides, summary, elapsed_seconds} entries sorted by `sort_by` " +
      "descending, plus the top entry under `best`. Cap: max_combinations (default " +
      "64). Set concurrency > 1 to run docker containers in parallel — each " +
      "container has its own startup overhead, so 2-4 is usually plenty.",
    inputSchema: {
      source: z.string().describe("PineScript v6 source."),
      ohlcv_csv_path: z.string().describe("Path to OHLCV CSV (same format as backtest_pine)."),
      image: z.string().optional().describe(`Docker image override. Defaults to ${DEFAULT_IMAGE}.`),
      inputs: ParamGridSchema.optional().describe(
        "Grid of input.*() names → list of values to sweep. " +
        "Example: {\"Fast Length\": [8, 12, 19], \"Slow Length\": [21, 26, 39]}"
      ),
      overrides: StrategyOverridesGridSchema.optional().describe(
        "Grid of strategy(...) header overrides → list of values, one axis " +
        "per key. Example: {\"default_qty_value\": [1, 5], \"commission_value\": [0.04]}. " +
        "Call list_engine_params for the full catalog with types and enum values."
      ),
      fixed_inputs: ParamMapSchema.optional().describe(
        "Inputs applied to every combo (overridden by per-combo `inputs` keys)."
      ),
      fixed_overrides: StrategyOverridesSchema.optional().describe(
        "Overrides applied to every combo (overridden by per-combo `overrides` keys)."
      ),
      runtime: RuntimeArgsSchema.optional().describe(
        "Engine runtime args applied to every combo in the sweep. Same " +
        "shape as backtest_pine.runtime — input_tf / script_tf / " +
        "bar_magnifier / magnifier_samples / magnifier_dist. Currently " +
        "fixed across the grid (not swept); add to the grid axes through " +
        "future versions if you need to vary them."
      ),
      max_combinations: z.number().int().min(1).max(1024).optional()
        .describe("Hard cap on combinations. Default 64."),
      concurrency: z.number().int().min(1).max(8).optional()
        .describe("Parallel docker runs. Default 1."),
      include_trades: z.boolean().optional()
        .describe("Include the per-trade list in each result. Default false (saves tokens)."),
      sort_by: z.enum(["net_pnl", "win_rate_pct", "max_drawdown", "total_trades"])
        .optional().describe("summary.* field to rank by, descending. Default net_pnl."),
    },
  },
  async (args) => asTextResult(await runBacktestGrid(args as BacktestGridArgs)),
);

server.registerTool(
  "fetch_binance_ohlcv",
  {
    description:
      "Fetch OHLCV candles from Binance public API and write a backtest-ready " +
      "CSV (header: timestamp,open,high,low,close,volume; timestamp = open time " +
      "in UNIX ms UTC). Supports `spot` and `usdt_perp` (USDT-margined " +
      "perpetual futures). Requests larger than 1000 bars are paginated " +
      "automatically. Free — no PineForge quota cost. The output path must " +
      "live inside the MCP cwd unless PINEFORGE_ALLOW_ANYWHERE=1.",
    inputSchema: {
      symbol: z.string().min(2).describe("Binance symbol, e.g. 'BTCUSDT'. Use binance_symbols to validate."),
      interval: IntervalSchema.describe(
        "Kline interval. Spot supports 1s + 1m..1M; usdt_perp supports 1m..1M (no 1s)."
      ),
      market: MarketSchema.optional().describe("'spot' (default) or 'usdt_perp'."),
      limit: z.number().int().min(1).max(100_000).optional()
        .describe("Total bars to fetch. Default 1000. Paginated above 1000."),
      start_time: z.number().int().nonnegative().optional()
        .describe("UNIX ms UTC. If unset, derived from end_time/now and limit."),
      end_time: z.number().int().nonnegative().optional()
        .describe("UNIX ms UTC. Defaults to now."),
      output_path: z.string().describe(
        "Path to write the CSV (will create parent dirs as needed)."
      ),
    },
  },
  async ({ symbol, interval, market, limit, start_time, end_time, output_path }) =>
    asTextResult(await fetchBinanceOhlcv({
      symbol,
      interval,
      market: market ?? "spot",
      limit: limit ?? 1000,
      start_time,
      end_time,
      output_path,
    })),
);

server.registerTool(
  "binance_symbols",
  {
    description:
      "List/validate symbols available on the Binance public API for OHLCV " +
      "fetching. Filters: `query` (substring of the symbol), `quote_asset` " +
      "(e.g. 'USDT'), `base_asset` (e.g. 'BTC'), `status` (e.g. 'TRADING'), " +
      "`contract_type` (futures only, e.g. 'PERPETUAL'). Results are " +
      "cached 5 min in process. Free.",
    inputSchema: {
      market: MarketSchema.describe("'spot' or 'usdt_perp'."),
      query: z.string().optional().describe("Case-insensitive substring of the symbol."),
      quote_asset: z.string().optional().describe("Filter by quote asset (e.g. 'USDT')."),
      base_asset: z.string().optional().describe("Filter by base asset (e.g. 'BTC')."),
      status: z.string().optional().describe("Filter by status. 'TRADING' returns active only."),
      contract_type: z.string().optional().describe(
        "Futures only. 'PERPETUAL' for usdt_perp swaps."
      ),
      limit: z.number().int().min(1).max(2000).optional()
        .describe("Max symbols to return. Default 200."),
    },
  },
  async (args) => asTextResult(await binanceSymbols(args as SymbolsArgs)),
);

server.registerTool(
  "list_engine_params",
  {
    description:
      "Returns the full catalog of engine knobs accepted by backtest_pine / " +
      "backtest_pine_grid in two groups: strategy_overrides (the 9 " +
      "strategy(...) header fields the runtime reads via " +
      "PINEFORGE_OVERRIDES — initial_capital, pyramiding, slippage, " +
      "commission_value, commission_type, default_qty_value, " +
      "default_qty_type, process_orders_on_close, close_entries_rule) and " +
      "runtime_args (input_tf, script_tf, bar_magnifier, " +
      "magnifier_samples, magnifier_dist — args to run_backtest_full, " +
      "NOT part of the strategy() header). Each entry is " +
      "{key, type, enum?, description}. Free — does not consume API quota " +
      "or run docker. Use this to discover what knobs the engine exposes " +
      "before issuing a backtest.",
    inputSchema: {},
  },
  async () => asTextResult({
    strategy_overrides: Object.entries(STRATEGY_OVERRIDES_CATALOG).map(([key, spec]) => ({
      key,
      type: spec.type,
      ...(spec.enum ? { enum: [...spec.enum] } : {}),
      description: spec.description,
    })),
    runtime_args: Object.entries(RUNTIME_ARGS_CATALOG).map(([key, spec]) => ({
      key,
      type: spec.type,
      ...(spec.enum ? { enum: [...spec.enum] } : {}),
      description: spec.description,
    })),
  }),
);

server.registerTool(
  "pull_engine_image",
  {
    description:
      "Run `docker pull` for the pineforge-engine runtime image on the user's " +
      "machine. Does not consume API quota. Useful before the first backtest_pine " +
      "call.",
    inputSchema: {
      image: z.string().optional().describe(
        `Image to pull. Defaults to ${DEFAULT_IMAGE}.`
      ),
    },
  },
  async ({ image }) => asTextResult(await pullImage(image ?? DEFAULT_IMAGE)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[pineforge-mcp] ready (stdio) — gateway:", GATEWAY);
