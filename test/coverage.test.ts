import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coverageIndex,
  coverageTopic,
  checkPineFeature,
  COVERAGE,
  type CoverageTopic,
} from "../src/coverage.js";

const VALID_STATUSES = ["supported", "partial", "unsupported", "via_transpiler"];

test("coverageIndex lists all 20 topics with version + legend", () => {
  const idx = coverageIndex();
  assert.equal(idx.topics.length, 20);
  assert.equal(idx.topics.length, COVERAGE.topics.length);
  assert.equal(idx.coverage_version, "2026-06-04 / 0fccede");
  // legend has the four canonical status keys.
  assert.deepEqual(
    Object.keys(idx.legend).sort(),
    ["partial", "supported", "unsupported", "via_transpiler"],
  );
  // index entries are the lightweight shape only (no detail/supported lists).
  for (const t of idx.topics) {
    assert.ok(typeof t.id === "string" && t.id.length > 0);
    assert.ok(typeof t.title === "string" && t.title.length > 0);
    assert.ok(typeof t.summary === "string" && t.summary.length > 0);
    assert.ok(!("detail" in t));
    assert.ok(!("supported" in t));
    assert.ok(!("unsupported" in t));
  }
});

test("every topic.status is one of the four valid statuses", () => {
  for (const t of COVERAGE.topics) {
    assert.ok(
      VALID_STATUSES.includes(t.status),
      `topic '${t.id}' has invalid status '${t.status}'`,
    );
  }
  for (const t of coverageIndex().topics) {
    assert.ok(VALID_STATUSES.includes(t.status));
  }
});

test("coverageTopic returns the full topic for a valid id", () => {
  const t = coverageTopic("ta") as CoverageTopic;
  assert.equal(t.id, "ta");
  assert.equal(t.status, "supported");
  assert.ok(t.detail.length > 0);
  assert.ok(Array.isArray(t.supported) && t.supported.includes("ta.supertrend"));
  assert.ok(Array.isArray(t.unsupported));
});

test("coverageTopic returns an error marker with valid_ids for an unknown id", () => {
  const r = coverageTopic("does_not_exist") as {
    error: string;
    query: string;
    valid_ids: string[];
  };
  assert.match(r.error, /Unknown coverage topic/);
  assert.equal(r.query, "does_not_exist");
  assert.equal(r.valid_ids.length, 20);
  assert.ok(r.valid_ids.includes("ta"));
});

test("checkPineFeature: exact supported identifier reports the topic status", () => {
  const r = checkPineFeature("ta.supertrend");
  assert.equal(r.status, "supported");
  assert.equal(r.topic, "ta");
});

test("checkPineFeature: exact unsupported identifier reports unsupported", () => {
  // 'plot' is listed in drawing_plotting_alerts.unsupported[].
  const r = checkPineFeature("plot");
  assert.equal(r.status, "unsupported");
  assert.equal(r.topic, "drawing_plotting_alerts");
});

test("checkPineFeature: namespace prefix fallback (ta.foo -> ta topic status)", () => {
  const r = checkPineFeature("ta.foo");
  assert.equal(r.topic, "ta");
  assert.equal(r.status, "supported");
  assert.match(r.note, /prefix/);
});

test("checkPineFeature: longest prefix wins (strategy.risk.* -> strategy_risk)", () => {
  const r = checkPineFeature("strategy.risk.something");
  assert.equal(r.topic, "strategy_risk");
  assert.equal(r.status, "partial");
});

test("checkPineFeature: alias fallback ('alert' -> drawing_plotting_alerts)", () => {
  const r = checkPineFeature("alert");
  // 'alert' is both an alias key AND an exact unsupported identifier; either
  // path resolves to the drawing topic with unsupported status.
  assert.equal(r.topic, "drawing_plotting_alerts");
  assert.equal(r.status, "unsupported");
});

test("checkPineFeature: alias-only key resolves via alias_map ('series')", () => {
  const r = checkPineFeature("series");
  assert.equal(r.topic, "series_history");
  assert.equal(r.status, "supported");
});

test("checkPineFeature: a miss returns not_found", () => {
  const r = checkPineFeature("totally.bogus.identifier.xyz");
  assert.equal(r.status, "not_found");
  assert.equal(r.topic, undefined);
  assert.match(r.note, /did not match/);
});

test("checkPineFeature: compound 'a / b' entry matches each id (strategy.cancel_all)", () => {
  const r = checkPineFeature("strategy.cancel_all");
  assert.equal(r.topic, "strategy_orders");
  assert.equal(r.status, "supported");
});

test("checkPineFeature: prose-tagged unsupported id beats namespace prefix (strategy.margin_liquidation_price)", () => {
  // entry is "strategy.margin_liquidation_price (always returns na)" under
  // strategy_state.unsupported; the bare "strategy." prefix must NOT win.
  const r = checkPineFeature("strategy.margin_liquidation_price");
  assert.equal(r.topic, "strategy_state");
  assert.equal(r.status, "unsupported");
});

test("checkPineFeature: trailing () in the query is normalized (input.float())", () => {
  const r = checkPineFeature("input.float()");
  assert.equal(r.topic, "inputs");
  assert.equal(r.status, "supported");
});
