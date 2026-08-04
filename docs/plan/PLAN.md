# Warden: Verify, Fix, and Ship the Sandbox Security Model

## Context

`warden` is an MCP server (already scaffolded, not to be redesigned) that runs
shell commands inside locked-down Docker containers, with audit logging and
network egress control. The README's "Security model" section makes specific,
falsifiable claims about isolation (no network by default, non-root, read-only
root fs, resource limits, hard timeout, audit-before-execute). This session's
job is to actually run the code against those claims — not read the comments
and trust them — fix any place code and doc diverge, and only then commit and
push to `https://github.com/dsvxmedia/warden` (public). This is going on a job
application; the user needs to defend every claim in an interview, so the bar
is "proven by real execution," not "looks right." Beyond the code itself, the
repo needs to read as a complete, organized portfolio piece: every artifact
from this session (plan, findings, evidence, demo, narrative PDF) has a fixed
home so nothing gets lost and anything can be found later.

**Execution approach for this session (per user instruction, clarified):** I
execute the plan below directly, step by step — I am not handing orchestration
off to `/weaponx` as a driver. Any further Plan-type subagent dispatch uses
`model: "fable"`. `gstack`/`weaponx` skills are used as tools where they
naturally fit (e.g. `gstack`'s `review`/`ship` for the final git commit+push
flow, `weaponx` for the fix-verify portion of the timeout-leak investigation
if useful), not as the top-level loop.

## Pre-flight facts already confirmed this session (don't re-derive)

- Docker 29.5.3 installed, daemon running.
- `alpine:3.20` is **not** pulled locally yet — the pull is a real step, not a formality.
- `gh` is authenticated as `dsvxmedia`, matching the target repo owner.
- `npx` 11.12.1 available → `@modelcontextprotocol/inspector --cli` can be used with no separate install.
- `.gitignore` ignores `node_modules/`, `.env`, `data/`, `*.log`, `.DS_Store` — it does **not** ignore `.claude/`, and `.claude/scheduled_tasks.lock` currently exists. Add `.claude/` to `.gitignore` before the first commit so session-local state doesn't land in a public portfolio repo.
- No test framework or `test` script exists — scripts written for this task are plain Node ESM, not Jest/Vitest.

## Key finding from code reading (the reason this isn't a rubber-stamp task)

`src/sandbox.js`'s "hard timeout" is a plain `setTimeout` that SIGKILLs the
**local `docker` CLI client process**, not the container. SIGKILL can't be
forwarded/caught, so the daemon is never told to stop the container — a timed-
out command can plausibly leave an orphaned container running past the point
Node considers it "killed." The README claims this is "a wall-clock kill
switch independent of the process's own behavior." This needs to be proven
true or false with real `docker ps` evidence, not assumed either way.

