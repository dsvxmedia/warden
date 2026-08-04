// scripts/verify-sandbox.js
//
// Standalone verification script (not part of the MCP server). Runs the
// five functional checks the README's "Security model" section implies,
// each against a REAL sandboxed container, and reports honest PASS/FAIL
// against real captured output — not assumed behavior.

import { runSandboxed } from "../src/sandbox.js";

const checks = [];
let failures = 0;

function report(name, pass, detail) {
  const tag = pass ? "[PASS]" : "[FAIL]";
  console.log(`${tag} ${name}`);
  console.log(`       ${detail}`);
  checks.push({ name, pass });
  if (!pass) failures++;
}

async function main() {
  // 1. echo hello — confirm exit code 0 and correct output
  {
    const r = await runSandboxed("echo hello");
    const pass = r.exitCode === 0 && r.truncatedOutput.trim() === "hello";
    report(
      "echo hello",
      pass,
      `exitCode=${r.exitCode}, output=${JSON.stringify(r.truncatedOutput.trim())}`
    );
  }

  // 2. whoami — confirm a non-root UID, not root/0
  //
  // Real finding: plain `whoami` errors on stock alpine:3.20, because the
  // image's /etc/passwd has no entry for UID 1000 (only root=0 and a few
  // system users), and busybox's whoami needs a name to resolve. This is
  // not a sandbox bug — it's a base-image quirk. The actual security
  // property (--user 1000:1000 is really applied, not root) is proven by
  // `id -u`, which doesn't need a passwd entry. Both are reported below
  // instead of hiding the whoami failure.
  {
    const whoamiResult = await runSandboxed("whoami");
    const idResult = await runSandboxed("id -u");
    const uid = idResult.truncatedOutput.trim();
    const pass = idResult.exitCode === 0 && uid === "1000";
    report(
      "non-root UID (id -u; whoami itself errors on stock alpine, see detail)",
      pass,
      `id -u: exitCode=${idResult.exitCode}, output=${JSON.stringify(uid)} | ` +
      `whoami: exitCode=${whoamiResult.exitCode}, output=${JSON.stringify(whoamiResult.truncatedOutput.trim())}`
    );
  }

  // 3. cat /etc/os-release on the read-only filesystem — reads should work
  {
    const r = await runSandboxed("cat /etc/os-release");
    const pass = r.exitCode === 0 && r.truncatedOutput.includes("Alpine");
    report(
      "cat /etc/os-release (read on read-only fs)",
      pass,
      `exitCode=${r.exitCode}, output starts with: ${JSON.stringify(r.truncatedOutput.slice(0, 40))}`
    );
  }

  // 4. touch /this-should-fail outside the tmpfs scratch dir — must fail
  {
    const r = await runSandboxed("touch /this-should-fail");
    const pass = r.exitCode !== 0 && r.exitCode !== null;
    report(
      "touch /this-should-fail (must fail — proves --read-only)",
      pass,
      `exitCode=${r.exitCode}, stderr=${JSON.stringify(r.truncatedOutput.trim())}`
    );
  }

  // 4b. control: touch inside the tmpfs scratch dir — must succeed, isolates
  //     the read-only claim from a possibly-broken sandbox in general
  {
    const r = await runSandboxed("touch /tmp/warden-scratch/this-should-work && echo wrote-ok");
    const pass = r.exitCode === 0 && r.truncatedOutput.includes("wrote-ok");
    report(
      "touch /tmp/warden-scratch/... (control — must succeed)",
      pass,
      `exitCode=${r.exitCode}, output=${JSON.stringify(r.truncatedOutput.trim())}`
    );
  }

  // 5. network egress attempt with default network:"none" — must fail/timeout
  {
    const r = await runSandboxed("wget -T 5 -O /dev/null http://example.com 2>&1");
    const pass = r.exitCode !== 0 && r.exitCode !== null;
    report(
      "wget example.com with network:none (must fail — proves network isolation)",
      pass,
      `exitCode=${r.exitCode}, durationMs=${r.durationMs}, output=${JSON.stringify(r.truncatedOutput.trim().slice(0, 200))}`
    );
  }

  console.log("");
  console.log(`${checks.length - failures}/${checks.length} checks passed`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
