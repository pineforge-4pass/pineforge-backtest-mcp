/**
 * PineForge Pine v6 coverage dataset — hand-authored canonical copy.
 *
 * Data sourced from pineforge-engine/docs/coverage.md +
 * pine_v6_coverage_detail.md and embedded here as a TS object literal (no
 * runtime fetch). This is the single source the MCP coverage tools serve.
 *
 * IMPORTANT: this is a hand-authored canonical copy. Updating it requires a
 * MANUAL re-sync across BOTH pineforge-backtest-mcp AND pineforge-mcp-public —
 * the two MCP surfaces carry their own copy of this dataset and they must not
 * drift. When coverage.md / pine_v6_coverage_detail.md change, edit this file
 * here and mirror the identical change in pineforge-mcp-public.
 */

export type CoverageStatus = "supported" | "partial" | "unsupported" | "via_transpiler";

export interface CoverageTopic {
  id: string;
  title: string;
  status: CoverageStatus;
  summary: string;
  detail: string;
  supported: string[];
  unsupported: string[];
}

export interface CoverageDataset {
  coverage_version: string;
  legend: Record<string, string>;
  topics: CoverageTopic[];
  prefix_map: Record<string, string>;
  alias_map: Record<string, string>;
}

export const COVERAGE: CoverageDataset = {
  coverage_version: "2026-06-04 / 0fccede",
  legend: {
    supported:
      "The Pine feature has a dedicated runtime class or function in libpineforge.a that fully implements its behavior end-to-end.",
    partial:
      "The feature is implemented in the runtime but with documented gaps or restrictions (e.g. some sub-features, configuration paths, or variants are missing or rejected).",
    unsupported:
      "The feature is not implemented anywhere in PineForge; it is parsed-and-skipped or rejected, producing no runtime behavior (e.g. drawing, plotting, and live alerts).",
    via_transpiler:
      "The feature has no dedicated runtime module, but PineForge's PineScript-to-C++ transpiler emits it inline against the C++ standard library or generated structs, so it still works end-to-end.",
  },
  topics: [
    {
      id: "engine_lifecycle",
      title: "Engine / strategy lifecycle",
      status: "supported",
      summary:
        "BacktestEngine with three run(...) overloads, per-bar on_bar hook, and ReportC/SecurityDiagC reporting are fully implemented in the runtime.",
      detail:
        "The runtime owns the full strategy lifecycle. BacktestEngine is an abstract base; the consumer compiler emits a strategy subclass that derives from it and implements on_bar(const Bar&). Three run(...) overloads are exposed: a bare (bars, n) form, a TF-aware form (input_tf/script_tf + magnifier args), and a full form that also injects a SymInfo, the input map, and a StrategyOverrides struct (NaN/-1 mean leave-default). The TF-aware overload auto-detects input_tf via detect_timeframe when empty and defaults script_tf to input_tf.\n\nStrategyOverrides only carries a fixed set of fields (initial_capital, commission_value, default_qty_value, pyramiding, slippage, commission_type, default_qty_type, process_orders_on_close, close_entries_rule); anything else (currency, margin, risk thresholds) must be set by the generated subclass — there is no runtime entry point. Per-input overrides go through set_input/clear_inputs before run(...); magnifier density via set_magnifier_volume_weighted.\n\nLifecycle reporting is via fill_report(ReportC*) which populates closed-trade summaries (TradeC[]), bar counters, magnifier work counters, TF/aggregation diagnostics, and per-security SecurityDiagC. The public C ABI exposes exactly 10 symbols: strategy_create/strategy_free, run_backtest, run_backtest_full, report_free, plus input/override/magnifier/trace setters and pf_version_get. indicator() is parse-and-skip (strategy-only engine); library() is unsupported. Note on barstate: the runtime DOES track barstate.islast (the barstate_islast_ flag is true on the genuine last bar of the batch run) — what is unsupported is live/realtime barstate semantics (barstate.isrealtime, barstate.islastconfirmedhistory are always false in batch).",
      supported: [
        "BacktestEngine",
        "run / run_backtest / run_backtest_full",
        "on_bar",
        "strategy()",
        "StrategyOverrides",
        "SymInfo / strategy_set_input / strategy_set_override",
        "fill_report (ReportC / SecurityDiagC)",
        "strategy_create / strategy_free / report_free",
        "detect_timeframe",
        "barstate.islast (barstate_islast_; true on last batch bar)",
      ],
      unsupported: [
        "indicator() (parse-and-skip; strategy-only engine)",
        "library() / import / export (library system not implemented)",
        "calc_on_every_tick / calc_on_order_fills (no live feed)",
        "barstate.isrealtime / barstate.islastconfirmedhistory realtime semantics (always false in batch)",
      ],
    },
    {
      id: "strategy_orders",
      title: "Strategy orders",
      status: "supported",
      summary:
        "All strategy order commands (entry/order/exit/close/close_all/cancel/cancel_all) are runtime-implemented with OHLC-path fills, OCA, pyramiding, slippage, commissions, margin gates, trailing stops, and TV deferred-flip carry.",
      detail:
        "The runtime owns strategy_entry, strategy_order, strategy_exit, strategy_close, strategy_close_all, strategy_cancel, and strategy_cancel_all. Pending orders resolve on every process_pending_orders(bar) call along a 4-waypoint OHLC path (O->H->L->C or O->L->H->C depending on open proximity to high vs low), handling stop/limit priority, gap fills, opposing-stop arbitration, OCA siblings, and trail levels. slippage_ (ticks) and syminfo_mintick_ round all fills; stop entries use directional mintick snapping (long stops up, short stops down) to match TradingView.\n\nPriced strategy.entry orders track TradingView's deferred-flip carry rule: an opposite priced entry placed while a position is open, firing later from flat after a close, opens qty + carried_position_qty; source order within a single on_bar matters. strategy_exit reserves a slice of the open position (partial exits one-shot per live position) and accepts profit/loss/limit/stop/trail_* params, but does not itself enforce that at least one is set. strategy_close does FIFO close by entry id (or all when empty), honouring close_entries_rule_any_ for ANY-mode partial close, with an immediately flag to bypass pending resolution.\n\nSizing uses QtyType {FIXED, PERCENT_OF_EQUITY, CASH} and default_qty_value_; commission uses CommissionType {PERCENT, CASH_PER_ORDER, CASH_PER_CONTRACT}. Margin checks use margin_long_/margin_short_ percentages from the subclass; if implied required capital exceeds equity the fill is silently rejected (matching TV). All strategy.* order constants (oca.*, commission.*, fixed/cash/percent_of_equity, long/short, default_entry_qty) are runtime-backed. strategy.convert_to_account/symbol are transpiler identity (no FX conversion).",
      supported: [
        "strategy.entry",
        "strategy.order",
        "strategy.exit",
        "strategy.close",
        "strategy.close_all",
        "strategy.cancel / strategy.cancel_all",
        "strategy.default_entry_qty",
        "strategy.oca.* / strategy.commission.*",
        "strategy.long / strategy.short",
        "QtyType / CommissionType",
        "slippage, pyramiding, margin_long_/margin_short_ gates",
      ],
      unsupported: [
        "strategy.convert_to_account / strategy.convert_to_symbol (transpiler identity, no FX adjustment)",
        "strategy.exit requirement that >=1 price param is set (policy lives outside runtime)",
      ],
    },
    {
      id: "strategy_state",
      title: "Strategy state / accessors",
      status: "supported",
      summary:
        "Position/equity/drawdown/runup tracking, win/loss counts, and the full closed- and open-trade accessor sets are wired directly on BacktestEngine.",
      detail:
        "The runtime tracks position state, equity/drawdown/runup, win/loss counts, and an intraday fill counter. strategy.closedtrades.* accessors are defined inline: profit, profit_percent, commission, entry/exit_bar_index, entry/exit_comment, entry/exit_id, entry/exit_price, entry/exit_time, size, max_runup(_percent), max_drawdown(_percent). strategy.opentrades.* mirrors the closed set minus the four exit_* fields. Pine v6 has no closedtrades/opentrades.direction(...) accessor — direction is encoded in the sign of size (positive=long, negative=short) — and the support checker rejects any direction(...) call.\n\nAggregate state methods on the engine: net_profit/gross_profit/gross_loss (and _percent), avg_trade/avg_winning_trade/avg_losing_trade (and _percent), count_wintrades/count_losstrades, current_equity, open_profit(price), open_trades_capital_held, and signed_position_size. Strategy state variables like strategy.equity, strategy.netprofit, strategy.position_size, strategy.position_avg_price, max_drawdown/max_runup, max_contracts_held_*, and eventrades are all runtime-backed. margin_liquidation_price() always returns na<double>().\n\nBar metadata helpers decompose current_bar_.timestamp (UTC) into year/month/dayofmonth/hour/minute/second/dayofweek/weekofyear with scalar accessors. barstate flags map onto three engine flags (is_first_tick_, is_last_tick_, barstate_islast_) with documented batch-mode approximations (islast always false, ishistory always true, isrealtime always false).",
      supported: [
        "strategy.closedtrades.* / strategy.opentrades.* accessors",
        "strategy.equity / netprofit / grossprofit / grossloss",
        "strategy.position_size / position_avg_price",
        "strategy.max_drawdown / max_runup (_percent)",
        "strategy.wintrades / losstrades / eventrades",
        "strategy.max_contracts_held_*",
        "current_equity / open_profit / signed_position_size",
      ],
      unsupported: [
        "strategy.closedtrades.direction / strategy.opentrades.direction (no such Pine v6 accessor; rejected by support checker — use sign of size)",
        "strategy.margin_liquidation_price (always returns na)",
        "barstate.islast/isrealtime/islastconfirmedhistory realtime semantics (batch-mode placeholders)",
      ],
    },
    {
      id: "strategy_risk",
      title: "Strategy risk",
      status: "partial",
      summary:
        "Runtime fields cover position-size cap, drawdown cap (abs/%), intraday-loss cap (abs/%), consecutive losing days, intraday filled-order cap, and direction allow-list — but none are exposed via StrategyOverrides.",
      detail:
        "BacktestEngine tracks risk fields and gates entries through check_risk_allow_entry(is_long) and update_risk_state(). The covered strategy.risk.* surface: allow_entry_in (risk_direction_: BOTH/LONG_ONLY/SHORT_ONLY), max_position_size (blocks new entries when position_qty_ >= cap), max_drawdown (+_is_pct_, halts on peak-to-trough drawdown crossing abs $ or % of peak equity), max_intraday_loss (+_is_pct_, halts on running intraday P&L; day boundary uses month/day-of-month, not session), max_cons_loss_days (halts after N consecutive losing days), and max_intraday_filled_orders (skips fills past the per-day cap; counter resets on new day-of-year).\n\nRisk halt is one-way: once risk_halted_ is set, no new entries are accepted for the rest of the run. The reason this topic is partial rather than supported: the summary table marks Strategy risk as 'Partial', and critically none of these risk fields are exposed via StrategyOverrides — its fixed override set excludes risk thresholds, so they must all be set directly by the generated subclass, with no runtime/ABI entry point for configuring them. The strategy.direction.* constants map to RiskDirection enum values.",
      supported: [
        "strategy.risk.allow_entry_in",
        "strategy.risk.max_position_size",
        "strategy.risk.max_drawdown",
        "strategy.risk.max_intraday_loss",
        "strategy.risk.max_cons_loss_days",
        "strategy.risk.max_intraday_filled_orders",
        "strategy.direction.all/long/short (RiskDirection enum)",
      ],
      unsupported: [
        "No StrategyOverrides / C-ABI entry point for any risk field (must be set in generated subclass)",
        "Risk thresholds not configurable at runtime via strategy_set_override",
      ],
    },
    {
      id: "inputs",
      title: "Inputs",
      status: "supported",
      summary:
        "All input.* kinds work via a string injection map plus typed getters; only UI metadata is dropped.",
      detail:
        "Inputs are stored as a std::unordered_map<std::string,std::string> on BacktestEngine. Generated code reads them through typed getters (get_input_double / _int / _bool / _string) that fall back to the Pine default on a missing key or parse failure. get_input_bool accepts \"true\"/\"1\" and \"false\"/\"0\" (anything else returns the default); the numeric getters route through std::stod / std::stoi with try/catch. The runtime is agnostic about the input *kind* — every input.* variant (float, int, bool, string, source, color, timeframe, enum, price, session, symbol, text_area, time) is presented as a string and the call-site getter decides the parse. The C ABI exposes strategy_set_input to override a value before run(...); internally this is set_input(key, value) / clear_inputs() on BacktestEngine. All 14 input.* functions are classified Runtime in the detail audit. UI metadata (group, inline, tooltip, display, confirm, options, min/max/step) has no runtime backing and is the consumer's problem.",
      supported: [
        "input()",
        "input.float()",
        "input.int()",
        "input.bool()",
        "input.string()",
        "input.source()",
        "input.color()",
        "input.timeframe()",
        "input.enum()",
        "input.session()",
        "input.symbol()",
        "input.price()",
        "input.text_area()",
        "input.time()",
        "get_input_double",
        "get_input_int",
        "get_input_bool",
        "get_input_string",
        "strategy_set_input",
      ],
      unsupported: [
        "group",
        "inline",
        "tooltip",
        "display",
        "confirm",
        "options",
        "min/max/step (UI metadata, no runtime backing)",
      ],
    },
    {
      id: "ta",
      title: "ta.*",
      status: "supported",
      summary:
        "59 ta.* functions + 8 volume ta.* series variables backed by stateful runtime classes, plus a free pivot_point_levels(); the ta.vwap 3-tuple bands form is now runtime-backed (Sprint B), with only pivot anchor/developing params left to the compiler.",
      detail:
        "ta.hpp (split across ta_moving_averages/oscillators/volatility_trend/extremes_volume/misc.cpp) implements 59 official Pine v6 ta.* functions plus 8 volume ta.* series variables as stateful classes, each exposing compute(...) (advance state) and recompute(...) (re-run on the same bar without disturbing permanent history, used by the magnifier and security intrabar paths). The consumer compiler allocates one instance per call site. Coverage spans moving averages (sma, ema, rma, wma, hma, vwma, alma, swma), oscillators/momentum (rsi, stoch, cci, mfi, mom, roc, cmo, tsi, wpr, cog, tr, atr, rci), bands/widths (bb, kc, bbw, kcw), trend/pivots (supertrend, dmi, sar, pivothigh, pivotlow), cross/state machines (crossover, crossunder, cross, rising, falling, barssince, valuewhen, change), windowed stats (stdev, variance, median, mode, range, dev, highest, lowest, percentrank, correlation, linreg), volume series variables (obv, accdist, nvi, pvi, pvt, wad, wvad, iii) and ta.vwap. ta.vwap now has both overloads: the single-value VWAP class and the 3-tuple VWAPBands class (VWAPBandsResult{vwap,upper,lower}, running variance via cum_pv_sq_) added in Sprint B for ta.vwap(src, anchor, stdev_mult).",
      supported: [
        "ta.sma",
        "ta.ema",
        "ta.rsi",
        "ta.atr",
        "ta.macd",
        "ta.bb",
        "ta.kc",
        "ta.supertrend",
        "ta.dmi",
        "ta.sar",
        "ta.stoch",
        "ta.linreg",
        "ta.vwap",
        "ta.vwap 3-tuple bands (src, anchor, stdev_mult)",
        "ta.obv",
        "ta.accdist",
        "ta.tr",
        "ta.pivothigh",
        "ta.pivotlow",
        "pivot_point_levels()",
      ],
      unsupported: [
        "ta.obv() and other parenthesized series-variable call forms — rejected by support checker (not Pine v6 functions)",
        "ta.change with bool source — runtime is numeric-only, compiler casts bool to 0.0/1.0",
        "Woodie pivot anchor/developing params (period open not received by free fn; close-based fallback used)",
        "strategy.*trades.direction(...) accessors (no such Pine v6 accessor; rejected)",
      ],
    },
    {
      id: "math",
      title: "math.*",
      status: "via_transpiler",
      summary:
        "Runtime backs only pine_random and rolling math::Sum; every other math.* (abs, sqrt, trig, min/max, round, constants) is emitted inline by the transpiler.",
      detail:
        "math.hpp/math.cpp own exactly two pieces: pine_random(...), a deterministic SplitMix64-style mixer that is stable across platforms/runs but is NOT TradingView's PRNG (math.random maps here, with no byte-for-byte TV parity); and math::Sum(length), a rolling-window sum backing math.sum(source, length) where NaN inputs short-circuit to NaN. math.round_to_mintick also maps to BacktestEngine::round_to_mintick. Everything else in the math namespace is the consumer compiler's responsibility — the transpiler emits it inline against <cmath> or simple expressions: math.abs/sqrt/pow/exp/log/log10/ceil/floor/round/sin/cos/tan/asin/acos/atan, math.min/max/avg/sign/todegrees/toradians, and the constants math.pi (M_PI), math.e (M_E), math.phi (inline literal), math.rphi (inline literal). So most scalar math.* works end-to-end despite having no dedicated runtime module.",
      supported: [
        "math.random (pine_random, SplitMix64, not TV-exact)",
        "math.sum (math::Sum class)",
        "math.round_to_mintick (BacktestEngine::round_to_mintick)",
        "math.abs (transpiler)",
        "math.sqrt (transpiler)",
        "math.pow (transpiler)",
        "math.min/math.max (transpiler)",
        "math.sin/cos/tan (transpiler)",
        "math.pi/math.e/math.phi/math.rphi (transpiler constants)",
      ],
      unsupported: [
        "TradingView-exact PRNG parity for math.random (out of scope by design — determinism preferred over TV byte-parity)",
      ],
    },
    {
      id: "str",
      title: "str.*",
      status: "partial",
      summary:
        "Five str.* helpers have dedicated runtime backing; the rest (length, contains, replace, lower/upper, tonumber, etc.) are emitted inline by the transpiler.",
      detail:
        "str_utils.hpp/str_utils.cpp own five helpers: pine_str_format ({N} placeholder substitution, all occurrences replaced), pine_str_format_time (Pine tokens yyyy/MM/dd/HH/mm/ss mapped to strftime; UTC via gmtime_r, otherwise swaps TZ under pine_tz::ScopedTimezone with localtime_r), pine_str_match (first capture group or full match; empty on no match/regex error), pine_str_split (vector<string>; empty separator yields {source}), and pine_str_tostring (NaN renders \"NaN\"; modes mintick/percent/volume, default falls back to std::to_string). pine_enum_str_at (in engine.hpp) backs str.tostring(<enum_member>) with index clamping.\n\nThe topic is partial at the runtime layer because all other string operations have no runtime API — the transpiler emits them inline against std::string: str.length, str.contains, str.replace/replace_all, str.lower/upper, str.tonumber, str.substring, str.startswith/endswith, str.pos, str.repeat, str.trim. Those still run end-to-end; they just aren't runtime modules.",
      supported: [
        "str.format (pine_str_format)",
        "str.format_time (pine_str_format_time)",
        "str.match (pine_str_match)",
        "str.split (pine_str_split)",
        "str.tostring (pine_str_tostring)",
        "str.tostring(enum) via pine_enum_str_at",
      ],
      unsupported: [
        "str.length",
        "str.contains",
        "str.replace / str.replace_all",
        "str.lower / str.upper",
        "str.tonumber",
        "str.substring",
        "str.startswith / str.endswith (no runtime API — emitted inline by transpiler)",
      ],
    },
    {
      id: "request_security",
      title: "request.security()",
      status: "partial",
      summary:
        "Dedicated runtime owns same-symbol MTF security: state machine, higher-TF ratio/calendar aggregation, lookahead/gaps, and lower-TF emulation; cross-symbol and external request.* are rejected.",
      detail:
        "coverage.md marks request.security() as Partial (line 44): libpineforge.a owns the security state machine (SecurityEvalState, coverage.md line 460), ratio/calendar aggregation via TimeframeAggregator, lookahead/gaps semantics, lower-TF emulation, and per-security diagnostics. The generated subclass drives it through configure_security_evaluators()/register_security_eval(...), evaluate_security(...), and clear_security(...) (lines 480-482). Higher-TF requests route bars through the aggregator: on a complete bar eval_complete_count++; on a partial bar under lookahead_on eval_partial_count++ with is_complete=false; on a partial bar under gaps_on clear_security (lines 492-495). The detail doc (line 657) classifies request.security() itself as Runtime (same-symbol MTF + higher-TF aggregation).\n\nrequest.security_lower_tf() is also Runtime-supported (detail line 658) via synthesize_lower_tf_bars, returning an earliest-to-latest array (coverage.md lines 507-510), but only for same-symbol intraday lower TFs that satisfy supports_lower_tf_emulation: both input and requested are fixed intraday minute strings (no D/W/M/S suffix), requested<input, and input_seconds % requested_seconds == 0 (lines 499-501). Lower-TF emulation rejects lookahead_on/gaps_on (ensure_supported_lower_tf_emulation_flags throws; it is lookahead_off/gaps_off only, lines 503-505). Only numeric and bool element arrays are supported; tuple/UDT/color/string element arrays are rejected by the transpiler (lines 510-512).\n\nThe 'Partial' status reflects that cross-symbol securities are not modelled (only same-symbol) and the external request.* variants are rejected at transpile. coverage.md's narrative (lines 769-776) names eight: request.financial, request.dividends, request.earnings, request.splits, request.currency_rate, request.economic, request.seed, request.quandl. Note: the detail doc table (line 655) additionally lists request.footprint() as Unsupported, so the full external-rejection set in that table is nine, not eight; the entry's eight-item list omits footprint (a completeness gap, but footprint is correctly not claimed as supported). barmerge.gaps_on/off and barmerge.lookahead_on/off are Runtime-backed flags on SecurityEvalState (detail lines 315-318).",
      supported: [
        "request.security",
        "request.security_lower_tf",
        "barmerge.gaps_on",
        "barmerge.gaps_off",
        "barmerge.lookahead_off",
        "barmerge.lookahead_on",
      ],
      unsupported: [
        "request.financial",
        "request.dividends",
        "request.earnings",
        "request.splits",
        "request.currency_rate",
        "request.economic",
        "request.seed",
        "request.quandl",
        "request.footprint",
        "barmerge.lookahead_on (for lower-TF emulation)",
        "cross-symbol request.security",
      ],
    },
    {
      id: "bar_magnifier",
      title: "Bar magnifier",
      status: "supported",
      summary:
        "Dedicated magnifier runtime samples the intrabar OHLC price path with six distribution modes plus optional volume-weighted sample density.",
      detail:
        "coverage.md lists Bar magnifier as Supported: OHLC-path sampling with 6 distribution modes plus optional volume-weighted sample density, implemented in magnifier.hpp/magnifier.cpp. The MagnifierDistribution enum exposes UNIFORM (equal arc-length spacing), COSINE (Chebyshev-like endpoint density), TRIANGLE (segment-midpoint density), ENDPOINTS (default; always exact O,H,L,C with uniform fill), FRONT_LOADED (density near O), and BACK_LOADED (density near C).\n\nsample_price_path(bar, n, dist) emits at least 2 points, always exactly O first and C last, with the middle leg O->H->L->C when open is closer to high else O->L->H->C (ties low-first). sample_price_path_volume_weighted(...) scales the sample count by bar.volume/mean_volume clamped to [min,max] (default 2..64); BacktestEngine::run_magnified_bar precomputes per-bar mean volume, and the toggle is set_magnifier_volume_weighted(bool) (C ABI: strategy_set_magnifier_volume_weighted).\n\nInside run_magnified_bar the engine threads every sub-bar, calls feed_security_eval_state once per sub-bar so security state machines see the fine bars, and forces is_first_tick_ true on the last sample of the last sub-bar so on_bar advances series history exactly once per script bar. The magnifier is configured via the TF-aware run(...) overloads (bar_magnifier, magnifier_samples, magnifier_dist) and run_backtest_full.",
      supported: [
        "MagnifierDistribution (UNIFORM, COSINE, TRIANGLE, ENDPOINTS, FRONT_LOADED, BACK_LOADED)",
        "sample_price_path",
        "sample_price_path_volume_weighted",
        "set_magnifier_volume_weighted",
        "run_magnified_bar",
        "strategy_set_magnifier_volume_weighted",
      ],
      unsupported: [],
    },
    {
      id: "time_session_timezone",
      title: "Time / session / timezone",
      status: "supported",
      summary:
        "Dedicated session_time runtime implements pine_time/pine_time_close with session filtering plus session.* state and a mutex-guarded ScopedTimezone for thread-safe TZ formatting.",
      detail:
        "coverage.md lists Time/session/timezone as Supported: pine_time / pine_time_close with session filtering and a mutex-guarded pine_tz::ScopedTimezone, in session_time.hpp/session_time.cpp (timezone.cpp internal, not in the public include path). pine_time(bar_ms, tf, session, tz, chart_tf) and pine_time_close(...) return Unix milliseconds, or na<int64_t>() when the bar is outside the requested session (matching TradingView's filtered-session semantics); they parse session strings and convert timezones internally. The detail doc classifies time and time_close as Runtime in both var forms (current_bar_.timestamp / pine_time_close) and 1-arg fn forms (pine_time / pine_time_close), along with the 1-arg date/time functions hour(), minute(), second(), dayofmonth(), dayofweek(), month(), weekofyear(), year() (all Runtime).\n\nThe session.* variables are Runtime-backed (Sprint A): session.ismarket, session.ispremarket (0400-RTH_open local), session.ispostmarket (RTH_close-2000 local), and session.isfirstbar/islastbar with per-bar lookahead in engine_run.cpp. session.isfirstbar_regular/islastbar_regular are Runtime but aliased to the non-regular forms because the engine carries a single session string and cannot distinguish RTH vs ETH (documented limitation). time_tradingday is also Runtime (Sprint G1; derives session-day open in syminfo_.timezone with DST-edge fallback). session.regular/session.extended are emitted as string constants by the transpiler.\n\npine_tz::ScopedTimezone(tz) is RAII: it grabs a process-wide mutex, swaps the TZ env var (saving/restoring the prior value), and releases on destruction. This is the only reason pine_str_format_time and the session helpers are thread-safe in a multi-strategy harness. Empty / 'UTC' / 'Etc/UTC' use gmtime_r; other zones swap TZ under ScopedTimezone and use localtime_r. timenow is unsupported (no live clock; always na in batch mode).",
      supported: [
        "pine_time / time",
        "pine_time_close / time_close",
        "session.ismarket",
        "session.ispremarket",
        "session.ispostmarket",
        "session.isfirstbar",
        "session.islastbar",
        "time_tradingday",
        "pine_tz::ScopedTimezone",
        "hour/minute/dayofweek/year (1-arg forms)",
      ],
      unsupported: [
        "timenow",
        "session.isfirstbar_regular vs isfirstbar (Runtime but aliased, no RTH/ETH distinction)",
      ],
    },
    {
      id: "timeframe_parsing",
      title: "Timeframe parsing",
      status: "supported",
      summary:
        "Dedicated timeframe runtime parses TF strings, computes ratios, detects calendar/TF boundaries, auto-detects TF, and aggregates via TimeframeAggregator (passthrough/ratio/calendar).",
      detail:
        "coverage.md lists Timeframe parsing as Supported: tf_to_seconds, tf_ratio, tf_change, detect_timeframe, calendar boundary detection, and TimeframeAggregator (passthrough/ratio/calendar) in timeframe.hpp/timeframe.cpp. tf_to_seconds(tf) covers minute strings ('1','5','60','240',...), day strings ('D','1D'->86400) and week strings ('W','1W'->604800); month ('M','1M') returns -1 to flag calendar mode. Inline predicates tf_multiplier and tf_is_intraday/_daily/_weekly/_monthly/_seconds back the timeframe.* variables.\n\ntf_ratio(input_tf, target_tf) returns >1 for ratio aggregation, 1 for same TF, -1 for calendar (month), and -2 when target is finer than input. detect_timeframe(bars, n, max_samples=100) infers a TV-style TF string from median timestamp deltas (fallback '1' on insufficient/irregular data). tf_change(prev_ms,curr_ms,tf) and crosses_boundary(prev_ms,curr_ms,period) provide TF/calendar boundary detection. TimeframeAggregator runs in PASSTHROUGH (default ctor), RATIO (ctor (int ratio) -> every ratio input bars produce one output bar), and CALENDAR (ctor (target_tf,input_tf) -> day/week/month boundaries) modes, with feed(bar) returning AggregatedBar{Bar bar; bool is_complete; int sub_bar_count;}.\n\nThe detail doc marks timeframe.change() (tf_change), timeframe.in_seconds() (tf_to_seconds), timeframe.period, .multiplier, .main_period, and the timeframe.is* predicates as Runtime. timeframe.from_seconds() is Transpiler-emitted (inverse of tf_to_seconds), and timeframe.isticks is a constant false via the transpiler since the engine has no tick-TF support.",
      supported: [
        "tf_to_seconds / timeframe.in_seconds",
        "tf_ratio",
        "tf_change / timeframe.change",
        "detect_timeframe",
        "TimeframeAggregator (PASSTHROUGH/RATIO/CALENDAR)",
        "timeframe.period",
        "timeframe.multiplier",
        "timeframe.main_period",
        "timeframe.isintraday/isdaily/isweekly/ismonthly/isseconds",
      ],
      unsupported: [
        "timeframe.isticks (constant false; no tick TF)",
        "timeframe.from_seconds (transpiler-emitted, not a runtime module)",
      ],
    },
    {
      id: "numeric_matrices",
      title: "Numeric matrices",
      status: "supported",
      summary:
        "PineMatrix wraps Eigen::MatrixXd with a full member surface (construction, access, transforms, linear algebra, predicates); element type fixed to double.",
      detail:
        "The runtime owns `PineMatrix` (header `matrix.hpp`, impl `matrix.cpp`), an Eigen-backed double matrix. Construction is via static `new_(rows, cols, init_val=0)`. Access/structure ops cover `get/set/fill/row/col/rows/columns`, `add_row/add_col/remove_row/remove_col/swap_rows/swap_columns`, plus transforms `copy/submatrix/reshape/reverse/transpose/sort(column, ascending)/concat`.\n\nNumeric capability is the distinguishing feature: aggregation (`avg/min/max/mode/sum`), arithmetic (`diff/mult/pow`), full linear algebra (`det/inv/pinv/rank/trace/eigenvalues/eigenvectors`), `kron`, `elements_count`, and predicates (`is_square/is_identity/is_diagonal/is_antidiagonal/is_symmetric/is_antisymmetric/is_triangular/is_stochastic/is_binary/is_zero`). The per-identifier audit classifies all 44 `matrix.*` functions as Runtime, with numeric methods (det, inv, pinv, eigenvalues, eigenvectors) float-only. `order.ascending`/`order.descending` are Runtime constants used by `matrix.sort`.\n\nThe element type is fixed to double; non-double element matrices fall to the separate typed-matrix template (PineGenericMatrix), which covers int/bool/string/color/UDT element types but with structural ops only. UDT-typed numeric matrices are not runtime-supported.",
      supported: [
        "matrix.new",
        "matrix.det",
        "matrix.inv",
        "matrix.pinv",
        "matrix.eigenvalues",
        "matrix.eigenvectors",
        "matrix.kron",
        "matrix.transpose",
        "matrix.sort",
        "order.ascending",
        "order.descending",
      ],
      unsupported: ["UDT-element numeric matrices (numeric methods stay double-only)"],
    },
    {
      id: "typed_matrices",
      title: "Typed matrices",
      status: "supported",
      summary:
        "PineGenericMatrix<T> header-only template gives structural matrix ops for int/bool/string/color/UDT element types; no numeric methods.",
      detail:
        "`PineGenericMatrix<T>` (header-only, `include/pineforge/generic_matrix.hpp`) is a template over `std::vector<std::vector<T>>` (with T=bool specialized to `vector<vector<char>>`) covering non-double element types: int, bool, string, color, and UDT. The per-identifier audit (detail doc line 615) shows `matrix.new<type>()` dispatching `<float>` to `PineMatrix` and all other types to `PineGenericMatrix<T>`.\n\nUDT element types are genuinely runtime-supported: the source template instantiates over arbitrary structs, and `tests/test_generic_matrix_udt.cpp` exercises a `Pivot` UDT through new/get/set/add_row/row/submatrix/transpose/reshape plus strong-exception-guarantee paths. Note the coverage.md sentence 'UDT-typed matrices are not runtime-supported' belongs to the `PineMatrix` (Eigen double) section — it means the double-only `PineMatrix` cannot hold UDTs, not that `PineGenericMatrix<UDT>` is absent.\n\nThe support is structural only: add_row/remove_row/reshape/transpose and the other shape/access operations apply, but numeric methods (det, inv, pinv, eigenvalues, etc.) remain exclusively on `PineMatrix` (double). So a string/color/UDT matrix can be built, indexed, reshaped, and transposed, but cannot be inverted or have eigenvalues computed. (sort is also restricted: int/bool/string only on the primary template, unsupported for bool's specialization.)",
      supported: [
        "matrix.new<int>",
        "matrix.new<bool>",
        "matrix.new<string>",
        "matrix.new<color>",
        "matrix.new<UDT>",
        "add_row",
        "remove_row",
        "reshape",
        "transpose",
      ],
      unsupported: [
        "det",
        "inv",
        "pinv",
        "rank",
        "trace",
        "eigenvalues",
        "eigenvectors (all numeric methods are PineMatrix/double-only)",
      ],
    },
    {
      id: "series_history",
      title: "Series history",
      status: "supported",
      summary:
        "Series<T> header-only ring buffer implements Pine [k] history indexing with push/update/current, max_len default 500, out-of-range returns na<T>().",
      detail:
        "`Series<T>` (header-only, `series.hpp`) is a generic deque/ring buffer that implements Pine's `[k]` history semantics. `push(value)` records a new bar (newest at front); `update(value)` overwrites the current bar (used for magnifier intrabar); `operator[](k)` returns 0=current, k>=1 = k bars ago; `current()`, `size()`, and `clear()` round it out.\n\n`max_len` defaults to 500. Out-of-range or negative offsets return `na<T>()`. In the magnifier path the engine forces `is_first_tick_` true on the last sample of the last sub-bar so generated `on_bar(...)` advances series history exactly once per script bar. The audit classifies the `series` type keyword as Runtime, backed by this ring buffer.",
      supported: [
        "series",
        "Series<T>::push",
        "Series<T>::update",
        "operator[k] history indexing",
        "current",
        "size",
        "clear",
      ],
      unsupported: ["out-of-range/negative [k] returns na (not an error)"],
    },
    {
      id: "color",
      title: "Color",
      status: "supported",
      summary:
        "pine_color holds 17 named ARGB constants plus new_color, r, g, b, t helpers; no charting/drawing types.",
      detail:
        "The runtime owns color via `color.hpp` (header-only): 17 named ARGB constants in `pine_color::*` (aqua, black, blue, fuchsia, gray, green, lime, maroon, navy, olive, orange, purple, red, silver, teal, white, yellow). Helpers: `new_color(c, transp)` clears alpha and packs `(100 - transp) * 2.55` into the high byte; `r(c)/g(c)/b(c)` return channel bytes; `t(c)` recovers transparency (0-100) from the alpha byte.\n\nIn the per-identifier audit, `color.new()`, `color.r/g/b/t()`, and `color()` are Runtime; `color.rgb()` is Transpiler-emitted (inline ARGB assembly) and `color.from_gradient()` is Unknown (no runtime gradient function). There are no charting or drawing types in the runtime.",
      supported: [
        "color (type)",
        "color.new",
        "color.r",
        "color.g",
        "color.b",
        "color.t",
        "17 color.* named constants",
      ],
      unsupported: [
        "color.from_gradient (no runtime gradient)",
        "drawing/charting color types",
      ],
    },
    {
      id: "na",
      title: "`na` / `is_na`",
      status: "supported",
      summary:
        "na.hpp provides generic na<T>() generators and is_na(...) checks for double (NaN), int/int64 (INT_MIN), and bool (false).",
      detail:
        "The runtime owns `na` via `na.hpp` (header-only). `na<T>()` generates the sentinel per type: double -> NaN, int/int64_t -> INT_MIN, bool -> false. `is_na(double)` uses `std::isnan`; an integer overload checks `== INT_MIN`. These sentinels are used throughout the runtime (e.g. out-of-range `Series[k]`, absent pivot levels, `margin_liquidation_price()`, na-accepted syminfo fields).\n\nIn the per-identifier audit, both the `na` variable/fn and the `na()` function form map to `na<T>()` in `na.hpp` (Runtime). Related helpers `nz()` (`is_na(x) ? 0.0 : x`) and `fixnan()` (`is_na(x) ? prev : x`) are Transpiler-emitted inline rather than runtime classes.",
      supported: [
        "na",
        "na()",
        "is_na",
        "na<double>() NaN",
        "na<int>()/na<int64_t>() INT_MIN",
        "na<bool>() false",
      ],
      unsupported: [
        "nz() (transpiler-inlined, not a runtime module)",
        "fixnan() (transpiler-inlined)",
      ],
    },
    {
      id: "logging_errors",
      title: "Logging / runtime errors",
      status: "supported",
      summary:
        "Dedicated header-only log.hpp runtime fully backs log.info/warning/error and runtime.error (which throws std::runtime_error).",
      detail:
        "The coverage.md summary table lists Logging / runtime errors as Supported, owned by libpineforge.a. log.hpp exposes four inline functions: pine_log_info, pine_log_warning, pine_log_error (each writing to stderr with [INFO]/[WARN]/[ERROR] prefixes) and pine_runtime_error, which throws std::runtime_error. The detail doc maps the Pine identifiers log.info() -> pine_log_info(), log.warning() -> pine_log_warning(), log.error() -> pine_log_error(), and runtime.error() -> pine_runtime_error(), all marked Runtime.\n\nThe runtime additionally raises std::runtime_error itself from validate_security_timeframes, feed_security_eval_state (lower-TF synthesis failure), and ensure_supported_lower_tf_emulation_flags. The one logging-adjacent gap is the @strategy_alert_message annotation, which is parse-and-skip (alert template, no runtime), but that belongs to the alert surface rather than the log namespace.",
      supported: [
        "log.info",
        "log.warning",
        "log.error",
        "runtime.error",
        "pine_log_info",
        "pine_log_warning",
        "pine_log_error",
        "pine_runtime_error",
      ],
      unsupported: [
        "@strategy_alert_message (parse-and-skip; alert template, not part of log namespace)",
      ],
    },
    {
      id: "arrays_maps_udts",
      title: "Arrays / maps / UDTs",
      status: "via_transpiler",
      summary:
        "No runtime array/map/UDT module exists; PineForge's transpiler emits them inline as std::vector, std::unordered_map, and generated C++ structs, so they work end-to-end.",
      detail:
        "coverage.md flags this category as 'No runtime module (Pine surface still supported via consumer compiler)'. The runtime ships no array.hpp / map.hpp / UDT module; its only generic value containers are Series<T> (history), PineMatrix (numeric matrices), and PineGenericMatrix<T> (typed matrices). Pine arrays/maps/UDTs themselves still work in PineForge because the transpiler emits array<T> as std::vector<T>, map<K,V> as std::unordered_map<K,V>, and UDTs (including nested fields and array<UDT>) as plain C++ structs.\n\nThe detail doc confirms this: the array type, map type, all 54 array.* functions, and all 11 map.* functions are tagged Transpiler (no runtime module). The type and method keywords are Transpiler-handled for UDT struct/method generation. array.sort/sort_indices use std::sort; array.from is supported. order.ascending/order.descending are Runtime (used by array.sort and PineMatrix::sort).\n\nGaps to note: drawing-type arrays (array.new_label/line/box/table, etc.) are parsed but the underlying drawing ops are skipped, since there is no drawing runtime. request.security_lower_tf returns arrays of numeric/bool elements only; tuple, UDT, color, and string element arrays are rejected by the transpiler.",
      supported: [
        "array (type)",
        "array.new",
        "array.from",
        "array.sort",
        "array.sort_indices",
        "map (type)",
        "map.* (11 fns)",
        "type (UDT struct gen)",
        "method (UDT method gen)",
        "order.ascending",
        "order.descending",
        "matrix (PineMatrix / PineGenericMatrix runtime)",
      ],
      unsupported: [
        "array.new_label/line/box/table/linefill (drawing-type arrays: container works, drawing ops skipped)",
        "request.security_lower_tf tuple/UDT/color/string element arrays (transpiler-rejected)",
      ],
    },
    {
      id: "drawing_plotting_alerts",
      title: "Drawing / plotting / alerts",
      status: "unsupported",
      summary:
        "No charting/drawing/alert runtime exists; the transpiler parses-and-skips these so strategies still compile and run, but no visual side-effects or live alerts are emitted.",
      detail:
        "coverage.md lists Drawing / plotting / alerts as 'No runtime module' and states explicitly that no charting/drawing/alert types exist in the runtime; PineForge's transpiler parses-and-skips them so the strategy still compiles and runs, but no visual side-effects are produced. This is by design: PineForge is an offline backtesting engine, not a renderer, so visual/charting/alert APIs are out of scope regardless of consumer.\n\nThe detail doc tags the whole surface parse-and-skip: plot, plotshape, plotchar, plotcandle, plotbar, plotarrow (compile, no visual output); fill, hline, bgcolor, barcolor; the box, label, line, linefill, polyline, table drawing types and all their methods (e.g. label.* 20 fns, line.* 20 fns, box.* 27 fns); their .all collection variables; and the drawing/plotting style constants (label.style_* 22, line.style_* 6, plot.style_* 12, shape.*, location.*, extend.*, size.*, position.*, xloc.*, yloc.*). chart.point and its methods are parse-and-skip chart geometry.\n\nAlerts are the same: alert() and alertcondition() are parse-and-skip (parsed, no live emission); alert.freq_all/freq_once_per_bar/freq_once_per_bar_close constants and the @strategy_alert_message annotation are parse-and-skip. The forward-looking note rates plotting primitives as 'Feasible' via a future report-as-data path, but live alert() is 'Out of scope structurally' because PineForge produces no realtime stream. indicator() is also parse-and-skip since the engine is strategy-only.",
      supported: [],
      unsupported: [
        "plot",
        "plotshape",
        "plotchar",
        "plotcandle",
        "plotbar",
        "plotarrow",
        "fill",
        "hline",
        "bgcolor",
        "barcolor",
        "label.new",
        "line.new",
        "box.new",
        "table.*",
        "polyline.*",
        "linefill.*",
        "chart.point.*",
        "alert",
        "alertcondition",
        "alert.freq_* constants",
        "@strategy_alert_message",
        "indicator",
      ],
    },
  ],
  prefix_map: {
    "ta.": "ta",
    "math.": "math",
    "str.": "str",
    "request.": "request_security",
    "barmerge.": "request_security",
    "strategy.": "strategy_orders",
    "strategy.risk.": "strategy_risk",
    "strategy.direction.": "strategy_risk",
    "strategy.closedtrades.": "strategy_state",
    "strategy.opentrades.": "strategy_state",
    "input.": "inputs",
    "matrix.": "numeric_matrices",
    "array.": "arrays_maps_udts",
    "map.": "arrays_maps_udts",
    "color.": "color",
    "timeframe.": "timeframe_parsing",
    "session.": "time_session_timezone",
    "log.": "logging_errors",
    "runtime.": "logging_errors",
    "order.": "arrays_maps_udts",
    "barstate.": "strategy_state",
    "chart.": "drawing_plotting_alerts",
    "label.": "drawing_plotting_alerts",
    "line.": "drawing_plotting_alerts",
    "box.": "drawing_plotting_alerts",
    "table.": "drawing_plotting_alerts",
    "polyline.": "drawing_plotting_alerts",
    "linefill.": "drawing_plotting_alerts",
    "alert.": "drawing_plotting_alerts",
  },
  alias_map: {
    alert: "drawing_plotting_alerts",
    alertcondition: "drawing_plotting_alerts",
    plot: "drawing_plotting_alerts",
    plotshape: "drawing_plotting_alerts",
    plotchar: "drawing_plotting_alerts",
    plotcandle: "drawing_plotting_alerts",
    plotbar: "drawing_plotting_alerts",
    plotarrow: "drawing_plotting_alerts",
    hline: "drawing_plotting_alerts",
    fill: "drawing_plotting_alerts",
    bgcolor: "drawing_plotting_alerts",
    barcolor: "drawing_plotting_alerts",
    label: "drawing_plotting_alerts",
    line: "drawing_plotting_alerts",
    box: "drawing_plotting_alerts",
    table: "drawing_plotting_alerts",
    polyline: "drawing_plotting_alerts",
    linefill: "drawing_plotting_alerts",
    indicator: "drawing_plotting_alerts",
    array: "arrays_maps_udts",
    map: "arrays_maps_udts",
    matrix: "numeric_matrices",
    series: "series_history",
    color: "color",
    na: "na",
    is_na: "na",
    nz: "na",
    fixnan: "na",
    input: "inputs",
    strategy: "strategy_orders",
    time: "time_session_timezone",
    time_close: "time_session_timezone",
    timenow: "time_session_timezone",
    hour: "time_session_timezone",
    minute: "time_session_timezone",
    second: "time_session_timezone",
    dayofweek: "time_session_timezone",
    dayofmonth: "time_session_timezone",
    month: "time_session_timezone",
    year: "time_session_timezone",
    weekofyear: "time_session_timezone",
    barstate: "strategy_state",
    request: "request_security",
    library: "engine_lifecycle",
    import: "engine_lifecycle",
    export: "engine_lifecycle",
  },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

export interface CoverageIndexEntry {
  id: string;
  title: string;
  status: CoverageStatus;
  summary: string;
}

export interface CoverageIndexResult {
  coverage_version: string;
  legend: Record<string, string>;
  topics: CoverageIndexEntry[];
}

/**
 * Lightweight index of every coverage topic — id/title/status/summary only,
 * with the legend and version. Strips the heavy detail/supported/unsupported
 * fields so it stays cheap to return.
 */
export function coverageIndex(): CoverageIndexResult {
  return {
    coverage_version: COVERAGE.coverage_version,
    legend: COVERAGE.legend,
    topics: COVERAGE.topics.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      summary: t.summary,
    })),
  };
}

