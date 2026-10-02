/**
 * The plain-text block check_tradingview_parity returns next to its JSON.
 * Reads the grading core's response (parity/pf_parity.py) as it is.
 */

export const METHODOLOGY_URL = "https://pineforge.dev/en/methodology/";

export const RETENTION_LOCAL =
  "Everything runs on your machine; market data is fetched from Binance only when you do not pass bars.";

export const RETENTION_HOSTED =
  "The script and trade list are written to a temporary folder in the sandbox and deleted when grading ends; " +
  "nothing is stored. If a result is larger than the offload threshold it is kept under an unguessable link " +
  "for up to 7 days, then deleted.";

type Json = Record<string, unknown>;

export interface FormatOptions {
  /** The retention sentence true for the serving MCP. */
  retention: string;
  /** Extra lines (e.g. where the bars came from) printed before the versions line. */
  notes?: string[];
}

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return fmtNum(v);
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toFixed(2);
  if (abs >= 1) return n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return n.toPrecision(6).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function pct(v: unknown, digits = 4): string {
  return typeof v === "number" && Number.isFinite(v) ? `${(v * 100).toFixed(digits)}%` : str(v);
}

function checkValue(c: Json): string {
  const name = String(c.name ?? "");
  const v = c.value;
  if ("tradingview" in c || "pineforge" in c) {
    const parts = [`TradingView ${str(c.tradingview)}, PineForge ${str(c.pineforge)}`];
    if (c.abs !== undefined) parts.push(`Δ ${str(c.abs)}`);
    if (typeof v === "number" && v !== 0) parts.push(`(${pct(v, 2)})`);
    return parts.join(" ");
  }
  if (/coverage/i.test(name)) {
    const of = typeof c.of === "number" ? ` (${str(c.unmatched)} of ${c.of} unmatched)` : "";
    return pct(v, 1) + of;
  }
  if (/distinct/i.test(name) && typeof v === "number") return `${v} mismatch${v === 1 ? "" : "es"}`;
  if (typeof v === "number") return pct(v);
  return str(v);
}

function passText(c: Json): string {
  const tiers = ["excellent", "strong", "moderate"];
  for (const t of tiers) {
    if (c[`pass_${t}`] === true) return `meets ${t}`;
  }
  const failed = tiers.filter((t) => c[`pass_${t}`] === false);
  if (failed.length) return `below ${failed[failed.length - 1]}`;
  if (typeof c.pass === "boolean") return c.pass ? "pass" : "fail";
  return "";
}

function tradeText(t: unknown): string {
  if (!isObj(t)) return "none";
  const parts: string[] = [];
  if (t.trade !== undefined && t.trade !== null) parts.push(`#${str(t.trade)}`);
  if (t.side) parts.push(str(t.side));
  parts.push(`${str(t.entry_time)} @ ${str(t.entry_price)} -> ${str(t.exit_time)} @ ${str(t.exit_price)}`);
  if (t.qty !== undefined) parts.push(`qty ${str(t.qty)}`);
  if (t.pnl !== undefined) parts.push(`P&L ${str(t.pnl)}`);
  if (t.signal) parts.push(`signal ${str(t.signal)}`);
  if (t.open_at_range_end === true) parts.push("(open at the range end)");
  return parts.join(" ");
}

const DELTA_LABEL: Record<string, string> = { entry: "entry", exit: "exit", pnl: "P&L", qty: "qty" };

// Relative deltas print as percentages; *_seconds and *_abs keep their units.
function deltaText(d: unknown): string {
  if (!isObj(d)) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(d)) {
    if (v === null || v === undefined) continue;
    const base = k.replace(/_(seconds|abs)$/, "");
    const label = DELTA_LABEL[base] ?? base;
    if (typeof v !== "number") parts.push(`${label} ${str(v)}`);
    else if (k.endsWith("_seconds")) {
      if (v !== 0) parts.push(`${label} time ${v > 0 ? "+" : ""}${v} s`);
    } else if (k.endsWith("_abs")) {
      parts.push(`${label}${base === "exit" || base === "entry" ? " price" : ""} Δ ${v > 0 ? "+" : ""}${fmtNum(v)}`);
    } else parts.push(`${label} ${pct(v)}`);
  }
  return parts.join(", ");
}

const KIND_LABEL: Record<string, string> = {
  unmatched_tradingview: "TradingView only",
  unmatched_pineforge: "PineForge only",
  deviating_pair: "matched, outside the threshold",
};

