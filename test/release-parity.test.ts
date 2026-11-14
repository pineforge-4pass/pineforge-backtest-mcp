import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
// @ts-ignore Workflow helpers are exercised directly.
import { prepareParityUpdate, installParityUpdate, verifyParityVendor } from "../scripts/release-parity.mjs";

const names = ["derive_corpus_feeds.py", "parity_paths.py", "pf_release_run.py",
  "run_parity_jailed.py", "run_strategy.py", "verify_corpus.py"];
const localImports = ["derive_corpus_feeds.py", "run_strategy.py", "verify_corpus.py"];
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const bytesOf = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url));
const canonical = (value: any): string => JSON.stringify(sort(value)) + "\n";
function sort(x: any): any {
  return x && typeof x === "object" && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, sort(x[key])])) : x;
}
function bind(lock: any) {
  const { event_id: _event, manifest: _manifest, ...fields } = lock;
  const manifest = Buffer.from(JSON.stringify(fields) + "\n");
  lock.manifest.sha256 = hash(manifest);
  lock.event_id = `sha256:${hash(manifest)}`;
  return manifest;
}
// Generated transport inputs only. These deliberately change every local byte
// stream; they are NOT the engine's 1.12.0 payload or native ABI qualification.
function wire(commit = "a".repeat(40)) {
  const files: Record<string, Buffer> = Object.fromEntries(names.map((name) => [name,
    existsSync(new URL(`../parity/vendor/${name}`, import.meta.url))
      ? Buffer.concat([bytesOf(`parity/vendor/${name}`), Buffer.from(`\n# transport unit test refresh ${commit}\n`)])
      : Buffer.from(`# transport unit test only: ${name} ${commit}\n`),
  ]));
  const lock = JSON.parse(bytesOf("test/fixtures/release/hub-1.12.0-release-manifest.json").toString());
  lock.versions.engine.commit = commit;
  const p = lock.versions.engine.parity;
  p.engine_commit = lock.versions.engine.commit;
  p.payload_sha256 = Object.fromEntries(names.map((name) => [name, hash(files[name]!)]));
  p.descriptor_sha256 = hash(canonical({
    schema: p.schema, source_manifest_sha256: p.source_manifest_sha256,
    engine_commit: p.engine_commit, payload_sha256: p.payload_sha256,
  }));
  p.sums_sha256 = hash(`${p.descriptor_sha256}  PARITY-MANIFEST.json\n` +
    names.map((name) => `${p.payload_sha256[name]}  ${name}\n`).join(""));
  lock.manifest = { asset: "release-manifest.json", sha256: "" };
  return { files, lock, manifest: bind(lock) };
}
function checkout() {
  const root = mkdtempSync(join(tmpdir(), "pf-parity-update-"));
  mkdirSync(join(root, "parity/vendor"), { recursive: true });
  for (const name of ["parity/pf_parity.py", "parity/README.md",
    "parity/vendor/SHA256SUMS", ...localImports.map((name) => `parity/vendor/${name}`)]) {
    writeFileSync(join(root, name), bytesOf(name));
  }
  return root;
}
function unchanged(root: string) {
  for (const name of localImports) assert.deepEqual(readFileSync(join(root, "parity/vendor", name)), bytesOf(`parity/vendor/${name}`));
  for (const name of names.filter((name) => !localImports.includes(name))) assert.equal(existsSync(join(root, "parity/vendor", name)), false);
  for (const name of ["parity/vendor/SHA256SUMS", "parity/pf_parity.py", "parity/README.md"]) {
    assert.deepEqual(readFileSync(join(root, name)), bytesOf(name));
  }
}
function installedSnapshot(root: string) {
  return Object.fromEntries([
    "parity/pf_parity.py", "parity/README.md",
    ...readdirSync(join(root, "parity/vendor")).sort().map((name) => `parity/vendor/${name}`),
  ].map((name) => [name, readFileSync(join(root, name))]));
}
async function prepare(w: ReturnType<typeof wire>) {
  const requested: string[] = [];
  const plan = await prepareParityUpdate(w.lock, w.manifest, async (url: string, name: string) => {
    requested.push(url);
    return w.files[name];
  });
  assert.deepEqual(requested, names.map((name) =>
    `https://raw.githubusercontent.com/pineforge-4pass/pineforge-engine/${w.lock.versions.engine.commit}/scripts/${name}`));
  return plan;
}

