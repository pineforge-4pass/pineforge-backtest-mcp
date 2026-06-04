# Glama-deployable self-contained MCP — Design

**Date:** 2026-06-04
**Status:** Approved (design); pending implementation plan

## Goal

Produce a single container image where **every tool works with no host Docker
daemon** — the `pineforge-engine` is baked in and invoked in-process. The image
is runnable by users directly from Glama (which builds the Dockerfile, runs
security scans, and hosts deployments). Earns the Glama "release" + "A for
quality". The existing `npx`-on-host usage (which drives the *host* Docker
daemon) must keep working unchanged.

### Success criteria

- `transpile_pine`, `backtest_pine`, `backtest_pine_grid` all run inside the
  Glama-hosted container with no host Docker socket.
- `fetch_binance_ohlcv`, `binance_symbols` work (outbound HTTP only).
- Grid sweeps retain real parallelism in-container.
- `npx -y @pineforge/codegen-mcp` on a host still drives the host Docker daemon
  exactly as today (zero behavior change).
- Combined image builds + starts + answers MCP `tools/list` (Glama build test).

## Scope

Two repositories:

1. **`pineforge-engine`** — make the container entrypoint path-flexible and
   concurrency-safe so it can be driven in-process by multiple parallel calls.
2. **`pineforge-codegen-mcp`** — add an engine-invocation abstraction with
   docker and local backends, a combined Dockerfile in a dedicated `docker/`
   folder, CI to build/push the image, and the Glama release.

Out of scope: rewriting the engine in another language; changing the C++/Python
backtest internals; changing Binance tool logic.

---

## Repo 1 — `pineforge-engine`: concurrency-safe entrypoint

File: `docker/entrypoint.sh`. Two surgical, fully back-compatible edits.

### 1a. Input directory flexibility

```bash
IN_DIR="${PINEFORGE_IN_DIR:-/in}"
PINE="${IN_DIR}/strategy.pine"
SRC_CPP="${IN_DIR}/strategy.cpp"
OHLCV="${IN_DIR}/ohlcv.csv"
```

Default `/in` → docker-mode behavior is byte-identical. Local mode passes a
unique `PINEFORGE_IN_DIR` per call.

### 1b. Per-run work dir (no fixed `/tmp` paths)

Replace fixed `GEN=/tmp/strategy.cpp` and `SO=/tmp/strategy.so` with:

```bash
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
GEN="$WORK/strategy.cpp"
SO="$WORK/strategy.so"
```

Eliminates the cross-invocation collision when multiple backtests run in the
same container in parallel.

### 1c. Release

Bump engine `VERSION`, build + push `ghcr.io/pineforge-4pass/pineforge-engine`
(existing engine `release.yml`). The combined MCP image pins this new tag.

---

## Repo 2 — `pineforge-codegen-mcp`

### 2a. Engine-invocation abstraction (`src/engine.ts`, new)

Single interface both backends implement:

```ts
interface EngineRunner {
  transpile(source: string): Promise<string>;            // → C++
  backtest(args: {
    pine?: string;            // strategy.pine source (preferred)
    cppPath?: string;         // pre-transpiled TU (back-compat path)
    csvPath: string;          // OHLCV
    inputs?: ParamMap;
    overrides?: ParamMap;
    runtime?: RuntimeArgsLike;
  }): Promise<unknown>;       // parsed JSON report
  engineInfo(): Promise<EngineInfo>;  // for check/pull tools
}
```

- **`DockerRunner`** — current `dockerTranspile` / `dockerBacktest` /
  `checkEngineImage` / pull logic moved here verbatim. Drives host Docker, one
  container per call (isolation as today). Used by `npx`-on-host.
- **`LocalRunner`** — per call: `mktemp` an IN_DIR, write `strategy.pine`
  (and `ohlcv.csv` for backtest) into it, set the same `PINEFORGE_*` env vars
  plus `PINEFORGE_IN_DIR`, spawn `${PINEFORGE_PREFIX}/bin/entrypoint.sh`,
  collect stdout (JSON for backtest, raw C++ for transpile-only). Cleanup the
  temp dir in `finally`.

**Engine exit-code mapping** (both runners surface clear MCP errors):

| code | meaning              |
|------|----------------------|
| 2    | missing input mount  |
| 3    | compile failure      |
| 4    | backtest failure     |
| 5    | transpile failure    |

### 2b. Mode selection

`PINEFORGE_ENGINE_MODE=docker|local`.

