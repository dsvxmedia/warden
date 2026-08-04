# What built this, and how

A factual record of the tools used to verify, fix, document, and ship this
repo in one session. Kept separate from the narrative
[`BEHIND_THE_SCENES.pdf`](../BEHIND_THE_SCENES.pdf) — this file is for
"how do I reproduce or extend this," not "what happened."

## Claude Code, direct tool use

Most of the work — reading `src/sandbox.js`, `src/egress.js`, `src/audit.js`,
`src/index.js`; writing and running the three `scripts/verify-*.js` files;
applying the two code fixes; running Docker and `gh` commands — was done
with Claude Code's own file and shell tools, no special skill needed.

## `hyperframes` (video)

Used to build [`docs/demo/walkthrough-video.mp4`](../demo/walkthrough-video.mp4).
The `general-video` HyperFrames workflow composes an HTML document with
timed `data-*` attributes into a rendered MP4. The real terminal recording
(`docs/demo/terminal-recording.gif`, captured with `vhs`) was converted to
an MP4 and used as the actual background footage for two scenes, with
caption overlays layered on top and a title/closing card. Nothing in the
video is synthetic — every frame of footage traces back to a real command
run earlier in the session.

One real bug came up during this step: an early version of the composition
put an opaque full-screen background on the caption-overlay layer, which
sat on a higher timeline track than the video and blotted it out entirely
in every render — only the caption text was ever visible. `npx hyperframes
snapshot` (a debug tool that captures frames at specific timestamps without
a full render) made this easy to catch before the final render, rather than
after.

## `vhs` (Charmbracelet)

Used to build [`docs/demo/terminal-recording.gif`](../demo/terminal-recording.gif).
`vhs` drives a real terminal session from a script (`.tape` file) and
records the actual output — it's not a mockup or a typed-out animation, the
GIF shows `scripts/verify-sandbox.js` and `warden-cli logs`/`status`
actually running against a live Docker daemon.

## `make-pdf`

Used to render [`docs/BEHIND_THE_SCENES.md`](../BEHIND_THE_SCENES.md) into
[`docs/BEHIND_THE_SCENES.pdf`](../BEHIND_THE_SCENES.pdf).

## `humanizer`

Applied to `docs/BEHIND_THE_SCENES.md` before rendering, to strip
AI-writing patterns (inflated language, em dashes, rule-of-three lists,
vague attribution) from the narrative build story, so it reads like
something a person wrote by hand.

## `gstack` (`review` / `ship`)

Used for the final git commit and push workflow in place of ad hoc git
commands.
