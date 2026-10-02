import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coverageIndex,
  coverageTopic,
  checkPineFeature,
  COVERAGE,
  entryIdentifiers,
  type CoverageStatus,
  type CoverageTopic,
} from "../src/coverage.js";

const VALID_STATUSES = ["supported", "partial", "unsupported", "via_transpiler"];

test("coverageIndex lists all 21 topics with version + legend", () => {
  const idx = coverageIndex();
  assert.equal(idx.topics.length, 21);
  assert.equal(idx.topics.length, COVERAGE.topics.length);
  assert.equal(idx.coverage_version, "engine v1.0.1 + codegen 1.0.1 (2026-10-02)");
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
    assert.ok(!("partial" in t));
    assert.ok(!("via_transpiler" in t));
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
  assert.equal(r.valid_ids.length, 21);
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
  assert.equal(r.status, "supported");
});

test("checkPineFeature: an exact entry wins over the alias_map ('alert' -> drawing_plotting_alerts)", () => {
  const r = checkPineFeature("alert");
  // 'alert' is both an alias key AND an exact unsupported identifier; the exact entry answers.
  assert.equal(r.topic, "drawing_plotting_alerts");
  assert.equal(r.status, "unsupported");
  assert.doesNotMatch(r.note, /alias/);
});

test("checkPineFeature: alias-only key resolves via alias_map ('matrix')", () => {
  const r = checkPineFeature("matrix");
  assert.equal(r.topic, "numeric_matrices");
  assert.equal(r.status, "supported");
  assert.match(r.note, /alias/);
});

