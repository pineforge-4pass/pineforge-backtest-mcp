#!/usr/bin/env node
/**
 * @pineforge/codegen-mcp — local (in-container) entrypoint.
 *
 * Used by the self-contained Docker image where the pineforge-release base
 * (engine runtime + bundled codegen) is baked in: runs the engine in-process
 * (LocalRunner), no host Docker daemon. The MCP
 * image *is* the container, so the image-management tools are omitted; a
 * read-only engine_info tool is registered instead. All tool logic lives in
 * ./server.ts.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LocalRunner } from "./engine.js";
import { createServer } from "./server.js";

const server = createServer(new LocalRunner(), { imageTools: false });
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[pineforge-mcp] ready (stdio) — local in-process transpile + backtest");
