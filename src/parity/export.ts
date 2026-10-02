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
  /**
   * Cells read from the whole workbook: the sheets read (List of trades and
   * Properties) share one budget, empty cells inside a row's span included.
   */
  maxCells: number;
  /** Columns of one sheet row (default 256; Excel's own limit is 16,384). */
  maxColumns?: number;
  /** Entries of the shared-strings part, counted before any is decoded (default 2,000,000). */
  maxSharedStrings?: number;
}

// A real TradingView export holds a few hundred distinct texts (types, signals,
// the header, the Properties labels). The local cap follows the local byte caps
// instead: a 64 MiB part holds at most about 4 million minimal (16-byte)
// entries, and half of that keeps the decoded strings to roughly 100-200 MB in
// the local process.
const DEFAULT_MAX_SHARED_STRINGS = 2_000_000;

export const DEFAULT_EXPORT_LIMITS: ExportLimits = {
  maxInputChars: 32 * 1024 * 1024,
  maxPartBytes: 64 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxRows: 400_000,
  maxCells: 8_000_000,
  maxSharedStrings: DEFAULT_MAX_SHARED_STRINGS,
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
    // A reference outside Unicode stays as written instead of throwing.
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : `&${e};`;
  });
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return m ? xmlDecode(m[1] ?? m[2] ?? "") : undefined;
}

interface XmlElement {
  /** Text between the tag name and `>` (or `/>`). */
  attrs: string;
  /** Text between the opening and the closing tag; null for `<name .../>`. */
  body: string | null;
}

// A tag name ends at whitespace, "/", ">" or another "<"; names the reader
// looks for are short, so a longer run is not one of its tags and is not read
// further. Together with indexOf this keeps every scan linear in the input.
const NAME_END = /[\s/<>]/;
const MAX_TAG_NAME = 64;

/**
 * Every `<name ...>...</name>` and `<name .../>` element of `xml` in order, the
 * name matched with or without a namespace prefix (`x:row`). One left-to-right
 * pass driven by indexOf, so the cost is linear in the input. The first opening
 * tag without a closing tag ends the scan with an error: nothing after it is
 * read, and nothing is searched twice. Same-name nesting is not expected (the
 * first closing tag closes the element).
 */
function* xmlElements(xml: string, name: string): Generator<XmlElement> {
  let pos = 0;
  for (;;) {
    const lt = xml.indexOf("<", pos);
    if (lt < 0) return;
    let end = lt + 1;
    const stop = Math.min(xml.length, lt + 1 + MAX_TAG_NAME);
    while (end < stop && !NAME_END.test(xml[end]!)) end++;
    if (end === lt + 1 || (end < xml.length && !NAME_END.test(xml[end]!)) || xml[end] === "<") {
      pos = lt + 1; // no name, a name too long for any tag read here, or "<" inside it
      continue;
    }
    const qname = xml.slice(lt + 1, end);
    const colon = qname.lastIndexOf(":");
    if ((colon < 0 ? qname : qname.slice(colon + 1)) !== name) {
      pos = lt + 1;
      continue;
    }
    const gt = xml.indexOf(">", end);
    if (gt < 0) throw unclosed(name);
    if (xml[gt - 1] === "/") {
      yield { attrs: xml.slice(end, gt - 1), body: null };
      pos = gt + 1;
      continue;
    }
    const closing = `</${qname}`;
    let at = gt + 1;
    let close = -1;
    let after = -1;
    for (;;) {
      close = xml.indexOf(closing, at);
      if (close < 0) throw unclosed(name);
      after = close + closing.length;
      while (after < xml.length && /\s/.test(xml[after]!)) after++;
      if (xml[after] === ">") break;
      at = close + closing.length;
    }
    yield { attrs: xml.slice(end, gt), body: xml.slice(gt + 1, close) };
    pos = after + 1;
  }
}

function firstElement(xml: string, name: string): XmlElement | undefined {
  for (const el of xmlElements(xml, name)) return el;
  return undefined;
}

function unclosed(name: string): ParityInputError {
  return new ParityInputError("bad_trades_csv", `The XLSX has a <${name}> tag that is never closed.`);
}