test("checkPineFeature: Object prototype keys are not aliases", () => {
  for (const q of ["constructor", "__proto__", "toString"]) {
    assert.equal(checkPineFeature(q).status, "not_found", q);
  }
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

test("checkPineFeature: prose-tagged unsupported id beats namespace prefix (strategy.closedtrades.direction)", () => {
  // entry is "strategy.closedtrades.direction / strategy.opentrades.direction (no such
  // Pine v6 accessor; ...)" under strategy_state.unsupported; the prefix must NOT win.
  const r = checkPineFeature("strategy.closedtrades.direction");
  assert.equal(r.topic, "strategy_state");
  assert.equal(r.status, "unsupported");
});

test("checkPineFeature: an unsupported-list hit under a SUPPORTED topic still reports unsupported", () => {
  // 'strategy.default_entry_qty' is unsupported under the otherwise-supported strategy_orders topic.
  const r = checkPineFeature("strategy.default_entry_qty");
  assert.equal(r.status, "unsupported");
  assert.equal(r.topic, "strategy_orders");
});

test("checkPineFeature: trailing () in the query is normalized (input.float())", () => {
  const r = checkPineFeature("input.float()");
  assert.equal(r.topic, "inputs");
  assert.equal(r.status, "supported");
});

// ─── Answers corrected against engine v1.0.1 / codegen 1.0.1 ─────────────────

function expectFeature(feature: string, status: CoverageStatus, topic: string, noteIncludes?: string) {
  const r = checkPineFeature(feature);
  assert.equal(r.status, status, `${feature}: ${r.note}`);
  assert.equal(r.topic, topic, `${feature}: ${r.note}`);
  if (noteIncludes) assert.ok(r.note.includes(noteIncludes), `${feature} note: ${r.note}`);
}

test("check_pine_feature: request.security is partial, scoped to what this server can supply", () => {
  expectFeature("request.security", "partial", "request_security", "this server cannot supply other symbols' bars");
  expectFeature("request.security()", "partial", "request_security", "stops the run");
  expectFeature("request.security_lower_tf", "partial", "request_security", "string elements are refused");
  expectFeature("barmerge.lookahead_on", "supported", "request_security");
  expectFeature("barmerge.gaps_off", "supported", "request_security");
  expectFeature("request.security", "partial", "request_security", "including one written as a string");
  expectFeature("syminfo.tickerid", "supported", "request_security");
  expectFeature("ticker.heikinashi", "supported", "request_security");
  expectFeature("ticker.standard", "via_transpiler", "request_security");
  expectFeature("ticker.new", "unsupported", "request_security", "refused");
  expectFeature("ticker.renko", "unsupported", "request_security");
});

test("check_pine_feature: recorded and refused request.* calls are unsupported here, with the reason", () => {
  for (const f of ["request.financial", "request.earnings", "request.dividends", "request.splits"]) {
    expectFeature(f, "unsupported", "request_security", "this server installs none");
  }
  expectFeature("request.footprint", "unsupported", "request_security", "this server installs none");
  for (const f of ["request.economic", "request.currency_rate", "request.seed", "request.quandl"]) {
    expectFeature(f, "unsupported", "request_security", "refused at transpile");
  }
});

test("check_pine_feature: drawings are data the strategy reads back; plots, tables and alerts have no effect", () => {
  for (const f of ["line.new", "line.get_y2", "box.new", "box.get_top", "label.new", "label.get_text", "linefill.new", "chart.point.from_index"]) {
    expectFeature(f, "supported", "drawing_plotting_alerts");
  }
  expectFeature("line.new", "supported", "drawing_plotting_alerts", "data");
  expectFeature("line.set_color", "unsupported", "drawing_plotting_alerts", "visual setters");
  expectFeature("line.all", "unsupported", "drawing_plotting_alerts", "does not compile");
  for (const f of ["plot", "bgcolor", "table.new", "table", "polyline.new", "alertcondition"]) {
    expectFeature(f, "unsupported", "drawing_plotting_alerts");
  }
  const t = coverageTopic("drawing_plotting_alerts") as CoverageTopic;
  assert.equal(t.status, "partial");
});

test("check_pine_feature: lifecycle answers (calc_on_order_fills, varip, indicator, import)", () => {
  expectFeature("calc_on_order_fills", "supported", "engine_lifecycle");
  expectFeature("calc_on_every_tick", "unsupported", "engine_lifecycle");
  expectFeature("varip", "supported", "engine_lifecycle");
  expectFeature("indicator", "unsupported", "engine_lifecycle", "strategies only");
  expectFeature("indicator()", "unsupported", "engine_lifecycle");
  expectFeature("import", "unsupported", "engine_lifecycle", "no library sources");
  expectFeature("library", "unsupported", "engine_lifecycle");
});

test("check_pine_feature: identifiers that prose inside unsupported entries used to shadow now resolve correctly", () => {
  expectFeature("strategy.exit", "supported", "strategy_orders");
  expectFeature("ta.obv", "supported", "ta");
  expectFeature("ta.change", "supported", "ta");
  expectFeature("na", "supported", "na");
  expectFeature("color", "supported", "color");
  expectFeature("math.random", "partial", "math", "not TradingView's generator");
  assert.notEqual(checkPineFeature("string").status, "unsupported");
  assert.notEqual(checkPineFeature("line").status, "unsupported");
});

test("check_pine_feature: transpiler-emitted functions report via_transpiler, not unsupported", () => {
  for (const f of ["str.length", "str.contains", "str.replace_all", "str.tonumber"]) expectFeature(f, "via_transpiler", "str");
  expectFeature("str.format", "supported", "str");
  expectFeature("nz", "via_transpiler", "na");
  expectFeature("fixnan", "via_transpiler", "na");
  expectFeature("math.abs", "via_transpiler", "math");
  expectFeature("math.sum", "supported", "math");
  expectFeature("array.new", "via_transpiler", "arrays_maps_udts");
  expectFeature("strategy.convert_to_account", "via_transpiler", "strategy_orders", "no FX adjustment");
  expectFeature("color.rgb", "via_transpiler", "color");
});

test("check_pine_feature: state, time and timeframe answers match engine v1.0.1", () => {
  expectFeature("strategy.margin_liquidation_price", "supported", "strategy_state");
  expectFeature("barstate.islast", "supported", "strategy_state");
  expectFeature("barstate.islastconfirmedhistory", "partial", "strategy_state");
  expectFeature("barstate.isrealtime", "partial", "strategy_state");
  expectFeature("strategy.risk.max_intraday_filled_orders", "supported", "strategy_risk");
  expectFeature("session.isfirstbar_regular", "supported", "time_session_timezone");
  expectFeature("timenow", "partial", "time_session_timezone", "wall clock");
  expectFeature("timeframe.from_seconds", "unsupported", "timeframe_parsing");
  expectFeature("timeframe.isticks", "supported", "timeframe_parsing");
  expectFeature("color.from_gradient", "unsupported", "color", "default color");
});

test("check_pine_feature: maps are their own partial topic (string keys, primitive values)", () => {
  expectFeature("map.put", "partial", "maps", "string keys");
  expectFeature("map", "partial", "maps");
  const r = checkPineFeature("map.whatever");
  assert.equal(r.topic, "maps");
  assert.equal(r.status, "partial");
});

// Bare (undotted, lowercase) tokens that are real Pine or engine identifiers. Any other
// bare word outside an entry's parentheses is prose and would become a false match.
const BARE_IDENTIFIERS = new Set([
  "alert", "alertcondition", "array", "barcolor", "bgcolor", "color", "confirm", "dayofmonth",
  "dayofweek", "display", "export", "fill", "fixnan", "group", "hline", "hour", "import",
  "indicator", "inline", "input", "library", "map", "max", "method", "min", "minute", "month",
  "na", "nz", "options", "plot", "plotarrow", "plotbar", "plotcandle", "plotchar", "plotshape",
  "polyline", "pyramiding", "run", "second", "series", "slippage", "step", "strategy", "table",
  "time", "timenow", "tooltip", "type", "varip", "weekofyear", "year",
]);

test("every catalog entry keeps prose inside one trailing parenthesis, so only identifiers match", () => {
  for (const t of COVERAGE.topics) {
    for (const list of ["supported", "partial", "via_transpiler", "unsupported"] as const) {
      for (const entry of t[list] ?? []) {
        assert.ok(!/\([^)]*\(/.test(entry), `${t.id}.${list}: nested parentheses in "${entry}"`);
        for (const id of entryIdentifiers(entry)) {
          assert.ok(
            /[._A-Z*]/.test(id) || BARE_IDENTIFIERS.has(id),
            `${t.id}.${list}: "${id}" in "${entry}" is prose, not an identifier`,
          );
        }
      }
    }
  }
});

test("no identifier a topic lists as working resolves to unsupported", () => {
  for (const t of COVERAGE.topics) {
    for (const list of ["supported", "partial", "via_transpiler"] as const) {
      for (const entry of t[list] ?? []) {
        for (const id of entryIdentifiers(entry)) {
          assert.notEqual(checkPineFeature(id).status, "unsupported", `${t.id}.${list}: ${id}`);
        }
      }
    }
  }
});

test("every prefix_map and alias_map target is a real topic", () => {
  const ids = new Set(COVERAGE.topics.map((t) => t.id));
  for (const target of [...Object.values(COVERAGE.prefix_map), ...Object.values(COVERAGE.alias_map)]) {
    assert.ok(ids.has(target), `unknown topic ${target}`);
  }
});

test("review fixes: matrix.rank/trace, str.tostring, input.source, arrays, @annotations", () => {
  expectFeature("matrix.rank", "supported", "numeric_matrices");
  expectFeature("matrix.trace", "supported", "numeric_matrices");
  expectFeature("str.tostring", "partial", "str", "array argument");
  expectFeature("input.source", "partial", "inputs", "hlcc4");
  expectFeature("input.float", "supported", "inputs");
  expectFeature("array.slice", "partial", "arrays_maps_udts", "aliases");
  expectFeature("array.new_color", "unsupported", "arrays_maps_udts");
  expectFeature("array.new_table", "unsupported", "arrays_maps_udts");
  expectFeature("array.new_float", "via_transpiler", "arrays_maps_udts");
  expectFeature("@strategy_alert_message", "unsupported", "logging_errors");
});

// Entries that describe C++ or Pine syntax and carry no matchable identifier on purpose.
const DESCRIPTIVE_ENTRIES = new Set([
  "matrix.new<int>", "matrix.new<bool>", "matrix.new<string>", "matrix.new<color>", "matrix.new<UDT>",
  "na<double>() (NaN)", "na<int>() / na<int64_t>() (INT_MIN / INT64_MIN)", "na<bool>() (false)",
  "Series<T>::push / Series<T>::update / Series<T>::current",
  "series[k] (0 = current bar, k >= 1 = k bars ago; out of range reads na; max_len 500)",
  "tz_util::ScopedTimezone",
]);

test("every catalog entry yields an identifier to match, unless it is a known descriptive entry", () => {
  for (const t of COVERAGE.topics) {
    for (const list of ["supported", "partial", "via_transpiler", "unsupported"] as const) {
      for (const entry of t[list] ?? []) {
        if (DESCRIPTIVE_ENTRIES.has(entry)) continue;
        assert.ok(entryIdentifiers(entry).length > 0, `${t.id}.${list}: "${entry}" matches nothing`);
      }
    }
  }
});
