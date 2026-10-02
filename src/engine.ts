/**
 * @pineforge/backtest-mcp — docker engine primitives.
 *
 * Low-level Docker plumbing for the engine image: Pine → C++ transpile,
 * backtest invocation, image freshness/pull. Extracted from index.ts so a
 * second backend can live alongside it. No behavior change.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Config ───────────────────────────────────────────────────────────────

export const DEFAULT_IMAGE = process.env.PINEFORGE_IMAGE ?? "ghcr.io/pineforge-4pass/pineforge-release:latest";
export const DOCKER_TIMEOUT_MS = Number(process.env.PINEFORGE_DOCKER_TIMEOUT_MS ?? 120_000);
// One parity check (transpile + compile + run + grade) inside the grading core.
// The core's own deadline is PARITY_TIMEOUT_MS; the runner stops the driver only
// PARITY_GRACE_MS later (SIGTERM, then SIGKILL after PARITY_KILL_GRACE_MS), so
// the core reports its own timeout first and, when stopped, kills its children.
export const PARITY_TIMEOUT_MS = Number(process.env.PINEFORGE_PARITY_TIMEOUT_MS ?? 600_000);
const PARITY_GRACE_MS = 30_000;
const PARITY_KILL_GRACE_MS = 5_000;
const PARITY_STDOUT_CAP = 64 * 1024 * 1024;

// ─── Local transpile (Pine → C++ via the engine container) ──────────────────

// Runs the engine image in transpile-only mode: writes the Pine source to a
// temp file, mounts it read-only, and returns the generated C++ on stdout.
// No network (`--network=none`), no API key — codegen is bundled in the image.
export async function dockerTranspile(source: string, image: string): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), "pineforge-tr-"));
  const pinePath = join(tmp, "strategy.pine");
  await writeFile(pinePath, source, "utf8");
  try {
    const dockerArgs = [
      "run", "--rm", "--network=none",
      "-e", "PINEFORGE_TRANSPILE_ONLY=1",
      "-v", `${pinePath}:/in/strategy.pine:ro`,
      image,
    ];
    const child = spawn("docker", dockerArgs, { stdio: ["ignore", "pipe", "pipe"] });
    const { stdout, stderr, code } = await collectChild(child, DOCKER_TIMEOUT_MS);
    if (code !== 0) {
      throw new Error(
        `transpile failed (docker exit ${code}):\n${stderr.slice(-2048)}`
      );
    }
    return stdout;
  } finally {
    rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ─── Shared param types ───────────────────────────────────────────────────

export type ParamMap = Record<string, string | number | boolean>;
export type ParamGrid = Record<string, Array<string | number | boolean>>;

export interface RuntimeArgsLike {
  input_tf?: string;
  script_tf?: string;
  bar_magnifier?: boolean;
  magnifier_samples?: number;
  magnifier_dist?: string;
}

export async function pullImage(image: string): Promise<{ image: string; pulled: boolean; output: string }> {
  const child = spawn("docker", ["pull", image], { stdio: ["ignore", "pipe", "pipe"] });
  const { stdout, stderr, code } = await collectChild(child, DOCKER_TIMEOUT_MS);
  if (code !== 0) throw new Error(`docker pull failed (${code}): ${stderr.slice(-1024)}`);
  return { image, pulled: true, output: (stdout + stderr).trim().slice(-2048) };
}

export interface ImageFreshness {
  image: string;
  local_present: boolean;
  local_digest: string | null;
  remote_digest: string | null;
  remote_digests_all: string[];
  up_to_date: boolean;
  recommend_pull: boolean;
  notes: string[];
  pulled?: boolean;
  pull_output?: string;
  error?: string;
}

// Compare local image manifest digest vs registry per-platform digest without
// downloading layers. `docker manifest inspect --verbose` returns either a
// single object (single-arch tag) or an array (multi-arch / manifest list);
// each entry exposes `.Descriptor.digest`, which is exactly the digest format
// stored in the local image's RepoDigests. Up-to-date iff local digest is in
// the remote per-platform set.
export async function checkEngineImage(image: string, autoPull: boolean): Promise<ImageFreshness> {
  const notes: string[] = [];
  let local_present = false;
  let local_digest: string | null = null;
  let remote_digest: string | null = null;
  let remote_digests_all: string[] = [];
  let error: string | undefined;

  {
    const child = spawn(
      "docker",
      ["image", "inspect", "--format", "{{json .RepoDigests}}", image],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const { stdout, stderr, code } = await collectChild(child, DOCKER_TIMEOUT_MS);
    if (code === 0) {
      try {
        const arr = JSON.parse(stdout.trim()) as string[];
        const digests = arr
          .map((r) => r.split("@")[1])
          .filter((s): s is string => !!s && s.startsWith("sha256:"));
        if (digests.length > 0) {
          local_present = true;
          local_digest = digests[0] ?? null;
        } else {
          local_present = true;
          notes.push("local image present but has no RepoDigest (likely built locally, not pulled)");
        }
      } catch (e) {
        notes.push(`failed to parse local RepoDigests: ${(e as Error).message}`);
      }
    } else {
      const msg = (stderr || stdout).toLowerCase();
      if (msg.includes("no such image") || msg.includes("no such object")) {
        notes.push("local image absent");
      } else {
        notes.push(`docker image inspect failed (${code}): ${(stderr || stdout).trim().slice(-512)}`);
      }
    }
  }

  {
    const child = spawn(
      "docker",
      ["manifest", "inspect", "--verbose", image],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const { stdout, stderr, code } = await collectChild(child, DOCKER_TIMEOUT_MS);
    if (code === 0) {
      try {
        const parsed = JSON.parse(stdout.trim());
        const items = Array.isArray(parsed) ? parsed : [parsed];
        remote_digests_all = items
          .map((it: any) => it?.Descriptor?.digest as string | undefined)
          .filter((s): s is string => !!s && s.startsWith("sha256:"));
        if (remote_digests_all.length === 0) {
          error = "remote manifest contained no Descriptor.digest entries";
        }
      } catch (e) {
        error = `failed to parse manifest inspect output: ${(e as Error).message}`;
      }
    } else {
      error = `docker manifest inspect failed (${code}): ${(stderr || stdout).trim().slice(-512)}`;
    }
  }

  let up_to_date = false;
  if (local_digest && remote_digests_all.length > 0) {
    up_to_date = remote_digests_all.includes(local_digest);
    remote_digest = up_to_date ? local_digest : (remote_digests_all[0] ?? null);
  } else if (remote_digests_all.length > 0) {
    remote_digest = remote_digests_all[0] ?? null;
  }

  // recommend_pull defaults to "not up-to-date". When remote query failed,
  // only recommend pulling if the local image is missing — otherwise we
  // can't actually tell whether a pull is needed.
  let recommend_pull = !up_to_date;
  if (error && local_present) recommend_pull = false;

  const result: ImageFreshness = {
    image,
    local_present,
    local_digest,
    remote_digest,
    remote_digests_all,
    up_to_date,
    recommend_pull,
    notes,
    ...(error ? { error } : {}),
  };

  if (autoPull && recommend_pull) {
    try {
      const pulled = await pullImage(image);
      result.pulled = true;
      result.pull_output = pulled.output;
    } catch (e) {
      result.pulled = false;
      result.notes.push(`auto_pull failed: ${(e as Error).message}`);
    }
  }

  return result;
}

// ─── Param stringify helper ───────────────────────────────────────────────

export function stringifyParams(p?: ParamMap): Record<string, string> {
  if (!p) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(p)) out[k] = String(v);
  return out;
}

// ─── Docker backtest invocation ───────────────────────────────────────────

interface DockerResult { stdout: string; stderr: string; code: number; }

export async function dockerBacktest(args: {
  image: string;
  cppPath: string;
  csvPath: string;
  inputs?: ParamMap | Record<string, string>;
  overrides?: ParamMap | Record<string, string>;
  runtime?: RuntimeArgsLike;
}): Promise<unknown> {
  const dockerArgs: string[] = [
    "run", "--rm",
    "--network=none",
  ];
  const inputsObj = stringifyParams(args.inputs as ParamMap | undefined);
  const overridesObj = stringifyParams(args.overrides as ParamMap | undefined);
  if (Object.keys(inputsObj).length) {
    dockerArgs.push("-e", `PINEFORGE_INPUTS=${JSON.stringify(inputsObj)}`);
  }
  if (Object.keys(overridesObj).length) {
    dockerArgs.push("-e", `PINEFORGE_OVERRIDES=${JSON.stringify(overridesObj)}`);
  }
  const r = args.runtime ?? {};
  if (r.input_tf !== undefined && r.input_tf !== "") {
    dockerArgs.push("-e", `PINEFORGE_INPUT_TF=${r.input_tf}`);
  }
  if (r.script_tf !== undefined && r.script_tf !== "") {
    dockerArgs.push("-e", `PINEFORGE_SCRIPT_TF=${r.script_tf}`);
  }
  if (r.bar_magnifier !== undefined) {
    dockerArgs.push("-e", `PINEFORGE_BAR_MAGNIFIER=${r.bar_magnifier ? "true" : "false"}`);
  }
  if (r.magnifier_samples !== undefined) {
    dockerArgs.push("-e", `PINEFORGE_MAGNIFIER_SAMPLES=${r.magnifier_samples}`);
  }
  if (r.magnifier_dist !== undefined) {
    dockerArgs.push("-e", `PINEFORGE_MAGNIFIER_DIST=${r.magnifier_dist}`);
  }
  dockerArgs.push(
    "-v", `${args.cppPath}:/in/strategy.cpp:ro`,
    "-v", `${args.csvPath}:/in/ohlcv.csv:ro`,
    args.image,
  );

  const child = spawn("docker", dockerArgs, { stdio: ["ignore", "pipe", "pipe"] });
  const { stdout, stderr, code } = await collectChild(child, DOCKER_TIMEOUT_MS);
  if (code !== 0) {
    throw new Error(
      `docker exited ${code}\n` +
      `stderr (last 2KB):\n${stderr.slice(-2048)}`
    );
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(
      `backtest produced non-JSON output (first 500B):\n${stdout.slice(0, 500)}`
    );
  }
}

export function collectChild(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<DockerResult> {
  return new Promise<DockerResult>((resolveP, rejectP) => {
    let stdout = "", stderr = "";
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectP(new Error(`docker timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", (e) => { clearTimeout(timer); rejectP(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ stdout, stderr, code: code ?? 1 });
    });
  });
}

// ─── Engine runner abstraction ─────────────────────────────────────────────

export interface EngineInfo {
  mode: "docker" | "local";
  baked_in: boolean;
  version: string | null;
  image?: string;
}

export interface BacktestCall {
  cppPath: string;                 // pre-transpiled TU (grid reuses one)
  csvPath: string;                 // OHLCV csv
  image?: string;                  // per-call docker image override; ignored by LocalRunner
  inputs?: ParamMap;
  overrides?: ParamMap;
  runtime?: RuntimeArgsLike;
}

export interface ParityCall {
  /** The grading core's request (parity/pf_parity.py) without file paths. */
  request: Record<string, unknown>;
  /** The bars CSV on this machine (header timestamp,open,high,low,close,volume). */
  barsPath: string;
  /** Optional 1-minute magnifier feed on this machine. */
  magnifierBarsPath?: string;
}

