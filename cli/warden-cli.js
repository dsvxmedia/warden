#!/usr/bin/env node
// warden-cli.js
//
// Human-facing companion to the MCP server. Talks directly to Docker and
// to the audit log — it does not go through the MCP server, so it works
// even if the MCP process itself is unresponsive (the operator's
// override path, not just the agent's).
//
// Usage:
//   warden-cli status        list currently running warden sandboxes
//   warden-cli logs [n]      show the last n audit log entries (default 20)
//   warden-cli kill <id>     force-kill a running sandbox container by id
//   warden-cli allowlist     show the current egress allowlist

import { spawn, spawnSync } from "node:child_process";
import { readRecentLog } from "../src/audit.js";
import { getAllowlist } from "../src/egress.js";

const [, , cmd, ...args] = process.argv;

function dockerPs() {
  // Filter by the "warden-" name prefix every sandbox container gets
  // (see sandbox.js's containerName), not by base image — an ancestor
  // filter would also match any unrelated container someone else happens
  // to be running from the same image, misreporting it as a live Warden
  // sandbox.
  const res = spawnSync("docker", [
    "ps",
    "--filter", "name=^/warden-",
    "--format", "{{.ID}}\t{{.Status}}\t{{.Command}}",
  ], { encoding: "utf8" });
  return res.stdout.trim();
}

async function main() {
  switch (cmd) {
    case "status": {
      const out = dockerPs();
      console.log(out ? out : "No running Warden sandboxes.");
      break;
    }
    case "logs": {
      const n = Number(args[0]) || 20;
      const entries = await readRecentLog(n);
      for (const e of entries) {
        if (e.event === "unparseable") {
          console.log(`[?] CORRUPT LOG LINE (skipped)  ${e.raw}`);
        } else if (e.event === "attempt") {
          console.log(`[${e.ts}] ATTEMPT ${e.id.slice(0, 8)}  ${e.tool}  ${JSON.stringify(e.params)}`);
        } else {
          console.log(`[${e.ts}] RESULT  ${e.attemptId?.slice(0, 8)}  exit=${e.exitCode}  ${e.durationMs}ms${e.error ? "  error=" + e.error : ""}`);
        }
      }
      break;
    }
    case "kill": {
      const id = args[0];
      if (!id) {
        console.error("Usage: warden-cli kill <container_id>");
        process.exit(1);
      }
      const res = spawnSync("docker", ["kill", id], { encoding: "utf8" });
      console.log(res.stdout || res.stderr || `Killed ${id}`);
      break;
    }
    case "allowlist": {
      const list = await getAllowlist();
      console.log(list.length ? list.join("\n") : "(empty — sandboxes have no outbound network access)");
      break;
    }
    default:
      console.log("Usage: warden-cli <status|logs [n]|kill <id>|allowlist>");
  }
}

main();
