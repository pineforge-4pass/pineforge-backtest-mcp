/**
 * Read a TradingView Strategy Tester export: the "List of trades" CSV, or the
 * report XLSX (base64) with its "List of trades" and "Properties" sheets.
 *
 * Either way the result is one canonical CSV in the columns the grader reads
 * (verify_corpus.py parse_trades), plus whatever tool settings the XLSX
 * Properties sheet states. TradingView does not document its XLSX layout, so
 * sheet names and property keys are matched loosely and unknown keys are
 * ignored. Inflate is injected by the caller (Node zlib or a Worker's
 * DecompressionStream) so this file has no runtime imports.
 */

import { ParityInputError } from "./errors.js";
import { parseCsv, toCsv } from "./csv.js";
import { normalizeTimeframe } from "./market.js";

/** Raw DEFLATE (ZIP method 8). Must throw once the output passes maxOutputBytes. */
export type InflateFn = (data: Uint8Array, maxOutputBytes: number) => Uint8Array | Promise<Uint8Array>;

export interface ExportLimits {
  /** Largest CSV text or base64 XLSX accepted, in characters. */
  maxInputChars: number;
  /** Largest decompressed XLSX part, and all parts together, in bytes. */
  maxPartBytes: number;
  maxTotalBytes: number;
  /** Trade-list rows (two per closed trade). */
  maxRows: number;
  /** Cells read from one sheet, empty cells inside a row's span included. */
  maxCells: number;
  /** Columns of one sheet row (default 256; Excel's own limit is 16,384). */
  maxColumns?: number;
}

export const DEFAULT_EXPORT_LIMITS: ExportLimits = {
  maxInputChars: 32 * 1024 * 1024,
  maxPartBytes: 64 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxRows: 400_000,
  maxCells: 8_000_000,
};

/** Tool settings an export can state. Times are wall clock in the chart timezone. */
export interface ExportSettings {
  symbol?: string;
  timeframe?: string;
  chart_timezone?: string;
  range_start_wall?: string;
  range_end_wall?: string;
  strategy_overrides?: Record<string, number | string | boolean>;
  runtime?: { bar_magnifier?: boolean };
}

export interface PropertyRow {
  section: string;
  name: string;
  value: string;
}

export interface TradingViewExport {
  format: "csv" | "xlsx";
  /** The trade list as the grader reads it. */
  csv: string;
  /** Rows after the header. */
  rows: number;
  /** Trade numbers with both an entry and an exit row. */
  closedTrades: number;
  settings: ExportSettings;
  /** Every Properties row as read (XLSX only). */
  properties: PropertyRow[];
  /** "Strategy inputs" rows of the Properties sheet (reported, not applied). */
  strategyInputs: PropertyRow[];
  warnings: string[];
}

// ─── Entry point ──────────────────────────────────────────────────────────

export async function readTradingViewExport(
  input: string,
  inflate: InflateFn,
  limits: ExportLimits = DEFAULT_EXPORT_LIMITS,
): Promise<TradingViewExport> {
  if (input.length > limits.maxInputChars) {
    throw new ParityInputError(
      "bad_trades_csv",
      `The trade list is ${input.length} characters; the limit is ${limits.maxInputChars}.`,
    );
  }
  const b64 = stripDataUrl(input.trim());
  if (b64.startsWith("UEsDB")) return readXlsx(b64, inflate, limits);
  if (looksLikeBinaryZip(input)) {
    throw new ParityInputError(
      "bad_trades_csv",
      "The XLSX arrived as raw bytes; pass the file base64-encoded (it then starts with UEsDB).",
    );
  }
  const text = input.replace(/^﻿/, "");
  const rows = parseCsv(text, limits.maxRows + 1);
  if (rows.length > limits.maxRows + 1) {
    throw new ParityInputError("bad_trades_csv", `The trade list has more than ${limits.maxRows} rows.`);
  }
  const checked = checkTradeRows(rows);
  return {
    format: "csv",
    csv: text,
    rows: rows.length - 1,
    closedTrades: checked.closedTrades,
    settings: {},
    properties: [],
    strategyInputs: [],
    warnings: checked.warnings,
  };
}

function stripDataUrl(s: string): string {
  const m = /^data:[^,]*;base64,/i.exec(s);
  return (m ? s.slice(m[0].length) : s).replace(/\s+/g, "");
}

