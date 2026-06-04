# Glama-deployable self-contained MCP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship one container image where every MCP tool works with no host Docker daemon (engine baked in, invoked in-process), runnable from Glama, while the `npx`-on-host path keeps driving the host Docker daemon unchanged.

**Architecture:** Introduce an `EngineRunner` abstraction with two backends — `DockerRunner` (today's `docker run`, host usage) and `LocalRunner` (spawns the engine's `entrypoint.sh` in-process). Mode is chosen by `PINEFORGE_ENGINE_MODE` (default `docker`). The engine's `entrypoint.sh` is made path-flexible (`PINEFORGE_IN_DIR`) and concurrency-safe (per-run `mktemp` work dir). A combined Dockerfile in `docker/` layers Node onto the released engine image and sets local mode.

**Tech Stack:** TypeScript (ESM, Node ≥20), `@modelcontextprotocol/sdk`, zod, Docker multi-stage build, bash (engine entrypoint), `node:test` + `tsx` for tests, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-06-04-glama-deployable-mcp-design.md`

**Repos touched:**
- `pineforge-engine` (sibling, `../pineforge-engine`) — Task 1 only.
- `pineforge-codegen-mcp` (this repo) — Tasks 2–10.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `../pineforge-engine/docker/entrypoint.sh` | (modify) flexible `IN_DIR`, per-run `mktemp` work dir |
| `../pineforge-engine/tests/test_entrypoint_indir.sh` | (create) shell test for IN_DIR + isolation |
| `src/engine.ts` | (create) `EngineRunner` interface, `DockerRunner`, `LocalRunner`, `selectRunner`, moved docker primitives + shared types |
| `src/index.ts` | (modify) construct runner from env; call `runner.*`; remove moved code |
| `test/engine.local.test.ts` | (create) LocalRunner unit + concurrency tests |
| `test/engine.select.test.ts` | (create) `selectRunner` mode-selection test |
| `test/fixtures/fake-prefix/bin/entrypoint.sh` | (create) fake engine for LocalRunner tests |
| `package.json` | (modify) add `test` script |
| `.dockerignore` | (create) trim build context |
| `docker/Dockerfile` | (create) combined self-contained image |
| `Dockerfile` | (delete) superseded by `docker/Dockerfile` |
| `.github/workflows/publish.yml` | (modify) add combined-image build+push job |

---

## Task 1: Engine entrypoint — flexible IN_DIR + concurrency-safe work dir

**Repo:** `../pineforge-engine`

**Files:**
- Modify: `../pineforge-engine/docker/entrypoint.sh:48-52`
- Test: `../pineforge-engine/tests/test_entrypoint_indir.sh` (create)

- [ ] **Step 1: Write the failing shell test**

Create `../pineforge-engine/tests/test_entrypoint_indir.sh`:

```bash
#!/usr/bin/env bash
# Verifies entrypoint honors PINEFORGE_IN_DIR and uses a per-run work dir
# (no fixed /tmp/strategy.* collisions). Stubs g++/python so the test needs
# no real toolchain — it only exercises the path/work-dir logic of the script.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ENTRY="$HERE/../docker/entrypoint.sh"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Fake prefix + toolchain. g++ writes the .so it is told to (-o arg);
# run_json.py prints a sentinel JSON. Put stubs first on PATH.
mkdir -p "$work/bin" "$work/prefix/bin" "$work/prefix/lib" "$work/prefix/include"
cat > "$work/bin/g++" <<'SH'
#!/usr/bin/env bash
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
: > "$out"
SH
cat > "$work/prefix/bin/run_json.py" <<'SH'
#!/usr/bin/env python3
print('{"ok": true, "marker": "indir"}')
SH
: > "$work/prefix/lib/libpineforge.a"
chmod +x "$work/bin/g++" "$work/prefix/bin/run_json.py"

# A custom input dir (NOT /in) with a pre-transpiled cpp + csv.
indir="$work/indir"; mkdir -p "$indir"
echo "int main(){}" > "$indir/strategy.cpp"
echo "timestamp,open,high,low,close,volume" > "$indir/ohlcv.csv"