export interface EngineRunner {
  readonly mode: "docker" | "local";
  transpile(source: string, image?: string): Promise<string>;
  backtest(call: BacktestCall): Promise<unknown>;
  /** Run the grading core once; resolves to its JSON response. */
  parity(call: ParityCall): Promise<Record<string, unknown>>;
  engineInfo(): Promise<EngineInfo>;
  // Image freshness — meaningful only for docker; local returns a static note.
  checkImage(image: string, autoPull: boolean): Promise<ImageFreshness | EngineInfo>;
  pullImage(image: string): Promise<{ image: string; pulled: boolean; output: string }>;
}

export class DockerRunner implements EngineRunner {
  readonly mode = "docker" as const;
  constructor(private image: string = DEFAULT_IMAGE) {}

  transpile(source: string, image?: string): Promise<string> {
    return dockerTranspile(source, image ?? this.image);
  }
  backtest(call: BacktestCall): Promise<unknown> {
    return dockerBacktest({ ...call, image: call.image ?? this.image });
  }
  // The engine image runs the grading core: no network, the core read-only,
  // the bars read-only, a per-call jail for the core's work, the request on stdin.
  async parity(call: ParityCall): Promise<Record<string, unknown>> {
    const jail = await mkdtemp(join(tmpdir(), "pineforge-parity-"));
    const name = `pineforge-parity-${randomBytes(6).toString("hex")}`;
    try {
      await mkdir(join(jail, "work"));
      const args = [
        "run", "--rm", "-i", "--network=none", "--name", name,
        "--entrypoint", "python3",
        "-e", `PF_PARITY_TIMEOUT_MS=${PARITY_TIMEOUT_MS}`,
        "-e", "PYTHONDONTWRITEBYTECODE=1",
        "-v", `${parityCoreDir()}:/opt/pf-parity:ro`,
        "-v", `${jail}:/jail`,
        "-v", `${call.barsPath}:/in/ohlcv.csv:ro`,
      ];
      if (call.magnifierBarsPath) args.push("-v", `${call.magnifierBarsPath}:/in/magnifier.csv:ro`);
      // Run as the caller so the 0700 jail and the caller's files are readable.
      if (typeof process.getuid === "function" && typeof process.getgid === "function") {
        args.push("--user", `${process.getuid()}:${process.getgid()}`);
      }
      args.push(this.image, "/opt/pf-parity/pf_parity.py");
      const request = { ...call.request, ohlcv_csv_path: "/in/ohlcv.csv", workdir: "/jail/work",
        magnifier_ohlcv_csv_path: call.magnifierBarsPath ? "/in/magnifier.csv" : null };
      return await runParityCore("docker", args, request, {
        onTimeout: () => {
          spawn("docker", ["kill", name], { stdio: "ignore" }).on("error", () => undefined);
        },
      });
    } finally {
      await rm(jail, { recursive: true, force: true }).catch(() => undefined);
    }
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

// ─── Local backend (in-process entrypoint.sh) ──────────────────────────────

// Builds the PINEFORGE_* env the entrypoint reads. Shared contract with the
// docker backend's -e flags so both speak identically.
function engineEnv(call: { inputs?: ParamMap; overrides?: ParamMap; runtime?: RuntimeArgsLike }): Record<string, string> {
  const env: Record<string, string> = {};
  const inputs = stringifyParams(call.inputs);
  const overrides = stringifyParams(call.overrides);
  if (Object.keys(inputs).length) env.PINEFORGE_INPUTS = JSON.stringify(inputs);
  if (Object.keys(overrides).length) env.PINEFORGE_OVERRIDES = JSON.stringify(overrides);
  const r = call.runtime ?? {};
  if (r.input_tf !== undefined && r.input_tf !== "") env.PINEFORGE_INPUT_TF = r.input_tf;
  if (r.script_tf !== undefined && r.script_tf !== "") env.PINEFORGE_SCRIPT_TF = r.script_tf;
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

  private async run(inDir: string, extraEnv: Record<string, string>): Promise<string> {
    const child = spawn("bash", [this.entrypoint()], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PINEFORGE_PREFIX: this.prefix, PINEFORGE_IN_DIR: inDir, ...extraEnv },
    });
    const { stdout, stderr, code } = await collectChild(child, DOCKER_TIMEOUT_MS);
    if (code !== 0) {
      const map: Record<number, string> = { 2: "missing input", 3: "compile failure", 4: "backtest failure", 5: "transpile failure" };
      throw new Error(`engine ${map[code] ?? "error"} (exit ${code}):\n${stderr.slice(-2048)}`);
    }
    return stdout;
  }

