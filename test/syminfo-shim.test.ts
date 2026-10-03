// docker/pf_run_json.py: its own Python tests, and that it ships where the runners
// look for it (npm package and the Glama image).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { shimPath } from "../src/overlay.js";

const root = fileURLToPath(new URL("..", import.meta.url));

test("pf_run_json.py: the Python tests pass (python3 -m unittest)", () => {
  const r = spawnSync("python3", ["-m", "unittest", "discover", "-s", "docker", "-p", "test_*.py", "-v"], {
    cwd: root, encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /\nOK\n?$/);
  assert.match(r.stderr, /Ran \d+ tests/);
});

test("the runners find the shim at docker/pf_run_json.py of the package root", () => {
  assert.equal(shimPath(), `${root}docker/pf_run_json.py`);
  assert.ok(existsSync(shimPath()));
});

test("the shim is in the npm package", () => {
  const files = (JSON.parse(readFileSync(root + "package.json", "utf8")) as { files: string[] }).files;
  assert.ok(files.includes("docker/pf_run_json.py"), `package.json files: ${files.join(", ")}`);
  const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  const listed = (JSON.parse(packed.stdout) as Array<{ files: Array<{ path: string }> }>)[0]!.files.map((f) => f.path);
  assert.ok(listed.includes("docker/pf_run_json.py"), "npm pack does not list the shim");
  assert.ok(!listed.includes("docker/test_pf_run_json.py"), "the Python tests are not shipped");
});

test("the shim is in the Glama image, next to dist/, where shimPath() looks", () => {
  const dockerfile = readFileSync(root + "docker/Dockerfile", "utf8");
  assert.match(dockerfile, /^COPY --from=mcp \/app\/docker\/pf_run_json\.py \.\/docker\/pf_run_json\.py$/m);
  assert.match(dockerfile, /^WORKDIR \/app$/m);
  assert.match(dockerfile, /^COPY --from=mcp \/app\/dist \.\/dist$/m);
  const ignored = readFileSync(root + ".dockerignore", "utf8").split("\n");
  assert.ok(!ignored.some((l) => l === "docker" || l.startsWith("docker/")), ".dockerignore must not drop docker/");
});
