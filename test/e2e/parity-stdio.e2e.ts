/**
 * stdio E2E for check_tradingview_parity: a real MCP client spawns the server
 * and grades corpus probes through the public inputs only; each tier must equal
 * the published one (validation_report.md, corpus a35c7c4).
 *
 *   PF_E2E_SERVER       JSON argv of the server, default ["node","dist/index.js"]
 *   PF_E2E_PATH_MAP     "<host prefix>=<server prefix>" for paths in tool args (Docker image)
 *   PF_E2E_SAMPLE       probes to draw (default 30); PF_E2E_SEED (default 20261002)
 *   PF_E2E_PROBES       comma-separated slugs instead of the draw
 *   PF_E2E_CONCURRENCY  parallel calls (default 3)
 *   PF_E2E_OUT          write the result table (markdown) here
 *   + PF_E2E_CORPUS, PF_E2E_FEED_15M, PF_E2E_FEED_1M (see corpus.ts)
 *
 * Run: node --import tsx --test test/e2e/parity-stdio.e2e.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { TOOL, callParity, connect, pathMapper } from "./client.js";
import { env, exclusionReason, listProbes, probeCall, stratifiedSample, type Probe } from "./corpus.js";

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  }));
}

test(`${TOOL} over stdio reproduces the published corpus tiers`, async () => {
  const corpus = env("PF_E2E_CORPUS");
  const feed15 = env("PF_E2E_FEED_15M");
  const feed1 = env("PF_E2E_FEED_1M");
  const all = listProbes(corpus);
  const excluded = all.filter((p) => exclusionReason(p) !== null);
  const eligible = all.filter((p) => exclusionReason(p) === null);
  console.log(`probes ${all.length}; eligible ${eligible.length}; excluded ${excluded.length}:`);
  for (const p of excluded) console.log(`  excluded ${p.slug}: ${exclusionReason(p)}`);

  const wanted = process.env.PF_E2E_PROBES?.split(",").map((s) => s.trim()).filter(Boolean);
  const sample: Probe[] = wanted
    ? wanted.map((s) => {
        const p = eligible.find((q) => q.slug === s);
        assert.ok(p, `${s} is not an eligible probe`);
        return p;
      })
    : stratifiedSample(eligible, Number(process.env.PF_E2E_SAMPLE ?? 30), Number(process.env.PF_E2E_SEED ?? 20261002));
  // An empty or short sample must fail, not pass as AGREEMENT 0/0.
  const requested = wanted ? wanted.length : Number(process.env.PF_E2E_SAMPLE ?? 30);
  assert.ok(Number.isInteger(requested) && requested > 0, `bad sample size ${requested}`);
  assert.ok(eligible.length >= requested, `only ${eligible.length} eligible probes for a sample of ${requested}`);
  assert.equal(sample.length, requested, `sample of ${sample.length}, ${requested} requested`);
  assert.equal(new Set(sample.map((p) => p.slug)).size, sample.length, "a probe was drawn twice");
  console.log(`sample (${sample.length}): ${sample.map((p) => p.slug).join(", ")}`);

  const client = await connect();
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === TOOL), `server does not list ${TOOL}`);

    const rows: string[] = [];
    const failures: string[] = [];
    const map = pathMapper();
    await pool(sample, Number(process.env.PF_E2E_CONCURRENCY ?? 3), async (p) => {
      const { args } = probeCall(p, feed15, feed1, map);
      const t0 = Date.now();
      let tier = "error";
      let detail = "";
      try {
        const out = await callParity(client, args);
        if (out.isError || !out.data || out.data.ok !== true) {
          detail = out.text.split("\n")[0]?.slice(0, 200) ?? "";
        } else {
          tier = String(out.data.tier);
          detail = `matched ${out.data.matched}, TV-only ${out.data.unmatched_tradingview}, PF-only ${out.data.unmatched_pineforge}`;
        }
      } catch (e) {
        detail = e instanceof Error ? e.message.slice(0, 200) : String(e);
      }
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      const ok = tier === p.expectedTier;
      rows.push(`| ${p.slug} | ${p.category} | ${p.expectedTier} | ${tier} | ${ok ? "yes" : "NO"} | ${secs} | ${detail} |`);
      console.log(`${ok ? "AGREE" : "DIFFER"} ${p.slug}: published ${p.expectedTier}, tool ${tier} (${secs}s) ${detail}`);
      if (!ok) failures.push(`${p.slug}: published ${p.expectedTier}, tool ${tier} (${detail})`);
    });
    rows.sort();
    const table = [
      "| probe | category | published | tool | agree | seconds | detail |",
      "|---|---|---|---|---|---:|---|",
      ...rows,
      "",
      `AGREEMENT ${sample.length - failures.length}/${sample.length}`,
    ].join("\n");
    console.log(table);
    if (process.env.PF_E2E_OUT) writeFileSync(process.env.PF_E2E_OUT, table + "\n");
    assert.deepEqual(failures, []);
    // Every drawn probe was graded and agreed: AGREEMENT n/n with n the sample.
    assert.equal(rows.length, requested, `${rows.length} probes graded of ${requested}`);
    assert.equal(rows.filter((r) => r.includes("| yes |")).length, requested);
  } finally {
    await client.close();
  }
});
