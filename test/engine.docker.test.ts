import { test } from "node:test";
import assert from "node:assert/strict";
import { DockerRunner } from "../src/engine.js";

test("DockerRunner reports docker mode, not baked in", async () => {
  const r = new DockerRunner("ghcr.io/example/engine:1.2.3");
  assert.equal(r.mode, "docker");
  const info = await r.engineInfo();
  assert.deepEqual(info, {
    mode: "docker", baked_in: false, version: null,
    image: "ghcr.io/example/engine:1.2.3",
  });
});
