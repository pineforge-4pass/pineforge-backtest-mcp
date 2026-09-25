import { test } from "node:test";
import assert from "node:assert/strict";
import { VERSION } from "../src/version.js";

test("version is a semver string", () => {
  // A prerelease base pineforge-release makes this a prerelease (0.9.32-rc.1).
  assert.match(VERSION, /^\d+\.\d+\.\d+(-(alpha|beta|rc)\.\d+)?$/);
});
