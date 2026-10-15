// Executes only on CI/cloud runners. Every suite must produce its declared,
// nonzero test inventory with zero failures, cancellations or skips.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readLock, sha256 } from "./release-contract.mjs";
import { integrity } from "./release-evidence.mjs";

export function verifyTap(tap, expected) {
  assert.ok(Number.isInteger(expected) && expected > 0, "nonzero expected tests required");
  const n = (key) => { const m = tap.match(new RegExp(`^# ${key} (\\d+)$`, "m")); assert.ok(m, `missing ${key} count`); return Number(m[1]); };
  assert.equal(n("tests"), expected, "suite inventory changed");
  assert.equal(n("pass"), expected, "incomplete suite");
  for (const key of ["fail", "cancelled", "skipped", "todo"]) assert.equal(n(key), 0, `${key} tests cannot authorize release`);
}
async function run() {
  const lock = readLock();
  const inventory = JSON.parse(readFileSync("test/fixtures/release/runtime-inventory.json"));
  const packed = JSON.parse(readFileSync(".release-ci/offline-package/package.json"));
  assert.equal(integrity(`.release-ci/offline-package/${packed.tar}`), packed.integrity, "test tarball changed");
  const mode = process.argv[2];
  assert.ok(["npm", "image"].includes(mode), "expected npm or image");
  const root = process.cwd();
  const feed15 = resolve(".release-ci/corpus/data/derived/ohlcv_ETH-USDT-USDT_15m.csv");
  const feed1 = resolve(".release-ci/corpus/data/ohlcv_ETH-USDT-USDT_1m.csv");
  assert.equal(sha256(readFileSync(feed1)), inventory.feed_1m_sha256);
  const rows = readFileSync(feed15, "utf8").trim().split("\n").slice(1).map((s) => s.split(","));
  assert.ok(rows.length > 1000, "empty/short derived feed");
  // The existing live-fetch negative case uses these recorded bars instead of
  // the public network. The transpiler, compiler, engine and grader remain real.
  const stub = createServer((req, res) => {
    const u = new URL(req.url, "http://stub");
    res.setHeader("content-type", "application/json");
    if (u.pathname.endsWith("exchangeInfo")) {
      const file = u.pathname.startsWith("/fapi") ? "fapi" : "spot";
      res.end(readFileSync(`test/fixtures/binance/${file}-exchangeinfo.json`));
    } else if (u.pathname.endsWith("klines")) {
      const start = Number(u.searchParams.get("startTime") ?? 0);
      const end = Number(u.searchParams.get("endTime") ?? Infinity);
      const limit = Number(u.searchParams.get("limit") ?? 1000);
      res.end(JSON.stringify(rows.filter((r) => Number(r[0]) >= start && Number(r[0]) <= end).slice(0, limit)
        .map(([t, o, h, l, c, v]) => [Number(t), o, h, l, c, v, Number(t) + 899999, "0", 0, "0", "0", "0"])));
    } else { res.statusCode = 404; res.end("{}"); }
  });
  await new Promise((ok) => stub.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${stub.address().port}`;
  const env = { ...process.env,
    PF_RELEASE_GATE: "1", PF_E2E_MODE: mode, PF_E2E_CORPUS: resolve(".release-ci/corpus"),
    PF_E2E_FEED_15M: feed15, PF_E2E_FEED_1M: feed1, PF_E2E_SYMINFO_CSV: resolve(".release-ci/syminfo.csv"),
    PF_E2E_SAMPLE: String(inventory.parity_sample), PF_E2E_SEED: String(inventory.parity_seed),
    PF_E2E_CONCURRENCY: "3", PINEFORGE_PARITY_TIMEOUT_MS: "60000",
    PINEFORGE_BINANCE_SPOT_URL: url, PINEFORGE_BINANCE_FAPI_URL: url,
    PF_E2E_SERVER: JSON.stringify(mode === "image" ? ["node", resolve("scripts/e2e-container-server.mjs")]
      : ["node", resolve(".release-ci/installed/node_modules/@pineforge/backtest-mcp/dist/index.js")]),
  };
  // The packed package must select its generated default without an override.
  delete env.PINEFORGE_IMAGE;
  delete env.PF_E2E_PATH_MAP;
  delete env.PF_E2E_DOCKER_IMAGE;
  delete env.PF_E2E_PROBES;
  const suites = [];
  try {
    for (const [file, count] of Object.entries(inventory.suites)) {
      const chunks = [];
      const code = await new Promise((done, reject) => {
        const suiteEnv = { ...env, PINEFORGE_PARITY_TIMEOUT_MS: file === "parity-negative.e2e.ts" ? "60000" : "600000" };
        const child = spawn("node", ["--import", "tsx", "--test", "--test-reporter=tap", `test/e2e/${file}`], { env: suiteEnv, cwd: root, stdio: ["ignore", "pipe", "inherit"] });
        child.stdout.on("data", (b) => { process.stdout.write(b); chunks.push(b); });
        child.on("error", reject); child.on("exit", done);
      });
      const tap = Buffer.concat(chunks).toString();
      writeFileSync(`.release-ci/${mode}-${file}.tap`, tap);
      assert.equal(code, 0, `${mode} ${file} failed`);
      verifyTap(tap, count);
      if (file === "parity-stdio.e2e.ts") assert.match(tap, new RegExp(`AGREEMENT ${inventory.parity_sample}/${inventory.parity_sample}`));
      suites.push({ suite: file, expected: count, passed: count, skipped: 0, result: "success" });
    }
    const imageID = mode === "image" ? execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", env.PF_E2E_CANDIDATE_IMAGE], { encoding: "utf8" }).trim() : null;
    writeFileSync(`.release-ci/runtime-${process.env.PF_ARCH}-${mode}.json`, JSON.stringify({
      role: "offline", mode, arch: process.env.PF_ARCH, event_id: lock.event_id ?? null,
      source_sha: process.env.GITHUB_SHA, run_id: process.env.GITHUB_RUN_ID,
      artifact_attempt: process.env.GITHUB_RUN_ATTEMPT,
      package_integrity: packed.integrity,
      hub_image: `${lock.image.repository}@${lock.image.digest}`, image_id: imageID,
      fixture_inventory_sha256: sha256(readFileSync("test/fixtures/release/runtime-inventory.json")), suites,
    }, null, 2) + "\n");
  } finally { await new Promise((ok) => stub.close(ok)); }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { await run(); } catch (e) { console.error(e); process.exitCode = 1; }
}
