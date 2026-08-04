// audit.js
//
// Append-only audit trail. Every sandboxed execution request is logged
// BEFORE it runs, not after — so a killed or crashed sandbox still leaves
// a record of what was attempted. This mirrors the authorization-gate
// pattern from production TCS agents (log/gate before any write or
// outbound action), applied here at the sandbox-execution layer instead
// of the CRM-write layer.

import { appendFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, "..", "data");
const LOG_FILE = path.join(LOG_DIR, "audit.log.jsonl");

async function ensureLogDir() {
  if (!existsSync(LOG_DIR)) {
    await mkdir(LOG_DIR, { recursive: true });
  }
}

/**
 * Record an execution attempt. Called BEFORE the sandbox runs.
 * Returns the record's id so a follow-up "result" event can reference it.
 */
export async function logAttempt({ tool, params, requestedBy = "mcp-client" }) {
  await ensureLogDir();
  const record = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    event: "attempt",
    tool,
    params,
    requestedBy,
  };
  await appendFile(LOG_FILE, JSON.stringify(record) + "\n", "utf8");
  return record.id;
}

/**
 * Record the outcome of a previously logged attempt.
 */
export async function logResult(attemptId, { exitCode, durationMs, truncatedOutput, error }) {
  await ensureLogDir();
  const record = {
    id: crypto.randomUUID(),
    attemptId,
    ts: new Date().toISOString(),
    event: "result",
    exitCode,
    durationMs,
    truncatedOutput,
    error: error ? String(error) : null,
  };
  await appendFile(LOG_FILE, JSON.stringify(record) + "\n", "utf8");
}

/**
 * Read the last N log entries, newest first. Used by warden-cli logs.
 *
 * A single truncated or corrupted line (e.g. from a crash mid-write)
 * should not deny access to every other entry in an audit log — that
 * defeats the point of having one. Unparseable lines are skipped, not
 * fatal.
 */
export async function readRecentLog(n = 20) {
  await ensureLogDir();
  if (!existsSync(LOG_FILE)) return [];
  const raw = await readFile(LOG_FILE, "utf8");
  const lines = raw.trim().split("\n").filter(Boolean);
  const parsed = [];
  for (const l of lines.slice(-n)) {
    try {
      parsed.push(JSON.parse(l));
    } catch {
      parsed.push({ event: "unparseable", raw: l.slice(0, 200) });
    }
  }
  return parsed.reverse();
}
