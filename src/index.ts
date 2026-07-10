#!/usr/bin/env node
/**
 * @pineforge/backtest-mcp — docker (npx/host) entrypoint.
 *
 * Drives the host Docker daemon (DockerRunner) and exposes the engine-image
 * management tools (pull_engine_image, check_engine_image). All tool logic
 * lives in ./server.ts; this entry only picks the runner + tool surface.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DockerRunner, DEFAULT_IMAGE } from "./engine.js";
import { createServer } from "./server.js";

const server = createServer(new DockerRunner(), { imageTools: true });
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[pineforge-mcp] ready (stdio) — docker transpile + backtest, image:", DEFAULT_IMAGE);