function looksLikeBinaryZip(s: string): boolean {
  return s.startsWith("PK\u0003\u0004");
}

// ─── Trade-list checks (the grader's columns and formats) ─────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

interface CheckedRows {
  closedTrades: number;
  warnings: string[];
}

function checkTradeRows(rows: string[][]): CheckedRows {
  const header = rows[0];
  if (!header || header.length < 2) {
    throw new ParityInputError(
      "bad_trades_csv",
      "The trade list is empty or not CSV; export \"List of trades\" from TradingView's Strategy Tester (CSV, or the XLSX report).",
    );
  }
  const has = (n: string) => header.includes(n);
  const missing: string[] = [];
  const iNum = header.findIndex((h) => h === "Trade #" || h === "Trade number");
  if (iNum < 0) missing.push("'Trade number' (or 'Trade #')");
  if (!has("Type")) missing.push("'Type'");
  if (!has("Date and time")) missing.push("'Date and time'");
  const iPrice = header.findIndex((h) => h === "Price" || h.startsWith("Price "));
  if (iPrice < 0) missing.push("a 'Price' column (e.g. 'Price USDT')");
  if (missing.length) {
    const old = has("Date/Time") || has("Contracts") || has("Profit") || header.some((h) => h.startsWith("Profit "));
    throw new ParityInputError(
      "bad_trades_csv",
      `The trade list is missing ${missing.join(", ")}. Found columns: ${header.join(", ")}.` +
        (old ? " This looks like TradingView's older export layout; export the list again from the current Strategy Tester." : ""),
    );
  }
  const iType = header.indexOf("Type");
  const iTime = header.indexOf("Date and time");
  const entries = new Set<string>();
  const exits = new Set<string>();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    const line = r + 1;
    const num = (row[iNum] ?? "").trim();
    if (!/^\d+$/.test(num)) {
      throw new ParityInputError("bad_trades_csv", `Row ${line}: trade number '${row[iNum] ?? ""}' is not a whole number.`);
    }
    const type = row[iType] ?? "";
    if (!type.startsWith("Entry") && !type.startsWith("Exit")) {
      throw new ParityInputError("bad_trades_csv", `Row ${line}: Type '${type}' is neither an Entry nor an Exit.`);
    }
    const t = (row[iTime] ?? "").trim();
    if (!DATE_RE.test(t)) {
      throw new ParityInputError(
        "bad_trades_csv",
        `Row ${line}: 'Date and time' is '${row[iTime] ?? ""}', not YYYY-MM-DD HH:MM as TradingView exports it.`,
      );
    }
    const price = row[iPrice] ?? "";
    if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(price.trim())) {
      throw new ParityInputError("bad_trades_csv", `Row ${line}: price '${price}' is not a number.`);
    }
    (type.startsWith("Entry") ? entries : exits).add(num);
  }
  let closedTrades = 0;
  for (const n of entries) if (exits.has(n)) closedTrades++;
  const warnings: string[] = [];
  if (!header.some((h) => h === "Size (qty)" || h === "Position size (qty)" || h === "Qty")) {
    warnings.push("The trade list has no size column ('Size (qty)'); sizes are not compared.");
  }
  if (!header.some((h) => h === "Net PnL" || h === "Net P&L" || h.startsWith("Net PnL ") || h.startsWith("Net P&L "))) {
    warnings.push("The trade list has no 'Net PnL' column; P&L is not compared.");
  }
  return { closedTrades, warnings };
}

// ─── XLSX ─────────────────────────────────────────────────────────────────

