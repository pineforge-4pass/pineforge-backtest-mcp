// Kill test of the LocalRunner request sweep, run inside the MCP image (Linux):
//
//   docker run --rm --init -v "$PWD/scripts/parity-sweep-test.mjs:/t/sweep.mjs:ro" \
//     --entrypoint node <mcp image> /t/sweep.mjs
//
// LocalRunner.parity() runs the grading core; once the request is compiling
// (a cc1plus process of the request exists) or running (the harness exists),
// the driver gets SIGKILL. parity() must settle, and afterwards no process of
// the request may remain: no compiler grandchild, no harness.
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { LocalRunner } from "/app/dist/engine.js";

const START = 1743379200000; // 2025-03-31 00:00 UTC
const BARS = ["timestamp,open,high,low,close,volume",
  ...Array.from({ length: 400 }, (_, i) => `${START + i * 900_000},${100 + (i % 7)},${101 + (i % 7)},${99 + (i % 7)},${100.5 + (i % 7)},10`)].join("\n") + "\n";
const TRADES = "Trade number,Type,Date and time,Signal,Price USDT,Size (qty),Net PnL USDT\n" +
  "1,Exit long,2025-03-31 10:00,x,103,1,1\n1,Entry long,2025-03-31 05:00,L,102,1,1\n";
const ORDINARY = '//@version=6\nstrategy("sma", overlay = true)\nf = ta.sma(close, 5)\ns = ta.sma(close, 20)\n' +
  'if ta.crossover(f, s)\n    strategy.entry("L", strategy.long)\nif ta.crossunder(f, s)\n    strategy.close("L")\n';
const LOOP = '//@version=6\nstrategy("loop forever", overlay = true)\nvar int n = 0\nwhile true\n    n += 1\n' +
  'if n > 0\n    strategy.entry("L", strategy.long)\n';

function requestProcesses() {
  const out = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      // A process of the request: marked by PF_PARITY_REQUEST, working in a
      // LocalRunner jail, or the driver itself (also true before the marker existed).
      const env = readFileSync(`/proc/${name}/environ`);
      let cwd = "";
      try { cwd = readlinkSync(`/proc/${name}/cwd`); } catch { /* gone */ }
      const cmd0 = readFileSync(`/proc/${name}/cmdline`, "utf8");
      if (!env.includes(Buffer.from("PF_PARITY_REQUEST=")) && !cwd.startsWith("/tmp/pineforge-parity-") &&
          !cmd0.includes("pf_parity.py")) continue;
      const state = readFileSync(`/proc/${name}/stat`, "utf8").split(")").pop().trim().split(" ")[0];
      if (state === "Z") continue;
      const comm = readFileSync(`/proc/${name}/comm`, "utf8").trim();
      const cmd = readFileSync(`/proc/${name}/cmdline`, "utf8").replace(/\0/g, " ").trim();
      out.push({ pid: Number(name), comm, cmd });
    } catch { /* gone */ }
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runCase(name, pine, stage) {
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const dir = mkdtempSync("/tmp/sweep-test-");
  writeFileSync(`${dir}/bars.csv`, BARS);
  const runner = new LocalRunner();
  const settled = runner.parity({
    request: { pine, tradingview_trades_csv: TRADES, chart_timezone: "UTC", timeframe: "15",
      range_start_ms: START, range_end_ms: null, max_mismatches: 1 },
    barsPath: `${dir}/bars.csv`,
  }).then((r) => `answered ${JSON.stringify(r).slice(0, 80)}`, (e) => `failed: ${String(e.message ?? e).split("\n")[0]}`);
  let seen = null;
  for (let i = 0; i < 2400 && !seen; i++) {
    const procs = requestProcesses();
    const hit = procs.find(stage);
    if (hit) seen = { hit, procs };
    else await sleep(50);
  }
  if (!seen) return { ok: false, detail: `the ${name} stage was never seen` };
  const driver = seen.procs.find((p) => p.cmd.includes("pf_parity.py"));
  if (!driver) return { ok: false, detail: "no driver process" };
  process.kill(driver.pid, "SIGKILL");
  const outcome = await settled;
  await sleep(200);
  const left = requestProcesses();
  return {
    ok: left.length === 0,
    detail: `killed driver ${driver.pid} while ${seen.hit.comm} (${seen.hit.pid}) ran; ` +
      `request processes then: ${seen.procs.map((p) => `${p.pid}:${p.comm}`).join(" ")}; ` +
      `parity() ${outcome}; left after settle: ${left.map((p) => `${p.pid}:${p.comm}`).join(" ") || "none"}`,
  };
}

let failures = 0;
const cases = [
  ["compile", ORDINARY, (p) => p.comm === "cc1plus"],
  ["run", LOOP, (p) => p.cmd.includes("run_strategy.py")],
];
for (const [name, pine, stage] of cases) {
  const { ok, detail } = await runCase(name, pine, stage);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} SIGKILL the driver during ${name}: ${detail}`);
  for (const p of requestProcesses()) { try { process.kill(p.pid, "SIGKILL"); } catch { /* gone */ } }
}
console.log(`\n${failures ? "FAIL" : "PASS"}: ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
