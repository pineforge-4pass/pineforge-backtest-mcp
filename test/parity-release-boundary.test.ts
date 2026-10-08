/** Real MCP wrapper -> LocalRunner -> parity CLI -> compiled C ABI stand-in.
 * Engine/codegen are synthetic; no native image/corpus qualification claim.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalRunner, type ParityCall } from "../src/engine.js";
import { parityToolResult } from "../src/parity-tool.js";

class ObservedLocalRunner extends LocalRunner {
  coreResponse?: Record<string, unknown>;
  override async parity(call: ParityCall) {
    const response = await super.parity(call);
    this.coreResponse = structuredClone(response);
    return response;
  }
}

for (const kind of ["empty", "status", "refused"] as const) {
  test("release failure reaches MCP wrapper: " + kind, { concurrency: false }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pf-boundary-wrapper-"));
    const envKeys = ["PYTHONPATH", "PF_BOUNDARY_CASE", "PF_BOUNDARY_ABI_LOG", "PINEFORGE_PARITY_DIR"] as const;
    const original = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    try {
      const fixture = JSON.parse(execFileSync("python3",
        ["parity/release_boundary_fixture.py", "prepare", directory],
        { cwd: resolve("."), encoding: "utf8", timeout: 40_000 }));
      const abiLog = join(directory, kind + ".abi.log");
      Object.assign(process.env, {
        PYTHONPATH: fixture.pythonpath,
        PF_BOUNDARY_CASE: kind,
        PF_BOUNDARY_ABI_LOG: abiLog,
        PINEFORGE_PARITY_DIR: resolve("parity"),
      });
      const runner = new ObservedLocalRunner(fixture.prefix);
      const result = await parityToolResult(runner, {
        pine: fixture.pine, tradingview_trades: fixture.trades, chart_timezone: "UTC",
        timeframe: "1", range_start: "2025-03-31T00:00:00Z", range_end: "2025-03-31T00:02:00Z",
        ohlcv_csv_path: fixture.bars, inputs: kind === "refused" ? { Period: 0 } : {},
      }, {
        resolvePath: (path) => resolve(path),
        fetchBinanceCsv: async () => { throw new Error("boundary fixture must not fetch network data"); },
      });
      const core = runner.coreResponse;
      assert.ok(core, JSON.stringify(result));
      assert.equal(core.ok, false);
      assert.equal(core.error, "backtest");
      assert.ok(String(core.message).includes(fixture.expected_text[kind]), JSON.stringify(core));
      const events = ["create", ...(kind === "refused" ? ["setting_refused:Period=0"] : []),
        "run:3_bars", "report_free", "state_free"];
      assert.deepEqual((await readFile(abiLog, "utf8")).trim().split("\n"), events);
      assert.equal(result.structuredContent.ok, core.ok);
      assert.equal(result.structuredContent.error, core.error);
      assert.equal(result.structuredContent.message, core.message);
      assert.deepEqual(JSON.parse(result.content[1]!.text), result.structuredContent);
      assert.ok(result.content[0]!.text.includes("Parity check failed (backtest): " + core.message));
      console.log(JSON.stringify({ case: kind, compiler_receipts: fixture.compiler_receipts,
        core, result, abi_events: events, boundary_preconditions: "actual JSON and wrapper reached" }));
      // Deliberate RED mode changes this assertion's expectation only.
      const expectedIsError = process.env.PF_BOUNDARY_WRONG_EXPECTATIONS === "1" ? false : true;
      assert.equal(result.isError, expectedIsError, kind + ": MCP isError expectation");
    } finally {
      for (const key of envKeys) {
        if (original[key] === undefined) delete process.env[key];
        else process.env[key] = original[key];
      }
      await rm(directory, { recursive: true });
    }
  });
}
