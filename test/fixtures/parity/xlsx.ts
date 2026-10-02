/**
 * Builds TradingView-style Strategy Tester XLSX reports for the tests (see
 * README.md for the layout followed). Minimal OOXML: shared strings, one date
 * style, deflated ZIP parts.
 */

import { deflateRawSync } from "node:zlib";
import { parseCsv } from "../../../src/parity/csv.js";

export type XCell = string | number | boolean | null | { date: string };

export interface XSheet {
  name: string;
  rows: XCell[][];
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A ZIP of `files` (deflated unless `store` is set). */
export function zip(files: Array<{ name: string; data: Uint8Array; store?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const body = f.store ? Buffer.from(f.data) : deflateRawSync(f.data);
    const crc = crc32(f.data);
    const method = f.store ? 0 : 8;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function colName(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** "YYYY-MM-DD HH:MM" to an Excel serial (1900 system). */
export function wallToSerial(wall: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(wall);
  if (!m) throw new Error(`bad wall time ${wall}`);
  const ms = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!);
  return ms / 86_400_000 + 25569;
}

export function buildXlsx(sheets: XSheet[]): Buffer {
  const strings: string[] = [];
  const index = new Map<string, number>();
  const sst = (s: string) => {
    let i = index.get(s);
    if (i === undefined) {
      i = strings.length;
      strings.push(s);
      index.set(s, i);
    }
    return i;
  };
  const sheetXml = (rows: XCell[][]) => {
    const body = rows.map((r, ri) => {
      const cells = r.map((c, ci) => {
        const ref = `${colName(ci)}${ri + 1}`;
        if (c === null) return "";
        if (typeof c === "object") return `<c r="${ref}" s="1"><v>${wallToSerial(c.date)}</v></c>`;
        if (typeof c === "number") return `<c r="${ref}"><v>${c}</v></c>`;
        if (typeof c === "boolean") return `<c r="${ref}" t="b"><v>${c ? 1 : 0}</v></c>`;
        return `<c r="${ref}" t="s"><v>${sst(c)}</v></c>`;
      }).join("");
      return `<row r="${ri + 1}">${cells}</row>`;
    }).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
  };
  const sheetParts = sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, xml: sheetXml(s.rows) }));
  const enc = (s: string) => Buffer.from(s, "utf8");
  const files = [
    {
      name: "[Content_Types].xml",
      data: enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheetParts.map((p) => `<Override PartName="/${p.name}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`),
    },
    {
      name: "_rels/.rels",
      data: enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    },
    {
      name: "xl/workbook.xml",
      data: enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId${sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`),
    },
    {
      name: "xl/styles.xml",
      data: enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd hh:mm"/></numFmts><fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" xfId="0"/><xf numFmtId="164" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`),
    },
    ...sheetParts.map((p) => ({ name: p.name, data: enc(p.xml) })),
  ];
  // Shared strings are complete only after every sheet is rendered.
  files.push({
    name: "xl/sharedStrings.xml",
    data: enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join("")}</sst>`),
  });
  return zip(files);
}

const NUMERIC = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;

/** The "List of trades" sheet of a CSV export: dates as serials, numbers as numbers. */
export function tradesSheetFromCsv(csv: string): XSheet {
  const rows = parseCsv(csv.replace(/^﻿/, ""));
  const header = rows[0]!;
  const iTime = header.indexOf("Date and time");
  return {
    name: "List of trades",
    rows: [
      header,
      ...rows.slice(1).map((r) => r.map((v, i): XCell => {
        if (i === iTime) return { date: v };
        if (v === "") return null;
        return NUMERIC.test(v) ? Number(v) : v;
      })),
    ],
  };
}

export const SAMPLE_PROPERTIES: XCell[][] = [
  ["Date range"],
  ["Trading range", "Jan 1, 2020, 00:00 — Apr 1, 2025, 08:00"],
  ["Symbol info"],
  ["Symbol", "BINANCE:ETHUSDT.P"],
  ["Timeframe", "15m"],
  ["Chart type", "Candles"],
  ["Point value", "1"],
  ["Currency", "USDT"],
  ["Tick size", "0.01"],
  ["Strategy inputs"],
  ["Max contracts", 5],
  ["Strategy properties"],
  ["Initial capital", 1000000],
  ["Account currency", "Default"],
  ["Order size", "1 Contracts"],
  ["Pyramiding", "5 orders"],
  ["Commission", "0 %"],
  ["Verify price for limit orders", "0 ticks"],
  ["Slippage", "0 ticks"],
  ["Margin for long positions", "100 %"],
  ["Margin for short positions", "100 %"],
  ["Recalculate", "After order is filled: Off, On every tick: Off"],
  ["Fill orders", "On bar close: Off, Using bar magnifier: Off, Using standard OHLC: On"],
];

/** A full TradingView-style report around a CSV trade list. */
export function reportXlsx(csv: string, properties: XCell[][] = SAMPLE_PROPERTIES): Buffer {
  return buildXlsx([
    { name: "Performance", rows: [["", "All", "Long", "Short"], ["Net profit", 79.83, 79.83, 0]] },
    { name: "Trades analysis", rows: [["", "All"], ["Total trades", 5]] },
    { name: "Risk performance ratios", rows: [["", "All"], ["Sharpe ratio", 0]] },
    tradesSheetFromCsv(csv),
    { name: "Properties", rows: properties },
  ]);
}
