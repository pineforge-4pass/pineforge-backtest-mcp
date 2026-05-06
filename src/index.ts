#!/usr/bin/env node
/**
 * @pineforge/codegen-mcp — local stdio MCP server.
 *
 * Bridges an AI agent to the hosted PineForge codegen API (transpile,
 * quota) AND to the user's local Docker daemon (backtest runner). Runs
 * on the user's machine so OHLCV files never leave it; only the Pine
 * source travels to the codegen API.
 *
 * Auth: PINEFORGE_API_KEY env var (required).
 * Gateway override: PINEFORGE_GATEWAY env var (default: production URL).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";

// ─── Config ───────────────────────────────────────────────────────────────

const GATEWAY = process.env.PINEFORGE_GATEWAY ?? "https://codegen-gateway.luis-fca.workers.dev";
const API_KEY = process.env.PINEFORGE_API_KEY ?? "";
const DEFAULT_IMAGE = "ghcr.io/fullpass-4pass/pineforge-engine:latest";
const ALLOW_ANYWHERE = process.env.PINEFORGE_ALLOW_ANYWHERE === "1";
const DOCKER_TIMEOUT_MS = Number(process.env.PINEFORGE_DOCKER_TIMEOUT_MS ?? 120_000);

if (!API_KEY) {
  console.error("[pineforge-mcp] PINEFORGE_API_KEY env var is required");
  process.exit(2);
}

// ─── Tool implementations ────────────────────────────────────────────────

interface Quota { used: number; limit: number; period: string; refunded: boolean; }

async function callTranspile(source: string): Promise<{ cpp: string; quota: Quota }> {
  const resp = await fetch(`${GATEWAY}/transpile`, {
    method: "POST",
    headers: { "x-api-key": API_KEY, "content-type": "text/plain" },
    body: source,
  });
  const text = await resp.text();
  const quota: Quota = {
    used: Number(resp.headers.get("x-quota-used") ?? 0),
    limit: Number(resp.headers.get("x-quota-limit") ?? 0),
    period: resp.headers.get("x-quota-period") ?? "",
    refunded: resp.headers.get("x-quota-refunded") === "1",
  };
  if (!resp.ok) throw new Error(`transpile failed (${resp.status}): ${text}`);
  return { cpp: text, quota };
}

async function callGetQuota(): Promise<unknown> {
  const resp = await fetch(`${GATEWAY}/quota`, {
    method: "GET",
    headers: { "x-api-key": API_KEY },
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`get_quota failed (${resp.status}): ${text}`);
  return JSON.parse(text);
}

async function runBacktest(args: { source: string; ohlcv_csv_path: string; image?: string }): Promise<unknown> {
  const csvPath = await resolveCsvPath(args.ohlcv_csv_path);
  const image = args.image ?? DEFAULT_IMAGE;

  // 1. transpile via remote API
  const { cpp } = await callTranspile(args.source);

  // 2. write strategy.cpp into a tmp dir, mount that + the user's CSV
  const tmp = await mkdtemp(join(tmpdir(), "pineforge-bt-"));
  const cppPath = join(tmp, "strategy.cpp");
  await writeFile(cppPath, cpp, "utf8");

  try {
    const { stdout, stderr, code } = await dockerRun(image, cppPath, csvPath);
    if (code !== 0) {
      throw new Error(
        `docker exited ${code}\n` +
        `stderr (last 2KB):\n${stderr.slice(-2048)}`
      );
    }
    let report: unknown;
    try { report = JSON.parse(stdout); }
    catch {
      throw new Error(
        `backtest produced non-JSON output (first 500B):\n${stdout.slice(0, 500)}`
      );
    }
    return { ...(report as object), _meta: { strategy_cpp_bytes: cpp.length, image } };
  } finally {
    rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function pullImage(image: string): Promise<{ image: string; pulled: boolean; output: string }> {
  const child = spawn("docker", ["pull", image], { stdio: ["ignore", "pipe", "pipe"] });
  const { stdout, stderr, code } = await collectChild(child, DOCKER_TIMEOUT_MS);
  if (code !== 0) throw new Error(`docker pull failed (${code}): ${stderr.slice(-1024)}`);
  return { image, pulled: true, output: (stdout + stderr).trim().slice(-2048) };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

async function resolveCsvPath(p: string): Promise<string> {
  const abs = isAbsolute(p) ? p : resolve(process.cwd(), p);
  if (!ALLOW_ANYWHERE && !abs.startsWith(process.cwd() + "/") && abs !== process.cwd()) {
    throw new Error(
      `OHLCV path '${abs}' is outside cwd '${process.cwd()}'. ` +
      `Set PINEFORGE_ALLOW_ANYWHERE=1 to override.`
    );
  }
  const st = await stat(abs).catch(() => null);
  if (!st || !st.isFile()) throw new Error(`OHLCV file not found: ${abs}`);
  // Sanity-check header line.
  const head = (await readFile(abs, "utf8")).slice(0, 200).split(/\r?\n/)[0] ?? "";
  const expected = ["timestamp", "open", "high", "low", "close", "volume"];
  const cols = head.toLowerCase().split(",").map((s) => s.trim());
  if (expected.some((c, i) => cols[i] !== c)) {
    throw new Error(
      `OHLCV header mismatch. Expected: ${expected.join(",")}\nGot: ${head}`
    );
  }
  return abs;
}

interface DockerResult { stdout: string; stderr: string; code: number; }

async function dockerRun(image: string, cppPath: string, csvPath: string): Promise<DockerResult> {
  const child = spawn(
    "docker",
    [
      "run", "--rm",
      "--network=none",
      "-v", `${cppPath}:/in/strategy.cpp:ro`,
      "-v", `${csvPath}:/in/ohlcv.csv:ro`,
      image,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  return collectChild(child, DOCKER_TIMEOUT_MS);
}

function collectChild(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<DockerResult> {
  return new Promise<DockerResult>((resolveP, rejectP) => {
    let stdout = "", stderr = "";
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectP(new Error(`docker timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", (e) => { clearTimeout(timer); rejectP(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ stdout, stderr, code: code ?? 1 });
    });
  });
}

const asTextResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

// ─── MCP server wiring ────────────────────────────────────────────────────

const server = new McpServer(
  { name: "pineforge-codegen-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.registerTool(
  "transpile_pine",
  {
    description:
      "Transpile PineScript v6 source to a C++ translation unit using the hosted " +
      "PineForge codegen API. Compile failures DO NOT consume the monthly quota — " +
      "only successful 200 responses count. Use backtest_pine if you also want to " +
      "run the strategy locally.",
    inputSchema: {
      source: z.string().describe("PineScript v6 source (must include //@version=6)."),
    },
  },
  async ({ source }) => asTextResult(await callTranspile(source)),
);

server.registerTool(
  "get_quota",
  {
    description:
      "Return the current calendar month's API quota usage for the configured key: " +
      "{used, limit, period, expires_at, tier}. Free — does not consume quota.",
    inputSchema: {},
  },
  async () => asTextResult(await callGetQuota()),
);

server.registerTool(
  "backtest_pine",
  {
    description:
      "Transpile a PineScript v6 strategy and run it against an OHLCV CSV via the " +
      "pineforge-engine Docker image on the user's local machine. The OHLCV file " +
      "stays on the user's box; only the Pine source travels over the network. " +
      "Returns the parsed JSON report (summary, trades, elapsed_seconds).",
    inputSchema: {
      source: z.string().describe("PineScript v6 source."),
      ohlcv_csv_path: z.string().describe(
        "Absolute or cwd-relative path to OHLCV CSV with header " +
        "'timestamp,open,high,low,close,volume' (timestamp = UNIX ms UTC)."
      ),
      image: z.string().optional().describe(
        `Docker image override. Defaults to ${DEFAULT_IMAGE}.`
      ),
    },
  },
  async ({ source, ohlcv_csv_path, image }) =>
    asTextResult(await runBacktest({ source, ohlcv_csv_path, image })),
);

server.registerTool(
  "pull_engine_image",
  {
    description:
      "Run `docker pull` for the pineforge-engine runtime image on the user's " +
      "machine. Does not consume API quota. Useful before the first backtest_pine " +
      "call.",
    inputSchema: {
      image: z.string().optional().describe(
        `Image to pull. Defaults to ${DEFAULT_IMAGE}.`
      ),
    },
  },
  async ({ image }) => asTextResult(await pullImage(image ?? DEFAULT_IMAGE)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[pineforge-mcp] ready (stdio) — gateway:", GATEWAY);
