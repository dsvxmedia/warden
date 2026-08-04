# Testing the memory limit, and a real bug it turned up

## The goal

The README claims: "Memory, CPU, and PID caps prevent a runaway or
fork-bombing process from affecting the host." `WARDEN_MEMORY_LIMIT`
(default `256m`) is passed straight to Docker's `--memory` flag with no
validation. The question: does it actually cap memory, or does the flag
just get accepted and ignored?

## Building a real allocation, safely, with only alpine's built-in tools

Alpine's busybox has no simple "allocate N megabytes" command. The trick
used here:

```sh
x=$(head -c 150000000 /dev/zero | tr '\0' 'a'); echo done
```

`head -c 150000000 /dev/zero` streams 150,000,000 zero bytes. Piping
through `tr '\0' 'a'` turns every byte into a literal `a`. The outer
`x=$(...)` is shell command substitution — the shell has to read the
entire stream into its own memory before it can assign it to `x`, so this
forces the `sh` process itself to hold roughly 150MB in memory.

The `tr` step is not decoration. `/dev/zero` is literally all NUL bytes,
and command substitution in some shells treats an embedded NUL as a string
terminator — which would make it unclear whether the shell really buffered
150MB or silently stopped at the first byte. Converting every byte to `a`
removes that doubt entirely.

## Three checks, not one

A single pass/fail isn't enough evidence on its own — a failure could come
from something else entirely (a bad command, `--pids-limit`, an image
problem). Three checks together isolate the memory limit as the actual
cause:

1. **Limited run** — `WARDEN_MEMORY_LIMIT=64m`, allocate ~150MB (over 2x
   the limit). Expect the process to be killed, `done` never printed.
   Real result: `exitCode=137, printedDone=false`. Pass.
2. **Control run** — same command, `WARDEN_MEMORY_LIMIT=512m`. Expect
   success. Real result: `exitCode=0, printedDone=true, output="done"`.
   Pass. This proves the limited run's failure was really about memory,
   not something else in the command.
3. **Positive OOM confirmation** — exit code 137 alone is ambiguous; a
   plain `kill -9` or the timeout path (see
   [`timeout-container-leak.md`](timeout-container-leak.md)) produces the
   same code. To get an unambiguous signal, the container was run directly
   with `docker run` (not through `runSandboxed`), with `--rm` removed and
   `--name` added, so it could be inspected after it exited:
   `docker inspect --format='{{.State.OOMKilled}}'` returned `true`.
   Raw output: [`docs/evidence/memory-limit-oom-inspect.txt`](../evidence/memory-limit-oom-inspect.txt).

## The real bug this testing found

An independent second allocation method was used as a cross-check: instead
of the shell trick, run `python3 -c "bytearray(400*1024*1024)"` inside a
`python:3-alpine` container (swapped in via the existing
`WARDEN_SANDBOX_IMAGE` env var — no code change needed) against
`WARDEN_MEMORY_LIMIT=256m`.

This was expected to fail the same way. It didn't:

```
400MB vs 256m limit: {"exitCode":0, ...}  — the allocation succeeded
```

The process used 400MB of memory with a 256MB limit set, and nothing
stopped it.

**Why:** Docker's `--memory` flag controls physical memory. A separate
flag, `--memory-swap`, controls memory *plus* swap. If `--memory-swap` is
not set, Docker defaults it to **two times** `--memory`. `sandbox.js` was
only setting `--memory`, so every sandbox actually had, in practice, up to
double `WARDEN_MEMORY_LIMIT` of usable memory-plus-swap before the kernel
would step in. A 600MB allocation against the same 256m limit confirmed
this exactly: it got killed (`exitCode=137`), because 600MB is over the
implicit 512MB (2 × 256m) ceiling, while 400MB was under it and survived.

## The fix

One line added to `src/sandbox.js`, right after `--memory`:

```js
"--memory-swap", DEFAULT_MEMORY,
```

Setting `--memory-swap` equal to `--memory` removes the implicit swap
headroom, so the configured limit is the real ceiling, not half of it.

## Re-verified after the fix

The same 400MB-against-256m case that previously succeeded was re-run and
now correctly fails:

```
400MB vs 256m limit (post-fix, expect kill now): {"exitCode":137,...}
```

The full limited/control/oom-inspect suite was also re-run against the
fixed code and all three still pass, confirming the fix didn't break the
already-working paths.