- Default **`docker`** → `npx`-on-host behavior unchanged.
- Combined image sets **`local`**.

`src/index.ts` constructs the runner once at startup from the env, then replaces
direct `dockerTranspile` / `dockerBacktest` calls with `runner.transpile` /
`runner.backtest`. The `pMap` parallel grid path is untouched — both runners are
safe under concurrency (docker = container isolation; local = per-run mktemp).

### 2c. Image-freshness tools in local mode

`check_engine_image` / `pull_engine_image` are docker-only concepts. In local
mode the engine is baked in, so `LocalRunner.engineInfo()` returns a static
descriptor (`{ mode: "local", baked_in: true, version: <engine version> }`) and
the tools answer with that instead of shelling to docker. Tools remain listed
(clean introspection) and never error in local mode.

### 2d. Binance tools

`fetch_binance_ohlcv`, `binance_symbols` are pure `fetch` HTTP — unchanged in
both modes. They require outbound network; the Glama-hosted runtime allows
outbound HTTP. CSV writes land under the container working dir (enabled by
`PINEFORGE_ALLOW_ANYWHERE=1` in the image).

### 2e. Combined image — dedicated `docker/` folder

Move Docker artifacts into `docker/`:

- `docker/Dockerfile` — the combined, self-contained image (below).
- Root `Dockerfile` is removed; the combined image also satisfies Glama's
  build + introspection test, so the thin image is no longer needed.

```dockerfile
# build MCP dist + prod deps
FROM node:22-slim AS mcp
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

# final: engine image + node runtime + MCP server
FROM ghcr.io/pineforge-4pass/pineforge-engine:<pinned>
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

Notes:
- Node binary copied from `node:22-slim`; engine base is debian bookworm
  (glibc), so the node binary is ABI-compatible.
- Build context is the MCP repo root; `docker build -f docker/Dockerfile .`.
- `<pinned>` = the engine version released in step 1c.

### 2f. CI

Add a GitHub Actions job (extend `.github/workflows/publish.yml` or a sibling)
that, on tag push, builds `docker/Dockerfile` and pushes
`ghcr.io/pineforge-4pass/pineforge-codegen-mcp:<version>` and `:latest`.
Glama also builds from the Dockerfile directly; the ghcr image is a convenience
for direct `docker pull` users.

### 2g. Tests (TDD)

- **LocalRunner unit** — point `PINEFORGE_PREFIX` at a fixture dir whose
  `bin/entrypoint.sh` echoes a known JSON / C++ and asserts env + input files;
  verify the runner writes files, sets env, parses output, maps exit codes.
- **Concurrency isolation** — two `LocalRunner.backtest` calls in parallel
  against a fixture entrypoint that writes to its `mktemp` dir; assert no
  cross-talk and both results correct.
- **Engine shell test** (engine repo) — drive `entrypoint.sh` with a custom
  `PINEFORGE_IN_DIR` and confirm mktemp work-dir behavior + default `/in`
  unchanged.
- **Smoke (optional, needs built image)** — `docker run` the combined image,
  MCP `initialize` + `tools/list` + a tiny transpile/backtest over stdio.

---

## Glama release (manual, post-build)

Once `docker/Dockerfile` builds green:

1. Claim the server (Score tab) if not already.
2. `admin/dockerfile` → configure build spec (build context = repo root,
   Dockerfile = `docker/Dockerfile`) → **Deploy**.
3. Build test passes → **Make Release** → version `v0.8.0` → publish.

Flips the "No Glama release" ✗ and awards the A grade.

---

## Data flow

```
agent
  → MCP tool (e.g. backtest_pine)
  → runner = (PINEFORGE_ENGINE_MODE === "local") ? LocalRunner : DockerRunner
  → runner.backtest({ pine, csvPath, inputs, overrides, runtime })
      • DockerRunner: docker run engine, -v mounts, -e env → stdout JSON
      • LocalRunner:  mktemp IN_DIR, write files, set PINEFORGE_IN_DIR + env,
                      spawn entrypoint.sh → stdout JSON
  → parse JSON → MCP result
```

## Risks / notes

- **Engine tag pinning**: combined image couples to a specific engine version.
  Bump deliberately; document the pinned tag in the Dockerfile.
- **Node ABI**: relies on debian-on-debian glibc compatibility for the copied
  node binary. If the engine base image changes distro, revisit.
- **Outbound network on Glama**: Binance tools assume egress is permitted in
  the hosted runtime; if Glama restricts egress, those two tools degrade (the
  backtest tools still work with a user-supplied CSV).
