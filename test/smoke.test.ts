import { test } from "node:test";
import assert from "node:assert/strict";
import { VERSION } from "../src/version.js";

test("version is a semver string", () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});
