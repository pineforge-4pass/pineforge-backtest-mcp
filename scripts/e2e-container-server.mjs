// A transparent stdio adapter: preserve cwd, temporary paths and per-client
// environment overrides used by the existing negative and syminfo suites.
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
const image = process.env.PF_E2E_CANDIDATE_IMAGE;
if (!image || !/^[a-z0-9/:._-]+$/.test(image)) throw Error("missing candidate image");
const workspace = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
const args = ["run", "--rm", "-i", "--network", "host", "--user", `${process.getuid()}:${process.getgid()}`,
  "-v", `${workspace}:${workspace}`, "-v", `${tmpdir()}:${tmpdir()}`, "-w", process.cwd()];
for (const key of Object.keys(process.env).filter((k) => k.startsWith("PINEFORGE_"))) args.push("-e", key);
const child = spawn("docker", [...args, "--entrypoint", "node", image, "/app/dist/index.local.js"], { stdio: "inherit" });
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => child.kill(sig));
child.on("error", (e) => { console.error(e.message); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
