// scripts/verify-timeout-cleanup.js
//
// Standalone verification script (not part of the MCP server). Proves or
// disproves the README's claim that warden's timeout is "a wall-clock kill
// switch independent of the process's own behavior."
//
// sandbox.js's timeout handler does `child.kill("SIGKILL")` on the local
// `docker` CLI client process. SIGKILL can't be caught or forwarded, so
// there is no guarantee the daemon is ever told to stop the container
// itself — it could be orphaned, still running, after Node considers the
// call "done." This script checks `docker ps` for real evidence instead of
// trusting the comment.
//
// Usage:
//   WARDEN_TIMEOUT_MS=3000 node scripts/verify-timeout-cleanup.js before
//   WARDEN_TIMEOUT_MS=3000 node scripts/verify-timeout-cleanup.js after
//
// WARDEN_TIMEOUT_MS must be set in the environment BEFORE this process
// starts (not inside the script) because sandbox.js reads it into a
// module-level constant at import time.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runSandboxed } from "../src/sandbox.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const label = process.argv[2] || "run";
const image = process.env.WARDEN_SANDBOX_IMAGE || "alpine:3.20";
const timeoutMs = process.env.WARDEN_TIMEOUT_MS || "15000 (default)";
const evidencePath = path.join(__dirname, "..", "docs", "evidence", `timeout-${label}.txt`);

function dockerPs() {
  const result = spawnSync("docker", [
    "ps",
    "--filter", `ancestor=${image}`,
    "--format", "{{.ID}}\t{{.Status}}\t{{.Command}}",
  ]);
  return result.stdout.toString().trim();
}

function log(lines) {
  const text = lines.join("\n");
  console.log(text);
  writeFileSync(evidencePath, text + "\n");
}

async function main() {
  const lines = [];
  lines.push(`# verify-timeout-cleanup (${label})`);
  lines.push(`timestamp: ${new Date().toISOString()}`);
  lines.push(`WARDEN_TIMEOUT_MS: ${timeoutMs}`);
  lines.push(`image: ${image}`);
  lines.push("");

  const baseline = dockerPs();
  lines.push("## baseline `docker ps` (before running the sandboxed sleep)");
  lines.push(baseline === "" ? "(empty)" : baseline);
  lines.push("");

  lines.push("## running: runSandboxed(\"sleep 60\") with a short timeout, expecting it to be force-killed");
  const start = Date.now();
  const result = await runSandboxed("sleep 60");
  const elapsedMs = Date.now() - start;
  lines.push(`resolved after ${elapsedMs}ms: ${JSON.stringify(result)}`);
  lines.push("");

  const after = dockerPs();
  lines.push("## `docker ps` immediately after the call resolved");
  lines.push(after === "" ? "(empty)" : after);
  lines.push("");

  const leaked = after !== "";
  if (leaked) {
    lines.push("[FAIL] Container is still running after the timeout fired. The");
    lines.push("       'hard timeout... independent of the process's own behavior'");
    lines.push("       claim does not hold: SIGKILL to the docker CLI client did not");
    lines.push("       stop the container on the daemon side.");
    const id = after.split("\t")[0];
    if (id) {
      lines.push(`       cleaning up orphaned container ${id} now (docker kill)`);
      spawnSync("docker", ["kill", id]);
    }
  } else {
    lines.push("[PASS] No container from this image is running after the timeout fired.");
    lines.push("       The container was actually stopped, not just the local client.");
  }

  log(lines);
  process.exit(leaked ? 1 : 0);
}

main();
