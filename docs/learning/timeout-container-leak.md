# The timeout container leak

## What the README claimed

The "Security model" section says the sandbox has a hard timeout: "a wall-clock
kill switch independent of the process's own behavior."

## What the code actually did

`src/sandbox.js` ran every command with `docker run` in the foreground (no
`-d`). When the timeout fired, the code called `child.kill("SIGKILL")` on the
local `docker` CLI process — the client, not the container.

`docker run` in foreground mode is just a client talking to the Docker
daemon over its API. Killing that client process does not tell the daemon to
stop the container. SIGKILL also can't be caught or forwarded by the process
receiving it, so there was no code path that could turn "kill the client"
into "kill the container" on its own.

## How this was checked

A script, `scripts/verify-timeout-cleanup.js`, ran a sandboxed `sleep 60`
with `WARDEN_TIMEOUT_MS=3000`, then checked `docker ps` right after the call
returned.

**Before the fix**, real output:

```
resolved after 3011ms: {"exitCode":null,"durationMs":3011,"truncatedOutput":"","timedOut":true}

## `docker ps` immediately after the call resolved
3e54e3e70397	Up 2 seconds	"sh -c 'sleep 60'"

[FAIL] Container is still running after the timeout fired.
```

Node believed the command was over after about three seconds. The container
was still running in Docker, doing nothing useful, until the script's own
cleanup step killed it by hand.

Full raw output: [`docs/evidence/timeout-before.txt`](../evidence/timeout-before.txt).

## The fix

Two changes to `runSandboxed()` in `src/sandbox.js`:

1. Give every container a name (`warden-<uuid>`) via `--name`, so it can be
   targeted directly instead of only being reachable through the client
   process.
2. On timeout, run `docker kill <name>` **synchronously**, before killing the
   local client process.

## A bug in the first fix attempt

The first version called `docker kill` with `spawn()` (async, not awaited)
and then immediately killed the local client. That still failed the
verification script — the async `docker kill` command hadn't finished
running by the time the client's `close` event fired and the promise
resolved, so `docker ps` still showed the container as running. Async
"fire and forget" cleanup lost the race against the synchronous
`child.kill("SIGKILL")` right next to it.

The actual fix uses `spawnSync("docker", ["kill", containerName])`, which
blocks until the kill command has finished, before killing the client. This
only adds a synchronous pause on the timeout path (the rare case), not on
normal command execution.

**After the fix**, real output:

```
resolved after 3073ms: {"exitCode":null,"durationMs":3073,"truncatedOutput":"","timedOut":true}

## `docker ps` immediately after the call resolved
(empty)

[PASS] No container from this image is running after the timeout fired.
```

Full raw output: [`docs/evidence/timeout-after.txt`](../evidence/timeout-after.txt).

## Regression check

A normal, fast command (`echo hello`) was re-run after the fix to confirm
the `--name` flag and the timeout-path change didn't break anything on the
common path:

```
{"exitCode":0,"durationMs":194,"truncatedOutput":"hello\n","timedOut":false}
```

Exit code 0, correct output, normal duration.
