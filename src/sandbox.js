// sandbox.js
//
// Executes a shell command inside a locked-down, ephemeral Docker
// container instead of on the host. This is the actual security surface
// of the project — read this file before the README claims anything.
//
// Controls applied, and why:
//
//   --rm                          container is destroyed after exit; no
//                                  persistence, nothing to clean up or leak
//   --network <mode>               "none" by default (see egress.js) — a
//                                  sandbox that can't reach the network
//                                  can't exfiltrate data or call out to
//                                  an attacker-controlled host, even if
//                                  the command it runs is malicious
//   --cap-drop=ALL                strips all Linux capabilities
//                                  (CAP_NET_ADMIN, CAP_SYS_ADMIN, etc.)
//                                  so even a container-breakout-adjacent
//                                  bug has nothing privileged to abuse
//   --security-opt=no-new-privileges
//                                  blocks setuid/setgid escalation inside
//                                  the container
//   --read-only                   root filesystem is read-only; only
//                                  /tmp/warden-scratch (tmpfs) is writable
//   --user 1000:1000              runs as a non-root UID inside the
//                                  container, independent of the image's
//                                  default user
//   --memory / --cpus / --pids-limit
//                                  resource caps so a runaway or forkbomb
//                                  process can't take down the host
//   timeout wrapper                hard wall-clock kill switch independent
//                                  of the process's own behavior — SIGKILL
//                                  to the local `docker` CLI client can't be
//                                  forwarded to the daemon, so the timeout
//                                  also force-stops the container directly
//                                  by name (see docs/learning/timeout-container-leak.md)
//
// What this does NOT provide, on purpose (documented, not hidden):
//   - kernel-level isolation of a gVisor/Firecracker microVM — this is
//     Docker's namespace/cgroup isolation, which is weaker against a
//     kernel-exploit-class attacker. See README "Tradeoffs" section for
//     why that's an acceptable default here and what would change it.

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const DEFAULT_IMAGE = process.env.WARDEN_SANDBOX_IMAGE || "alpine:3.20";
const DEFAULT_MEMORY = process.env.WARDEN_MEMORY_LIMIT || "256m";
const DEFAULT_CPUS = process.env.WARDEN_CPU_LIMIT || "0.5";
const DEFAULT_PIDS = process.env.WARDEN_PIDS_LIMIT || "64";
const DEFAULT_TIMEOUT_MS = Number(process.env.WARDEN_TIMEOUT_MS || 15000);
const MAX_OUTPUT_CHARS = 8000;

/**
 * Run `command` inside a sandboxed container.
 * @param {string} command - shell command to execute inside the sandbox
 * @param {object} opts
 * @param {"none"|"allowlist"} [opts.network] - network mode; "none" unless
 *        an explicit allowlist has been configured (see egress.js)
 */
export function runSandboxed(command, opts = {}) {
  const network = opts.network === "allowlist" ? "warden-egress" : "none";
  const containerName = `warden-${randomUUID()}`;

  const args = [
    "run",
    "--rm",
    "--name", containerName,
    "--network", network,
    "--cap-drop=ALL",
    "--security-opt", "no-new-privileges",
    "--read-only",
    "--tmpfs", "/tmp/warden-scratch:rw,size=64m,mode=1777",
    "--user", "1000:1000",
    "--memory", DEFAULT_MEMORY,
    // Without --memory-swap, Docker defaults it to 2x --memory, so a
    // process can actually use up to double WARDEN_MEMORY_LIMIT before
    // being OOM-killed (see docs/learning/memory-oom-methodology.md).
    // Pinning it equal to --memory removes that implicit swap headroom.
    "--memory-swap", DEFAULT_MEMORY,
    "--cpus", DEFAULT_CPUS,
    "--pids-limit", DEFAULT_PIDS,
    DEFAULT_IMAGE,
    "sh", "-c", command,
  ];

  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      // SIGKILL to the local `docker run` client only kills the CLI
      // process — SIGKILL can't be caught or forwarded, so the daemon is
      // never told to stop the container on its own. Force-stop it by
      // name FIRST, synchronously, so it's actually gone before the local
      // client is killed and this call resolves; an async fire-and-forget
      // kill here loses the race against the client's own "close" event.
      // --rm still cleans up the container's metadata once it's killed.
      // This can race a command that finishes naturally right as the
      // timeout fires, in which case "No such container" is expected.
      spawnSync("docker", ["kill", containerName], { stdio: "ignore" });
      child.kill("SIGKILL");
    }, DEFAULT_TIMEOUT_MS);

    // Stop accumulating once past MAX_OUTPUT_CHARS — the final combine
    // truncates to this length anyway, so buffering more than that on the
    // host is pure waste, and unbounded here it's a real host-memory DoS:
    // a flooding command (e.g. `yes`) can grow this string proportional to
    // (throughput × time), with nothing capping it until the timeout, and
    // completely independent of the container's own --memory limit (see
    // docs/learning/unbounded-output-buffering.md).
    child.stdout.on("data", (d) => { if (stdout.length < MAX_OUTPUT_CHARS) stdout += d.toString(); });
    child.stderr.on("data", (d) => { if (stderr.length < MAX_OUTPUT_CHARS) stderr += d.toString(); });

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      const combined = (stdout + (stderr ? "\n[stderr]\n" + stderr : "")).slice(0, MAX_OUTPUT_CHARS);
      resolve({
        exitCode: killed ? null : exitCode,
        durationMs,
        truncatedOutput: combined,
        timedOut: killed,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: null,
        durationMs: Date.now() - started,
        truncatedOutput: "",
        error: err.message,
      });
    });
  });
}