out="$(PATH="$work/bin:$PATH" \
     PINEFORGE_PREFIX="$work/prefix" \
     PINEFORGE_IN_DIR="$indir" \
     bash "$ENTRY" 2>/dev/null)"

echo "$out" | grep -q '"marker": "indir"' || { echo "FAIL: did not run from PINEFORGE_IN_DIR"; exit 1; }
# Fixed legacy paths must NOT have been created by the run.
[ ! -e /tmp/strategy.so ] || { echo "FAIL: wrote fixed /tmp/strategy.so"; exit 1; }
echo "PASS"
```

```bash
chmod +x ../pineforge-engine/tests/test_entrypoint_indir.sh
```

- [ ] **Step 2: Run test, verify it FAILS**

Run: `bash ../pineforge-engine/tests/test_entrypoint_indir.sh`
Expected: `FAIL: did not run from PINEFORGE_IN_DIR` (current script hardcodes `/in` and `/tmp`).

- [ ] **Step 3: Edit `entrypoint.sh`**

Replace lines 48–52 (the fixed path block):

```bash
PINE=/in/strategy.pine
SRC_CPP=/in/strategy.cpp
OHLCV=/in/ohlcv.csv
GEN=/tmp/strategy.cpp
SO=/tmp/strategy.so
```

with:

```bash
IN_DIR="${PINEFORGE_IN_DIR:-/in}"
PINE="${IN_DIR}/strategy.pine"
SRC_CPP="${IN_DIR}/strategy.cpp"
OHLCV="${IN_DIR}/ohlcv.csv"
# Per-run work dir so parallel in-process invocations never collide on the
# generated TU / shared object. Cleaned up on exit. (Was fixed /tmp/strategy.*)
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
GEN="${WORK}/strategy.cpp"
SO="${WORK}/strategy.so"
```

- [ ] **Step 4: Run test, verify it PASSES**

Run: `bash ../pineforge-engine/tests/test_entrypoint_indir.sh`
Expected: `PASS`

- [ ] **Step 5: Commit (engine repo)**

```bash
git -C ../pineforge-engine add docker/entrypoint.sh tests/test_entrypoint_indir.sh
git -C ../pineforge-engine commit -m "feat(entrypoint): PINEFORGE_IN_DIR + per-run mktemp work dir (concurrency-safe)"
```

- [ ] **Step 6: Release the engine image**

Bump engine `VERSION` `0.7.1 → 0.8.0`, then tag to trigger `release.yml`:

```bash
echo "0.8.0" > ../pineforge-engine/VERSION
git -C ../pineforge-engine add VERSION
git -C ../pineforge-engine commit -m "release: v0.8.0 — concurrency-safe entrypoint"
git -C ../pineforge-engine tag v0.8.0
git -C ../pineforge-engine push origin main
git -C ../pineforge-engine push origin v0.8.0
```

Wait for `release.yml` to push `ghcr.io/pineforge-4pass/pineforge-engine:0.8.0`. This tag is pinned by Task 8.

---

## Task 2: Test harness for the MCP repo

No test runner exists today (only `tsx`). Use Node's built-in `node:test` driven through `tsx` for TypeScript ESM.

**Files:**
- Modify: `package.json` (scripts)
- Test: `test/smoke.test.ts` (create)

- [ ] **Step 1: Add the `test` script**

In `package.json` `scripts`, add (keep existing entries):

```json
"test": "node --import tsx --test test/**/*.test.ts"
```

- [ ] **Step 2: Write a trivial test**

Create `test/smoke.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { VERSION } from "../src/version.js";

