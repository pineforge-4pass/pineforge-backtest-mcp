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
  if (/count|entries/i.test(name) && ("tradingview" in c || "pineforge" in c)) {
    const parts = [`TradingView ${str(c.tradingview)}, PineForge ${str(c.pineforge)}`];
    if (c.abs !== undefined) parts.push(`Δ ${str(c.abs)}`);
    if (typeof v === "number" && v !== 0) parts.push(`(${pct(v, 2)})`);
    return parts.join(" ");
  }
  if (/coverage/i.test(name)) return pct(v, 1);
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
  return parts.join(" ");
}

function deltaText(d: unknown): string {
  if (!isObj(d)) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(d)) {
    if (v === null || v === undefined) continue;
    parts.push(`${k} ${typeof v === "number" ? pct(v) : str(v)}`);
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

  const total = (n: unknown) => (typeof n === "number" ? n : 0);
  const matched = total(r.matched);
  const tvOnly = total(r.unmatched_tradingview);
  const pfOnly = total(r.unmatched_pineforge);
  lines.push(
    `Matched ${matched} of ${matched + tvOnly} TradingView trades; ${tvOnly} TradingView-only, ${pfOnly} PineForge-only.`,
  );

  const mismatches = Array.isArray(r.mismatches) ? r.mismatches.filter(isObj) : [];
  if (mismatches.length) {
    const listed = typeof r.mismatches_total === "number" ? r.mismatches_total : undefined;
    lines.push("", `Mismatches (first ${mismatches.length}${listed !== undefined ? ` of ${listed}` : ""}, by entry time):`);
    mismatches.forEach((m, i) => {
      lines.push(`${i + 1}. ${KIND_LABEL[String(m.kind)] ?? str(m.kind)}`);
      lines.push(`   TradingView: ${tradeText(m.tradingview)}`);
      lines.push(`   PineForge:   ${tradeText(m.pineforge)}`);
      const d = deltaText(m.deltas);
      if (d) lines.push(`   deltas: ${d}`);
      if (m.hint) lines.push(`   hint: ${str(m.hint)}`);
    });
  } else if (typeof r.mismatches_note === "string" && r.mismatches_note) {
    lines.push(r.mismatches_note);
  }

  const tz = isObj(r.timezone) ? r.timezone : undefined;
  if (tz && (tz.note || tz.better)) {
    lines.push("");
    if (tz.note) lines.push(`Timezone: ${str(tz.note)}`);
    if (tz.better && !String(tz.note ?? "").includes(String(tz.better))) {
      lines.push(`Timezone: more trades line up under ${str(tz.better)} than under ${str(tz.given)}.`);
    }
  }
  const win = isObj(r.window) ? r.window : undefined;
  if (win) {
    const parts: string[] = [];
    if (win.range_start) parts.push(`range start ${str(win.range_start)}`);
    if (win.range_end) parts.push(`range end ${str(win.range_end)}${win.range_end_source ? ` (${str(win.range_end_source)})` : ""}`);
    if (parts.length) lines.push("", `Window: ${parts.join(", ")}.`);
  }
  const warnings = Array.isArray(r.warnings) ? r.warnings.map(str).filter(Boolean) : [];
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
