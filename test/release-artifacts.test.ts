import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore workflow module.
import { chooseArtifact } from "../scripts/release-artifacts.mjs";
const artifact = (name: string, expired = false) => ({ name, expired });
test("reruns retain history and use the newest evidence for the same source run", () => {
  const a = [artifact("offline-runtime-amd64-17-1"), artifact("offline-runtime-amd64-17-2"), artifact("offline-runtime-amd64-18-9")];
  assert.equal(chooseArtifact(a, "offline-runtime-amd64", 17), "offline-runtime-amd64-17-2");
  assert.equal(chooseArtifact(a, "offline-runtime-amd64", 18), "offline-runtime-amd64-18-9");
  assert.throws(() => chooseArtifact(a, "offline-runtime-arm64", 17));
  assert.throws(() => chooseArtifact(a, "offline-runtime-amd64", 19));
});
test("an expired newest attempt cannot be replaced by an older green artifact", () => {
  assert.throws(() => chooseArtifact([artifact("offline-gate-17-1"), artifact("offline-gate-17-2", true)], "offline-gate", 17), /expired/);
  assert.throws(() => chooseArtifact([artifact("offline-gate-17-two")], "offline-gate", 17), /missing/);
});
