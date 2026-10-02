/**
 * PineForge Pine v6 coverage dataset — hand-authored canonical copy.
 *
 * Data sourced from pineforge-engine docs/coverage.md +
 * docs/pine_v6_coverage_detail.md and pineforge-codegen's README + CHANGELOG, at
 * the release tags named in coverage_version, and embedded here as a TS object
 * literal (no runtime fetch). This is the single source the MCP coverage tools
 * serve. Every status is scoped to what a backtest on this server can do: the
 * server installs no other symbol's bars, no recorded request data and no
 * library sources, so where the engine supports more, the entry says so.
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
  /** Works with a documented gap or restriction (see the legend). */
  partial?: string[];
  /** No runtime module; the transpiler emits it inline and it works end-to-end. */
  via_transpiler?: string[];
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
  coverage_version: "engine v1.0.1 + codegen 1.0.1 (2026-10-02)",
  legend: {
    supported:
      "Works end-to-end in a backtest on this server: libpineforge.a implements it, with the code PineForge's transpiler emits for it.",
    partial:
      "Works with a documented gap or restriction: some variants, argument types or data are refused or missing, or the value only approximates TradingView's. The entry names the gap. Where the engine supports more than this server can supply (another symbol's bars, recorded request data, library sources), the entry says so.",
    unsupported:
      "A backtest on this server cannot use it: PineForge's transpiler refuses it, the generated C++ does not compile, or it is accepted with no effect (plots, tables, alerts and visual setters).",
    via_transpiler:
      "The feature has no dedicated runtime module, but PineForge's PineScript-to-C++ transpiler emits it inline against the C++ standard library or generated structs, so it still works end-to-end.",
  },
  topics: [
    {
      id: "engine_lifecycle",
      title: "Engine / strategy lifecycle",
      status: "supported",
      summary:
        "BacktestEngine runs a strategy over its bars through one-shot run(...) overloads, the per-bar on_bar hook and cumulative reporting; calc_on_order_fills is modelled. This server runs one-shot backtests of strategy() scripts.",
      detail:
        "The generated strategy derives from source::PineStrategyHost (a NativeStrategyHost, itself a BacktestEngine) and implements on_bar(const Bar&). Three run(...) overloads are exposed: a bare (bars, n) form, a TF-aware form (input_tf/script_tf + magnifier args), and a full form that also injects a SymInfo, the input map and a StrategyOverrides struct (NaN/-1 mean leave-default). The TF-aware overload auto-detects input_tf via detect_timeframe when empty and defaults script_tf to input_tf. The engine also has a continuous historical-to-realtime stream lifecycle (strategy_stream_*); this server runs one-shot backtests only.\n\nStrategyOverrides carries a fixed set of fields: initial_capital, commission_value, default_qty_value, pyramiding, slippage, commission_type, default_qty_type, process_orders_on_close, calc_on_order_fills and close_entries_rule. Anything else (currency, margin, risk limits) is set by the generated strategy; there is no runtime entry point for it. Per-input overrides go through set_input/clear_inputs before run(...); magnifier density via set_magnifier_volume_weighted. fill_report(ReportC*) fills closed trades, bar counters, magnifier work counters, TF/aggregation diagnostics and per-security SecurityDiagC. The public header pineforge.h has 71 PF_API declarations: 62 runtime implementations and nine per-strategy generated exports.\n\ncalc_on_order_fills is modelled: the Pine adapter recalculates the script after each fill, with TradingView's script-state rollback. calc_on_every_tick is not modelled (codegen does not read it). varip is accepted: a historical bar executes once, so a varip keeps its value like var, and it is left out of the calc_on_order_fills rollback.\n\nindicator() scripts are refused: PineForge runs strategies only. A library(...) script and export in a strategy are refused. codegen inlines an imported library when it is given the library's source (transpile(..., libraries={...}) or a requests manifest); this server passes no library sources, so an import is refused, unless its alias is ta, math or str and it names only that namespace's built-ins, which is a no-op.",
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
        "calc_on_order_fills (modelled: the script recalculates after each fill, with TradingView's rollback)",
        "varip (accepted: on historical bars it keeps its value like var; left out of the calc_on_order_fills rollback)",
      ],
      unsupported: [
        "indicator() (refused: PineForge runs strategies only)",
        "library() / export (refused: PineForge transpiles strategies only)",
        "import (refused on this server, which passes codegen no library sources; an import aliased ta, math or str that names only that namespace's built-ins is a no-op)",
        "calc_on_every_tick (accepted, not modelled: codegen does not read it)",
      ],
    },
    {
      id: "strategy_orders",
      title: "Strategy orders",
      status: "supported",
      summary:
        "All strategy order commands (entry/order/exit/close/close_all/cancel/cancel_all) with OHLC-path fills, OCA, pyramiding, slippage, commissions, TradingView's margin admission and margin calls, partial and FIFO-vs-ANY closes, trailing stops and TV deferred-flip carry.",
      detail:
        "The generated strategy calls the order methods of source::PineStrategyHost: strategy_entry, strategy_order, strategy_exit, strategy_close, strategy_close_all, strategy_cancel and strategy_cancel_all. Native resting requests resolve at each native driver decision point along a 4-waypoint OHLC path (O->H->L->C or O->L->H->C, by the open's proximity to the high or the low): stop/limit priority, gap fills, opposing-stop arbitration, OCA siblings and trail levels. Slippage (ticks) and syminfo.mintick round all fills; stop entries snap to the tick in their direction (long stops up, short stops down), as on TradingView.\n\nPriced strategy.entry orders follow TradingView's deferred-flip carry: an opposite priced entry placed while a position is open, firing later from flat after a close, opens qty + the carried position qty; source order within one on_bar matters. strategy.exit reserves a slice of the open position (partial exits with the same id are one-shot per position) and takes profit/loss/limit/stop/trail_* params; the runtime does not itself require one of them. strategy.close closes FIFO by entry id (or all when empty), honours close_entries_rule ANY for partial closes, and immediately bypasses pending-order resolution.\n\nSizing uses default_qty_type (fixed, percent_of_equity, cash) and default_qty_value. A Pine v6 script that omits initial_capital, default_qty_type or default_qty_value runs with TradingView's defaults (100000, strategy.percent_of_equity, 100), which codegen 1.0.0 and later declare in the generated constructor. Commission is percent, cash per order or cash per contract. Margin uses margin_long/margin_short percentages (100 = no leverage): the Pine adapter admits an opening by TradingView's money rule and books TradingView's margin calls through a maintenance-only margin model. strategy.convert_to_account and strategy.convert_to_symbol have no runtime feed: the transpiler treats them as identity (no FX adjustment). strategy.default_entry_qty transpiles, but codegen 1.0.1's C++ for it does not compile.",
      supported: [
        "strategy.entry",
        "strategy.order",
        "strategy.exit",
        "strategy.close",
        "strategy.close_all",
        "strategy.cancel / strategy.cancel_all",
        "strategy.oca.* / strategy.commission.*",
        "strategy.long / strategy.short",
        "strategy.fixed / strategy.cash / strategy.percent_of_equity",
        "QtyType / CommissionType",
        "slippage / pyramiding / margin_long / margin_short / process_orders_on_close / close_entries_rule (strategy declaration arguments)",
      ],
      via_transpiler: [
        "strategy.convert_to_account / strategy.convert_to_symbol (emitted as identity: the value comes back unconverted, no FX adjustment)",
      ],
      unsupported: [
        "strategy.default_entry_qty (transpiles, but codegen 1.0.1's C++ for it does not compile)",
      ],
    },
    {
      id: "strategy_state",
      title: "Strategy state / accessors",
      status: "supported",
      summary:
        "Position, equity, drawdown and run-up tracking, win/loss counts, the closed- and open-trade accessors, strategy.margin_liquidation_price, and barstate.* flags with their backtest values.",
      detail:
        "strategy.closedtrades.* accessors: profit, profit_percent, commission, entry/exit_bar_index, entry/exit_comment, entry/exit_id, entry/exit_price, entry/exit_time, size, max_runup(_percent), max_drawdown(_percent). strategy.opentrades.* mirrors the closed set minus the four exit_* fields. Pine v6 has no closedtrades/opentrades.direction(...) accessor: direction is the sign of size (positive long, negative short), and the support checker rejects a direction(...) call.\n\nAggregate state on the engine: net_profit/gross_profit/gross_loss (and _percent), avg_trade/avg_winning_trade/avg_losing_trade (and _percent), count_wintrades/count_losstrades, current_equity, open_profit(price), open_trades_capital_held and signed_position_size. strategy.equity, netprofit, position_size, position_avg_price, max_drawdown/max_runup, max_contracts_held_* and eventrades read that state. strategy.margin_liquidation_price reads the kernel's liquidation price in TradingView's tick spelling (PineStrategyHost::margin_liquidation_price).\n\nbarstate in a backtest, where every bar is historical: isfirst is bar_index == 0; islast is true on the run's final bar; ishistory is always true; isrealtime is always false; isnew follows the first tick of a script bar and isconfirmed its last; islastconfirmedhistory is true on the run's final bar, and codegen warns that it approximates.",
      supported: [
        "strategy.closedtrades.* / strategy.opentrades.* (accessors; direction is the sign of size)",
        "strategy.equity / strategy.netprofit / strategy.grossprofit / strategy.grossloss",
        "strategy.position_size / strategy.position_avg_price",
        "strategy.max_drawdown / strategy.max_runup / strategy.max_drawdown_percent / strategy.max_runup_percent",
        "strategy.wintrades / strategy.losstrades / strategy.eventrades",
        "strategy.max_contracts_held_all / strategy.max_contracts_held_long / strategy.max_contracts_held_short",
        "strategy.margin_liquidation_price (the kernel's liquidation price in TradingView's tick spelling)",
        "current_equity / open_profit / signed_position_size",
        "barstate.isfirst / barstate.islast / barstate.ishistory / barstate.isnew / barstate.isconfirmed (backtest values: see detail)",
      ],
      partial: [
        "barstate.isrealtime (always false: every bar is historical in a backtest; codegen warns that it approximates)",
        "barstate.islastconfirmedhistory (true on the run's final bar; codegen warns that it approximates)",
      ],
      unsupported: [
        "strategy.closedtrades.direction / strategy.opentrades.direction (no such Pine v6 accessor; the support checker rejects it: use the sign of size)",
      ],
    },
    {
      id: "strategy_risk",
      title: "Strategy risk",
      status: "supported",
      summary:
        "All six strategy.risk.* limits are enforced: allow_entry_in, max_position_size, max_drawdown, max_intraday_loss, max_cons_loss_days and max_intraday_filled_orders. The script's own calls set them; none is a StrategyOverrides key.",
      detail:
        "The generated strategy declares the six limits through PineStrategyHost::set_pine_risk_* and the Pine adapter enforces them (PineExecutionAdapter::update_risk_state). allow_entry_in blocks entries against the allowed direction (strategy.direction.all/long/short). max_position_size blocks new entries when the position quantity reaches the cap. max_drawdown halts the strategy when peak-to-trough drawdown crosses the cap (absolute, or % of peak equity). max_intraday_loss halts it when the running intraday P&L crosses the cap; the day boundary uses month and day of month, not the session. max_cons_loss_days halts it after N consecutive losing days. max_intraday_filled_orders is a latch-till-day-rollover fill cap: the cap-triggering fill emits TradingView's synthetic cap-close, then every further fill (and order placement) on that chart day is dropped.\n\nThe drawdown and consecutive-loss-day halts are one-way: once either latches, no new entries are accepted for the rest of the run. None of these limits is a StrategyOverrides key, so a backtest cannot override them from outside the script.",
      supported: [
        "strategy.risk.allow_entry_in",
        "strategy.risk.max_position_size",
        "strategy.risk.max_drawdown",
        "strategy.risk.max_intraday_loss",
        "strategy.risk.max_cons_loss_days",
        "strategy.risk.max_intraday_filled_orders (latch-till-day-rollover cap-close)",
        "strategy.direction.all / strategy.direction.long / strategy.direction.short",
      ],
      unsupported: [],
    },
    {
      id: "inputs",
      title: "Inputs",
      status: "supported",
      summary:
        "Every input.* kind works: values arrive as strings through an override map and typed getters, and input.source overrides resolve native source names. UI metadata has no runtime backing.",
      detail:
        "Inputs are stored as a std::unordered_map<std::string,std::string> on the engine. Generated code reads them through typed getters (get_input_double / _int / _int64 / _bool / _string, and get_input_source) that fall back to the Pine default on a missing key or a parse failure. get_input_bool accepts \"true\"/\"1\" and \"false\"/\"0\" (anything else returns the default); the numeric getters route through std::stod / std::stoi / std::stoll with try/catch. get_input_int64 backs 64-bit payloads such as input.color (packed ARGB). get_input_source backs input.source overrides: it resolves a native source name (open, high, low, close, volume, hl2, hlc3, ohlc4, hlcc4) to the engine's source series and falls back to the codegen default when the key is absent or the override is not a native name. The runtime does not care about the input kind: every input.* value is a string and the getter at the call site decides the parse. The C ABI's strategy_set_input overrides a value before run(...). UI metadata (group, inline, tooltip, display, confirm, options, min/max/step) has no runtime backing.",
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
        "get_input_int64",
        "get_input_bool",
        "get_input_string",
        "get_input_source",
        "strategy_set_input",
      ],
      unsupported: [
        "group / inline / tooltip / display / confirm / options / min / max / step (input UI metadata: no runtime backing)",
      ],
    },
    {
      id: "ta",
      title: "ta.*",
      status: "supported",
      summary:
        "59 ta.* functions and 8 ta.* series variables backed by stateful runtime classes, plus ta.pivot_point_levels with anchor and developing, ta.vwap with any anchor and its 3-tuple bands form, and series lengths for ta.highest/lowest/highestbars/lowestbars.",
      detail:
        "ta.hpp (split across ta_moving_averages/oscillators/volatility_trend/extremes_volume/misc.cpp) implements the official Pine v6 ta.* functions and series variables as stateful classes, each exposing compute(...) (advance state) and recompute(...) (re-run on the same bar without disturbing permanent history, used by the magnifier and security paths). The transpiler allocates one instance per call site. Coverage spans moving averages (sma, ema, rma, wma, hma, vwma, alma with floor, swma), oscillators/momentum (rsi, stoch, cci, mfi, mom, roc, cmo, tsi, wpr, cog, rci, tr, atr), bands/widths (bb, kc and kcw with useTrueRange, bbw), trend/pivots (supertrend, dmi, sar, pivothigh, pivotlow), cross/state machines (crossover, crossunder, cross, change, rising, falling, barssince, valuewhen), windowed stats (stdev, variance, dev, median, mode, range, highest, lowest, highestbars, lowestbars, percentrank, percentile_nearest_rank, percentile_linear_interpolation, correlation, linreg), cumulative/chart extremes (cum, max, min), the volume series variables (obv, accdist, nvi, pvi, pvt, wad, wvad, iii) and ta.vwap.\n\nta.vwap restarts on the session day by default; any other anchor uses AnchoredVWAP, and the 3-tuple [vwap, upper, lower] = ta.vwap(src, anchor, stdev_mult) form is backed by VWAPBands / AnchoredVWAPBands. ta.pivot_point_levels(type, anchor, developing) is the stateful PivotPointLevels; Woodie with developing = true stops the run (Woodie has no developing levels). The parenthesized call form of a series variable, such as ta.obv(), is refused: it is not a Pine v6 function. ta.change takes a numeric source in the runtime; the transpiler casts a bool source to 0/1. ta.tr(handle_na) follows Pine v6's first-bar split.\n\nA length that is neither a constant nor an input: a simple length, fixed for the run, builds the indicator on the call site's first execution; a series length of ta.highest, ta.lowest, ta.highestbars or ta.lowestbars re-windows every call; ta.supertrend keeps its first execution's factor; a length of 0, a negative length or na stops the run. A series length of any other ta.* is refused.",
      supported: [
        "ta.sma",
        "ta.ema",
        "ta.rsi",
        "ta.atr",
        "ta.macd",
        "ta.bb",
        "ta.kc / ta.kcw (useTrueRange)",
        "ta.alma (floor)",
        "ta.supertrend",
        "ta.dmi",
        "ta.sar",
        "ta.stoch",
        "ta.linreg",
        "ta.vwap (session-day anchor by default, any anchor, and the 3-tuple bands form)",
        "ta.obv / ta.accdist / ta.nvi / ta.pvi / ta.pvt / ta.wad / ta.wvad / ta.iii (series variables; the call form with parentheses is refused: not a Pine v6 function)",
        "ta.tr",
        "ta.change (a bool source is cast to 0/1 by the transpiler)",
        "ta.highest / ta.lowest / ta.highestbars / ta.lowestbars (a series length re-windows every call)",
        "ta.cum / ta.max / ta.min",
        "ta.pivothigh",
        "ta.pivotlow",
        "ta.pivot_point_levels (anchor and developing; Woodie with developing = true stops the run)",
        "pivot_point_levels()",
      ],
      unsupported: [],
    },
    {
      id: "math",
      title: "math.*",
      status: "via_transpiler",
      summary:
        "The runtime backs math.random (deterministic, not TradingView's generator) and the rolling math.sum; PineForge's transpiler emits every other math.* inline, so they work end-to-end.",
      detail:
        "math.hpp/math.cpp own two pieces. pine_random(lo, call_site, hi, seed, bar_index) is a deterministic SplitMix64-style mixer, stable across platforms and runs but not TradingView's PRNG: math.random maps here, so its values differ from TradingView's (TradingView-exact PRNG parity is out of scope by design). math::Sum(length) backs math.sum(source, length): na sources are ignored, the output stays na until length non-na values exist, then holds the sum of the last length non-na values, including on na-input bars. math.round_to_mintick maps to BacktestEngine::round_to_mintick. Everything else in the math namespace is emitted inline by PineForge's transpiler against <cmath> or simple expressions: math.abs/sqrt/pow/exp/log/log10/ceil/floor/round/sign/avg/min/max/todegrees/toradians, the trig functions, and the constants math.pi, math.e, math.phi and math.rphi.",
      supported: [
        "math.sum (math::Sum: na inputs are skipped)",
        "math.round_to_mintick (BacktestEngine::round_to_mintick)",
      ],
      partial: [
        "math.random (deterministic and reproducible, but not TradingView's generator: its values differ from TradingView's)",
      ],
      via_transpiler: [
        "math.abs / math.sqrt / math.pow / math.exp / math.log / math.log10 / math.ceil / math.floor / math.round / math.sign / math.avg / math.todegrees / math.toradians",
        "math.min / math.max",
        "math.sin / math.cos / math.tan / math.asin / math.acos / math.atan",
        "math.pi / math.e / math.phi / math.rphi (constants)",
      ],
      unsupported: [],
    },
    {
      id: "str",
      title: "str.*",
      status: "supported",
      summary:
        "The runtime backs str.format, str.format_time, str.match, str.split and str.tostring; PineForge's transpiler emits the other str.* functions inline against std::string, so they work end-to-end.",
      detail:
        "str_utils.hpp/str_utils.cpp own the runtime helpers. pine_str_format and str_format_values implement MessageFormat: {N} and {N,number,<style>} placeholders (integer, percent, currency or a decimal pattern), text between single quotes is literal, and a placeholder with no such argument is kept as written; a number argument in {N} renders as #,###.###. pine_str_format_time maps Pine tokens (yyyy/MM/dd/HH/mm/ss) to strftime: empty/\"UTC\"/\"Etc/UTC\" use gmtime_r, any other zone swaps TZ under tz_util::ScopedTimezone and uses localtime_r. pine_str_match returns the first capture group, else the full match, and an empty string on no match or a regex error. pine_str_split returns a vector<string>; an empty separator yields {source}. pine_str_tostring renders the value's shortest round-trip decimal digits, rounded half-up; NaN, Infinity and -Infinity print as such; modes are the default (up to ten fraction digits), \"percent\", \"volume\" (K/M/B/T), \"mintick\", or a decimal pattern (#.##, #.00, #,###, #.##%). str.tostring(<enum member>) uses pine_enum_str_at (source/pine_policy_support.hpp), which clamps the index.\n\nEvery other string operation (str.length, str.contains, str.replace/replace_all, str.lower/upper, str.tonumber, str.substring, str.startswith/endswith, str.pos, str.repeat, str.trim) has no runtime API: PineForge's transpiler emits it inline against std::string, and it runs end-to-end. codegen warns where str.repeat's result can be na, which the engine cannot yet represent exactly.",
      supported: [
        "str.format (MessageFormat placeholders)",
        "str.format_time",
        "str.match",
        "str.split",
        "str.tostring (default, percent, volume and mintick formats, decimal patterns, enum members)",
      ],
      via_transpiler: [
        "str.length / str.contains / str.replace / str.replace_all / str.lower / str.upper / str.tonumber",
        "str.substring / str.startswith / str.endswith / str.pos / str.repeat / str.trim (emitted inline against std::string)",
      ],
      unsupported: [],
    },
    {
      id: "request_security",
      title: "request.security()",
      status: "partial",
      summary:
        "On the chart's own symbol, request.security and request.security_lower_tf run here: higher-timeframe aggregation, lookahead and gaps, and lower-timeframe emulation. On another symbol, request.security is supported by the engine, which reads that symbol's own bars installed before the run; this server cannot supply other symbols' bars, so such a request whose value can reach a trade stops the run.",
      detail:
        "Chart symbol: the runtime owns the security state machine (SecurityEvalState), ratio/calendar aggregation (TimeframeAggregator), lookahead/gaps semantics, lower-timeframe emulation and per-security diagnostics. A higher-timeframe request routes the chart's bars through the aggregator: a complete bar evaluates with is_complete=true; a partial bar evaluates under lookahead_on, clears under gaps_on, and is otherwise held until it completes. codegen warns that lookahead_on exposes the completed higher-timeframe value from the bucket's first chart bar.\n\nrequest.security_lower_tf emulates intrabars from each chart bar when both timeframes are fixed intraday minute strings (no D/W/M/S suffix), the requested one is finer and it divides the chart's evenly; the array runs earliest to latest within the chart bar. Its elements may be float, int or bool; tuple, UDT, color and string element types are refused. Emulation is lookahead_off/gaps_off only. A run fails when a request exists but the chart timeframe is unknown, when a lower timeframe cannot be emulated, or when a request.security timeframe is finer than a chart fed only its own bars.\n\nAnother symbol: supported by the engine; this server cannot supply other symbols' bars. In engine v1.0.1 a site of another symbol reads that symbol's own bars, which the host installs through the engine's C API before the run (strategy_set_symbol_feed / _feed_column / strategy_set_symbol_facts) from a feed a requests manifest pins; codegen 1.0.0 and later lower such a site onto it. This server installs no other symbol's bars, so a request on another symbol whose value can reach a trade transpiles, then stops the run where its value is read (\"... no data is pinned for this request, and its value was read\"); it never reads the chart's bars in its place. One whose value reaches only plots, alerts, tables or logs lowers to na with a warning, and trades are unaffected.\n\nThe other request.* calls: request.financial, request.earnings, request.dividends and request.splits read per-bar series that a requests manifest records, and request.footprint inside request.security reads a pinned feed's delta column. This server installs neither, so a value of theirs that can reach a trade stops the run where it is read, and one that reaches only plots, alerts, tables or logs reads na. request.economic, request.currency_rate, request.seed and request.quandl are refused at transpile.",
      partial: [
        "request.security (supported by the engine; this server cannot supply other symbols' bars: on the chart's symbol it runs, and on another symbol a value that can reach a trade stops the run, while one that reaches only plots, alerts, tables or logs reads na)",
        "request.security_lower_tf (chart's symbol, fixed intraday minute timeframes that divide the chart's; float, int or bool elements: tuple, UDT, color and string elements are refused)",
      ],
      supported: [
        "barmerge.gaps_on / barmerge.gaps_off",
        "barmerge.lookahead_off",
        "barmerge.lookahead_on (codegen warns that it exposes the completed higher-timeframe value from the bucket's first chart bar)",
      ],
      unsupported: [
        "request.financial / request.earnings / request.dividends / request.splits (PineForge reads them from recorded per-bar series; this server installs none, so a value that can reach a trade stops the run, and one that reaches only plots, alerts, tables or logs reads na)",
        "request.footprint (reads a pinned feed's delta column; this server installs none, so a value that can reach a trade stops the run)",
        "request.economic / request.currency_rate (refused at transpile)",
        "request.seed (refused at transpile: TradingView seeds have no PineForge equivalent)",
        "request.quandl (refused at transpile: deprecated upstream)",
      ],
    },
    {
      id: "bar_magnifier",
      title: "Bar magnifier",
      status: "supported",
      summary:
        "With a feed finer than the chart, the magnifier walks TradingView's own intrabars (a 15-minute chart walks 2-minute bars); with the chart's own bars only, it samples each bar's OHLC path with six distribution modes and optional volume-weighted density.",
      detail:
        "With a feed finer than the chart, the bar magnifier walks TradingView's own intrabars at TradingView's intrabar timeframe (a 15-minute chart walks 2-minute bars), each owned by the chart bar holding its last minute (source/magnifier_intrabars.hpp). With the chart's own bars only, it samples each bar's OHLC path (magnifier.hpp/magnifier.cpp). MagnifierDistribution has six modes: UNIFORM (equal arc-length spacing), COSINE (Chebyshev-like endpoint density), TRIANGLE (segment-midpoint density), ENDPOINTS (default; always exact O, H, L, C with uniform fill), FRONT_LOADED (density near O) and BACK_LOADED (density near C).\n\nsample_price_path(bar, n, dist) emits at least 2 points, O first and C last, with the middle leg O->H->L->C when the open is closer to the high, else O->L->H->C (ties low-first). sample_price_path_volume_weighted(...) scales the sample count by bar.volume / mean volume, clamped to [min, max] (default 2..64); the toggle is set_magnifier_volume_weighted(bool) (C ABI: strategy_set_magnifier_volume_weighted).\n\nThe kernel matches orders over every sub-bar of a magnified script bar; the Pine host runs the script once, at the terminal sub-bar, so on_bar advances series history once per script bar. The magnifier is configured through the TF-aware run(...) overloads and run_backtest_full. A script that declares use_bar_magnifier = true exports strategy_declares_bar_magnifier().",
      supported: [
        "MagnifierDistribution (UNIFORM, COSINE, TRIANGLE, ENDPOINTS, FRONT_LOADED, BACK_LOADED)",
        "sample_price_path",
        "sample_price_path_volume_weighted",
        "set_magnifier_volume_weighted",
        "strategy_set_magnifier_volume_weighted",
        "strategy_declares_bar_magnifier",
      ],
      unsupported: [],
    },
    {
      id: "time_session_timezone",
      title: "Time / session / timezone",
      status: "supported",
      summary:
        "pine_time / pine_time_close with session filtering and timezone conversion, session.* flags from the engine's session calendar, and a mutex-guarded tz_util::ScopedTimezone.",
      detail:
        "pine_time(bar_ms, tf, session, tz, chart_tf) and pine_time_close(...) return Unix milliseconds, or na when no bar of tf built on the requested session holds the bar (TradingView's semantics for filtered sessions). A session argument builds its own bars in its timezone (the explicit one, else syminfo.timezone): a D bar runs from a session day's first window open to its last close, a W or M bar from the first session day of its week or month to the next one's, and an intraday bar opens at each window's open. time() / time_close() with a nonzero bars_back or timeframe_bars_back read another bar's time (codegen 1.0.0).\n\nsession.ismarket, session.ispremarket and session.ispostmarket read the engine's session calendar and in-session facts, and session.isfirstbar / islastbar and their _regular forms read the engine's session-day members (codegen 1.0.0). Inside a request.security payload they keep time-of-day predicates and warn; session.<flag>[k] reads the flag's history. tz_util::ScopedTimezone(tz) is RAII: it holds a process-wide mutex and swaps TZ, so pine_str_format_time and the session helpers are safe in a multi-strategy harness.\n\ntimenow compiles with a warning that it diverges from TradingView: a backtest has no wall clock, and codegen 1.0.1 reads the current bar's time for it.",
      supported: [
        "time / pine_time",
        "time_close / pine_time_close",
        "session.ismarket / session.ispremarket / session.ispostmarket",
        "session.isfirstbar / session.islastbar / session.isfirstbar_regular / session.islastbar_regular",
        "time_tradingday",
        "hour / minute / second / dayofmonth / dayofweek / month / year / weekofyear",
        "tz_util::ScopedTimezone",
      ],
      partial: [
        "timenow (compiles with a warning: a backtest has no wall clock, so it reads the current bar's time)",
      ],
      unsupported: [],
    },
    {
      id: "timeframe_parsing",
      title: "Timeframe parsing",
      status: "supported",
      summary:
        "The timeframe runtime parses TF strings, computes ratios, detects calendar/TF boundaries, auto-detects the input TF, and aggregates via TimeframeAggregator (passthrough/ratio/calendar).",
      detail:
        "timeframe.hpp/timeframe.cpp: tf_to_seconds(tf) covers minute strings ('1','5','60','240',...), day strings ('D','1D' -> 86400) and week strings ('W','1W' -> 604800); month ('M','1M') returns -1 to flag calendar mode. tf_multiplier and tf_is_intraday/_daily/_weekly/_monthly/_seconds back the timeframe.* variables.\n\ntf_ratio(input_tf, target_tf) returns >1 for ratio aggregation, 1 for the same TF, -1 for calendar (month) and -2 when the target is finer than the input. detect_timeframe(bars, n, max_samples=100) infers a TV-style TF string from median timestamp deltas (fallback '1' on insufficient or irregular data). tf_change(prev_ms, curr_ms, tf) and crosses_boundary(prev_ms, curr_ms, period) detect TF/calendar boundaries. TimeframeAggregator runs in PASSTHROUGH, RATIO (every ratio input bars make one output bar) and CALENDAR (day/week/month boundaries) modes; feed(bar) returns AggregatedBar{bar, is_complete, sub_bar_count}.\n\ntimeframe.change(), timeframe.in_seconds(), timeframe.period, timeframe.multiplier, timeframe.main_period and the timeframe.is* predicates work. timeframe.isticks is false (the engine has no tick timeframe). timeframe.from_seconds() is refused: codegen 1.0.1 reports that it is not implemented yet.",
      supported: [
        "tf_to_seconds / timeframe.in_seconds",
        "tf_ratio",
        "tf_change / timeframe.change",
        "detect_timeframe",
        "TimeframeAggregator (PASSTHROUGH/RATIO/CALENDAR)",
        "timeframe.period",
        "timeframe.multiplier",
        "timeframe.main_period",
        "timeframe.isintraday / timeframe.isdaily / timeframe.isweekly / timeframe.ismonthly / timeframe.isseconds",
        "timeframe.isticks (always false: the engine has no tick timeframe)",
      ],
      unsupported: ["timeframe.from_seconds (refused: codegen 1.0.1 reports that it is not implemented yet)"],
    },
    {
      id: "numeric_matrices",
      title: "Numeric matrices",
      status: "supported",
      summary:
        "PineMatrix wraps Eigen::MatrixXd with a full member surface (construction, access, transforms, linear algebra, predicates); the element type is double. Since codegen 1.0.1 a matrix's history (m[1]) is readable.",
      detail:
        "The runtime owns PineMatrix (matrix.hpp, matrix.cpp), an Eigen-backed double matrix. Construction is the static new_(rows, cols, init_val=0). Access and structure: get/set/fill/row/col/rows/columns, add_row/add_col/remove_row/remove_col/swap_rows/swap_columns; transforms copy/submatrix/reshape/reverse/transpose/sort(column, ascending)/concat. Aggregation avg/min/max/mode/sum, arithmetic diff/mult/pow, linear algebra det/inv/pinv/rank/trace/eigenvalues/eigenvectors, kron, elements_count, and the predicates is_square/is_identity/is_diagonal/is_antidiagonal/is_symmetric/is_antisymmetric/is_triangular/is_stochastic/is_binary/is_zero. order.ascending/order.descending are runtime constants used by matrix.sort.\n\nThe element type is fixed to double; other element types use PineGenericMatrix<T> (see typed_matrices). Since codegen 1.0.1, m[k] of a matrix variable (top-level or a block's local) is a read-only copy of the matrix as the variable left it k executions back: (m[1]).get(0, 0) and matrix.copy(m[1]) work; a change to the copy stops the run with RE10051, and a method on it before the variable has a history with RE10053. The history of a function's matrix parameter or local is not kept. As in 1.0.0, matrix.sum(m1, m2) and other matrix results used without a declared type do not compile.",
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
        "matrix.copy",
        "order.ascending",
        "order.descending",
      ],
      unsupported: [],
    },
    {
      id: "typed_matrices",
      title: "Typed matrices",
      status: "supported",
      summary:
        "PineGenericMatrix<T> header-only template gives structural matrix ops for int/bool/string/color/UDT element types; numeric methods stay on the double PineMatrix.",
      detail:
        "PineGenericMatrix<T> (header-only, include/pineforge/generic_matrix.hpp) is a template over std::vector<std::vector<T>> (T=bool specialized to vector<vector<char>>) for non-double element types: int, bool, string, color and UDT. matrix.new<float>() is a PineMatrix; every other element type is a PineGenericMatrix<T>.\n\nUDT element types work: the template instantiates over arbitrary structs. engine coverage.md's sentence that UDT-typed matrices are not runtime-supported belongs to the PineMatrix (double) section: the double-only PineMatrix cannot hold UDTs.\n\nThe support is structural: add_row/remove_row/reshape/transpose and the other shape and access operations apply, but the numeric methods (det, inv, pinv, rank, trace, eigenvalues, eigenvectors) exist only on PineMatrix. A string/color/UDT matrix can be built, indexed, reshaped and transposed, but not inverted. sort is limited to int/bool/string on the primary template and is not available for bool's specialization.",
      supported: [
        "matrix.new<int>",
        "matrix.new<bool>",
        "matrix.new<string>",
        "matrix.new<color>",
        "matrix.new<UDT>",
        "matrix.add_row / matrix.remove_row / matrix.reshape / matrix.transpose (structural ops)",
      ],
      unsupported: [
        "matrix.det / matrix.inv / matrix.pinv / matrix.rank / matrix.trace / matrix.eigenvalues / matrix.eigenvectors (on an int, bool, string, color or UDT matrix: numeric methods are PineMatrix/double-only)",
      ],
    },
    {
      id: "series_history",
      title: "Series history",
      status: "supported",
      summary:
        "Series<T> is a ring buffer with Pine [k] semantics (max_len default 500, out-of-range reads na). Since codegen 1.0.1 the history operator also reads objects, drawings, arrays and matrices.",
      detail:
        "Series<T> (header-only, series.hpp) implements Pine's [k] history: push(value) records a new bar (newest at the front), update(value) overwrites the current bar (magnifier intrabar), operator[](k) returns 0 = current, k >= 1 = k bars ago, plus current(), size() and clear(). max_len defaults to 500; an out-of-range or negative offset reads na<T>(), not an error. In the magnifier path the Pine host runs the script once per script bar, so history advances exactly once per script bar.\n\nSince codegen 1.0.1: obj[k] of a user-defined object or a drawing is the reference the variable held k bars back (na before the first), and (obj[k]).field reads that object as it is now, as on TradingView; a[k] of an array or matrix is a read-only copy of the collection k executions back. TradingView's own refusals apply: a field or method straight after the history operator (c[1].v, a[1].size(); write (c[1]).v), the history of a field, and an array's history used as a number, condition, string or element. See arrays_maps_udts and drawing_plotting_alerts for the limits.",
      supported: [
        "series",
        "Series<T>::push / Series<T>::update / Series<T>::current",
        "series[k] (0 = current bar, k >= 1 = k bars ago; out of range reads na; max_len 500)",
      ],
      unsupported: [],
    },
    {
      id: "color",
      title: "Color",
      status: "supported",
      summary:
        "pine_color holds 17 named ARGB constants plus new_color, r, g, b and t helpers; color.rgb is emitted inline, and color.from_gradient is accepted but returns a default color.",
      detail:
        "color.hpp (header-only): 17 named ARGB constants in pine_color::* (aqua, black, blue, fuchsia, gray, green, lime, maroon, navy, olive, orange, purple, red, silver, teal, white, yellow). new_color(c, transp) sets the alpha byte to the whole number nearest 255 x (100 - transp) / 100, clamped to 0..255 (an na transparency is fully transparent); r(c)/g(c)/b(c) return the channel bytes; t(c) recovers the transparency (0..100). A fractional input or series transparency rounds to the nearest alpha byte as TradingView's does; a fractional constant transparency also rounds, where TradingView truncates (10.5 reads back 11 where TradingView reads 10). color.rgb is emitted inline by the transpiler, and color.new / color.rgb bind a keyword transparency like a positional one.\n\ncolor.from_gradient is accepted with a warning: it evaluates its arguments and returns a default color, not the gradient. Drawing objects are data in drawing.hpp; the runtime has no charting or rendering types.",
      supported: [
        "color (type)",
        "color.new",
        "color.r / color.g / color.b / color.t",
        "color.* (17 named constants)",
      ],
      via_transpiler: ["color.rgb (emitted inline)"],
      unsupported: [
        "color.from_gradient (accepted with a warning: it evaluates its arguments and returns a default color, not the gradient)",
      ],
    },
    {
      id: "na",
      title: "`na` / `is_na`",
      status: "supported",
      summary:
        "na<T>() and is_na(...) for double (NaN), int (INT_MIN), int64 (INT64_MIN) and bool (false), plus null-ID detection for maps; nz() and fixnan() are emitted inline.",
      detail:
        "na.hpp (header-only): na<T>() gives the sentinel per type: double -> NaN, int -> INT_MIN, int64_t -> INT64_MIN, bool -> false. is_na(double) uses std::isnan; the integer overload compares with the type's minimum; map.hpp adds a null-ID overload for PineMap<K,V>. These sentinels are used throughout the runtime (out-of-range Series[k], absent pivot levels, na syminfo fields).\n\nnz() and fixnan() are emitted inline by the transpiler; fixnan evaluates its argument once (codegen 1.0.0). Since codegen 1.0.0, na follows Pine's rules wherever the generated C++ converts a value: it is false in if, ?:, and/or and boolean parameters, and an integer conversion of na stays na.",
      supported: ["na", "na()", "is_na", "na<double>() (NaN)", "na<int>() / na<int64_t>() (INT_MIN / INT64_MIN)", "na<bool>() (false)"],
      via_transpiler: ["nz (emitted inline)", "fixnan (emitted inline; evaluates its argument once)"],
      unsupported: [],
    },
    {
      id: "logging_errors",
      title: "Logging / runtime errors",
      status: "supported",
      summary:
        "Header-only log.hpp backs log.info/warning/error and runtime.error (which throws std::runtime_error and fails the run).",
      detail:
        "log.hpp exposes four inline functions: pine_log_info, pine_log_warning, pine_log_error (each writing to stderr with an [INFO]/[WARN]/[ERROR] prefix) and pine_runtime_error, which throws std::runtime_error. log.info() -> pine_log_info(), log.warning() -> pine_log_warning(), log.error() -> pine_log_error(), runtime.error() -> pine_runtime_error(); formatted log.* calls are lowered (codegen 1.0.0).\n\nThe runtime also raises std::runtime_error itself from validate_security_timeframes, feed_security_eval_state (lower-TF synthesis failure) and ensure_supported_lower_tf_emulation_flags; strategy_get_last_error carries the text of a failed run. The @strategy_alert_message annotation is parse-and-skip (alert template, no runtime), which belongs to the alert surface.",
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
      unsupported: ["@strategy_alert_message (parse-and-skip; alert template, not part of the log namespace)"],
    },
    {
      id: "maps",
      title: "Maps",
      status: "partial",
      summary:
        "map.hpp's PineMap<K,V> backs Pine maps with string keys and primitive values: insertion order, alias/copy/null semantics and the 50,000-pair limit. Other key or value types, map history and nested map-bearing matrices are refused.",
      detail:
        "map.hpp provides ordered PineMap<K,V> handles: map-ID aliasing, map.copy() container separation, insertion-ordered keys and values, typed missing results, null IDs, Pine-aware primitive keys and the 50,000-pair limit, with primitive-only rollback snapshots. The transpiler emits this runtime for its supported subset, string keys and primitive values, including typed and inferred na, function and UDT parameter and return propagation, once-only receiver evaluation and pair iteration. It refuses the rest instead of emitting incorrect C++: a key type other than string (\"map keys must be string in PineForge's supported map subset\"), a non-primitive value (\"map values must be primitive in PineForge's supported map subset\"), map-bearing history, nested map-bearing matrices and ambiguous specializations.",
      partial: [
        "map (type: string keys and primitive values only)",
        "map.new / map.put / map.get / map.contains / map.remove / map.keys / map.values / map.size / map.clear / map.copy / map.put_all (string keys and primitive values only; other key or value types are refused)",
      ],
      supported: [],
      unsupported: [],
    },
    {
      id: "arrays_maps_udts",
      title: "Arrays / UDTs",
      status: "via_transpiler",
      summary:
        "No runtime array or UDT module: PineForge's transpiler emits arrays as std::vector and user-defined types as C++ structs, so they work end-to-end, including (since codegen 1.0.1) the history of arrays and objects. Maps are their own topic (maps).",
      detail:
        "The runtime ships no array or UDT module; the transpiler emits array<T> as std::vector<T> and UDTs (including nested fields and array<UDT>) as plain C++ structs, and handles the type and method keywords. array.sort/sort_indices use std::sort; array.from is supported; order.ascending/order.descending are runtime constants. Every array.slice warns that PineForge copies the slice where TradingView aliases it. Arrays of lines, boxes, labels and linefills hold drawings, which are data (see drawing_plotting_alerts).\n\nHistory (codegen 1.0.1): a[k] of an array variable, top-level or a block's local, is a read-only copy of the array as the variable left it k executions back; built-ins read it, na() tests it, and a for...in loop over a[1] iterates the array the variable holds now, as on TradingView. A change to the copy stops the run with RE10051, and a method on it before the variable has a history with RE10052. obj[k] of a UDT variable is the reference it held k bars back, and (obj[k]).field reads that object as it is now. Not kept: the history of a function's array parameter or local, of a call's result or of a selection (TradingView keeps one per call), and a typed method's receiver at a call site that skips bars counts calls instead of chart bars. Refused with TradingView's codes: a field or method straight after the history operator (c[1].v, a[1].size(); write (a[1]).size()), the history of a field (CE10290), and an array's history used as a number, condition, string or element (CE10123 and related codes).",
      supported: ["order.ascending / order.descending (runtime constants)"],
      via_transpiler: [
        "array (type)",
        "array.new / array.from / array.push / array.get / array.set / array.size / array.sort / array.sort_indices",
        "array.slice (copies where TradingView aliases; codegen warns)",
        "array.* (array functions are emitted inline)",
        "type (UDT struct generation)",
        "method (UDT method generation)",
      ],
      unsupported: [],
    },
    {
      id: "drawing_plotting_alerts",
      title: "Drawing / plotting / alerts",
      status: "partial",
      summary:
        "Drawings are data: line, box, label and linefill objects and chart.point keep their geometry, which strategy logic can read back (since codegen 1.0.1 also through their history). Nothing is drawn: visual setters, plots, tables, polylines and alerts are accepted and have no effect.",
      detail:
        "drawing.hpp keeps line/box/label/linefill handles in per-type arenas and chart.point as a value type: geometry as data, no rendering. Visual fields (color, style, width and the like) are dropped at lowering, and a visual setter such as line.set_color is accepted with a warning and does nothing. A drawing op on an na handle halts the run, as on TradingView; a deleted or collected drawing reads as na, and drawings are collected as TradingView collects them. The arenas are part of the script state that calc_on_order_fills checkpoints and rolls back. Since codegen 1.0.1, b[k] of a drawing variable is the reference it held k bars back, (b[1]).get_top() reads that box as it is now, and == / != compare two lines or two labels by identity. Refused: b[1].get_top() without the parentheses (CE10010), the history of a drawing inside a request.security expression, and the history of a chart.point variable whose fields the script changes. In codegen 1.0.1 the C++ for line.all, box.all and label.all does not compile.\n\nplot, plotshape, plotchar, plotcandle, plotbar, plotarrow, fill, hline, bgcolor, barcolor, table.*, polyline.*, alert(...) and alertcondition(...) are accepted with a warning and have no effect on a backtest: the engine renders nothing and emits no alert events. A request whose value reaches only these sinks lowers to na.",
      supported: [
        "line.new / line.get_x1 / line.get_x2 / line.get_y1 / line.get_y2 / line.get_price / line.set_x1 / line.set_x2 / line.set_y1 / line.set_y2 / line.set_xy1 / line.set_xy2 / line.copy / line.delete (geometry kept as data the strategy reads back; nothing is drawn)",
        "box.new / box.get_top / box.get_bottom / box.get_left / box.get_right / box.set_top / box.set_bottom / box.set_left / box.set_right / box.set_lefttop / box.set_rightbottom / box.copy / box.delete (geometry as data)",
        "label.new / label.get_x / label.get_y / label.get_text / label.set_x / label.set_y / label.set_xy / label.set_text / label.copy / label.delete (geometry and text as data)",
        "linefill.new / linefill.get_line1 / linefill.get_line2 / linefill.delete (data)",
        "chart.point.new / chart.point.from_index / chart.point.from_time / chart.point.copy (a value type)",
      ],
      unsupported: [
        "line.all / box.all / label.all (codegen 1.0.1's C++ for them does not compile)",
        "line.set_color / line.set_style / line.set_width / line.set_extend / box.set_bgcolor / box.set_border_color / box.set_border_width / label.set_color / label.set_style / label.set_textcolor / label.set_size / linefill.set_color (visual setters: accepted with a warning, no effect)",
        "plot / plotshape / plotchar / plotcandle / plotbar / plotarrow (accepted with a warning, no effect)",
        "fill / hline / bgcolor / barcolor (accepted with a warning, no effect)",
        "table / table.* (accepted with a warning, no effect)",
        "polyline / polyline.* (accepted with a warning, no effect)",
        "alert / alertcondition (accepted with a warning: no alert events are emitted)",
        "alert.freq_all / alert.freq_once_per_bar / alert.freq_once_per_bar_close",
        "@strategy_alert_message",
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
    "map.": "maps",
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
    indicator: "engine_lifecycle",
    array: "arrays_maps_udts",
    map: "maps",
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
    varip: "engine_lifecycle",
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
 *   1. Exact identifier match in any topic's unsupported[] / partial[] /
 *      via_transpiler[] / supported[] list (checked in that order): the list
 *      names the status, and the note quotes the matching entry.
 *   1b. A "namespace.*" entry (e.g. "table.*") covers every identifier under
 *      that namespace, with the same list order; exact matches win over it.
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
export function entryIdentifiers(entry: string): string[] {
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

/** A topic's per-feature lists, in resolution order; each list's name is the status it reports. */
const ENTRY_LISTS = ["unsupported", "partial", "via_transpiler", "supported"] as const;

export function checkPineFeature(feature: string): CheckPineFeatureResult {
  const query = feature;
  const q = normalizeFeatureQuery(query);

  // (1) Exact identifier match in unsupported[] / partial[] / via_transpiler[] / supported[].
  for (const t of COVERAGE.topics) {
    for (const status of ENTRY_LISTS) {
      const entry = (t[status] ?? []).find((e) => entryIdentifiers(e).includes(q));
      if (entry !== undefined) {
        return {
          query,
          status,
          topic: t.id,
          note: `'${query}' is listed as ${status} under topic '${t.id}' (${t.title}): ${entry}`,
        };
      }
    }
  }

  // (1b) A "namespace.*" entry covers every identifier under that namespace.
  for (const t of COVERAGE.topics) {
    for (const status of ENTRY_LISTS) {
      for (const entry of t[status] ?? []) {
        const wildcard = entryIdentifiers(entry).find(
          (id) => id.endsWith(".*") && q.startsWith(id.slice(0, -1)),
        );
        if (wildcard !== undefined) {
          return {
            query,
            status,
            topic: t.id,
            note: `'${query}' falls under '${wildcard}', listed as ${status} under topic '${t.id}' (${t.title}): ${entry}`,
          };
        }
      }
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
