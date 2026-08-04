// scripts/verify-memory-limit.js
//
// Standalone verification script (not part of the MCP server). Proves that
// WARDEN_MEMORY_LIMIT is actually enforced by the Docker memory cgroup, not
// just passed through as an unvalidated string.
//
// The allocation trick: `x=$(head -c N /dev/zero | tr '\0' 'a')` makes the
// shell buffer N bytes into its own process memory via command
// substitution. The `tr '\0' 'a'` step matters — /dev/zero is literal NUL
// bytes, and command substitution can treat an embedded NUL as a string
// terminator in some shells, which would make the "did we really allocate
// this much memory" claim ambiguous. Piping through tr first makes every
// byte a real, non-null 'a', so there's no such ambiguity.
//
// Usage (three separate runs, because WARDEN_MEMORY_LIMIT is read into a
// module-level constant in sandbox.js at import time, so it must be set in
// the environment before this process starts):
//
//   WARDEN_MEMORY_LIMIT=64m  node scripts/verify-memory-limit.js limited
//   WARDEN_MEMORY_LIMIT=512m node scripts/verify-memory-limit.js control
//   node scripts/verify-memory-limit.js oom-inspect

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2];
const ALLOC_CMD = "x=$(head -c 150000000 /dev/zero | tr '\\0' 'a'); echo done";

function saveEvidence(name, text) {
  writeFileSync(path.join(__dirname, "..", "docs", "evidence", name), text + "\n");
}

async function runLimitedOrControl(label, expectSuccess) {
  const { runSandboxed } = await import("../src/sandbox.js");
  const limit = process.env.WARDEN_MEMORY_LIMIT || "(default)";
  console.log(`# verify-memory-limit (${label}), WARDEN_MEMORY_LIMIT=${limit}`);
  const result = await runSandboxed(ALLOC_CMD);
  const printedDone = result.truncatedOutput.includes("done");
  const pass = expectSuccess ? printedDone : !printedDone;
  const tag = pass ? "[PASS]" : "[FAIL]";
  const detail = `exitCode=${result.exitCode}, durationMs=${result.durationMs}, printedDone=${printedDone}, output=${JSON.stringify(result.truncatedOutput.trim().slice(0, 200))}`;
  console.log(`${tag} ${label}: ${detail}`);
  process.exit(pass ? 0 : 1);
}

function runOomInspect() {
  const containerName = `warden-oom-check-${Date.now()}`;
  const args = [
    "run",
    "--name", containerName,
    "--network", "none",
    "--cap-drop=ALL",
    "--security-opt", "no-new-privileges",
    "--read-only",
    "--tmpfs", "/tmp/warden-scratch:rw,size=64m,mode=1777",
    "--user", "1000:1000",
    "--memory", "64m",
    "--cpus", "0.5",
    "--pids-limit", "64",
    "alpine:3.20",
    "sh", "-c", ALLOC_CMD,
  ];

  const lines = [];
  lines.push(`# verify-memory-limit (oom-inspect)`);
  lines.push(`timestamp: ${new Date().toISOString()}`);
  lines.push(`container: ${containerName}`);
  lines.push(`command: docker ${args.join(" ")}`);
  lines.push("");

  const runResult = spawnSync("docker", args, { encoding: "utf8" });
  lines.push(`run exit status: ${runResult.status}, signal: ${runResult.signal}`);
  lines.push(`stdout: ${JSON.stringify(runResult.stdout?.trim())}`);
  lines.push(`stderr: ${JSON.stringify(runResult.stderr?.trim())}`);
  lines.push("");

  const inspect = spawnSync("docker", [
    "inspect",
    "--format={{.State.OOMKilled}} exitCode={{.State.ExitCode}}",
    containerName,
  ], { encoding: "utf8" });
  const inspectOutput = inspect.stdout.trim();
  lines.push(`docker inspect --format='{{.State.OOMKilled}} exitCode={{.State.ExitCode}}': ${inspectOutput}`);

  const cleanup = spawnSync("docker", ["rm", containerName], { encoding: "utf8" });
  lines.push(`cleanup (docker rm): ${cleanup.stdout.trim()}${cleanup.stderr ? " " + cleanup.stderr.trim() : ""}`);

  const pass = inspectOutput.startsWith("true");
  lines.push("");
  lines.push(pass
    ? "[PASS] docker inspect confirms OOMKilled=true — the memory limit was actually enforced by the kernel cgroup, not just passed as an unvalidated flag."
    : "[FAIL] docker inspect did not report OOMKilled=true — memory limit enforcement is not confirmed.");

  const text = lines.join("\n");
  console.log(text);
  saveEvidence("memory-limit-oom-inspect.txt", text);
  process.exit(pass ? 0 : 1);
}

if (mode === "limited") {
  runLimitedOrControl("limited (expect kill)", false);
} else if (mode === "control") {
  runLimitedOrControl("control (expect success)", true);
} else if (mode === "oom-inspect") {
  runOomInspect();
} else {
  console.error("Usage: node scripts/verify-memory-limit.js <limited|control|oom-inspect>");
  process.exit(2);
}
