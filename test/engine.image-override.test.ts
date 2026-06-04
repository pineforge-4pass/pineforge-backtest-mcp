import { test } from "node:test";
import assert from "node:assert/strict";
import { DockerRunner } from "../src/engine.js";

test("DockerRunner default image used when no per-call override", async () => {
  const r = new DockerRunner("ghcr.io/base:1");
  assert.equal((await r.engineInfo()).image, "ghcr.io/base:1");
});