export interface CoverageTopicErrorResult {
  error: string;
  query: string;
  valid_ids: string[];
}

/**
 * Full topic object for a given id. On an unknown id returns an error marker
 * listing the valid ids (rather than throwing) so the tool surface degrades
 * gracefully.
 */
export function coverageTopic(id: string): CoverageTopic | CoverageTopicErrorResult {
  const topic = COVERAGE.topics.find((t) => t.id === id);
  if (topic) return topic;
  return {
    error: `Unknown coverage topic id '${id}'.`,
    query: id,
    valid_ids: COVERAGE.topics.map((t) => t.id),
  };
}

export interface CheckPineFeatureResult {
  query: string;
  status: CoverageStatus | "not_found";
  topic?: string;
  note: string;
}

/**
 * Resolve an arbitrary Pine identifier / namespace to a coverage status.
 *
 * Resolution order:
 *   1. Exact identifier match in any topic's supported[] / unsupported[]:
 *      a hit in unsupported[] => "unsupported"; a hit in supported[] => that
 *      topic's own status (so a feature listed under a `partial` topic reports
 *      `partial`, etc.).
 *   2. Longest matching namespace prefix in prefix_map => that topic's status.
 *   3. Exact key in alias_map => that topic's status.
 *   4. Otherwise { status: "not_found" }.
 */
