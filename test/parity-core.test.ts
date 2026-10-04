import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The grading core under parity/ calls pineforge-engine v1.1.0's own harness
// and grader. These tests pin those vendored files to the bytes of that tag.

const VENDOR = fileURLToPath(new URL("../parity/vendor/", import.meta.url));
const DRIVER = fileURLToPath(new URL("../parity/pf_parity.py", import.meta.url));
const GRADER_SHA256 = "431452ecddc8184937951ddf9a4c5f29029731237301967b5b480800be6fd1a6";

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sums(): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of readFileSync(VENDOR + "SHA256SUMS", "utf8").split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    assert.ok(m, `SHA256SUMS line is not '<sha256>  <file>': ${line}`);
    out.set(m[2]!, m[1]!);
  }
  return out;
}

test("every vendored file matches vendor/SHA256SUMS", () => {
  const listed = sums();
  assert.ok(listed.size > 0);
  for (const [file, expected] of listed) {
    assert.equal(sha256(VENDOR + file), expected, `${file} differs from the vendored bytes`);
  }
});

test("vendor/ holds nothing SHA256SUMS does not list", () => {
  const listed = sums();
  const present = readdirSync(VENDOR).filter((f) => f !== "SHA256SUMS" && f !== "__pycache__");
  assert.deepEqual(present.sort(), [...listed.keys()].sort());
});

test("the grader is pineforge-engine v1.1.0 verify_corpus.py", () => {
  assert.equal(sums().get("verify_corpus.py"), GRADER_SHA256);
  assert.equal(sha256(VENDOR + "verify_corpus.py"), GRADER_SHA256);
  assert.match(readFileSync(VENDOR + "SHA256SUMS", "utf8"),
    /pineforge-engine v1\.1\.0 \(commit 54b3996bb24d840b90d1a4e958ee9d98a7131908\)/);
});

test("the driver reports the grader hash it was vendored with", () => {
  const src = readFileSync(DRIVER, "utf8");
  assert.ok(src.includes(`GRADER_SHA256 = "${GRADER_SHA256}"`));
});
