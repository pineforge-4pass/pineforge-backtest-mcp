// Release receiver input: immutable engine scripts, checked against the hub's
// byte-verified manifest. No vendor writes until the entire input is verified.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PARITY_PAYLOAD, sha256, validateReady, verifyManifest } from "./release-contract.mjs";
import { compareVersions } from "./release-version.mjs";

export const PARITY_FILES = [
  ...PARITY_PAYLOAD.map((name) => `parity/vendor/${name}`),
  "parity/vendor/SHA256SUMS", "parity/pf_parity.py", "parity/README.md",
];
const fail = (code, detail) => { throw new Error(`${code}: ${detail}`); };
function identity(lock, manifest) {
  try {
    validateReady(lock);
    if (manifest !== undefined) verifyManifest(lock, manifest);
  } catch (error) {
    fail(/engine parity sums hash mismatch/.test(error.message)
      ? "PARITY_MANIFEST_SUMS_MISMATCH" : "PARITY_MANIFEST_INVALID", error.message);
  }
  // Historical events predate the payload contract. Modern events cannot take
  // this branch: validateReady requires their complete parity identity.
  return compareVersions(lock.release_version, "1.11.0") < 0 ? null : lock.versions.engine;
}
function verifyBytes(name, bytes, expected) {
  if (bytes === undefined || bytes === null) fail("PARITY_PAYLOAD_MISSING", name);
  const actual = sha256(bytes);
  if (actual !== expected) fail("PARITY_DIGEST_MISMATCH", `${name} expected ${expected} got ${actual}`);
}
export async function prepareParityUpdate(lock, manifest, fetchBytes = async (url, name) => {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (response.status === 404) fail("PARITY_PAYLOAD_MISSING", name);
    if (!response.ok) fail("PARITY_FETCH_FAILED", `${name} HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (/^PARITY_/.test(error.message)) throw error;
    fail("PARITY_FETCH_FAILED", `${name} ${error.message}`);
  }
}) {
  if (!Buffer.isBuffer(manifest)) fail("PARITY_MANIFEST_INVALID", "release manifest bytes are required");
  const engine = identity(lock, manifest);
  if (!engine) return null;
  const files = {};
  for (const name of PARITY_PAYLOAD) {
    const url = `https://raw.githubusercontent.com/pineforge-4pass/pineforge-engine/${engine.commit}/scripts/${name}`;
    let bytes;
    try { bytes = await fetchBytes(url, name); }
    catch (error) {
      if (/^PARITY_/.test(error.message)) throw error;
      fail("PARITY_FETCH_FAILED", `${name} ${error.message}`);
    }
    verifyBytes(name, bytes, engine.parity.payload_sha256[name]);
    files[name] = Buffer.from(bytes);
  }
  return { lock, manifest, files };
}
function sumsText(engine) {
  return `# pineforge-engine ${engine.tag} commit ${engine.commit}; scripts/ payload verified against release-manifest.json\n` +
    PARITY_PAYLOAD.map((name) => `${engine.parity.payload_sha256[name]}  ${name}\n`).join("");
}
function driverProvenance(engine) {
  return [
    ["GRADER_SHA256", engine.parity.payload_sha256["verify_corpus.py"]],
    ["GRADER_SOURCE", `pineforge-engine ${engine.tag} commit ${engine.commit} scripts/verify_corpus.py`],
  ];
}
const driverPattern = (key) => new RegExp(`^${key} = "[^"\\\\\\r\\n]*"$`, "gm");
function driverAssignmentOffsets(driver, key) {
  const offsets = new Set();
  let targets = [], depth = 0;
  // Keep logical statements intact across brackets and explicit continuations.
  // Strings/comments cannot supply a declaration or conceal a second target.
  // Conservatively treat every owned name before an assignment operator as a
  // target, including chained, unpacked, annotated and augmented assignments.
  const tokens = /#[^\r\n]*|[rubfRUBF]*(?:"""(?:\\[\s\S]|(?!""")[\s\S])*"""|'''(?:\\[\s\S]|(?!''')[\s\S])*'''|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')|\\\r?\n|[A-Za-z_]\w*|==|!=|<=|>=|(?:\*\*|\/\/|<<|>>|[+\-*/%@&|^:])?=|[^\S\r\n]+|[\s\S]/g;
  for (const match of driver.matchAll(tokens)) {
    const token = match[0];
    if (/^(?:[rubf]*["']|#|\\\r?\n)/i.test(token)) {
      // A formatted string can evaluate a named expression. Fail closed on an
      // owned assignment there as well, without accepting it as canonical.
      if (/^[rubf]*f[rubf]*["']/i.test(token) &&
          new RegExp(`\\b${key}\\b(?:\\s|\\\\\\r?\\n)*:=`).test(token)) {
        offsets.add(match.index);
      }
      continue;
    }
    if (token === key) targets.push(match.index);
    if (/^(?:\*\*|\/\/|<<|>>|[+\-*/%@&|^:])?=$/.test(token)) {
      for (const index of targets) offsets.add(index);
      targets = [];
    }
    if (/^[([{]$/.test(token)) depth++;
    if (/^[)\]}]$/.test(token)) depth--;
    if (token === ";" || (/^[\r\n]$/.test(token) && depth === 0)) targets = [];
  }
  return offsets;
}
function driverAssignment(driver, key) {
  // Discovery does not depend on the quoting or value of any assignment.
  const assignments = driverAssignmentOffsets(driver, key);
  const canonical = [...driver.matchAll(driverPattern(key))];
  if (assignments.size !== 1 || canonical.length !== 1 || !assignments.has(canonical[0].index)) {
    fail("PARITY_PROVENANCE_INVALID", key);
  }
  return canonical[0][0];
}
const readmePattern = /<!-- parity-source:start -->[\s\S]*?<!-- parity-source:end -->/g;
function readmeProvenance(lock, engine) {
  return `<!-- parity-source:start -->\nInstalled payload: pineforge-engine \`${engine.tag}\`, commit \`${engine.commit}\`, ` +
    `verified against release manifest SHA-256 \`${lock.manifest.sha256}\`.\n<!-- parity-source:end -->`;
}
function readProvenance(root, name) {
  try { return readFileSync(join(root, name), "utf8"); }
  catch { fail("PARITY_PROVENANCE_INVALID", name); }
}
function readmeSource(readme) {
  const matches = [...readme.matchAll(readmePattern)];
  if (matches.length !== 1 || readme.split("<!-- parity-source:start -->").length !== 2 ||
      readme.split("<!-- parity-source:end -->").length !== 2) {
    fail("PARITY_PROVENANCE_INVALID", "README source markers");
  }
  return matches[0][0];
}
export function installParityUpdate(plan, root = ".") {
  if (!plan) return;
  if (!Buffer.isBuffer(plan.manifest)) fail("PARITY_MANIFEST_INVALID", "release manifest bytes are required");
  const engine = identity(plan.lock, plan.manifest);
  for (const name of PARITY_PAYLOAD) verifyBytes(name, plan.files[name], engine.parity.payload_sha256[name]);
  // Prepare generated provenance before writing even the first vendor byte.
  const driverPath = join(root, "parity/pf_parity.py");
  let driver = readProvenance(root, "parity/pf_parity.py");
  for (const [key, value] of driverProvenance(engine)) {
    driverAssignment(driver, key);
    // A prior release's single canonical value is valid update input.
    driver = driver.replace(driverPattern(key), `${key} = "${value}"`);
  }
  const readmePath = join(root, "parity/README.md");
  const readme = readProvenance(root, "parity/README.md");
  readmeSource(readme);
  const updatedReadme = readme.replace(readmePattern, readmeProvenance(plan.lock, engine));
  mkdirSync(join(root, "parity/vendor"), { recursive: true });
  for (const name of PARITY_PAYLOAD) writeFileSync(join(root, "parity/vendor", name), plan.files[name]);
  writeFileSync(join(root, "parity/vendor/SHA256SUMS"), sumsText(engine));
  writeFileSync(driverPath, driver);
  writeFileSync(readmePath, updatedReadme);
}
export function verifyParityVendor(lock, root = ".") {
  const engine = identity(lock);
  if (!engine) return;
  // Driver/README provenance lives outside vendor; only these seven regular
  // files belong inside it. Reject directories and symlinks as well as extras.
  const expected = [...PARITY_PAYLOAD, "SHA256SUMS"];
  let entries;
  try { entries = readdirSync(join(root, "parity/vendor"), { withFileTypes: true }); }
  catch { fail("PARITY_INVENTORY_INVALID", "cannot read parity/vendor"); }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!expected.includes(entry.name)) fail("PARITY_INVENTORY_INVALID", `unexpected entry ${entry.name}`);
    if (!entry.isFile()) fail("PARITY_INVENTORY_INVALID", `non-file entry ${entry.name}`);
  }
  for (const name of expected) {
    if (!entries.some((entry) => entry.name === name)) fail("PARITY_PAYLOAD_MISSING", name);
  }
  let sums;
  try { sums = readFileSync(join(root, "parity/vendor/SHA256SUMS"), "utf8"); }
  catch { fail("PARITY_PAYLOAD_MISSING", "SHA256SUMS"); }
  if (sums !== sumsText(engine)) fail("PARITY_MANIFEST_SUMS_MISMATCH", "local SHA256SUMS disagrees with release manifest");
  for (const name of PARITY_PAYLOAD) {
    let bytes;
    try { bytes = readFileSync(join(root, "parity/vendor", name)); }
    catch { fail("PARITY_PAYLOAD_MISSING", name); }
    verifyBytes(name, bytes, engine.parity.payload_sha256[name]);
  }
  // Expected provenance comes only from the validated release identity, never
  // from the installed text being checked.
  const driver = readProvenance(root, "parity/pf_parity.py");
  for (const [key, value] of driverProvenance(engine)) {
    if (driverAssignment(driver, key) !== `${key} = "${value}"`) {
      fail("PARITY_PROVENANCE_INVALID", key);
    }
  }
  const readme = readProvenance(root, "parity/README.md");
  if (readmeSource(readme) !== readmeProvenance(lock, engine)) {
    fail("PARITY_PROVENANCE_INVALID", "README source content");
  }
}
// Also available to the proof runner without the receiver's git/GitHub writes.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    let lock, manifest;
    try {
      lock = JSON.parse(readFileSync("release-lock.json", "utf8"));
      if (process.argv[2] === "update") manifest = readFileSync("release-manifest.json");
    } catch (error) { fail("PARITY_MANIFEST_INVALID", error.message); }
    if (process.argv[2] === "update") {
      const plan = await prepareParityUpdate(lock, manifest);
      if (!plan) fail("PARITY_MANIFEST_INVALID", "pinned release predates the six-file payload contract");
      installParityUpdate(plan);
    } else if (process.argv[2] !== "verify") throw new Error("expected update or verify");
    verifyParityVendor(lock);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