function base64ToBytes(b64: string): Uint8Array {
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    throw new ParityInputError("bad_trades_csv", "The XLSX is not valid base64.");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

function zipEntries(b: Uint8Array): Map<string, ZipEntry> {
  const badZip = (why: string) => new ParityInputError("bad_trades_csv", `The XLSX is not a readable ZIP file (${why}).`);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (u32(b, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw badZip("no end-of-directory record");
  const count = u16(b, eocd + 10);
  let p = u32(b, eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw badZip("ZIP64 is not supported");
  const dec = new TextDecoder();
  const out = new Map<string, ZipEntry>();
  for (let k = 0; k < count; k++) {
    if (p + 46 > b.length || u32(b, p) !== 0x02014b50) throw badZip("bad central directory");
    const method = u16(b, p + 10);
    const compressedSize = u32(b, p + 20);
    const size = u32(b, p + 24);
    const nameLen = u16(b, p + 28);
    const extraLen = u16(b, p + 30);
    const commentLen = u16(b, p + 32);
    const offset = u32(b, p + 42);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nameLen));
    out.set(name.replace(/^\/+/, ""), { name, method, compressedSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

class XlsxReader {
  private used = 0;
  constructor(
    private bytes: Uint8Array,
    private entries: Map<string, ZipEntry>,
    private inflate: InflateFn,
    private limits: ExportLimits,
  ) {}

  has(name: string): boolean {
    return this.entries.has(name);
  }

  async text(name: string): Promise<string> {
    const e = this.entries.get(name);
    if (!e) throw new ParityInputError("bad_trades_csv", `The XLSX has no part ${name}.`);
    const b = this.bytes;
    const lh = e.offset;
    if (lh + 30 > b.length || u32(b, lh) !== 0x04034b50) {
      throw new ParityInputError("bad_trades_csv", `The XLSX part ${name} has no local header.`);
    }
    const start = lh + 30 + u16(b, lh + 26) + u16(b, lh + 28);
    const data = b.subarray(start, start + e.compressedSize);
    const cap = Math.min(this.limits.maxPartBytes, this.limits.maxTotalBytes - this.used);
    if (e.size > cap) {
      throw new ParityInputError("bad_trades_csv", `The XLSX part ${name} is larger than the ${cap}-byte limit.`);
    }
    let raw: Uint8Array;
    if (e.method === 0) raw = data;
    else if (e.method === 8) {
      try {
        raw = await this.inflate(data, cap);
      } catch {
        throw new ParityInputError("bad_trades_csv", `The XLSX part ${name} could not be decompressed within the ${cap}-byte limit.`);
      }
    } else {
      throw new ParityInputError("bad_trades_csv", `The XLSX part ${name} uses ZIP method ${e.method}, which is not supported.`);
    }
    if (raw.length > cap) {
      throw new ParityInputError("bad_trades_csv", `The XLSX part ${name} is larger than the ${cap}-byte limit.`);
    }
    this.used += raw.length;
    return new TextDecoder().decode(raw);
  }
}

function xmlDecode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e === "amp") return "&";
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return String.fromCodePoint(code);
  });
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return m ? xmlDecode(m[1] ?? m[2] ?? "") : undefined;
}

/** All <t> text inside a fragment (shared string or inline string, rich runs joined). */
function textRuns(fragment: string): string {
  let out = "";
  for (const m of fragment.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)) out += xmlDecode(m[1]!);
  return out;
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function isDateFormatCode(code: string): boolean {
  const bare = code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "").replace(/\\./g, "");
  return /[dmyhs]/i.test(bare) && !/^[#0.,%\s]*$/.test(bare);
}

interface Cell {
  /** Displayed text for strings; the number for numeric cells. */
  value: string | number | boolean | null;
  isDate: boolean;
}

type Grid = Map<number, Map<number, Cell>>;

const DEFAULT_MAX_COLUMNS = 256;
const EXCEL_MAX_COLUMNS = 16_384;
const EXCEL_MAX_ROWS = 1_048_576;
const CELL_REF = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/;

/** Zero-based column of an A1 reference inside Excel's grid, else null. */
function colIndex(ref: string): number | null {
  const m = CELL_REF.exec(ref);
  if (!m) return null;
  let n = 0;
  for (const ch of m[1]!) n = n * 26 + (ch.charCodeAt(0) - 64);
  if (n > EXCEL_MAX_COLUMNS || Number(m[2]) > EXCEL_MAX_ROWS) return null;
  return n - 1;
}

function badCell(): ParityInputError {
  return new ParityInputError("bad_trades_csv", "A sheet of the XLSX has a cell reference outside Excel's grid.");
}

function parseSheet(xml: string, shared: string[], dateStyles: Set<number>, limits: ExportLimits): Grid {
  const grid: Grid = new Map();
  let cells = 0;
  let rowNo = 0;
  for (const rm of xml.matchAll(/<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
    const rAttr = attr(rm[1] ?? "", "r");
    rowNo = rAttr ? Number(rAttr) : rowNo + 1;
    if (!Number.isInteger(rowNo) || rowNo < 1 || rowNo > EXCEL_MAX_ROWS) throw badCell();
    if (rowNo > limits.maxRows + 1) {
      throw new ParityInputError("bad_trades_csv", `A sheet of the XLSX has more than ${limits.maxRows} rows.`);
    }
    const row = new Map<number, Cell>();
    let col = -1;
    for (const cm of (rm[2] ?? "").matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      if (++cells > limits.maxCells) {
        throw new ParityInputError("bad_trades_csv", `A sheet of the XLSX has more than ${limits.maxCells} cells.`);
      }
      const a = cm[1] ?? "";
      const ref = attr(a, "r");
      const at = ref ? colIndex(ref) : col + 1;
      if (at === null || at >= EXCEL_MAX_COLUMNS) throw badCell();
      col = at;
      const t = attr(a, "t") ?? "n";
      const style = Number(attr(a, "s") ?? 0);
      const body = cm[2] ?? "";
      const v = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body)?.[1];
      let value: Cell["value"] = null;
      if (t === "s") value = shared[Number(v)] ?? "";
      else if (t === "inlineStr") value = textRuns(body);
      else if (t === "str" || t === "e" || t === "d") value = v === undefined ? "" : xmlDecode(v);
      else if (t === "b") value = v === "1";
      else if (v !== undefined && v.trim() !== "") value = Number(v);
      row.set(col, { value, isDate: t === "n" && dateStyles.has(style) });
    }
    grid.set(rowNo, row);
  }
  return grid;
}

/** Rows as arrays, after checking widths against the column cap and cell budget. */
function gridRows(grid: Grid, limits: ExportLimits): Cell[][] {
  const maxColumns = limits.maxColumns ?? DEFAULT_MAX_COLUMNS;
  const rowNos = [...grid.keys()].sort((a, b) => a - b);
  const widths = new Map<number, number>();
  let cells = 0;
  for (const r of rowNos) {
    let width = 0;
    for (const c of grid.get(r)!.keys()) if (c + 1 > width) width = c + 1;
    if (width > maxColumns) {
      throw new ParityInputError("bad_trades_csv", `A sheet of the XLSX has a row wider than ${maxColumns} columns.`);
    }
    cells += width;
    if (cells > limits.maxCells) {
      throw new ParityInputError("bad_trades_csv", `A sheet of the XLSX spans more than ${limits.maxCells} cells.`);
    }
    widths.set(r, width);
  }
  return rowNos.map((r) => {
    const row = grid.get(r)!;
    return Array.from({ length: widths.get(r)! }, (_, c) => row.get(c) ?? { value: null, isDate: false });
  });
}

/** Excel serial (1900 or 1904 system) to "YYYY-MM-DD HH:MM", rounded to the minute. */
export function excelSerialToWall(serial: number, date1904 = false): string {
  const epochDays = date1904 ? 24107 : 25569;
  const minutes = Math.round((serial - epochDays) * 1440);
  const d = new Date(minutes * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function cellText(c: Cell, date1904: boolean): string {
  if (c.value === null) return "";
  if (typeof c.value === "boolean") return c.value ? "TRUE" : "FALSE";
  if (typeof c.value === "number") return c.isDate ? excelSerialToWall(c.value, date1904) : numberText(c.value);
  return c.value;
}

function numberText(n: number): string {
  // Shortest round-trip form, as Python's float() reads it back.
  return Number.isFinite(n) ? String(n) : "";
}

/** A date cell or a date string in the "Date and time" column as YYYY-MM-DD HH:MM. */
function tradeTimeText(c: Cell, date1904: boolean): string {
  if (typeof c.value === "number") return excelSerialToWall(c.value, date1904);
  const s = String(c.value ?? "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : s;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

async function readXlsx(b64: string, inflate: InflateFn, limits: ExportLimits): Promise<TradingViewExport> {
  const bytes = base64ToBytes(b64);
  const zip = new XlsxReader(bytes, zipEntries(bytes), inflate, limits);
  if (!zip.has("xl/workbook.xml")) {
    throw new ParityInputError("bad_trades_csv", "The file is a ZIP but not an XLSX workbook (no xl/workbook.xml).");
  }
  const workbook = await zip.text("xl/workbook.xml");
  const date1904 = /<(?:\w+:)?workbookPr\b[^>]*\bdate1904\s*=\s*["'](1|true)["']/i.test(workbook);
  const rels = zip.has("xl/_rels/workbook.xml.rels") ? await zip.text("xl/_rels/workbook.xml.rels") : "";
  const targets = new Map<string, string>();
  for (const m of rels.matchAll(/<(?:\w+:)?Relationship\b([^>]*)\/?>/g)) {
    const id = attr(m[1]!, "Id");
    const target = attr(m[1]!, "Target");
    if (id && target) {
      targets.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`);
    }
  }
  const sheets: Array<{ name: string; path: string }> = [];
  for (const m of workbook.matchAll(/<(?:\w+:)?sheet\b([^>]*)\/?>/g)) {
    const name = attr(m[1]!, "name") ?? "";
    const rid = attr(m[1]!, "r:id") ?? attr(m[1]!, "id");
    const path = rid ? targets.get(rid) : undefined;
    if (path) sheets.push({ name, path });
  }
  const shared: string[] = [];
  if (zip.has("xl/sharedStrings.xml")) {
    const sst = await zip.text("xl/sharedStrings.xml");
    for (const m of sst.matchAll(/<(?:\w+:)?si>([\s\S]*?)<\/(?:\w+:)?si>/g)) shared.push(textRuns(m[1]!));
  }
  const dateStyles = new Set<number>();
  if (zip.has("xl/styles.xml")) {
    const styles = await zip.text("xl/styles.xml");
    const custom = new Map<number, string>();
    for (const m of styles.matchAll(/<(?:\w+:)?numFmt\b([^>]*)\/?>/g)) {
      custom.set(Number(attr(m[1]!, "numFmtId")), attr(m[1]!, "formatCode") ?? "");
    }
    const xfs = /<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/.exec(styles)?.[1] ?? "";
    let i = 0;
    for (const m of xfs.matchAll(/<(?:\w+:)?xf\b([^>]*?)(?:\/>|>)/g)) {
      const id = Number(attr(m[1]!, "numFmtId") ?? 0);
      if (BUILTIN_DATE_FORMATS.has(id) || (custom.has(id) && isDateFormatCode(custom.get(id)!))) dateStyles.add(i);
      i++;
    }
  }

  const byName = (pred: (n: string) => boolean) => sheets.find((s) => pred(norm(s.name)));
  const tradesSheet = byName((n) => n.includes("listoftrades")) ?? byName((n) => n.includes("trades") && !n.includes("analysis"));
  const propsSheet = byName((n) => n.includes("properties")) ?? byName((n) => n.includes("settings"));
  if (!tradesSheet) {
    throw new ParityInputError(
      "bad_trades_csv",
      `The XLSX has no "List of trades" sheet (sheets: ${sheets.map((s) => s.name).join(", ") || "none"}).`,
    );
  }

  const tradeCells = gridRows(parseSheet(await zip.text(tradesSheet.path), shared, dateStyles, limits), limits);
  const headerIdx = tradeCells.findIndex((r) => r.some((c) => {
    const v = String(c.value ?? "");
    return v === "Trade number" || v === "Trade #";
  }));
  if (headerIdx < 0) {
    throw new ParityInputError(
      "bad_trades_csv",
      `The "${tradesSheet.name}" sheet has no header row with 'Trade number' (or 'Trade #').`,
    );
  }
  const header = tradeCells[headerIdx]!.map((c) => String(c.value ?? "").trim());
  while (header.length && header[header.length - 1] === "") header.pop();
  const iTime = header.indexOf("Date and time");
  const out: string[][] = [header];
  for (const r of tradeCells.slice(headerIdx + 1)) {
    if (r.every((c) => c.value === null || c.value === "")) continue;
    out.push(header.map((_, i) => {
      const c = r[i] ?? { value: null, isDate: false };
      return i === iTime ? tradeTimeText(c, date1904) : cellText(c, date1904);
    }));
  }
  const checked = checkTradeRows(out);

  const properties: PropertyRow[] = [];
  const strategyInputs: PropertyRow[] = [];
  const warnings = [...checked.warnings];
  let settings: ExportSettings = {};
  if (propsSheet) {
    let section = "";
    const propCells = gridRows(parseSheet(await zip.text(propsSheet.path), shared, dateStyles, limits), limits);
    for (const r of propCells) {
      const texts = r.map((c) => cellText(c, date1904).trim()).filter((s, i) => s !== "" || i < 2);
      const name = texts[0] ?? "";
      const value = texts.slice(1).filter(Boolean).join(" ");
      if (!name) continue;
      if (!value) {
        section = name;
        continue;
      }
      const row = { section, name, value };
      properties.push(row);
      if (/input/i.test(section)) strategyInputs.push(row);
    }
    const mapped = settingsFromProperties(properties.filter((p) => !/input/i.test(p.section)));
    settings = mapped.settings;
    warnings.push(...mapped.warnings);
  } else {
    warnings.push(`The XLSX has no "Properties" sheet; symbol, timeframe, range and timezone must be passed.`);
  }
  if (strategyInputs.length) {
    warnings.push(
      `The export lists ${strategyInputs.length} strategy input(s); they are not applied. ` +
        "Pass `inputs` for any you changed from the script's defaults.",
    );
  }
  return {
    format: "xlsx",
    csv: toCsv(out),
    rows: out.length - 1,
    closedTrades: checked.closedTrades,
    settings,
    properties,
    strategyInputs,
    warnings,
  };
}

// ─── Properties sheet -> tool settings ────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** One wall-clock time in TradingView's spellings, to "YYYY-MM-DD HH:MM". */
export function parseWallText(s: string): string | null {
  const t = s.trim();
  const p = (n: number) => String(n).padStart(2, "0");
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T,]+(\d{1,2}):(\d{2}))?$/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${p(Number(m[4] ?? 0))}:${m[5] ?? "00"}`;
  m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})(?:[ ,]+(\d{1,2}):(\d{2}))?$/.exec(t);
  if (m && MONTHS[m[1]!.toLowerCase()]) {
    return `${m[3]}-${p(MONTHS[m[1]!.toLowerCase()]!)}-${p(Number(m[2]))} ${p(Number(m[4] ?? 0))}:${m[5] ?? "00"}`;
  }
  m = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})(?:[ ,]+(\d{1,2}):(\d{2}))?$/.exec(t);
  if (m && MONTHS[m[2]!.toLowerCase()]) {
    return `${m[3]}-${p(MONTHS[m[2]!.toLowerCase()]!)}-${p(Number(m[1]))} ${p(Number(m[4] ?? 0))}:${m[5] ?? "00"}`;
  }
  return null;
}

function parseRange(value: string): [string, string] | null {
  const parts = value.split(/\s+(?:—|–|-|to)\s+|\s*[—–]\s*/);
  if (parts.length !== 2) return null;
  const a = parseWallText(parts[0]!);
  const b = parseWallText(parts[1]!);
  return a && b ? [a, b] : null;
}

function num(value: string): number | null {
  const m = /-?\d[\d,]*(?:\.\d+)?|-?\.\d+/.exec(value.replace(/ /g, " "));
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function onOff(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  if (["on", "yes", "true", "enabled", "checked", "✓", "✔", "1"].includes(v)) return true;
  if (["off", "no", "false", "disabled", "unchecked", "✗", "✕", "-", "0"].includes(v)) return false;
  return null;
}

export function settingsFromProperties(rows: PropertyRow[]): { settings: ExportSettings; warnings: string[] } {
  const settings: ExportSettings = {};
  const overrides: Record<string, number | string | boolean> = {};
  const warnings: string[] = [];
  const unread = (row: PropertyRow, input: string) =>
    warnings.push(`Could not read the export's "${row.name}" (${row.value}); pass ${input} if it matters.`);
  const ranges: Array<{ row: PropertyRow; range: [string, string] }> = [];
  let rangeStart: string | undefined;
  let rangeEnd: string | undefined;

  for (const row of rows) {
    const k = norm(row.name);
    const v = row.value.trim();
    if (k === "symbol" || k === "ticker") {
      settings.symbol = v;
    } else if (k === "timeframe" || k === "resolution" || k === "interval" || k === "charttimeframe") {
      try { settings.timeframe = normalizeTimeframe(v); } catch { unread(row, "`timeframe`"); }
    } else if (k === "timezone" || k === "charttimezone") {
      settings.chart_timezone = v;
    } else if (k.endsWith("range") && /trading|backtest|date|testing|^range$/.test(k)) {
      const r = parseRange(v);
      if (r) ranges.push({ row, range: r });
      else unread(row, "`range_start` / `range_end`");
    } else if (k === "rangestart" || k === "startdate" || k === "from" || k === "start") {
      const w = parseWallText(v);
      if (w) rangeStart = w; else unread(row, "`range_start`");
    } else if (k === "rangeend" || k === "enddate" || k === "to" || k === "end") {
      const w = parseWallText(v);
      if (w) rangeEnd = w; else unread(row, "`range_end`");
    } else if (k === "initialcapital") {
      const n = num(v);
      if (n !== null) overrides.initial_capital = n; else unread(row, "`strategy_overrides.initial_capital`");
    } else if (k === "ordersize" || k === "defaultordersize") {
      const n = num(v);
      const unit = v.toLowerCase();
      if (n === null) unread(row, "`strategy_overrides.default_qty_value`");
      else {
        overrides.default_qty_value = n;
        if (unit.includes("%") || unit.includes("equity")) overrides.default_qty_type = "percent_of_equity";
        else if (/contract|share|lot|unit/.test(unit)) overrides.default_qty_type = "fixed";
        else if (/[a-z]{3,}/.test(unit.replace(/[\d.,\s]/g, ""))) overrides.default_qty_type = "cash";
        else unread(row, "`strategy_overrides.default_qty_type`");
      }
    } else if (k === "pyramiding") {
      const n = num(v);
      if (n !== null && Number.isInteger(n)) overrides.pyramiding = n; else unread(row, "`strategy_overrides.pyramiding`");
    } else if (k === "commission") {
      const n = num(v);
      const unit = v.toLowerCase();
      if (n === null) unread(row, "`strategy_overrides.commission_value`");
      else {
        overrides.commission_value = n;
        if (unit.includes("%")) overrides.commission_type = "percent";
        else if (unit.includes("per contract")) overrides.commission_type = "cash_per_contract";
        else if (unit.includes("per order")) overrides.commission_type = "cash_per_order";
        else if (n !== 0) unread(row, "`strategy_overrides.commission_type`");
      }
    } else if (k === "slippage") {
      const n = num(v);
      if (n !== null && Number.isInteger(n)) overrides.slippage = n; else unread(row, "`strategy_overrides.slippage`");
    } else if (k === "fillorders" || k === "fillorderson") {
      for (const part of v.split(/[,;\n]/)) {
        const [label, state] = part.split(":").map((s) => s.trim());
        const b = state === undefined ? null : onOff(state);
        if (!label || b === null) continue;
        const l = norm(label);
        if (l.includes("barclose")) overrides.process_orders_on_close = b;
        else if (l.includes("magnifier")) settings.runtime = { ...settings.runtime, bar_magnifier: b };
      }
    } else if (k.includes("onbarclose")) {
      const b = onOff(v);
      if (b !== null) overrides.process_orders_on_close = b; else unread(row, "`strategy_overrides.process_orders_on_close`");
    } else if (k.includes("barmagnifier")) {
      const b = onOff(v);
      if (b !== null) settings.runtime = { ...settings.runtime, bar_magnifier: b };
      else unread(row, "`runtime.bar_magnifier`");
    }
    // Anything else (chart type, point value, margin, recalculate, ...) is not a tool setting.
  }

  if (ranges.length === 1) {
    [rangeStart, rangeEnd] = [rangeStart ?? ranges[0]!.range[0], rangeEnd ?? ranges[0]!.range[1]];
  } else if (ranges.length > 1) {
    const distinct = new Set(ranges.map((r) => r.range.join("|")));
    if (distinct.size === 1) [rangeStart, rangeEnd] = ranges[0]!.range;
    else {
      warnings.push(
        `The export states ${ranges.map((r) => `"${r.row.name}" ${r.row.value}`).join(" and ")}; ` +
          "pass `range_start` (the first bar TradingView computed) to choose.",
      );
    }
  }
  if (rangeStart) settings.range_start_wall = rangeStart;
  if (rangeEnd) settings.range_end_wall = rangeEnd;
  if (Object.keys(overrides).length) settings.strategy_overrides = overrides;
  return { settings, warnings };
}
