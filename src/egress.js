// egress.js
//
// Sandboxes have no network access by default (see sandbox.js, --network
// none). This module is the ONLY path by which a sandbox can reach the
// network at all: an explicit, persisted allowlist of domains, applied to
// a dedicated Docker network ("warden-egress") that routes outbound
// traffic through a minimal forward proxy honoring that allowlist.
//
// The allowlist is the security control, not a suggestion. An empty
// allowlist means "allowlist" network mode behaves identically to "none".
//
// This is intentionally simple (a JSON file, not a database) so the
// control surface is auditable by reading one file, not by trusting an
// opaque config store.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(__dirname, "..", "data");
const ALLOWLIST_FILE = path.join(CONFIG_DIR, "egress-allowlist.json");

async function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) {
    await mkdir(CONFIG_DIR, { recursive: true });
  }
}

export async function getAllowlist() {
  await ensureConfigDir();
  if (!existsSync(ALLOWLIST_FILE)) return [];
  const raw = await readFile(ALLOWLIST_FILE, "utf8");
  return JSON.parse(raw);
}

/**
 * Replace the egress allowlist. Domains only — no wildcards, no CIDR
 * ranges, on purpose: this keeps the control legible to a human reading
 * the file, at the cost of flexibility. A production version would
 * regenerate the forward-proxy ACL here too; that wiring is left as a
 * documented next step (see README "Not yet built").
 */
export async function setAllowlist(domains) {
  await ensureConfigDir();
  const clean = [...new Set(domains.map((d) => d.trim().toLowerCase()).filter(Boolean))];
  await writeFile(ALLOWLIST_FILE, JSON.stringify(clean, null, 2), "utf8");
  return clean;
}