test("version is a semver string", () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});
```

- [ ] **Step 3: Run it, verify PASS**

Run: `npm test`
Expected: 1 test passing. (If the glob fails on your shell, the equivalent is `node --import tsx --test test/smoke.test.ts`.)

- [ ] **Step 4: Commit**

```bash
git add package.json test/smoke.test.ts
git commit -m "test: add node:test + tsx harness"
```

---

## Task 3: Move docker primitives + shared types into `src/engine.ts`

Relocate the engine/docker plumbing out of `index.ts` so both backends can live together. This is a **verbatim move** — no logic change.

**Files:**
- Create: `src/engine.ts`
- Modify: `src/index.ts` (remove moved code, add import)

- [ ] **Step 1: Create `src/engine.ts` with the moved primitives**

Cut these from `src/index.ts` **verbatim** and paste into a new `src/engine.ts`:
- the `ParamMap`, `ParamGrid`, `RuntimeArgsLike` type aliases/interfaces (around `src/index.ts:74-84`),
- `interface DockerResult` (`:447`),
- `interface ImageFreshness` (`:230-242`),
- functions `dockerTranspile` (`:40-64`), `dockerBacktest` (`:443-505` incl. the env-build body), `collectChild` (`:506-...`), `stringifyParams` (search for `function stringifyParams`), `pullImage` (`:223-228`), `checkEngineImage` (`:250-...`).

Add at the top of `src/engine.ts`:

```ts
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
```

Add `export` to each moved type and function (e.g. `export async function dockerTranspile(...)`, `export interface ImageFreshness`, etc.). Keep the constants they need — move `DOCKER_TIMEOUT_MS` and `DEFAULT_IMAGE` resolution into `engine.ts`:

```ts
export const DEFAULT_IMAGE = process.env.PINEFORGE_IMAGE ?? "ghcr.io/pineforge-4pass/pineforge-engine:latest";
export const DOCKER_TIMEOUT_MS = Number(process.env.PINEFORGE_DOCKER_TIMEOUT_MS ?? 120_000);
```

- [ ] **Step 2: Re-import the moved names into `index.ts`**

At the top of `src/index.ts`, delete the now-moved declarations and add:

```ts
import {
  DEFAULT_IMAGE,
  dockerTranspile,
  dockerBacktest,
  checkEngineImage,
  pullImage,
  type ParamMap,
  type ParamGrid,
  type RuntimeArgsLike,
  type ImageFreshness,
} from "./engine.js";
```

(Remove the duplicate `DEFAULT_IMAGE`/`DOCKER_TIMEOUT_MS` consts from `index.ts`; they now come from `engine.ts`. `index.ts` keeps `ALLOW_ANYWHERE` and the Binance constants.)

- [ ] **Step 3: Build, verify it compiles**

Run: `npm run build`
Expected: `tsc` exits 0, no unresolved-symbol errors.

- [ ] **Step 4: Run tests, verify PASS**

Run: `npm test`
Expected: smoke test still passes.

- [ ] **Step 5: Commit**

```bash
git add src/engine.ts src/index.ts
git commit -m "refactor: move docker engine primitives into src/engine.ts (no behavior change)"
```

---

## Task 4: `EngineRunner` interface + `DockerRunner`

**Files:**
- Modify: `src/engine.ts`
- Test: `test/engine.docker.test.ts` (create)

- [ ] **Step 1: Add interface + types to `src/engine.ts`**

```ts
export interface EngineInfo {
  mode: "docker" | "local";
  baked_in: boolean;
  version: string | null;
  image?: string;
}

export interface BacktestCall {
  cppPath: string;                 // pre-transpiled TU (grid reuses one)
  csvPath: string;                 // OHLCV csv
  inputs?: ParamMap;
  overrides?: ParamMap;
  runtime?: RuntimeArgsLike;
}

export interface EngineRunner {
  readonly mode: "docker" | "local";
  transpile(source: string): Promise<string>;
  backtest(call: BacktestCall): Promise<unknown>;
  engineInfo(): Promise<EngineInfo>;
  // Image freshness — meaningful only for docker; local returns a static note.
  checkImage(image: string, autoPull: boolean): Promise<ImageFreshness | EngineInfo>;
  pullImage(image: string): Promise<{ image: string; pulled: boolean; output: string }>;
}
```

- [ ] **Step 2: Add `DockerRunner` delegating to the moved primitives**

```ts
export class DockerRunner implements EngineRunner {
  readonly mode = "docker" as const;
  constructor(private image: string = DEFAULT_IMAGE) {}