test("matching six-file input refreshes vendor, provenance and the real driver's local imports", async () => {
  const root = checkout();
  try {
    const w = wire();
    const plan = await prepare(w);
    unchanged(root);
    installParityUpdate(plan, root);
    writeFileSync(join(root, "release-lock.json"), JSON.stringify(w.lock));
    verifyParityVendor(w.lock, root);
    for (const name of names) {
      assert.deepEqual(readFileSync(join(root, "parity/vendor", name)), w.files[name]);
      assert.notEqual(hash(w.files[name]!), localImports.includes(name) ? hash(bytesOf(`parity/vendor/${name}`)) : "");
    }
    assert.equal(existsSync(join(root, "parity/vendor/PARITY-MANIFEST.json")), false);
    assert.ok(readFileSync(join(root, "parity/README.md"), "utf8").includes(w.lock.manifest.sha256));
    // Load the actual driver in a fresh interpreter, so cached repository
    // modules and an injected PYTHONPATH cannot manufacture import provenance.
    const observed = spawnSync("python3", ["-I", "-B", "-c", `
import importlib.util, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("pf_parity", root / "parity/pf_parity.py")
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)
import run_strategy, derive_corpus_feeds
print(json.dumps({"paths": [str(pathlib.Path(m.__file__).resolve()) for m in
    (driver.vc, run_strategy, derive_corpus_feeds)],
    "grader": driver.GRADER_SHA256, "source": driver.GRADER_SOURCE}))
`, root], { encoding: "utf8", timeout: 30_000 });
    assert.equal(observed.status, 0, observed.stderr);
    const actual = JSON.parse(observed.stdout);
    assert.deepEqual(actual.paths, ["verify_corpus.py", "run_strategy.py", "derive_corpus_feeds.py"]
      .map((name) => join(root, "parity/vendor", name)));
    assert.equal(actual.grader, hash(w.files["verify_corpus.py"]!));
    assert.ok(actual.source.includes(w.lock.versions.engine.commit));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const name of ["stale.py", "PARITY-MANIFEST.json"]) {
  test(`RED: unexpected installed ${name} fails closed without changing the tree`, async () => {
    const root = checkout();
    try {
      const w = wire();
      installParityUpdate(await prepare(w), root);
      verifyParityVendor(w.lock, root);
      const installed = installedSnapshot(root), path = join(root, "parity/vendor", name);
      writeFileSync(path, `stale installed input: ${name}\n`);
      const rejected = installedSnapshot(root);
      assert.throws(() => verifyParityVendor(w.lock, root), {
        message: `PARITY_INVENTORY_INVALID: unexpected entry ${name}`,
      }, `extra installed file ${name} must be rejected`);
      assert.deepEqual(installedSnapshot(root), rejected, "rejection must not write or remove files");
      rmSync(path);
      verifyParityVendor(w.lock, root);
      assert.deepEqual(installedSnapshot(root), installed);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
const changedHex = (value: string) => (value[0] === "0" ? "1" : "0") + value.slice(1);
const changeReadmeSource = (text: string, before: string, after: string) =>
  text.replace(/<!-- parity-source:start -->[\s\S]*?<!-- parity-source:end -->/g,
    (block) => block.replace(before, after));
const expectedDriverValues = (w: ReturnType<typeof wire>) => [
  ["GRADER_SHA256", w.lock.versions.engine.parity.payload_sha256["verify_corpus.py"]],
  ["GRADER_SOURCE", `pineforge-engine ${w.lock.versions.engine.tag} commit ${w.lock.versions.engine.commit} scripts/verify_corpus.py`],
] as Array<[string, string]>;
const priorDriverValue = (key: string) =>
  bytesOf("parity/pf_parity.py").toString("utf8").match(new RegExp(`^${key} = "([^"\\n]*)"$`, "m"))![1]!;
const assignmentMutations: Array<[string, (text: string, key: string, line: string) => string]> = [
  ["second single-quoted assignment", (text, key, line) =>
    text.replace(line, `${line}\n${key} = '${priorDriverValue(key)}'`)],
  ["second double-quoted assignment with extra spaces", (text, key, line) =>
    text.replace(line, `${line}\n${key}   =   "${priorDriverValue(key)}"`)],
  ["duplicate canonical assignment", (text, _key, line) =>
    text.replace(line, `${line}\n${line}`)],
  ["three mixed assignments", (text, key, line) =>
    text.replace(line, `${line}\n${key}='stale provenance'\n${key}\t=  "later provenance"`)],
  ["single noncanonical quotes", (text, key, line) =>
    text.replace(line, `${key} = '${line.slice(key.length + 4, -1)}'`)],
  ["single noncanonical spaces", (text, key, line) =>
    text.replace(line, line.replace(`${key} = `, `${key}   =   `))],
  ["single noncanonical tabs", (text, key, line) =>
    text.replace(line, line.replace(`${key} = `, `${key}\t=\t`))],
  ["single trailing comment", (text, _key, line) =>
    text.replace(line, `${line} # noncanonical`)],
  ["missing assignment", (text, _key, line) => text.replace(line, "")],
  ["inline extra assignment", (text, key, line) =>
    text.replace(line, `${line}\nif True: ${key} = 'stale provenance'`)],
  ["indented extra assignment", (text, key, line) =>
    text.replace(line, `${line}\nif True:\n    ${key} = 'stale provenance'`)],
  ["continued extra assignment", (text, key, line) =>
    text.replace(line, `${line}\n${key} \\\n = 'stale provenance'`)],
  ["annotated extra assignment", (text, key, line) =>
    text.replace(line, `${line}\n${key}: str = 'stale provenance'`)],
  ["augmented extra assignment", (text, key, line) =>
    text.replace(line, `${line}\n${key} += 'stale provenance'`)],
  ["assignment expression", (text, key, line) =>
    text.replace(line, `${line}\n(${key} := 'stale provenance')`)],
  ["chained extra assignment", (text, key, line) =>
    text.replace(line, `${line}\nother = ${key} = 'stale provenance'`)],
  ["unpacked extra assignment", (text, key, line) =>
    text.replace(line, `${line}\n(\n    ${key},\n    other,\n) = ('stale provenance', None)`)],
  ["semicolon extra assignment", (text, key, line) =>
    text.replace(line, `${line}\nother = None; ${key} = 'stale provenance'`)],
  ["formatted string assignment expression", (text, key, line) =>
    text.replace(line, `${line}\nf"{(${key} := 'stale provenance')}"`)],
  ["declaration concealed in a string", (text, _key, line) =>
    text.replace(line, `"""\n${line}\n"""`)],
];
for (const key of ["GRADER_SHA256", "GRADER_SOURCE"]) {
  for (const [label, mutate] of assignmentMutations) {
    for (const operation of ["install", "verify"]) {
      test(`RED: ${operation} rejects ${key} ${label} without changing installed bytes`, async () => {
        const root = checkout();
        try {
          const current = wire(), currentPlan = await prepare(current);
          installParityUpdate(currentPlan, root);
          verifyParityVendor(current.lock, root);
          const installed = installedSnapshot(root), target = join(root, "parity/pf_parity.py");
          const original = readFileSync(target), text = original.toString("utf8");
          const value = expectedDriverValues(current).find(([name]) => name === key)![1];
          const line = `${key} = "${value}"`, changed = mutate(text, key, line);
          assert.ok(text.includes(line), "setup must install the release-derived canonical assignment");
          assert.notEqual(priorDriverValue(key), value, "the prior release must supply a stale value");
          assert.notEqual(changed, text, `${label} must mutate actual installed bytes`);
          // All incoming payload bytes and the commit differ, so an early write
          // cannot be hidden by reinstalling an otherwise identical payload.
          const incoming = wire("b".repeat(40)), incomingPlan = await prepare(incoming);
          for (const name of names) assert.notDeepEqual(incoming.files[name], current.files[name]);
          writeFileSync(target, changed);
          const rejected = installedSnapshot(root);
          assert.throws(() => operation === "install"
            ? installParityUpdate(incomingPlan, root) : verifyParityVendor(current.lock, root), {
            message: `PARITY_PROVENANCE_INVALID: ${key}`,
          }, `${operation} must refuse ${key} ${label}`);
          assert.deepEqual(installedSnapshot(root), rejected, "refusal must preserve all vendor and provenance bytes");
          writeFileSync(target, original);
          verifyParityVendor(current.lock, root);
          assert.deepEqual(installedSnapshot(root), installed);
          installParityUpdate(incomingPlan, root);
          verifyParityVendor(incoming.lock, root);
        } finally { rmSync(root, { recursive: true, force: true }); }
      });
    }
  }
}
test("one canonical assignment per name accepts prior values and installs the release-derived values", async () => {
  const root = checkout();
  try {
    const current = wire(), incoming = wire("b".repeat(40));
    installParityUpdate(await prepare(current), root);
    verifyParityVendor(current.lock, root);
    const before = readFileSync(join(root, "parity/pf_parity.py"), "utf8");
    for (const [key, value] of expectedDriverValues(current)) {
      assert.equal(before.split(`${key} = "${value}"`).length, 2);
    }
    installParityUpdate(await prepare(incoming), root);
    verifyParityVendor(incoming.lock, root);
    const after = readFileSync(join(root, "parity/pf_parity.py"), "utf8");
    for (const [key, value] of expectedDriverValues(incoming)) {
      assert.equal(after.split(`${key} = "${value}"`).length, 2);
      assert.equal(after.includes(`${key} = "${expectedDriverValues(current).find(([name]) => name === key)![1]}"`), false);
    }
    const installed = installedSnapshot(root);
    installParityUpdate(await prepare(incoming), root);
    verifyParityVendor(incoming.lock, root);
    assert.deepEqual(installedSnapshot(root), installed);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
for (const [label, path, change, error] of [
  ["driver grader hash", "parity/pf_parity.py", (text, w) =>
    text.replace(/^GRADER_SHA256 = "[^"\n]*"$/m,
      `GRADER_SHA256 = "${changedHex(w.lock.versions.engine.parity.payload_sha256["verify_corpus.py"])}"`), "GRADER_SHA256"],
  ["driver source commit", "parity/pf_parity.py", (text, w) =>
    text.replace(/^GRADER_SOURCE = "[^"\n]*"$/m,
      (line) => line.replace(w.lock.versions.engine.commit, changedHex(w.lock.versions.engine.commit))), "GRADER_SOURCE"],
  ["README source tag", "parity/README.md", (text, w) =>
    changeReadmeSource(text, `\`${w.lock.versions.engine.tag}\``, `\`${w.lock.versions.engine.tag}-stale\``), "README source content"],
  ["README source commit", "parity/README.md", (text, w) =>
    changeReadmeSource(text, w.lock.versions.engine.commit, changedHex(w.lock.versions.engine.commit)), "README source content"],
  ["README manifest hash", "parity/README.md", (text, w) =>
    changeReadmeSource(text, w.lock.manifest.sha256, changedHex(w.lock.manifest.sha256)), "README source content"],
] as Array<[string, string, (text: string, w: ReturnType<typeof wire>) => string, string]>) {
  test(`RED: altered installed ${label} fails closed without changing the tree`, async () => {
    const root = checkout();
    try {
      const w = wire();
      installParityUpdate(await prepare(w), root);
      verifyParityVendor(w.lock, root);
      const installed = installedSnapshot(root), target = join(root, path);
      const original = readFileSync(target), changed = change(original.toString("utf8"), w);
      assert.notEqual(changed, original.toString("utf8"), `${label} must mutate real installed bytes`);
      writeFileSync(target, changed);
      const rejected = installedSnapshot(root);
      assert.throws(() => verifyParityVendor(w.lock, root), {
        message: `PARITY_PROVENANCE_INVALID: ${error}`,
      }, `altered installed ${label} must be rejected`);
      assert.deepEqual(installedSnapshot(root), rejected, "rejection must not rewrite installed provenance");
      writeFileSync(target, original);
      verifyParityVendor(w.lock, root);
      assert.deepEqual(installedSnapshot(root), installed);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
for (const name of [...names, "SHA256SUMS"]) {
  test(`missing installed ${name} fails closed without changing the tree`, async () => {
    const root = checkout();
    try {
      const w = wire();
      installParityUpdate(await prepare(w), root);
      const path = join(root, "parity/vendor", name), original = readFileSync(path);
      rmSync(path);
      const rejected = installedSnapshot(root);
      assert.throws(() => verifyParityVendor(w.lock, root), { message: `PARITY_PAYLOAD_MISSING: ${name}` });
      assert.deepEqual(installedSnapshot(root), rejected);
      writeFileSync(path, original);
      verifyParityVendor(w.lock, root);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

for (const name of names) {
  test(`RED: a changed fetched byte in ${name} refuses the whole update before writes`, async () => {
    const root = checkout();
    try {
      const w = wire(), expected = hash(w.files[name]!);
      w.files[name] = Buffer.concat([w.files[name]!, Buffer.from("x")]);
      await assert.rejects(() => prepare(w), {
        message: `PARITY_DIGEST_MISMATCH: ${name} expected ${expected} got ${hash(w.files[name]!)}`,
      });
      unchanged(root);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test(`RED: missing fetched ${name} refuses the whole update before writes`, async () => {
    const root = checkout();
    try {
      const w = wire();
      delete w.files[name];
      await assert.rejects(() => prepare(w), { message: `PARITY_PAYLOAD_MISSING: ${name}` });
      unchanged(root);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
test("RED: modifying a prepared buffer is rechecked before install; modifying installed bytes fails verification", async () => {
  const root = checkout();
  try {
    const w = wire(), plan = await prepare(w);
    const original = Buffer.from(plan.files["run_strategy.py"]);
    plan.files["run_strategy.py"][0] ^= 1;
    assert.throws(() => installParityUpdate(plan, root), /PARITY_DIGEST_MISMATCH: run_strategy.py/);
    unchanged(root);
    plan.files["run_strategy.py"] = original;
    installParityUpdate(plan, root);
    const path = join(root, "parity/vendor/run_strategy.py"), changed = readFileSync(path);
    changed[0] = changed[0]! ^ 1;
    writeFileSync(path, changed);
    assert.throws(() => verifyParityVendor(w.lock, root), /PARITY_DIGEST_MISMATCH: run_strategy.py/);
    writeFileSync(path, original);
    rmSync(path);
    assert.throws(() => verifyParityVendor(w.lock, root), { message: "PARITY_PAYLOAD_MISSING: run_strategy.py" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The CLI uses the production fetch implementation, with only HTTP replaced.
function cli(root: string, w: ReturnType<typeof wire>, response: any) {
  writeFileSync(join(root, "release-lock.json"), JSON.stringify(w.lock));
  writeFileSync(join(root, "release-manifest.json"), w.manifest);
  const url = `https://raw.githubusercontent.com/pineforge-4pass/pineforge-engine/${w.lock.versions.engine.commit}/scripts/`;
  const file = join(root, "mock.json");
  writeFileSync(file, JSON.stringify({ network: [], responses: Object.fromEntries(names.map((name, i) => [
    url + name, i === names.length - 1 ? response : { base64: w.files[name]!.toString("base64") },
  ])) }));
  return spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/release-parity.mjs", import.meta.url)), "update"], {
    cwd: root, encoding: "utf8", timeout: 30_000, env: { ...process.env,
      PF_MOCK_STATE: file, NODE_OPTIONS: `--import=${new URL("./fixtures/release/mock-registry.mjs", import.meta.url).href}` },
  });
}
for (const [label, response, error] of [
  ["HTTP 404", { status: 404 }, "PARITY_PAYLOAD_MISSING: verify_corpus.py"],
  ["HTTP 503", { status: 503 }, "PARITY_FETCH_FAILED: verify_corpus.py HTTP 503"],
  ["network failure", { error: "transport down" }, "PARITY_FETCH_FAILED: verify_corpus.py transport down"],
  ["changed byte", { body: "changed" }, "PARITY_DIGEST_MISMATCH: verify_corpus.py"],
] as Array<[string, any, string]>) {
  test(`CLI exits nonzero with named error on ${label} and leaves old bytes untouched`, () => {
    const root = checkout();
    try {
      const result = cli(root, wire(), response);
      assert.equal(result.status, 1, result.stderr);
      assert.ok(result.stderr.includes(error), result.stderr);
      unchanged(root);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
test("CLI succeeds only for a matching six-file input", () => {
  const root = checkout();
  try {
    const w = wire(), result = cli(root, w, { base64: w.files["verify_corpus.py"]!.toString("base64") });
    assert.equal(result.status, 0, result.stderr);
    verifyParityVendor(w.lock, root);
    for (const name of names) assert.deepEqual(readFileSync(join(root, "parity/vendor", name)), w.files[name]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
for (const [label, change, error] of [
  ["missing hash", (w: any) => { delete w.lock.versions.engine.parity.payload_sha256["run_strategy.py"]; }, "PARITY_MANIFEST_INVALID"],
  ["bad descriptor", (w: any) => { w.lock.versions.engine.parity.descriptor_sha256 = "0".repeat(64); }, "PARITY_MANIFEST_INVALID"],
  ["manifest/sums mismatch", (w: any) => { w.lock.versions.engine.parity.sums_sha256 = "0".repeat(64); }, "PARITY_MANIFEST_SUMS_MISMATCH"],
  ["stale manifest", (w: any) => { w.manifest = Buffer.concat([w.manifest, Buffer.from("\n")]); }, "PARITY_MANIFEST_INVALID"],
  ["malformed JSON", (w: any) => {
    w.manifest = Buffer.from("{");
    w.lock.manifest.sha256 = hash(w.manifest); w.lock.event_id = `sha256:${hash(w.manifest)}`;
  }, "PARITY_MANIFEST_INVALID"],
] as Array<[string, (w: any) => void, string]>) {
  test(`${label} fails before any payload fetch`, async () => {
    const w = wire();
    change(w);
    let fetched = false;
    await assert.rejects(() => prepareParityUpdate(w.lock, w.manifest, async () => { fetched = true; return Buffer.alloc(0); }),
      new RegExp(error));
    assert.equal(fetched, false);
  });
}
test("a local sums disagreement fails before runtime success can be reported", async () => {
  const root = checkout();
  try {
    const w = wire();
    installParityUpdate(await prepare(w), root);
    writeFileSync(join(root, "parity/vendor/SHA256SUMS"), "# obsolete\n");
    assert.throws(() => verifyParityVendor(w.lock, root), {
      message: "PARITY_MANIFEST_SUMS_MISMATCH: local SHA256SUMS disagrees with release manifest",
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const [script, mode] of [["release-contract.mjs", "verify"], ["runtime-e2e.mjs", "npm"]]) {
  test(`${script} rejects stale vendor bytes before artifact access or runtime setup`, async () => {
    const root = checkout();
    try {
      const w = wire();
      installParityUpdate(await prepare(w), root);
      writeFileSync(join(root, "release-lock.json"), JSON.stringify(w.lock));
      writeFileSync(join(root, "release-manifest.json"), w.manifest);
      writeFileSync(join(root, "parity/vendor/run_strategy.py"), "stale bytes");
      mkdirSync(join(root, "bin"));
      // If the guard regresses, block artifact access rather than reaching gh.
      writeFileSync(join(root, "bin/gh"), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
      const state = join(root, "mock.json");
      writeFileSync(state, JSON.stringify({ responses: {} }));
      const result = spawnSync(process.execPath, [
        fileURLToPath(new URL(`../scripts/${script}`, import.meta.url)), mode!,
      ], { cwd: root, encoding: "utf8", timeout: 30_000, env: {
        ...process.env, PF_MOCK_STATE: state, PATH: `${join(root, "bin")}${delimiter}${process.env.PATH}`,
        NODE_OPTIONS: `--import=${new URL("./fixtures/release/mock-registry.mjs", import.meta.url).href}`,
      } });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /PARITY_DIGEST_MISMATCH: run_strategy.py/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