const FEATURE_IDENT = /^[A-Za-z_][A-Za-z0-9_.]*\*?$/;

/**
 * Identifier tokens inside a supported[]/unsupported[] entry, ignoring
 * parenthetical notes and compound "a / b / c" lists. So
 * "strategy.cancel / strategy.cancel_all" yields both ids, and
 * "barmerge.lookahead_on (for lower-TF emulation)" yields just the id.
 */
function entryIdentifiers(entry: string): string[] {
  return entry
    .replace(/\([^)]*\)/g, " ")
    .split(/[\s/,]+/)
    .map((s) => s.replace(/\(\)$/, "").trim())
    .filter((s) => s.length > 0 && FEATURE_IDENT.test(s));
}

/** Normalize a lookup query for exact comparison (drop a trailing "()"). */
function normalizeFeatureQuery(q: string): string {
  return q.replace(/\(\)$/, "").trim();
}

export function checkPineFeature(feature: string): CheckPineFeatureResult {
  const query = feature;
  const q = normalizeFeatureQuery(query);

  // (1) Exact identifier match in supported[] / unsupported[].
  for (const t of COVERAGE.topics) {
    if (t.unsupported.some((e) => entryIdentifiers(e).includes(q))) {
      return {
        query,
        status: "unsupported",
        topic: t.id,
        note: `'${query}' is listed as unsupported under topic '${t.id}' (${t.title}).`,
      };
    }
    if (t.supported.some((e) => entryIdentifiers(e).includes(q))) {
      return {
        query,
        status: t.status,
        topic: t.id,
        note: `'${query}' is listed as supported under topic '${t.id}' (${t.title}), whose overall status is '${t.status}'.`,
      };
    }
  }

  // (2) Longest namespace prefix in prefix_map.
  let bestPrefix: string | undefined;
  for (const prefix of Object.keys(COVERAGE.prefix_map)) {
    if (query.startsWith(prefix)) {
      if (bestPrefix === undefined || prefix.length > bestPrefix.length) {
        bestPrefix = prefix;
      }
    }
  }
  if (bestPrefix !== undefined) {
    const topicId = COVERAGE.prefix_map[bestPrefix]!;
    const t = COVERAGE.topics.find((x) => x.id === topicId);
    const status = t ? t.status : "not_found";
    return {
      query,
      status,
      topic: topicId,
      note:
        `'${query}' resolved by namespace prefix '${bestPrefix}' to topic '${topicId}'` +
        (t ? ` (${t.title}), overall status '${t.status}'. Call get_coverage_topic for the exact supported/unsupported lists.` : "."),
    };
  }

  // (3) Exact alias_map key.
  const aliasTopicId = COVERAGE.alias_map[query];
  if (aliasTopicId !== undefined) {
    const t = COVERAGE.topics.find((x) => x.id === aliasTopicId);
    const status = t ? t.status : "not_found";
    return {
      query,
      status,
      topic: aliasTopicId,
      note:
        `'${query}' resolved by alias to topic '${aliasTopicId}'` +
        (t ? ` (${t.title}), overall status '${t.status}'. Call get_coverage_topic for the exact supported/unsupported lists.` : "."),
    };
  }

  // (4) Miss.
  return {
    query,
    status: "not_found",
    note:
      `'${query}' did not match any known Pine identifier, namespace prefix, or alias. ` +
      `Call list_coverage_topics to browse all topics, or check the spelling / namespace.`,
  };
}