  transpile(source: string): Promise<string> {
    return dockerTranspile(source, this.image);
  }
  backtest(call: BacktestCall): Promise<unknown> {
    return dockerBacktest({ image: this.image, ...call });
  }
  async engineInfo(): Promise<EngineInfo> {
    return { mode: "docker", baked_in: false, version: null, image: this.image };
  }
  checkImage(image: string, autoPull: boolean) {
    return checkEngineImage(image, autoPull);
  }
  pullImage(image: string) {
    return pullImage(image);
  }
}
```

- [ ] **Step 3: Write a DockerRunner shape test**

Create `test/engine.docker.test.ts`:

```ts
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
```

- [ ] **Step 4: Build + test, verify PASS**

Run: `npm run build && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/engine.ts test/engine.docker.test.ts
git commit -m "feat(engine): EngineRunner interface + DockerRunner backend"
```

---

## Task 5: `LocalRunner` (spawns entrypoint.sh in-process)

**Files:**
- Modify: `src/engine.ts`
- Test: `test/engine.local.test.ts` (create)
- Fixture: `test/fixtures/fake-prefix/bin/entrypoint.sh` (create)

- [ ] **Step 1: Create the fake-engine fixture**

`test/fixtures/fake-prefix/bin/entrypoint.sh` — mimics the real engine contract: reads `PINEFORGE_IN_DIR`, honors `PINEFORGE_TRANSPILE_ONLY`, echoes JSON with inputs back so the test can assert env + files arrived.

```bash
#!/usr/bin/env bash
set -euo pipefail
IN_DIR="${PINEFORGE_IN_DIR:?}"
if [[ "${PINEFORGE_TRANSPILE_ONLY:-}" == "1" ]]; then
  # echo the pine source wrapped so the test can see it round-tripped
  printf '// transpiled\n%s\n' "$(cat "${IN_DIR}/strategy.pine")"
  exit 0
fi
[[ -f "${IN_DIR}/strategy.cpp" ]] || { echo "missing cpp" >&2; exit 2; }
[[ -f "${IN_DIR}/ohlcv.csv"   ]] || { echo "missing csv" >&2; exit 2; }
# Emit a JSON report echoing the env so assertions can check propagation.
printf '{"ok":true,"inputs":%s,"overrides":%s,"input_tf":"%s"}\n' \
  "${PINEFORGE_INPUTS:-null}" "${PINEFORGE_OVERRIDES:-null}" "${PINEFORGE_INPUT_TF:-}"
```

```bash
chmod +x test/fixtures/fake-prefix/bin/entrypoint.sh
```

- [ ] **Step 2: Write failing LocalRunner tests**

Create `test/engine.local.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalRunner } from "../src/engine.js";

const PREFIX = resolve("test/fixtures/fake-prefix");

test("LocalRunner.transpile sends pine source through entrypoint", async () => {
  const r = new LocalRunner(PREFIX);
  const cpp = await r.transpile("strategy('x')");
  assert.match(cpp, /\/\/ transpiled/);
  assert.match(cpp, /strategy\('x'\)/);
});

test("LocalRunner.backtest writes cpp+csv and propagates env", async () => {
  const r = new LocalRunner(PREFIX);
  const tmp = await mkdtemp(join(tmpdir(), "lr-"));
  const cppPath = join(tmp, "strategy.cpp");
  const csvPath = join(tmp, "ohlcv.csv");
  await writeFile(cppPath, "int main(){}");
  await writeFile(csvPath, "timestamp,open,high,low,close,volume\n");
  const out = (await r.backtest({
    cppPath, csvPath,
    inputs: { "Fast Length": 8 },
    overrides: { commission_value: 0.04 },
    runtime: { input_tf: "60" },
  })) as { ok: boolean; inputs: Record<string, string>; input_tf: string };
  assert.equal(out.ok, true);
  assert.deepEqual(out.inputs, { "Fast Length": "8" });
  assert.equal(out.input_tf, "60");
});