/** All <t> text inside a fragment (shared string or inline string, rich runs joined). */
function textRuns(fragment: string): string {
  let out = "";
  for (const t of xmlElements(fragment, "t")) out += xmlDecode(t.body ?? "");
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

/** Cells counted so far across every sheet read from one workbook. */
interface CellBudget {
  /** Cells written in the sheets' XML. */
  parsed: number;
  /** Cells spanned by the rows, empty ones included (what gridRows allocates). */
  spanned: number;
}

function parseSheet(xml: string, shared: string[], dateStyles: Set<number>, limits: ExportLimits, budget: CellBudget): Grid {
  const grid: Grid = new Map();
  let rowNo = 0;
  for (const rm of xmlElements(xml, "row")) {
    const rAttr = attr(rm.attrs, "r");
    rowNo = rAttr ? Number(rAttr) : rowNo + 1;
    if (!Number.isInteger(rowNo) || rowNo < 1 || rowNo > EXCEL_MAX_ROWS) throw badCell();
    if (rowNo > limits.maxRows + 1) {
      throw new ParityInputError("bad_trades_csv", `A sheet of the XLSX has more than ${limits.maxRows} rows.`);
    }
    const row = new Map<number, Cell>();
    let col = -1;
    for (const cm of xmlElements(rm.body ?? "", "c")) {
      if (++budget.parsed > limits.maxCells) {
        throw new ParityInputError("bad_trades_csv",
          `The sheets read from the XLSX have more than ${limits.maxCells} cells together.`);
      }
      const a = cm.attrs;
      const ref = attr(a, "r");
      const at = ref ? colIndex(ref) : col + 1;
      if (at === null || at >= EXCEL_MAX_COLUMNS) throw badCell();
      col = at;
      const t = attr(a, "t") ?? "n";
      const style = Number(attr(a, "s") ?? 0);
      const body = cm.body ?? "";
      const v = firstElement(body, "v")?.body ?? undefined;
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
function gridRows(grid: Grid, limits: ExportLimits, budget: CellBudget): Cell[][] {
  const maxColumns = limits.maxColumns ?? DEFAULT_MAX_COLUMNS;
  const rowNos = [...grid.keys()].sort((a, b) => a - b);
  const widths = new Map<number, number>();
  for (const r of rowNos) {
    let width = 0;
    for (const c of grid.get(r)!.keys()) if (c + 1 > width) width = c + 1;
    if (width > maxColumns) {
      throw new ParityInputError("bad_trades_csv", `A sheet of the XLSX has a row wider than ${maxColumns} columns.`);
    }
    budget.spanned += width;
    if (budget.spanned > limits.maxCells) {
      throw new ParityInputError("bad_trades_csv",
        `The sheets read from the XLSX span more than ${limits.maxCells} cells together.`);
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
  const date1904 = /^(1|true)$/i.test(attr(firstElement(workbook, "workbookPr")?.attrs ?? "", "date1904") ?? "");
  const rels = zip.has("xl/_rels/workbook.xml.rels") ? await zip.text("xl/_rels/workbook.xml.rels") : "";
  const targets = new Map<string, string>();
  for (const rel of xmlElements(rels, "Relationship")) {
    const id = attr(rel.attrs, "Id");
    const target = attr(rel.attrs, "Target");
    if (id && target) {
      targets.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`);
    }
  }
  const sheets: Array<{ name: string; path: string }> = [];
  for (const sheet of xmlElements(workbook, "sheet")) {
    const name = attr(sheet.attrs, "name") ?? "";
    const rid = attr(sheet.attrs, "r:id") ?? attr(sheet.attrs, "id");
    const path = rid ? targets.get(rid) : undefined;
    if (path) sheets.push({ name, path });
  }
  const shared: string[] = [];
  if (zip.has("xl/sharedStrings.xml")) {
    const sst = await zip.text("xl/sharedStrings.xml");
    // Count the entries first, so an oversized part is refused before any string is decoded.
    const maxShared = limits.maxSharedStrings ?? DEFAULT_MAX_SHARED_STRINGS;
    let entries = 0;
    for (const _si of xmlElements(sst, "si")) {
      if (++entries > maxShared) {
        throw new ParityInputError("bad_trades_csv", `The XLSX has more than ${maxShared} shared strings.`);
      }
    }
    for (const si of xmlElements(sst, "si")) shared.push(textRuns(si.body ?? ""));
  }
  const dateStyles = new Set<number>();
  if (zip.has("xl/styles.xml")) {
    const styles = await zip.text("xl/styles.xml");
    const custom = new Map<number, string>();
    for (const fmt of xmlElements(styles, "numFmt")) {
      custom.set(Number(attr(fmt.attrs, "numFmtId")), attr(fmt.attrs, "formatCode") ?? "");
    }
    const xfs = firstElement(styles, "cellXfs")?.body ?? "";
    let i = 0;
    for (const xf of xmlElements(xfs, "xf")) {
      const id = Number(attr(xf.attrs, "numFmtId") ?? 0);
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

  // One cell budget for the whole workbook: the trades sheet and the Properties sheet draw on it together.
  const budget: CellBudget = { parsed: 0, spanned: 0 };
  const tradeCells = gridRows(parseSheet(await zip.text(tradesSheet.path), shared, dateStyles, limits, budget), limits, budget);
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
    const propCells = gridRows(parseSheet(await zip.text(propsSheet.path), shared, dateStyles, limits, budget), limits, budget);
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

// Range separators: a dash ("—", "–") with or without spaces, or " - " / " to "
// between spaces. Found with indexOf (a split regex over long whitespace runs
// backtracks quadratically); exactly one separator makes a range.
const RANGE_SEPARATORS = ["—", "–", " - ", " to "];

function parseRange(value: string): [string, string] | null {
  const v = value.replace(/\s/g, " ");
  let found: { at: number; len: number } | null = null;
  for (const sep of RANGE_SEPARATORS) {
    const at = v.indexOf(sep);
    if (at < 0) continue;
    if (found || v.indexOf(sep, at + sep.length) >= 0) return null;
    found = { at, len: sep.length };
  }
  if (!found) return null;
  const a = parseWallText(v.slice(0, found.at));
  const b = parseWallText(v.slice(found.at + found.len));
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
