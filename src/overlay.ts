/**
 * The prefix overlay: how an instrument reaches the engine without changing the image.
 *
 * The release image's entrypoint.sh compiles the strategy against
 * ${PINEFORGE_PREFIX}/include and /lib and runs ${PINEFORGE_PREFIX}/bin/run_json.py,
 * whose own `apply_syminfo` sets only mintick and pointvalue. For one run we build a
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
import type { Instrument } from "./instrument.js";

/** Where the release image keeps the engine. */
export const IMAGE_PREFIX = "/opt/pineforge";
/** The overlay's mount point inside the container. */
export const OVERLAY_MOUNT = "/opt/pineforge-overlay";

/** The entries of a prefix: its top-level names and those of its bin/. */
export interface PrefixLayout {
  top: string[];
  bin: string[];
}

/** The release image's layout (pineforge-release 1.0.x), which the host cannot list. */
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
      if (name !== "bin") await symlink(posix.join(realPrefix, name), join(dir, name));
    }
    for (const name of layout.bin) {
      if (name !== "run_json.py") await symlink(posix.join(realPrefix, "bin", name), join(dir, "bin", name));
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

/** The environment that points entrypoint.sh and the shim at an overlay mounted at `at`. */
export function overlayEnv(at: string, realPrefix: string): Record<string, string> {
  return {
    PINEFORGE_PREFIX: at,
    PINEFORGE_SYMINFO: `${at}/instrument.json`,
    REAL_PREFIX: realPrefix,
  };
}