test("LocalRunner backtests run in parallel without collision", async () => {
  const r = new LocalRunner(PREFIX);
  const mk = async (tf: string) => {
    const tmp = await mkdtemp(join(tmpdir(), "lrp-"));
    await writeFile(join(tmp, "strategy.cpp"), "int main(){}");
    await writeFile(join(tmp, "ohlcv.csv"), "timestamp,open,high,low,close,volume\n");
    return r.backtest({ cppPath: join(tmp, "strategy.cpp"), csvPath: join(tmp, "ohlcv.csv"), runtime: { input_tf: tf } });
  };
  const [a, b] = await Promise.all([mk("1"), mk("D")]) as Array<{ input_tf: string }>;
  assert.equal(a.input_tf, "1");
  assert.equal(b.input_tf, "D");
});

test("LocalRunner.engineInfo reports baked-in version from env", async () => {
  process.env.PINEFORGE_VERSION = "0.8.0";
  const r = new LocalRunner(PREFIX);
  assert.deepEqual(await r.engineInfo(), { mode: "local", baked_in: true, version: "0.8.0" });
});
```

- [ ] **Step 3: Run, verify FAIL**

Run: `npm test`
Expected: FAIL — `LocalRunner` not exported.

- [ ] **Step 4: Implement `LocalRunner` in `src/engine.ts`**

```ts
// Builds the PINEFORGE_* env the entrypoint reads. Shared by both calls so the
// docker and local backends speak the identical contract.
function engineEnv(call: { inputs?: ParamMap; overrides?: ParamMap; runtime?: RuntimeArgsLike }): Record<string, string> {
  const env: Record<string, string> = {};
  const inputs = stringifyParams(call.inputs);
  const overrides = stringifyParams(call.overrides);
  if (Object.keys(inputs).length) env.PINEFORGE_INPUTS = JSON.stringify(inputs);
  if (Object.keys(overrides).length) env.PINEFORGE_OVERRIDES = JSON.stringify(overrides);
  const r = call.runtime ?? {};
  if (r.input_tf) env.PINEFORGE_INPUT_TF = r.input_tf;
  if (r.script_tf) env.PINEFORGE_SCRIPT_TF = r.script_tf;
  if (r.bar_magnifier !== undefined) env.PINEFORGE_BAR_MAGNIFIER = r.bar_magnifier ? "true" : "false";
  if (r.magnifier_samples !== undefined) env.PINEFORGE_MAGNIFIER_SAMPLES = String(r.magnifier_samples);
  if (r.magnifier_dist !== undefined) env.PINEFORGE_MAGNIFIER_DIST = r.magnifier_dist;
  return env;
}

export class LocalRunner implements EngineRunner {
  readonly mode = "local" as const;
  constructor(private prefix: string = process.env.PINEFORGE_PREFIX ?? "/opt/pineforge") {}

  private entrypoint(): string {
    return join(this.prefix, "bin", "entrypoint.sh");
  }

