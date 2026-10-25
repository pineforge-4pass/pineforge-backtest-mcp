#!/usr/bin/env node
// External transport only: --paginate --slurp returns all recorded pages;
// an ordinary API call returns the first page, as the real gh CLI does.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const file = process.env.PF_PROBE_STATE;
const state = JSON.parse(readFileSync(file, "utf8"));
const args = process.argv.slice(2);
state.calls.push(args);
writeFileSync(file, JSON.stringify(state));

if (args[0] === "api") {
  const route = args.at(-1);
  assert.ok(Object.hasOwn(state.pages, route), `unexpected API route: ${route}`);
  assert.equal(args.includes("--paginate"), args.includes("--slurp"));
  const pages = state.pages[route];
  console.log(JSON.stringify(args.includes("--paginate") ? pages : pages[0]));
} else {
  assert.deepEqual(args.slice(0, 2), ["run", "download"]);
  const files = state.downloads[args[2]];
  assert.ok(files, `unexpected download: ${args[2]}`);
  assert.equal(args[args.indexOf("--name") + 1], files.name);
  const dir = args[args.indexOf("--dir") + 1];
  // Record the real helper's temporary directory so the test can remove it.
  state.downloadDirs.push(dir);
  writeFileSync(file, JSON.stringify(state));
  writeFileSync(join(dir, "gate-receipt.json"), JSON.stringify(files.receipt));
}
