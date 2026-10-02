import { test } from "node:test";
import assert from "node:assert/strict";
import { declaresMagnifier, magnifierEndMs, magnifierWindow, magnifierNotRun, formatParityResult } from "../src/parity/index.js";

test("magnifier declaration follows codegen's literal keyword argument", () => {
  const cases: Array<[string, boolean]> = [
    ['strategy("x", use_bar_magnifier=true)', true],
    ['strategy("x", use_bar_magnifier = (( true )))', true],
    ['strategy("x", use_bar_magnifier=(\n true\n), overlay=true)', true],
    ['// strategy("ignored", use_bar_magnifier=false)\nstrategy("x", use_bar_magnifier=true)', true],
    ['strategy("x", // use_bar_magnifier=false\nuse_bar_magnifier=(true))', true],
    ['strategy("x", use_bar_magnifier=false)', false],
    ['strategy("x", use_bar_magnifier=((false)))', false],
    ['strategy("x")', false],
    ['strategy("x") // use_bar_magnifier=true', false],
    ['// strategy("x", use_bar_magnifier=true)', false],
    ['strategy("use_bar_magnifier=true")', false],
    ["strategy('use_bar_magnifier=true')", false],
    ['label.new(0, 0, "strategy(x, use_bar_magnifier=true)")', false],
    ['strategy("a \\\" ) , use_bar_magnifier=false", use_bar_magnifier=true)', true],
    ['strategy("x")\nuse_bar_magnifier=true', false],
    ['strategy.entry("x", use_bar_magnifier=true)', false],
    ['strategy("x", use_bar_magnifier=not false)', false],
    ['strategy("x", use_bar_magnifier=(true) or (false))', false],
    ['strategy("x", use_bar_magnifier=enabled)', false],
  ];
  for (const [pine, expected] of cases) assert.equal(declaresMagnifier(pine), expected, pine);
});

test("magnifier window starts at the first chart open and includes the final bar's last millisecond", () => {
  const first = Date.UTC(2026, 8, 1, 0, 0);
  const last = Date.UTC(2026, 8, 1, 0, 30);
  assert.deepEqual(magnifierWindow(first, last, 900_000), {
    startMs: first, endMs: Date.UTC(2026, 8, 1, 0, 45) - 1,
  });
  assert.equal(magnifierEndMs(first, 86_400_000), first + 86_400_000 - 1);
  assert.deepEqual(magnifierWindow(first, first, 900_000), { startMs: first, endMs: first + 899_999 });
});

test("the shared formatter warns only when the harness says a declared magnifier did not run", () => {
  const r = { ok: true, tier: "excellent", matched: 1, unmatched_tradingview: 0, unmatched_pineforge: 0 };
  const log = ["  magnifier: declared-not-run: no magnifier feed"];
  assert.equal(magnifierNotRun(log), "no magnifier feed");
  assert.equal(magnifierNotRun(undefined), null);
  const text = formatParityResult({ ...r, window: { harness_log: log } }, { retention: "local" });
  assert.match(text, /declares the bar magnifier but ran without one, so fills inside bars may differ from TradingView's/);
  for (const harness_log of [undefined, [], ["magnifier: declared: run on the 1m feed"]]) {
    assert.doesNotMatch(formatParityResult({ ...r, window: { harness_log } }, { retention: "local" }), /ran without one/);
  }
});

// What pineforge-release 1.0.1's codegen emits for each source: the generated C++
// has `strategy_declares_bar_magnifier() { return 1; }` (true) or no such
// function (false). Collected with
//   docker run --rm --network=none -e PINEFORGE_TRANSPILE_ONLY=1 \
//     -v $PWD/<case>.pine:/in/strategy.pine:ro ghcr.io/pineforge-4pass/pineforge-release:1.0.1
const CODEGEN_1_0_1: Array<[string, string, boolean]> = [
  ["ordinary", '//@version=6\nstrategy("x", use_bar_magnifier=true)\nplot(close)\n', true],
  ["multiline triple-quoted title", '//@version=6\nstrategy("""multi\nline""", use_bar_magnifier=true)\nplot(close)\n', true],
  ["multiline triple-single-quoted title", "//@version=6\nstrategy('''multi\nline''', use_bar_magnifier=true)\nplot(close)\n", true],
  ["line-wrapped title", '//@version=6\nstrategy("multi\n     line", use_bar_magnifier=true)\nplot(close)\n', true],
  ["line-wrapped arguments", '//@version=6\nstrategy("x",\n     use_bar_magnifier = true)\nplot(close)\n', true],
  ["comment", '//@version=6\n// use_bar_magnifier=true\nstrategy("x")\nplot(close)\n', false],
  ["string containing the text", '//@version=6\nstrategy("use_bar_magnifier=true")\nplot(close)\n', false],
  ["string with the text, then the argument", '//@version=6\nstrategy("a, use_bar_magnifier=false", use_bar_magnifier=true)\nplot(close)\n', true],
  ["escaped quote in the title", '//@version=6\nstrategy("say \\"hi\\"", use_bar_magnifier=true)\nplot(close)\n', true],
  ["parentheses", '//@version=6\nstrategy("x", use_bar_magnifier=(true))\nplot(close)\n', true],
  ["false", '//@version=6\nstrategy("x", use_bar_magnifier=false)\nplot(close)\n', false],
];

test("magnifier declaration agrees with release 1.0.1's codegen, multiline and wrapped strings included", () => {
  for (const [name, pine, emitted] of CODEGEN_1_0_1) assert.equal(declaresMagnifier(pine), emitted, name);
});

test("a string that never ends: a literal use_bar_magnifier = true counts as declared", () => {
  assert.equal(declaresMagnifier('strategy("x, use_bar_magnifier=true)'), true);
  assert.equal(declaresMagnifier('strategy("""x", use_bar_magnifier = ( true ))'), true);
  assert.equal(declaresMagnifier('strategy("x, use_bar_magnifier=false)'), false);
  assert.equal(declaresMagnifier('strategy("x)'), false);
});