  // Spawn entrypoint.sh against a freshly-created IN_DIR, return stdout.
  private async run(inDir: string, extraEnv: Record<string, string>): Promise<string> {
    const child = spawn("bash", [this.entrypoint()], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PINEFORGE_PREFIX: this.prefix,
        PINEFORGE_IN_DIR: inDir,
        ...extraEnv,
      },
    });
    const { stdout, stderr, code } = await collectChild(child, DOCKER_TIMEOUT_MS);
    if (code !== 0) {
      const map: Record<number, string> = {
        2: "missing input", 3: "compile failure", 4: "backtest failure", 5: "transpile failure",
      };
      throw new Error(`engine ${map[code] ?? "error"} (exit ${code}):\n${stderr.slice(-2048)}`);
    }
    return stdout;
  }

  async transpile(source: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "pineforge-lr-tr-"));
    try {
      await writeFile(join(dir, "strategy.pine"), source, "utf8");
      return await this.run(dir, { PINEFORGE_TRANSPILE_ONLY: "1" });
    } finally {
      rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async backtest(call: BacktestCall): Promise<unknown> {
    const dir = await mkdtemp(join(tmpdir(), "pineforge-lr-bt-"));
    try {
      // Only strategy.cpp (engine prefers .pine when both exist).
      const cpp = await readFile(call.cppPath, "utf8");
      await writeFile(join(dir, "strategy.cpp"), cpp, "utf8");
      const csv = await readFile(call.csvPath, "utf8");
      await writeFile(join(dir, "ohlcv.csv"), csv, "utf8");
      const out = await this.run(dir, engineEnv(call));
      try { return JSON.parse(out); }
      catch { throw new Error(`backtest produced non-JSON output (first 500B):\n${out.slice(0, 500)}`); }
    } finally {
      rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async engineInfo(): Promise<EngineInfo> {
    return { mode: "local", baked_in: true, version: process.env.PINEFORGE_VERSION ?? null };
  }

  async checkImage(): Promise<EngineInfo> {
    return this.engineInfo();
  }

  async pullImage(image: string) {
    return { image, pulled: false, output: "engine is baked into the image (local mode); nothing to pull" };
  }
}
```

Add `readFile` to the `node:fs/promises` import at the top of `src/engine.ts`:

```ts
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
```

Ensure `stringifyParams` (moved in Task 3) is in scope above `engineEnv`.

- [ ] **Step 5: Run, verify PASS**

Run: `npm run build && npm test`
Expected: all LocalRunner tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/engine.ts test/engine.local.test.ts test/fixtures/fake-prefix/bin/entrypoint.sh
git commit -m "feat(engine): LocalRunner backend (in-process entrypoint.sh) + tests"
```

---

## Task 6: `selectRunner()` + wire into `index.ts`

**Files:**
- Modify: `src/engine.ts` (add factory)
- Modify: `src/index.ts` (use runner)
- Test: `test/engine.select.test.ts` (create)

- [ ] **Step 1: Write failing mode-selection test**

Create `test/engine.select.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectRunner } from "../src/engine.js";

test("defaults to docker mode", () => {
  delete process.env.PINEFORGE_ENGINE_MODE;
  assert.equal(selectRunner().mode, "docker");
});

test("PINEFORGE_ENGINE_MODE=local selects local", () => {
  process.env.PINEFORGE_ENGINE_MODE = "local";
  assert.equal(selectRunner().mode, "local");
  delete process.env.PINEFORGE_ENGINE_MODE;
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `npm test`
Expected: FAIL — `selectRunner` not exported.

- [ ] **Step 3: Add `selectRunner` to `src/engine.ts`**

```ts
export function selectRunner(image: string = DEFAULT_IMAGE): EngineRunner {
  return process.env.PINEFORGE_ENGINE_MODE === "local"
    ? new LocalRunner()
    : new DockerRunner(image);
}
```

- [ ] **Step 4: Wire the runner into `index.ts`**

Add to the imports from `./engine.js`: `selectRunner`, `type EngineRunner`. Near the other config consts in `src/index.ts`, add:

```ts
const engine: EngineRunner = selectRunner();
```

In `runBacktest` (`src/index.ts:101-123`): replace `const cpp = await dockerTranspile(args.source, image);` with `const cpp = await engine.transpile(args.source);` and replace the `dockerBacktest({ image, cppPath, csvPath, ... })` call with `engine.backtest({ cppPath, csvPath, inputs: args.inputs, overrides: args.overrides, runtime: args.runtime })`. Keep the `image` only for the `_meta`/return value (use `engine.mode === "docker" ? image : "local"`).

In `runBacktestGrid` (`src/index.ts:125-221`): replace `dockerTranspile(args.source, image)` with `engine.transpile(args.source)`, and the per-combo `dockerBacktest({ image, cppPath, csvPath, ... })` with `engine.backtest({ cppPath, csvPath, inputs: combo.inputs, overrides: combo.overrides, runtime: args.runtime })`.

In the standalone `transpile_pine` tool handler (search `registerTool("transpile_pine"` / the handler calling `dockerTranspile`): replace with `engine.transpile(source)`.

- [ ] **Step 5: Build + test, verify PASS**

Run: `npm run build && npm test`
Expected: all pass; no remaining references to `dockerTranspile`/`dockerBacktest` in `index.ts` (`grep -n "dockerTranspile\|dockerBacktest" src/index.ts` → no matches).

- [ ] **Step 6: Commit**

```bash
git add src/engine.ts src/index.ts test/engine.select.test.ts
git commit -m "feat: select engine runner from PINEFORGE_ENGINE_MODE; route tools through it"
```

---

## Task 7: `check_engine_image` / `pull_engine_image` tools through the runner

**Files:**
- Modify: `src/index.ts` (the two tool handlers)

- [ ] **Step 1: Route both tools through `engine`**

Find the `check_engine_image` tool handler (calls `checkEngineImage(...)`) and the `pull_engine_image` handler (calls `pullImage(...)`). Replace their bodies to delegate:

```ts
// check_engine_image handler:
async ({ image, auto_pull }) =>
  asTextResult(await engine.checkImage(image ?? DEFAULT_IMAGE, auto_pull === true)),

// pull_engine_image handler:
async ({ image }) =>
  asTextResult(await engine.pullImage(image ?? DEFAULT_IMAGE)),
```

(Local mode returns the static baked-in descriptor / no-op pull from Task 5; docker mode behaves exactly as before.)

- [ ] **Step 2: Build + test, verify PASS**

Run: `npm run build && npm test`
Expected: all pass.

- [ ] **Step 3: Manual local-mode sanity check**

Run:
```bash
PINEFORGE_ENGINE_MODE=local PINEFORGE_PREFIX="$(pwd)/test/fixtures/fake-prefix" \
  node --import tsx -e "import('./src/engine.js').then(async m => { const e=m.selectRunner(); console.log(await e.checkImage('x', false)); })"
```
Expected: prints `{ mode: 'local', baked_in: true, version: ... }`.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: image freshness tools degrade cleanly in local mode"
```

---

## Task 8: `.dockerignore` + combined image in `docker/`

**Files:**
- Create: `.dockerignore`
- Create: `docker/Dockerfile`
- Delete: `Dockerfile`

- [ ] **Step 1: Create `.dockerignore`**

```
.git
node_modules
dist
docs
*.log
```

- [ ] **Step 2: Create `docker/Dockerfile`**

```dockerfile
# Self-contained Glama-deployable MCP image: the pineforge-engine (g++, the
# prebuilt libpineforge.a, the bundled codegen, entrypoint.sh) plus the Node
# MCP server. Runs every tool with no host Docker daemon — the server execs
# the engine entrypoint in-process (PINEFORGE_ENGINE_MODE=local).
#
# Build: docker build -f docker/Dockerfile -t pineforge-codegen-mcp .

# --- build MCP dist + prod deps (lockfile present → npm ci) ---
FROM node:22-slim AS mcp
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

# --- final: engine image + node runtime + MCP server ---
FROM ghcr.io/pineforge-4pass/pineforge-engine:0.8.0
COPY --from=node:22-slim /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=mcp /app/dist ./dist
COPY --from=mcp /app/node_modules ./node_modules
COPY --from=mcp /app/package.json ./
ENV PINEFORGE_ENGINE_MODE=local \
    PINEFORGE_PREFIX=/opt/pineforge \
    PINEFORGE_ALLOW_ANYWHERE=1
ENTRYPOINT ["node", "dist/index.js"]
```

- [ ] **Step 3: Delete the old root Dockerfile**

```bash
git rm Dockerfile
```

- [ ] **Step 4: Build the image**

Run: `docker build -f docker/Dockerfile -t pineforge-codegen-mcp:test .`
Expected: build succeeds. (Requires the engine `:0.8.0` image from Task 1 Step 6 to be pullable.)

- [ ] **Step 5: Smoke-test node + MCP introspection in the image**

Run:
```bash
docker run --rm pineforge-codegen-mcp:test --version 2>/dev/null || true
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | docker run --rm -i pineforge-codegen-mcp:test | grep -q '"backtest_pine"' && echo "INTROSPECTION OK"
```
Expected: `INTROSPECTION OK` (server starts, lists tools over stdio). This also proves the copied `node` binary runs in the engine base.

- [ ] **Step 6: Commit**

```bash
git add .dockerignore docker/Dockerfile
git commit -m "feat(docker): self-contained combined image in docker/; add .dockerignore; drop root Dockerfile"
```

---

## Task 9: CI — build + push the combined image to GHCR on tag

**Files:**
- Modify: `.github/workflows/publish.yml`

- [ ] **Step 1: Add an image job**

Append after the `release` job in `.github/workflows/publish.yml`:

```yaml
  # Build + push the self-contained MCP image so users can `docker pull` it
  # (Glama also builds from docker/Dockerfile directly). Tag pushes only.
  image:
    needs: publish
    if: startsWith(github.ref, 'refs/tags/v')
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ github.token }}
      - name: Build and push
        uses: docker/build-push-action@v6
        env:
          TAG_NAME: ${{ github.ref_name }}
        with:
          context: .
          file: docker/Dockerfile
          push: true
          tags: |
            ghcr.io/pineforge-4pass/pineforge-codegen-mcp:${{ env.TAG_NAME }}
            ghcr.io/pineforge-4pass/pineforge-codegen-mcp:latest
```

- [ ] **Step 2: Lint the workflow locally**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/publish.yml')); print('yaml ok')"`
Expected: `yaml ok`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/publish.yml
git commit -m "ci: build + push self-contained MCP image to ghcr on tag"
```

---

## Task 10: Release v0.8.0 + Glama release (manual)

**Files:**
- Modify: `VERSION`
- Modify: `README.md` (document local-mode image)

- [ ] **Step 1: Document the image in README**

Under `## Install`, add a "Run as a container (Glama / self-contained)" subsection:

```markdown
### Run as a container (self-contained — no host Docker)

```bash
docker run --rm -i ghcr.io/pineforge-4pass/pineforge-codegen-mcp:latest
```

This image bundles the backtest engine; every tool works without a host Docker
daemon (`PINEFORGE_ENGINE_MODE=local`). The `npx` install above instead drives
your host Docker daemon.
```

- [ ] **Step 2: Bump VERSION + tag**

```bash
echo "0.8.0" > VERSION
git add VERSION README.md
git commit -m "release: v0.8.0 — self-contained Glama-deployable image + local engine mode"
git tag v0.8.0
git push origin main
git push origin v0.8.0
```

Expected: `publish.yml` runs npm publish → GitHub Release → ghcr image push.

- [ ] **Step 3: Verify CI artifacts**

Run: `gh release view v0.8.0 --json tagName -q .tagName` → `v0.8.0`.
Run: `docker pull ghcr.io/pineforge-4pass/pineforge-codegen-mcp:0.8.0` → succeeds.

- [ ] **Step 4: Glama release (manual UI — cannot be scripted)**

1. Claim the server at `https://glama.ai/mcp/servers/pineforge-4pass/pineforge-codegen-mcp/score` (if not already).
2. Open `.../admin/dockerfile`. Build context = repo root; Dockerfile = `docker/Dockerfile`. **If the admin can't point at a subfolder, paste the `docker/Dockerfile` contents into the build spec.** Click **Deploy**.
3. When the build test passes → **Make Release** → version `0.8.0` → **Create & Publish Release**.

Expected: "No Glama release" ✗ flips to a published release; server earns the A grade.

---

## Self-Review notes (already reconciled against the spec)

- Spec §Repo1 → Task 1. §2a interface/`cppPath` → Tasks 4–5. §2b mode select → Task 6. §2c image tools → Tasks 5+7. §2d Binance (unchanged) → no task needed. §2e image + §2e-bis `.dockerignore` → Task 8. §2f CI → Task 9. §2g tests → Tasks 1,2,5,6,8. §Glama release → Task 10.
- Type names consistent across tasks: `EngineRunner`, `BacktestCall`, `EngineInfo`, `LocalRunner`, `DockerRunner`, `selectRunner`, `engineEnv`, `stringifyParams`.
- Binance tools need no code change; they already gate writes on `PINEFORGE_ALLOW_ANYWHERE`, which the image sets to `1`.
