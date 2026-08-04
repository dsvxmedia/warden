#!/usr/bin/env node
// index.js — Warden MCP server entrypoint.
//
// Exposes three tools to any MCP client (Claude Code, Claude Desktop,
// etc.):
//
//   run_sandboxed        execute a shell command inside the locked-down
//                         Docker sandbox defined in sandbox.js
//   list_audit_log        return the last N logged execution attempts
//                         and their results
//   set_egress_allowlist  update which domains a sandbox may reach when
//                         run with network: "allowlist"
//
// Secrets: this file reads WARDEN_SANDBOX_IMAGE, WARDEN_MEMORY_LIMIT,
// etc. from environment variables only (via dotenv in development).
// Nothing is hardcoded and nothing is logged. See .env.example.

import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runSandboxed } from "./sandbox.js";
import { logAttempt, logResult, readRecentLog } from "./audit.js";
import { getAllowlist, setAllowlist } from "./egress.js";

const server = new McpServer({
  name: "warden-mcp",
  version: "0.1.0",
});

server.registerTool(
  "run_sandboxed",
  {
    title: "Run command in sandbox",
    description:
      "Executes a shell command inside a locked-down, ephemeral Docker container: non-root, all capabilities dropped, read-only filesystem, resource-limited, and no network access unless an egress allowlist has been explicitly configured. Every call is audit-logged before execution.",
    inputSchema: {
      command: z.string().min(1).describe("Shell command to run inside the sandbox"),
      network: z
        .enum(["none", "allowlist"])
        .default("none")
        .describe("Network mode. 'none' (default) has no network access at all. 'allowlist' routes through the configured egress allowlist."),
    },
  },
  async ({ command, network }) => {
    const attemptId = await logAttempt({
      tool: "run_sandboxed",
      params: { command, network },
    });

    const result = await runSandboxed(command, { network });

    await logResult(attemptId, {
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      truncatedOutput: result.truncatedOutput,
      error: result.error,
    });

    const summary = result.error
      ? `Sandbox failed to start: ${result.error}`
      : result.timedOut
        ? `Command timed out and was killed (exit code unavailable).`
        : `Exit code ${result.exitCode} in ${result.durationMs}ms.`;

    return {
      content: [
        {
          type: "text",
          text: `${summary}\n\n${result.truncatedOutput || "(no output)"}`,
        },
      ],
    };
  }
);

server.registerTool(
  "list_audit_log",
  {
    title: "List recent sandbox executions",
    description: "Returns the most recent sandbox execution attempts and their results, newest first.",
    inputSchema: {
      limit: z.number().int().min(1).max(200).default(20),
    },
  },
  async ({ limit }) => {
    const entries = await readRecentLog(limit);
    return {
      content: [{ type: "text", text: JSON.stringify(entries, null, 2) }],
    };
  }
);

server.registerTool(
  "set_egress_allowlist",
  {
    title: "Set sandbox egress allowlist",
    description:
      "Replaces the list of domains a sandbox may reach when run with network: 'allowlist'. An empty list disables all outbound access, identical to network: 'none'.",
    inputSchema: {
      domains: z.array(z.string()).describe("Domains to allow, e.g. ['api.example.com']"),
    },
  },
  async ({ domains }) => {
    const applied = await setAllowlist(domains);
    return {
      content: [
        {
          type: "text",
          text: `Egress allowlist updated: ${applied.length ? applied.join(", ") : "(empty — no outbound access permitted)"}`,
        },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
