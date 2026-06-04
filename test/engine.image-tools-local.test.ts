import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { LocalRunner } from "../src/engine.js";

const PREFIX = resolve("test/fixtures/fake-prefix");

test("LocalRunner.checkImage returns baked-in descriptor (no docker)", async () => {
  const r = new LocalRunner(PREFIX);
  const info = await r.checkImage("anything", false) as { mode: string; baked_in: boolean };
  assert.equal(info.mode, "local");
  assert.equal(info.baked_in, true);
});

test("LocalRunner.pullImage is a no-op in local mode", async () => {
  const r = new LocalRunner(PREFIX);
  const res = await r.pullImage("ghcr.io/x:1");
  assert.equal(res.pulled, false);
  assert.match(res.output, /baked into the image/);
});
