/**
 * MCP stdio client helpers for the check_tradingview_parity E2E files.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const TOOL = "check_tradingview_parity";
const CALL_TIMEOUT_MS = Number(process.env.PF_E2E_CALL_TIMEOUT_MS ?? 1_200_000);

export async function connect(): Promise<Client> {
  const argv = JSON.parse(process.env.PF_E2E_SERVER ?? '["node","dist/index.js"]') as string[];
  const transport = new StdioClientTransport({
    command: argv[0]!,
    args: argv.slice(1),
    env: { ...(process.env as Record<string, string>) },
    stderr: "inherit",
  });
  const client = new Client({ name: "parity-e2e", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

export function pathMapper(): (s: string) => string {
  const spec = process.env.PF_E2E_PATH_MAP;
  if (!spec) return (s) => s;
  const [from, to] = spec.split("=") as [string, string];
  return (s) => (s.startsWith(from) ? to + s.slice(from.length) : s);
}

export interface CallOutcome {
  isError: boolean;
  text: string;
  data: Record<string, unknown> | undefined;
}

export async function callParity(client: Client, args: Record<string, unknown>): Promise<CallOutcome> {
  const r = await client.callTool({ name: TOOL, arguments: args }, undefined, {
    timeout: CALL_TIMEOUT_MS,
  });
  const content = (r.content ?? []) as Array<{ type: string; text?: string }>;
  const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  return {
    isError: r.isError === true,
    text,
    data: r.structuredContent as Record<string, unknown> | undefined,
  };
}
