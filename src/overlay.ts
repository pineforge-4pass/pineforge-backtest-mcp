/**
 * The prefix overlay: how an instrument reaches the engine without changing the image.
 *
 * The release image's entrypoint.sh compiles the strategy against
 * ${PINEFORGE_PREFIX}/include and /lib and runs ${PINEFORGE_PREFIX}/bin/run_json.py,
 * whose own `apply_syminfo` sets mintick, pointvalue, timezone and session, and from
 * release 1.1.0 also `mincontract` as the lot grid. For one run we build a
 * temporary directory that mirrors the real prefix (a symlink to every entry) except
 * bin/run_json.py, which is docker/pf_run_json.py: it loads the image's run_json.py
 * from the real prefix, applies the whole instrument through the C ABI and reports
 * what it applied. entrypoint.sh is told `PINEFORGE_PREFIX=<overlay>` and
 * `PINEFORGE_SYMINFO=<overlay>/instrument.json` and is otherwise the image's own.
 *
 * Local runner: the overlay lives under the OS temp dir and links to the real prefix.
 * Docker: it is bind-mounted read-only into the container, where the same absolute
 * links (/opt/pineforge/...) resolve inside the image.
 */

import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { hasApplicableField, type Instrument } from "./instrument.js";

/** Where the release image keeps the engine. */
export const IMAGE_PREFIX = "/opt/pineforge";
/** The overlay's mount point inside the container. */
export const OVERLAY_MOUNT = "/opt/pineforge-overlay";

/** The entries of a prefix: its top-level names and those of its bin/. */
export interface PrefixLayout {
  top: string[];
  bin: string[];
}

/** The release image's layout (pineforge-release 1.0.x, 1.1.0, 1.2.0 and 1.3.0), which the host cannot list. */
export const IMAGE_LAYOUT: PrefixLayout = { top: ["include", "lib", "pycodegen"], bin: ["entrypoint.sh"] };

/** docker/pf_run_json.py at the package root (npm `files` and the Docker image ship it). */
export function shimPath(): string {
  return fileURLToPath(new URL("../docker/pf_run_json.py", import.meta.url));
}

/** The layout of a prefix on this machine. */
export async function layoutOf(prefix: string): Promise<PrefixLayout> {
  return {
    top: (await readdir(prefix)).filter((n) => n !== "bin"),
    bin: await readdir(join(prefix, "bin")),
  };
}

export interface Overlay {
  /** The overlay on this machine. */
  dir: string;
  cleanup(): Promise<void>;
}

/** The file operations createOverlay performs on the engine's prefix; a test replaces `symlink` to inject a failure. */
export const overlayFs = { symlink };

/** Fixed reasons a run goes ahead without the instrument (they are all the result ever says about why). */
export const SKIP_REASONS = {
  platform: "this platform cannot link the engine prefix",
  build: "the overlay of the engine prefix could not be built",
  run: "the engine image could not use the overlay",
} as const;

/** The warning for a run that went ahead without its instrument. */
export function skippedWarning(reason: string): string {
  return `the instrument could not be applied (${reason}); the engine ran with its defaults`;
}

/** Why no overlay can be built on this host, or undefined: it links the engine prefix with symbolic links. */
export function overlayUnavailable(platform: NodeJS.Platform = process.platform): string | undefined {
  return platform === "win32" ? SKIP_REASONS.platform : undefined;
}

/** Whether a failed run's stderr names the overlay (its mount path in the container, or its folder on this host). */
export function mentionsOverlay(stderr: string, overlayDir: string): boolean {
  return stderr.includes(OVERLAY_MOUNT) || (overlayDir !== "" && stderr.includes(overlayDir));
}

/**
 * Build the overlay of `realPrefix` (the prefix as the engine process sees it:
 * /opt/pineforge in the image) holding `instrument` as instrument.json.
 */
export async function createOverlay(instrument: Instrument, realPrefix: string, layout: PrefixLayout): Promise<Overlay> {
  const dir = await mkdtemp(join(tmpdir(), "pineforge-overlay-"));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    // mkdtemp makes it 0700, and the umask shapes the rest; a container user other than
    // the caller must read all of it.
    await chmod(dir, 0o755);
    await mkdir(join(dir, "bin"));
    await chmod(join(dir, "bin"), 0o755);
    for (const name of layout.top) {
      if (name !== "bin") await overlayFs.symlink(posix.join(realPrefix, name), join(dir, name));
    }
    for (const name of layout.bin) {
      if (name !== "run_json.py") await overlayFs.symlink(posix.join(realPrefix, "bin", name), join(dir, "bin", name));
    }
    await copyFile(shimPath(), join(dir, "bin", "run_json.py"));
    await chmod(join(dir, "bin", "run_json.py"), 0o644);
    await writeFile(join(dir, "instrument.json"), JSON.stringify(instrument) + "\n");
    await chmod(join(dir, "instrument.json"), 0o644);
    return { dir, cleanup };
  } catch (e) {
    await cleanup().catch(() => undefined);
    throw e;
  }
}

/**
 * The overlay a run needs, or undefined: none when the instrument has nothing the engine can be given
 * (the run is then the image's own), none on a host that cannot link the prefix, and none, with a notice,
 * when building it fails for any reason. A run never fails because its overlay could not be built.
 */
export async function tryOverlay(
  instrument: Instrument | undefined,
  realPrefix: string,
  layout: PrefixLayout | (() => Promise<PrefixLayout>),
  notices?: string[],
): Promise<Overlay | undefined> {
  if (!instrument || !hasApplicableField(instrument)) return undefined;
  const unavailable = overlayUnavailable();
  if (unavailable) {
    notices?.push(skippedWarning(unavailable));
    return undefined;
  }
  try {
    return await createOverlay(instrument, realPrefix, typeof layout === "function" ? await layout() : layout);
  } catch {
    notices?.push(skippedWarning(SKIP_REASONS.build));
    return undefined;
  }
}

/** The environment that points entrypoint.sh and the shim at an overlay mounted at `at`. */
export function overlayEnv(at: string, realPrefix: string): Record<string, string> {
  return {
    PINEFORGE_PREFIX: at,
    PINEFORGE_SYMINFO: `${at}/instrument.json`,
    REAL_PREFIX: realPrefix,
  };
}