  async transpile(source: string, _image?: string): Promise<string> {
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

  // The grading core copied into this image, on the baked-in engine.
  // Every process of the request inherits PF_PARITY_REQUEST=<id> and starts in
  // the jail; once the driver has exited (normally, by signal or by SIGKILL) the
  // request is swept, compiler grandchildren included, before cleanup returns.
  async parity(call: ParityCall): Promise<Record<string, unknown>> {
    const jail = await mkdtemp(join(tmpdir(), "pineforge-parity-"));
    const jailReal = await realpath(jail);
    const id = randomUUID();
    const marker = `PF_PARITY_REQUEST=${id}`;
    try {
      const request = { ...call.request, ohlcv_csv_path: call.barsPath, workdir: jail,
        magnifier_ohlcv_csv_path: call.magnifierBarsPath ?? null };
      return await runParityCore("python3", [join(parityCoreDir(), "pf_parity.py")], request, {
        env: {
          ...process.env,
          PINEFORGE_PREFIX: this.prefix,
          PF_PARITY_TIMEOUT_MS: String(PARITY_TIMEOUT_MS),
          PYTHONDONTWRITEBYTECODE: "1",
          PF_PARITY_REQUEST: id,
        },
        detached: true,
        sweep: (driverPid) => sweepRequest(marker, jailReal, driverPid),
      });
    } finally {
      await sweepRequest(marker, jailReal).catch(() => undefined);
      await rm(jail, { recursive: true, force: true }).catch(() => undefined);
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

// ─── Grading core process ─────────────────────────────────────────────────

/** parity/ at the package root (npm `files` and the Docker image ship it). */
export function parityCoreDir(): string {
  return process.env.PINEFORGE_PARITY_DIR ?? fileURLToPath(new URL("../parity", import.meta.url));
}

/**
 * Run the grading core with `request` on stdin. Exit 0 = a JSON answer (also
 * for user errors); anything else is an internal failure. Past the timeout
 * (plus grace) the process, or its whole group when detached, is killed and
 * the answer is a plain timeout error.
 */
export function runParityCore(
  cmd: string,
  args: string[],
  request: Record<string, unknown>,
  opts: {
    env?: NodeJS.ProcessEnv;
    detached?: boolean;
    onTimeout?: () => void;
    /** Kills what is left of the request; run once the driver exits and awaited before settling. */
    sweep?: (driverPid: number | undefined) => Promise<unknown>;
  } = {},
): Promise<Record<string, unknown>> {
  return new Promise((resolveSettled, rejectSettled) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: opts.env, detached: opts.detached });
    let sweeping: Promise<unknown> = Promise.resolve();
    const sweep = () => {
      if (opts.sweep) sweeping = sweeping.then(() => opts.sweep!(child.pid)).catch(() => undefined);
    };
    child.on("exit", () => sweep());
    const resolveP = (v: Record<string, unknown>) => { void sweeping.then(() => resolveSettled(v)); };
    const rejectP = (e: unknown) => { void sweeping.then(() => rejectSettled(e)); };
    const out: Buffer[] = [];
    let outBytes = 0;
    let overflow = false;
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d: Buffer) => {
      outBytes += d.length;
      if (outBytes > PARITY_STDOUT_CAP) overflow = true;
      else out.push(d);
    });
    child.stderr.on("data", (d: Buffer) => { stderr = (stderr + d.toString()).slice(-8192); });
    const signal = (sig: NodeJS.Signals) => {
      try {
        if (opts.detached && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch { /* already gone */ }
    };
    // SIGTERM lets the driver kill and reap its children (they run in their own
    // sessions); SIGKILL follows if it has not exited after the kill grace.
    let hardKill: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      opts.onTimeout?.();
      signal("SIGTERM");
      hardKill = setTimeout(() => {
        signal("SIGKILL");
        sweep();
      }, PARITY_KILL_GRACE_MS);
    }, PARITY_TIMEOUT_MS + PARITY_GRACE_MS);
    child.on("error", (e) => { clearTimeout(timer); clearTimeout(hardKill); rejectP(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(hardKill);
      if (timedOut) {
        resolveP({
          ok: false,
          error: "timeout",
          message: `The parity check did not finish within ${Math.round(PARITY_TIMEOUT_MS / 1000)} s ` +
            "(PINEFORGE_PARITY_TIMEOUT_MS) and was stopped.",
        });
        return;
      }
      if (overflow) {
        rejectP(new Error(`grading core output exceeded ${PARITY_STDOUT_CAP} bytes`));
        return;
      }
      const text = Buffer.concat(out).toString("utf8");
      if (code !== 0) {
        rejectP(new Error(`grading core failed (exit ${code}):\n${stderr.slice(-2048)}`));
        return;
      }
      try {
        resolveP(JSON.parse(text) as Record<string, unknown>);
      } catch {
        rejectP(new Error(`grading core printed non-JSON output (first 500 B):\n${text.slice(0, 500)}`));
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(request));
  });
}

// ─── Request sweep (LocalRunner) ──────────────────────────────────────────

/**
 * PIDs of one request, other than this process: those whose environment holds
 * `marker` (NAME=value) or whose working directory is inside the request's jail.
 * Linux reads /proc; elsewhere (macOS, the unit tests) lsof lists working
 * directories, since process environments are not readable there.
 */
async function requestPids(marker: string, jailReal: string): Promise<number[]> {
  const found: number[] = [];
  const inJail = (p: string) => p === jailReal || p.startsWith(`${jailReal}/`);
  if (process.platform === "linux") {
    const needle = Buffer.from(`${marker}\0`);
    for (const name of await readdir("/proc")) {
      if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
      try {
        if ((await readFile(`/proc/${name}/environ`)).includes(needle)) {
          found.push(Number(name));
          continue;
        }
      } catch { /* exited, or not ours to read */ }
      try {
        if (inJail(await readlink(`/proc/${name}/cwd`))) found.push(Number(name));
      } catch { /* exited, or not ours to read */ }
    }
    return found;
  }
  const lsof = spawnSync("lsof", ["-a", "-d", "cwd", "-u", String(process.getuid?.() ?? ""), "-F", "pn"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  let pid = 0;
  for (const line of (lsof.stdout ?? "").split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid && pid !== process.pid && inJail(line.slice(1))) found.push(pid);
  }
  return found;
}

/**
 * SIGKILL every process of one request: the driver's group, then anything still
 * marked as the request's (children in their own sessions, their compilers,
 * orphans). Repeats until none is left; throws if some will not go.
 */
export async function sweepRequest(marker: string, jailReal: string, driverPid?: number): Promise<number> {
  let killed = 0;
  if (driverPid) {
    try { process.kill(-driverPid, "SIGKILL"); } catch { /* the group is already empty */ }
  }
  for (let round = 0; round < 100; round++) {
    const pids = await requestPids(marker, jailReal);
    if (pids.length === 0) return killed;
    for (const pid of pids) {
      for (const target of [-pid, pid]) {
        try { process.kill(target, "SIGKILL"); } catch { /* not a group leader, or gone */ }
      }
      killed++;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("processes of the parity check did not stop");
}