function table(head: string[], rows: string[][]): string[] {
  const esc = (s: string) => s.replace(/\|/g, "\\|");
  return [
    `| ${head.join(" | ")} |`,
    `|${head.map(() => "---").join("|")}|`,
    ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`),
  ];
}

export function formatParityResult(response: unknown, opts: FormatOptions): string {
  const r = isObj(response) ? response : {};
  const lines: string[] = [];
  if (r.ok !== true) {
    lines.push(`Parity check failed (${str(r.error) || "error"}): ${str(r.message) || "no message"}`);
    for (const n of opts.notes ?? []) lines.push(n);
    lines.push("", `Methodology: ${METHODOLOGY_URL}`, opts.retention);
    return lines.join("\n");
  }

  lines.push(`Tier: ${str(r.tier)}: ${str(r.tier_meaning)}`);
  if (r.profile) lines.push(`Profile: ${str(r.profile)}`);
  lines.push("");

  const checks = Array.isArray(r.checks) ? r.checks.filter(isObj) : [];
  if (checks.length) {
    const tiers = ["excellent", "strong", "moderate"].filter((t) => checks.some((c) => c[t] !== undefined));
    lines.push(...table(
      ["check", "value", ...tiers, "result"],
      checks.map((c) => [str(c.name), checkValue(c), ...tiers.map((t) => str(c[t]) || "-"), passText(c)]),
    ));
    lines.push("");
  }

  const count = (n: unknown) => (typeof n === "number" ? n : null);
  const matched = count(r.matched) ?? 0;
  const tvOnly = count(r.unmatched_tradingview);
  const pfOnly = count(r.unmatched_pineforge);
  if (tvOnly === null || pfOnly === null) {
    lines.push(`Matched ${matched} TradingView trades; the per-trade listing is left out (see the warnings).`);
  } else {
    lines.push(
      `Matched ${matched} of ${matched + tvOnly} TradingView trades; ${tvOnly} TradingView-only, ${pfOnly} PineForge-only.`,
    );
  }

  const mismatches = Array.isArray(r.mismatches) ? r.mismatches.filter(isObj) : [];
  if (mismatches.length) {
    const all = (tvOnly ?? 0) + (pfOnly ?? 0) + (count(r.deviating_pairs) ?? 0);
    const of = all > mismatches.length ? ` of ${all}` : "";
    lines.push("", `Mismatches (first ${mismatches.length}${of}, by entry time; times in the chart timezone):`);
    mismatches.forEach((m, i) => {
      lines.push(`${i + 1}. ${KIND_LABEL[String(m.kind)] ?? str(m.kind)}`);
      lines.push(`   TradingView: ${tradeText(m.tradingview)}`);
      lines.push(`   PineForge:   ${tradeText(m.pineforge)}`);
      const d = deltaText(m.deltas);
      if (d) lines.push(`   deltas: ${d}`);
      if (m.hint) lines.push(`   hint: ${str(m.hint)}`);
    });
  }

  const printed = new Set<string>();
  const tz = isObj(r.timezone) ? r.timezone : undefined;
  const better = tz && isObj(tz.better) ? tz.better : undefined;
  if (tz && (tz.note || better)) {
    lines.push("");
    if (tz.note) {
      lines.push(`Timezone: ${str(tz.note)}`);
      printed.add(str(tz.note));
    }
    if (better) {
      lines.push(
        `Timezone: read in ${str(better.zone)}, ${str(better.matched)} trades match instead of ` +
          `${str(better.matched_given)} under ${str(tz.given)}; the tier above uses ${str(tz.given)}.`,
      );
    }
  }
  const win = isObj(r.window) ? r.window : undefined;
  if (win) {
    const utc = win.timezone_of_times ? ` ${str(win.timezone_of_times)}` : "";
    const parts: string[] = [];
    if (win.range_start) parts.push(`first bar ${str(win.range_start)}${utc}`);
    if (win.range_end) {
      parts.push(`range end ${str(win.range_end)}${utc}${win.range_end_source ? `, set by ${str(win.range_end_source)}` : ""}`);
    }
    if (parts.length) lines.push("", `Window: ${parts.join(", ")}.`);
  }
  const warnings = (Array.isArray(r.warnings) ? r.warnings.map(str) : [])
    .filter((w) => w && !printed.has(w) && !(better && w.startsWith(`Read in ${str(better.zone)},`)));
  if (warnings.length) {
    lines.push("", "Warnings:");
    for (const w of warnings) lines.push(`- ${w}`);
  }
  for (const n of opts.notes ?? []) lines.push(n);

  const v = isObj(r.versions) ? r.versions : {};
  lines.push(
    "",
    `Engine ${str(v.engine) || "?"}, codegen ${str(v.codegen) || "?"}, grader ${str(v.grader) || "verify_corpus.py"}` +
      (v.grader_sha256 ? ` (sha256 ${str(v.grader_sha256)})` : ""),
    `Methodology: ${METHODOLOGY_URL}`,
    opts.retention,
  );
  return lines.join("\n");
}
