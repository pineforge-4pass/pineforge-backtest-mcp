import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compareVersions } from "../../scripts/release-version.mjs";
import { normalizedVersion, readLock } from "../../scripts/release-contract.mjs";

const PINE = resolve("test/fixtures/syminfo/btc-ema-crossover.pine");
const FEED = resolve("test/fixtures/syminfo/btcusdt-4h-2188.csv");
const MIN_VOUCH_RELEASE = "1.9.1";
const LEGACY_SKIP_REASON = "legacy release before 1.9.1: pinned image predates strategy.cpp vouch enforcement";
const VOUCH_TEST_NAME = "the pinned release image accepts its generated C++ vouch and refuses changed mounted bytes";

const lock = readLock("release-lock.json");
const image = `${lock.image.repository}@${lock.image.digest}`;

interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number;
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function runDocker(args: string[], input?: string): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolveResult({
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      code: code ?? 1,
    }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function verifyPinnedImage(): Promise<string> {
  assert.match(image, /^ghcr\.io\/pineforge-4pass\/pineforge-release@sha256:[0-9a-f]{64}$/);

  const refs = await runDocker(["image", "inspect", "--format", "{{json .RepoDigests}}", image]);
  assert.equal(refs.code, 0, `${refs.stdout}\n${refs.stderr}`);
  const resolvedRefs = JSON.parse(refs.stdout) as string[];
  console.log(`# observed image refs: ${resolvedRefs.join(",")}`);
  assert.ok(resolvedRefs.includes(image), `Docker did not resolve the committed image index: ${image}`);

  const labels = await runDocker(["image", "inspect", "--format", "{{json .Config.Labels}}", image]);
  assert.equal(labels.code, 0, `${labels.stdout}\n${labels.stderr}`);
  const observedLabels = JSON.parse(labels.stdout) as Record<string, string>;
  const observedVersion = observedLabels["org.opencontainers.image.version"];
  console.log(`# observed image version: ${observedVersion ?? "<missing>"}`);
  const release = normalizedVersion(observedVersion);
  assert.equal(release, lock.release_version, "Docker image release version differs from the validated lock");
  return release;
}

async function runVouchControl(): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "pineforge-cpp-vouch-e2e-"));
  const pinePath = join(work, "strategy.pine");
  const cppPath = join(work, "strategy.cpp");
  const feedPath = join(work, "ohlcv.csv");
  writeFileSync(pinePath, readFileSync(PINE));
  writeFileSync(feedPath, readFileSync(FEED));

  const transpiled = await runDocker([
    "run", "--rm", "--network=none",
    "-e", "PINEFORGE_TRANSPILE_ONLY=1",
    "-v", `${pinePath}:/in/strategy.pine:ro`,
    image,
  ]);
  assert.equal(transpiled.code, 0, transpiled.stderr);
  assert.ok(transpiled.stdout.length > 0, "transpiler produced no C++");
  writeFileSync(cppPath, transpiled.stdout);

  const originalBytes = readFileSync(cppPath);
  const originalDigest = digest(originalBytes);
  const matching = await runDocker([
    "run", "--rm", "--network=none",
    "-e", `PINEFORGE_STRATEGY_CPP_SHA256=${originalDigest}`,
    "-v", `${cppPath}:/in/strategy.cpp:ro`,
    "-v", `${feedPath}:/in/ohlcv.csv:ro`,
    image,
  ]);
  assert.equal(matching.code, 0, matching.stderr);
  const parsed = JSON.parse(matching.stdout);
  assert.equal(typeof parsed, "object");
  assert.ok(parsed && !Array.isArray(parsed));
  assert.ok(parsed.summary, "ordinary parsed backtest has no summary");

  writeFileSync(cppPath, Buffer.from(`${originalBytes.toString("utf8")}\n`));
  const alteredBytes = readFileSync(cppPath);
  assert.notEqual(digest(alteredBytes), originalDigest, "the mounted file was not altered");
  const tamperedControl = await runDocker([
    "run", "--rm", "--network=none",
    "-e", `PINEFORGE_STRATEGY_CPP_SHA256=${originalDigest}`,
    "-v", `${cppPath}:/in/strategy.cpp:ro`,
    "-v", `${feedPath}:/in/ohlcv.csv:ro`,
    image,
  ]);
  assert.equal(tamperedControl.code, 2, `${tamperedControl.stdout}\n${tamperedControl.stderr}`);
  assert.ok(
    tamperedControl.stderr.split(/\r?\n/).includes("[pineforge] refused: mounted strategy.cpp is not vouched for by PINEFORGE_STRATEGY_CPP_SHA256"),
    `missing exact vouch refusal: ${tamperedControl.stderr}`,
  );
  assert.equal(JSON.parse(tamperedControl.stdout).code, "run_request_invalid");
}

const verifiedRelease = await verifyPinnedImage();
if (compareVersions(verifiedRelease, MIN_VOUCH_RELEASE) < 0) {
  test(VOUCH_TEST_NAME, { skip: LEGACY_SKIP_REASON }, () => {});
} else {
  test(VOUCH_TEST_NAME, runVouchControl);
}
