import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalRunner } from "../src/engine.js";

const PREFIX = resolve("test/fixtures/fake-prefix");

test("LocalRunner.transpile sends pine source through entrypoint", async () => {
  const r = new LocalRunner(PREFIX);
  const cpp = await r.transpile("strategy('x')");
  assert.match(cpp, /\/\/ transpiled/);
  assert.match(cpp, /strategy\('x'\)/);
});

test("LocalRunner.backtest writes cpp+csv and propagates env", async () => {
  const r = new LocalRunner(PREFIX);
  const tmp = await mkdtemp(join(tmpdir(), "lr-"));
  const cppPath = join(tmp, "strategy.cpp");
  const csvPath = join(tmp, "ohlcv.csv");
  await writeFile(cppPath, "int main(){}");
  await writeFile(csvPath, "timestamp,open,high,low,close,volume\n");
  const out = (await r.backtest({
    cppPath, csvPath,
    inputs: { "Fast Length": 8 },
    overrides: { commission_value: 0.04 },
    runtime: { input_tf: "60" },
  })) as { ok: boolean; inputs: Record<string, string>; input_tf: string };
  assert.equal(out.ok, true);
  assert.deepEqual(out.inputs, { "Fast Length": "8" });
  assert.equal(out.input_tf, "60");
});

test("LocalRunner backtests run in parallel without collision", async () => {
  const r = new LocalRunner(PREFIX);
  const mk = async (tf: string) => {
    const tmp = await mkdtemp(join(tmpdir(), "lrp-"));
    await writeFile(join(tmp, "strategy.cpp"), "int main(){}");
    await writeFile(join(tmp, "ohlcv.csv"), "timestamp,open,high,low,close,volume\n");
    return r.backtest({ cppPath: join(tmp, "strategy.cpp"), csvPath: join(tmp, "ohlcv.csv"), runtime: { input_tf: tf } });
  };
  const [a, b] = await Promise.all([mk("1"), mk("D")]) as Array<{ input_tf: string }>;
  assert.equal(a.input_tf, "1");
  assert.equal(b.input_tf, "D");
});

test("LocalRunner.engineInfo reports baked-in version from env", async () => {
  process.env.PINEFORGE_VERSION = "0.8.0";
  const r = new LocalRunner(PREFIX);
  assert.deepEqual(await r.engineInfo(), { mode: "local", baked_in: true, version: "0.8.0" });
});
