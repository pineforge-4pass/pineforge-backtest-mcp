import { test } from "node:test";
import assert from "node:assert/strict";
import { selectRunner } from "../src/engine.js";

test("defaults to docker mode", () => {
  const prev = process.env.PINEFORGE_ENGINE_MODE;
  delete process.env.PINEFORGE_ENGINE_MODE;
  try { assert.equal(selectRunner().mode, "docker"); }
  finally { if (prev !== undefined) process.env.PINEFORGE_ENGINE_MODE = prev; }
});

test("PINEFORGE_ENGINE_MODE=local selects local", () => {
  const prev = process.env.PINEFORGE_ENGINE_MODE;
  process.env.PINEFORGE_ENGINE_MODE = "local";
  try { assert.equal(selectRunner().mode, "local"); }
  finally { if (prev === undefined) delete process.env.PINEFORGE_ENGINE_MODE; else process.env.PINEFORGE_ENGINE_MODE = prev; }
});
