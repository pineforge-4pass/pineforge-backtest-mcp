/**
 * The source with comments removed and string contents blanked, so only code is
 * searched; null when a string never ends (the scanner cannot tell code from
 * text). Strings follow pineforge-codegen 1.0.1's lexer: triple-quoted strings
 * run to the matching triple quote, `"` / `'` strings to the matching unescaped
 * quote, both across line breaks (a wrapped string continues on the next line).
 */
function codeOnly(pine: string): string | null {
  let out = "";
  let i = 0;
  while (i < pine.length) {
    const c = pine[i]!;
    if (c === "/" && pine[i + 1] === "/") {
      while (i < pine.length && pine[i] !== "\n") i++; // a // comment runs to the end of the line
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = pine.startsWith(c.repeat(3), i);
      const close = triple ? c.repeat(3) : c;
      i += close.length;
      for (;;) {
        if (i >= pine.length) return null;
        if (pine[i] === "\\") {
          i += 2;
          continue;
        }
        if (pine.startsWith(close, i)) break;
        i++;
      }
      i += close.length;
      out += '""';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// The literal declaration, searched in the raw source when strings cannot be told apart.
const LITERAL_DECLARATION = /(^|[^\w.])use_bar_magnifier\s*=(?!=)[\s(]*true(?![\w.])/;

/** Strip whitespace and outer parentheses that enclose the whole expression. */
function unparen(expr: string): string {
  let e = expr.trim();
  for (;;) {
    if (!e.startsWith("(") || !e.endsWith(")")) return e;
    let depth = 0;
    for (let i = 0; i < e.length; i++) {
      if (e[i] === "(") depth++;
      else if (e[i] === ")" && --depth === 0 && i < e.length - 1) return e; // "(a) or (b)"
    }
    e = e.slice(1, -1).trim();
  }
}

/**
 * True when the script's strategy() declaration passes use_bar_magnifier = true,
 * read the way pineforge-codegen 1.0.1 reads it (emit_top._declares_bar_magnifier):
 * the keyword argument of the strategy(...) declaration must be the literal
 * true. Parentheses around it do not matter; comments and strings are not code;
 * any other expression (a variable, `not false`) does not declare the magnifier,
 * and codegen warns about it.
 */
export function declaresMagnifier(pine: string): boolean {
  const code = codeOnly(pine);
  // Unsure (a string that never ends): take a literal `use_bar_magnifier = true` as declared.
  if (code === null) return LITERAL_DECLARATION.test(pine);
  const decl = /(^|[^\w.])strategy\s*\(/.exec(code);
  if (!decl) return false;
  // Split the declaration's arguments at top-level commas.
  const args: string[] = [];
  let depth = 0;
  let from = decl.index + decl[0].length;
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[") depth++;
    else if ((c === ")" || c === "]") && depth > 0) depth--;
    else if (c === ")" || (c === "," && depth === 0)) {
      args.push(code.slice(from, i));
      from = i + 1;
      if (c === ")") break;
    }
  }
  for (const arg of args) {
    const m = /^\s*use_bar_magnifier\s*=(?!=)([\s\S]*)$/.exec(arg);
    if (m) return unparen(m[1]!) === "true";
  }
  return false;
}

/** The harness's line when a script declares the bar magnifier but its run had none. */
export function magnifierNotRun(harnessLog: unknown): string | null {
  if (!Array.isArray(harnessLog)) return null;
  for (const line of harnessLog) {
    const m = typeof line === "string" ? /^\s*magnifier: declared-not-run: (.*)$/.exec(line) : null;
    if (m) return m[1]!.trim();
  }
  return null;
}

/**
 * The 1-minute window the harness reads for a declared magnifier: from the
 * range start through the close of the final chart bar, i.e. its open plus the
 * chart interval minus 1 ms (run_strategy._declared_magnifier_plan).
 */
export function magnifierEndMs(lastChartOpenMs: number, intervalMs: number): number {
  return lastChartOpenMs + intervalMs - 1;
}

/** Inclusive 1-minute feed bounds for the chart bars the harness will read. */
export function magnifierWindow(firstChartOpenMs: number, lastChartOpenMs: number, chartDurationMs: number): {
  startMs: number;
  endMs: number;
} {
  return { startMs: firstChartOpenMs, endMs: magnifierEndMs(lastChartOpenMs, chartDurationMs) };
}