Everything else read in `sandbox.js`, `egress.js`, `audit.js`, `index.js`
matches the README's claims on inspection (full docker flag list: `--rm
--network <none|warden-egress> --cap-drop=ALL --security-opt no-new-privileges
--read-only --tmpfs /tmp/warden-scratch:rw,size=64m,mode=1777 --user 1000:1000
--memory --cpus --pids-limit`). The egress-allowlist-not-enforced gap and the
no-auth-layer gap are already honestly disclosed in README's "Not yet built"
section — leave those alone, they're accurate.

## Final project structure (the target — nothing gets lost, everything has a home)

```
warden/
├── src/                          # existing, untouched except sandbox.js fix (if leak confirmed)
├── cli/                          # existing, untouched
├── scripts/                      # new: standalone verification scripts (real evidence generators)
│   ├── verify-timeout-cleanup.js
│   ├── verify-sandbox.js
│   └── verify-memory-limit.js
├── docs/
│   ├── plan/
│   │   └── PLAN.md                       # this approved plan, saved verbatim as a permanent record
│   ├── learning/
│   │   ├── timeout-container-leak.md     # technical writeup: the bug, why it happens, the fix, before/after evidence
│   │   └── memory-oom-methodology.md     # how the OOM test was designed (NUL-byte issue, control run, docker inspect proof)
│   ├── skills-used/
│   │   └── README.md                     # which Claude Code skills/tools built this session and why (gstack, weaponx, humanizer, make-pdf, hyperframes)
│   ├── evidence/                         # raw captured command output, not just console prints
│   │   ├── timeout-before.txt
│   │   ├── timeout-after.txt
│   │   ├── memory-limit-oom-inspect.txt
│   │   └── mcp-inspector-tools-list.txt
│   ├── demo/
│   │   ├── terminal-recording.gif        # (or .cast) real captured output
│   │   └── walkthrough-video.mp4         # built via hyperframes
│   ├── BEHIND_THE_SCENES.md              # humanized, 5th-grade narrative build story
│   └── BEHIND_THE_SCENES.pdf             # rendered via make-pdf, styled after the user's reference template
├── data/                          # existing, gitignored, runtime-only (audit log, egress allowlist)
├── README.md                      # polish pass: badges, demo section, reordered structure
├── LICENSE                        # new, only if missing — matches package.json's MIT field
├── .mcp.json                      # new — MCP client registration
├── .gitignore                     # add .claude/
└── package.json                   # untouched
```

## Steps

**1. Preconditions (fail fast, blocks everything else)**
- `npm install`.
- `docker --version` / `docker info` to confirm daemon is live (already confirmed once this session, but the user asked for it as an explicit step — reconfirm at execution time in case state changed).
- `docker pull alpine:3.20` for real.
- `npm start`, background it, wait ~2s, confirm still alive (stdio MCP transport idles with no client attached, so "alive after 2s" is the right bar, not "produces output"), then kill it.
- Scaffold the empty `docs/` tree from the structure above (`plan/`, `learning/`, `skills-used/`, `evidence/`, `demo/`) so every later step has a known destination for its output.

**2. Timeout/container-leak check — "before" evidence**
- New script `scripts/verify-timeout-cleanup.js` (ESM, imports `runSandboxed` from `../src/sandbox.js`).
- Baseline `docker ps --filter ancestor=alpine:3.20` → assert empty.
- Run with `WARDEN_TIMEOUT_MS=3000 node scripts/verify-timeout-cleanup.js` calling `runSandboxed("sleep 60")` (env must be set before the script's `import` of `sandbox.js`, since the timeout constant is read at module-load time).
- Immediately re-check `docker ps` after the call resolves. PASS = empty (container gone); FAIL = container still listed, print the real `docker ps` line as evidence, and save that raw output to `docs/evidence/timeout-before.txt`.
- If FAIL, script cleans up (`docker kill <id>`) before exiting non-zero, so later steps aren't polluted.
- Run this against **unmodified** `sandbox.js` first to get real before-fix evidence.

**3. Fix (only if step 2 shows a real leak)**
- In `src/sandbox.js`: add `containerName = "warden-" + randomUUID()`, pass `--name`, `containerName` in the docker args, and in the timeout callback add `spawn("docker", ["kill", containerName], {stdio:"ignore"})` alongside the existing `child.kill("SIGKILL")`, with a one-line comment explaining SIGKILL-to-client doesn't reach the daemon. Minimal diff, no restructuring, matches existing comment style. Note: if the command finishes naturally right as the timeout fires, `docker kill` can race the container's own exit and return "No such container" — since it's spawned with `stdio:"ignore"` and its result isn't awaited, that error is inherently non-fatal to the outer call, but confirm this during testing rather than assume it.
- Re-run `scripts/verify-timeout-cleanup.js` — expect PASS now. Save that output to `docs/evidence/timeout-after.txt`. If step 2 actually passed on unmodified code, **don't apply a fix for a bug that doesn't exist** — just note the claim held up, and skip the "after" evidence file.
- Write `docs/learning/timeout-container-leak.md`: what the bug was, why SIGKILL doesn't reach the daemon, the fix, and links to the before/after evidence files. This is a durable technical note, separate from the narrative PDF.

**4. Functional sandbox checks (step 4 of the user's list)**
- New script `scripts/verify-sandbox.js`, run against the finalized `sandbox.js` (post-fix if applicable), covering exactly the 5 user-specified checks: `echo hello` (exit 0, correct output), `whoami` (non-root uid), `cat /etc/os-release` (succeeds — reads are fine), `touch /this-should-fail` (must fail — proves `--read-only`), `wget google.com`/`curl -m 3 example.com` with default `network:"none"` (must fail/timeout — proves network isolation).
- Each check prints `[PASS]`/`[FAIL]` with real captured stdout/exit code inline; script exits non-zero on any failure.

**5. Memory limit enforcement (step 5)**
- New script `scripts/verify-memory-limit.js`:
  - Limited run: `WARDEN_MEMORY_LIMIT=64m`, command `sh -c "x=$(head -c 150000000 /dev/zero | tr '\0' 'a'); echo done"` (>2x the limit, buffered into the shell process's own memory via command substitution) → expect kill, `done` never printed. The `tr '\0' 'a'` matters: `/dev/zero` is literal NUL bytes, and command substitution can treat embedded NULs as a string terminator in some shells — piping through `tr` first makes the buffered data unambiguous non-null bytes, so there's no question about whether the allocation actually happened.
  - Control run: same command, `WARDEN_MEMORY_LIMIT=512m` → expect success, `done` printed. This isolates memory-limit as the causal variable.
  - Positive OOM confirmation: build the same docker args manually **without `--rm`**, `--name warden-oom-check-<id>`, run via `spawnSync`, then `docker inspect --format='{{.State.OOMKilled}}' <name>` → assert `true`, save that raw output to `docs/evidence/memory-limit-oom-inspect.txt`, then `docker rm <name>` to clean up manually.
  - Optional (skip-and-say-so if infeasible): cross-check with `WARDEN_SANDBOX_IMAGE=python:3-alpine`, `python3 -c "bytearray(400*1024*1024)"` against `WARDEN_MEMORY_LIMIT=256m`, for a second independent allocation method.
  - Write `docs/learning/memory-oom-methodology.md`: why the naive approach (no `tr`) would have been ambiguous, why the control run matters, and what `docker inspect --format='{{.State.OOMKilled}}'` proves that an exit code alone doesn't.

**6. MCP client registration (step 6)**
- Add a project-scoped `.mcp.json` at repo root per README's Setup section.
- Automatable protocol-level proof: `npx @modelcontextprotocol/inspector --cli node src/index.js --method tools/list` (save raw output to `docs/evidence/mcp-inspector-tools-list.txt`), then a `tools/call` for **each of the three tools** (`run_sandboxed` with `command: "echo hello"`, `list_audit_log` with a `limit`, `set_egress_allowlist` with a small `domains` array) — the user's ask was that all three "actually show up and are callable," not just `run_sandboxed`, so exercise all three and capture real output verbatim for each.
- Note honestly: confirming the 3 tools appear in an actual Claude Desktop/Code restart is a manual step outside this session's control — report what was and wasn't verified programmatically vs. what requires the user's own restart.

**7. CLI smoke test (step 7)**
- Run `node cli/warden-cli.js logs` after steps above have populated `data/audit.log.jsonl` (guaranteed non-empty by then).
- For `node cli/warden-cli.js status` to show real non-empty output, background a `runSandboxed("sleep 8")` and run `status` while it's in flight — don't mistake a correct "No running sandboxes" between runs for a bug.

**8. README accuracy pass (step 8)**
- Only touch "Not yet built" if something built this session actually closes a gap — it doesn't (egress enforcement and auth layer are untouched, out of scope). Leave as-is.
- If the Part-3 fix was applied, it's optional/non-required polish to tighten the "Hard timeout" bullet to mention it now kills the container by name — do this only if it doesn't risk overstating, and keep it brief.

**9. Build the demo (hybrid: recording + video)**
- Terminal recording: capture REAL output from this session's actual runs of `scripts/verify-sandbox.js`, the before/after `scripts/verify-timeout-cleanup.js`, `scripts/verify-memory-limit.js`, and `warden-cli logs`/`status` — not staged/fake output. Use whatever terminal-recording tool is available (e.g. `vhs`, or `asciinema`+`agg`) to produce a GIF/asciicast; if no such tool can be installed cleanly, fall back to a clearly-labeled real-output transcript rather than blocking on tooling. Save under `docs/demo/terminal-recording.gif` (or `.cast`), embed in a "Demo" section near the top of the README.
- Screen-recorded video walkthrough: use the `hyperframes` skill (its mandatory entry point for any video creation) to build a short walkthrough narrating setup, a real sandboxed run, and the audit log — sourced from this session's actual commands/output, not a scripted fiction. Save under `docs/demo/walkthrough-video.mp4`.

**10. Repo polish ("#1 repository" presentation — metadata + structure only, no new visual branding)**
- `gh repo edit dsvxmedia/warden` to set a real description and relevant topics (e.g. `mcp`, `docker`, `sandbox`, `security`, `llm-tools`).
- Add badges to the top of the README (license, Node engine version; skip a CI/build badge since there's no CI in scope here — don't add a badge for something that doesn't exist).
- Confirm a `LICENSE` file exists at repo root matching `package.json`'s `"license": "MIT"` — add one if it's missing, don't just assume the field implies the file.
- Reorder README top-to-bottom: Demo section near the top (after the one-line pitch), then Setup, then Security model, then Not yet built — reordering only, not rewriting content that's already accurate.
- Add a short "Project docs" section to the README linking `docs/BEHIND_THE_SCENES.pdf`, `docs/learning/`, and `docs/skills-used/README.md` so a visitor can find the full story without digging.

**11. Documentation archive: learning notes + skills-used record**
- Finalize `docs/learning/timeout-container-leak.md` and `docs/learning/memory-oom-methodology.md` (drafted in steps 3 and 5) — technical, precise, evidence-linked notes, not narrative prose.
- Write `docs/skills-used/README.md`: a short factual record of which Claude Code skills/tools were used to build this session and why (e.g. `hyperframes` for the video, `make-pdf` for the PDF render, `humanizer` for the PDF's prose, `gstack`'s `review`/`ship` for the git flow) — a build-process record, useful for anyone (including future you) trying to reconstruct how this was assembled.
- Copy the approved plan verbatim into `docs/plan/PLAN.md` — the permanent record of what was planned before execution, for comparison against what actually happened.

**12. Build the "Behind the Scenes" PDF**
- Write `docs/BEHIND_THE_SCENES.md`: a plain-language narrative of the whole session — starting point (scaffolded but unverified), what got checked and how, what was actually found (the timeout/container-leak bug, with real before/after evidence), how it got fixed, and the final verified state. 5th-grade reading level, short plain sentences, no em dashes.
- Run the `humanizer` skill on this doc before finalizing, to strip AI-writing tells (inflated language, rule-of-three lists, vague attribution, em dashes, etc.).
- **Visual template**: match the structural design of the reference PDF the user shared (`TCS_Intelligence_Framework.pdf`) — dark cover page with a title/subtitle block, numbered section headers in a "01 / 02 / 03..." two-line style with a dark banner and short subtitle, section content on light pages, comparison/summary tables where useful, and short callout/pull-quote boxes for key lines. This governs layout and visual system only — the actual sentences still follow the 5th-grade/no-em-dash/humanizer constraints above; the reference doc's own dense corporate phrasing is not the writing style to copy, only its look.
- Use the `make-pdf` skill to render `docs/BEHIND_THE_SCENES.md` into `docs/BEHIND_THE_SCENES.pdf`, applying that visual system as far as `make-pdf`'s styling supports; if a full dark-cover/banner theme isn't achievable through the skill, keep the numbered-section structure and tables and fall back to its default clean styling rather than hand-rolling fragile custom CSS.
- Link the PDF from the README (near the top, alongside the demo).

**13. Cleanup check + git hygiene + ship**
- `docker ps -a --filter "name=warden-"` — confirm no leftover containers from the timeout, OOM-diagnostic, or status-smoke-test steps before wrapping up; remove any stragglers.
- Add `.claude/` to `.gitignore`.
- `git init`, `git add` (explicit files, not `-A`), commit with a real message describing what was verified/fixed this session.
- `gh repo view dsvxmedia/warden` first to check if the repo already exists (avoids `gh repo create` erroring on a pre-existing repo); create it only if missing, then `git push -u origin main`. The user's step 9 already explicitly authorized creating-if-needed and pushing as public — right before running it, give one last summary of what passed so there's a clear checkpoint before the irreversible public push, not a re-ask of permission already granted.
- Every file under `docs/` and `scripts/` gets committed too — they're real evidence and reference artifacts, not scratch files, and strengthen the "I can defend this" story.

**14. Final honest summary**
- Three buckets: (a) claims verified true exactly as documented with evidence, (b) claims that needed a code fix, with before/after evidence, (c) anything still not working or left unverified (e.g. python cross-check skipped) — plus the live GitHub URL, the demo assets, and the PDF link.

## Verification

- Every script in `scripts/` is independently runnable and self-reports PASS/FAIL with real captured output (docker exit codes, `docker ps`/`docker inspect` output, stdout) — this is the evidence trail for the interview.
- `git push` only happens after every check above has either passed or had a fix applied and re-verified — never on assumption.
- Final report explicitly separates "worked as documented" from "needed a fix" from "still broken" — no claim goes in the summary without a corresponding real command run in this session.
- The demo (recording + video) and the PDF both draw only on real output/commands from this session — nothing staged or invented, since both are meant to be defensible artifacts, not marketing copy.
- The PDF is checked against its own constraints before being converted: 5th-grade reading level, no em dashes, passed through `humanizer`.
- Every artifact has exactly one home in the `docs/` tree defined above — before the final commit, confirm nothing was left loose at the repo root or only printed to a terminal and never saved.

### Critical files
- `src/sandbox.js` — timeout/container-name fix (only if step 2 proves the leak)
- `README.md` — accuracy pass, "Not yet built" section, badges, reordered Demo/Setup/Security/Not-yet-built structure, "Project docs" links
- `.gitignore` — add `.claude/`
- `.mcp.json` (new) — MCP registration
- `LICENSE` (new, only if missing) — matches package.json's MIT field
- `scripts/verify-timeout-cleanup.js`, `scripts/verify-sandbox.js`, `scripts/verify-memory-limit.js` (new)
- `docs/plan/PLAN.md` (new) — this approved plan, saved verbatim
- `docs/learning/timeout-container-leak.md`, `docs/learning/memory-oom-methodology.md` (new)
- `docs/skills-used/README.md` (new)
- `docs/evidence/*.txt` (new) — raw captured command output
- `docs/demo/terminal-recording.gif`, `docs/demo/walkthrough-video.mp4` (new)
- `docs/BEHIND_THE_SCENES.md`, `docs/BEHIND_THE_SCENES.pdf` (new)
