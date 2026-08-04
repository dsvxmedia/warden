# Pressure-test audit: 4 real bugs beyond the original verification pass

The original verification session (see
[`timeout-container-leak.md`](timeout-container-leak.md) and
[`memory-oom-methodology.md`](memory-oom-methodology.md)) tested the specific
claims in the README. This pass went further: adversarial and edge-case
testing across `audit.js`, `egress.js`, `cli/warden-cli.js`, and additional
`sandbox.js` behavior the README doesn't explicitly claim but that matters
for real-world robustness. Four real, reproducible bugs were found and fixed.
Two other documented security claims (PIDs limit, CPU limit) were pressure
tested for the first time and held up.

## Claims that held up under adversarial testing

**PIDs limit vs a fork bomb.** A loop spawning 500 background processes
against `--pids-limit 64` failed immediately and correctly:

```
sh: can't fork: Resource temporarily unavailable
```

**CPU limit under a busy loop.** A tight infinite-loop command against the
default `--cpus 0.5` was captured mid-run with `docker stats`:

```
warden-87b1bd51-...   51.06%   680KiB / 256MiB
```

Real cgroup enforcement, not a decorative flag, on both.

## Bug 1: unbounded stdout accumulation on the host

`sandbox.js` concatenated every chunk of container stdout/stderr into a
JS string for the full lifetime of the command, only truncating to
`MAX_OUTPUT_CHARS` (8000) at the very end. A flooding command (`yes | head
-c 400000000`) grew the **host** Node process's RSS by 32.5MB in a 4-second
window, scaling with `throughput × time`, capped only by the wall-clock
timeout, not by anything related to the container's own `--memory` limit.
Nothing in the codebase limits concurrent `run_sandboxed` calls, so this
scales linearly with concurrency too.

**Fix:** stop appending to `stdout`/`stderr` once they reach
`MAX_OUTPUT_CHARS`, in `sandbox.js`'s `data` handlers. Re-tested: the same
400MB-flood test dropped from 32.5MB to 11MB of host growth, and a longer
10-second, 1GB-flood test stayed in the same range rather than continuing
to climb. This is a meaningful reduction, not a hermetic zero: Node still
receives and discards Buffer chunks while draining the pipe even once the
string stops growing, which causes some residual GC churn. Eliminating
that fully would mean pausing or destroying the stdout/stderr streams (or
killing the child) once the cap is hit, which changes behavior for
legitimate commands that emit a lot of early output before doing
meaningful later work, so it wasn't done here.

## Bug 2: one corrupted audit log line broke reading the entire log

`readRecentLog` parsed every line with `JSON.parse` inside a single
`.map()`, uncaught. One malformed line, appended to simulate a crash
mid-write, disk pressure, or manual tampering, threw and:

- Broke `list_audit_log` over the real MCP protocol (caught by the SDK,
  returned as `isError: true`, so the server itself survived, but the
  entire log became unreadable through that tool).
- Crashed `warden-cli logs` outright with a raw, uncaught `SyntaxError`
  and a full stack trace to the terminal.

For a security tool, an audit log that one bad line can black out entirely
undermines the audit-before-execute guarantee: you can't verify what
happened if you can't read any of the log.

**Fix:** `readRecentLog` now parses each line individually; an unparseable
line becomes a visible `{event: "unparseable", raw: ...}` placeholder
instead of aborting the whole read. It is surfaced, not silently dropped —
a log format that lets one corrupted entry make itself (and everything
after it) disappear is a bad property for an audit trail to have.
`warden-cli logs` prints these placeholders as `[?] CORRUPT LOG LINE
(skipped)` instead of crashing. Re-tested: with the same corrupted line
injected, `warden-cli logs` now prints the corrupt-line marker plus all 4
other real entries, no crash.

## Bug 3: same corruption gap in the egress allowlist file

`egress.js`'s `getAllowlist()` had the identical unguarded `JSON.parse`.
A corrupted `data/egress-allowlist.json` crashed `warden-cli allowlist`.

**Fix:** wrapped in try/catch; a corrupted file logs a clear warning to
stderr and returns an empty list, i.e. fails closed (no egress access),
matching the direction "empty" already means for this control. Re-tested:
corrupting the file now produces a warning and `(empty — sandboxes have no
outbound network access)` instead of a crash.

## Bug 4: `warden-cli status` could misreport unrelated containers as sandboxes

`dockerPs()` filtered by `ancestor=<image>`. Since the fix in
[`timeout-container-leak.md`](timeout-container-leak.md) gives every real
sandbox a `warden-<uuid>` name, filtering by image instead of name means
`warden-cli status` also matches **any other container on the host that
happens to use the same base image**, regardless of whether Warden started
it. Reproduced by starting an unrelated container by hand
(`docker run --name totally-unrelated-container alpine:3.20 sleep 15`):
`warden-cli status` reported it as a running Warden sandbox.

**Fix:** filter by `name=^/warden-` instead of `ancestor=`. Re-tested with
one real Warden sandbox and one unrelated same-image container running at
once: `status` now shows only the real one.

## Regression check

After all four fixes, the original three verification scripts
(`verify-sandbox.js`, `verify-timeout-cleanup.js`,
`verify-memory-limit.js`) were re-run in full and still pass, confirming
none of these fixes broke the behavior verified earlier in the session.
