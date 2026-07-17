# pi-spec-debate

[![Version](https://img.shields.io/badge/version-0.1.0-blue)](./package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![Pi package](https://img.shields.io/badge/pi-package-purple)](https://pi.dev)

Run a structured skeptic/builder/judge debate over a markdown spec in Pi until it reaches consensus, stalls, or needs explicit user direction.

## What it adds

- `/spec-debate <file>` command
- `spec_debate` tool for the main agent to invoke
- `spec-review-rubric` skill

The workflow runs three isolated Pi subprocesses per round:

- **skeptic**: finds holes, risks, and ambiguities
- **builder**: rewrites the document
- **judge**: decides whether the revised draft is good enough to stop or whether it needs explicit user direction

## Why use this?

Use `pi-spec-debate` when a single-pass review is not enough and you want a tighter loop between critique, revision, and stop/go judgment.

It is especially useful for:

- early RFCs and idea docs
- feasibility notes with hidden assumptions
- execution plans that need sharper scope and rollout detail
- specs that may require explicit owner decisions instead of silent model guesswork

## Install

From the git repo:

```bash
pi install git:github.com/amedeo/pi-spec-debate
```

Or from a local checkout while iterating:

```bash
pi install /absolute/path/to/pi-spec-debate
```

Then restart Pi or run `/reload`.

## Usage

```text
/spec-debate docs/idea.md
/spec-debate docs/idea.md --rounds 4
/spec-debate docs/idea.md --skeptic-model anthropic/claude-sonnet-4-5 --builder-model openai/gpt-4.1 --judge-model google/gemini-2.5-pro
```

The command writes results next to the source document in:

```text
<spec-name>.spec-debate/
```

Typical outputs:

- `final.md` — latest revised draft
- `consensus.md` — final decision, next steps, and any pending user questions
- `debate.md` — full round-by-round log
- `round-01-*.md/json` — per-round artifacts, checkpointed as each role completes
- `round-01-user.md` — user direction requested or provided in that round, when applicable
- `failure.md` — failure details and the latest partial model output, when a run fails

In Pi's expanded message view, the extension also shows the round-by-round skeptic / judge / builder back-and-forth inline, while still writing the full artifacts to disk.

Example output tree:

```text
idea.spec-debate/
├── final.md
├── consensus.md
├── debate.md
├── round-01-skeptic.md
├── round-01-builder.md
├── round-01-judge.json
└── round-01-user.md
```

In interactive TUI/RPC use, the debate can pause mid-run to ask the user for architectural, technical, design, product, or rollout direction, then continue with that answer integrated into the spec. In non-interactive mode, it stops with `needs-user-input` and writes the pending questions to disk.

The original source file is left untouched.

## Live progress and model output

While a debate runs, Pi shows the active round, role, model, elapsed time, provider retries or tool activity, and a bounded live preview of the role's output. The preview is the model's actual response that will be passed to the next role—not hidden chain-of-thought. Raw private reasoning is intentionally not exposed; Pi shows a `model reasoning (content hidden)` activity indicator instead.

Expand the completed command message or `spec_debate` tool result to inspect the full skeptic, judge, user-direction, and builder artifacts for every completed round.

## Tool usage

Once installed, you can also ask Pi in natural language to run a multi-model debate on a markdown spec. The extension exposes a `spec_debate` tool for that, and it may ask the user follow-up questions when the debate hits a direction-setting choice it should not invent.

## Configuration

Optional global config:

- Linux/macOS: `~/.pi/agent/spec-debate.json`

Optional project config:

- `<project>/.pi/spec-debate.json`

Example:

```json
{
  "maxRounds": 3,
  "writeRoundFiles": true,
  "models": {
    "skeptic": "anthropic/claude-sonnet-4-5",
    "builder": "openai/gpt-4.1",
    "judge": "google/gemini-2.5-pro"
  },
  "timeouts": {
    "skepticMs": 300000,
    "builderMs": 600000,
    "judgeMs": 300000,
    "roundMs": 0,
    "terminateGraceMs": 3000
  },
  "childTools": {
    "enableWebSearch": true,
    "webSearchToolNames": ["web_search"],
    "webSearchRoles": ["skeptic", "judge"]
  }
}
```

Environment variables also work:

- `PI_SPEC_DEBATE_MAX_ROUNDS`
- `PI_SPEC_DEBATE_SKEPTIC_MODEL`
- `PI_SPEC_DEBATE_BUILDER_MODEL`
- `PI_SPEC_DEBATE_JUDGE_MODEL`
- `PI_SPEC_DEBATE_SKEPTIC_TIMEOUT_MS`
- `PI_SPEC_DEBATE_BUILDER_TIMEOUT_MS`
- `PI_SPEC_DEBATE_JUDGE_TIMEOUT_MS`
- `PI_SPEC_DEBATE_ROUND_TIMEOUT_MS`
- `PI_SPEC_DEBATE_TERMINATE_GRACE_MS`
- `PI_SPEC_DEBATE_ENABLE_WEB_SEARCH`
- `PI_SPEC_DEBATE_WEB_SEARCH_TOOLS`
- `PI_SPEC_DEBATE_WEB_SEARCH_ROLES`

A timeout value of `0` disables that timeout. The per-round timeout is disabled by default so it cannot race the individual role budgets; cancellation from Pi still stops the active child process. Set a finite `roundMs` if you need an overall wall-clock cap.

By default, child skeptic/judge runs will use `web_search` if that tool is installed and available in Pi. Builder stays tool-free by default.

Per-command arguments override config.

## Notes

- Child debate agents remain isolated by default. When `web_search` is available, skeptic/judge child runs allowlist only that tool and exclude `spec_debate` to avoid recursion.
- Child subprocesses support optional per-role and per-round timeouts plus SIGTERM→SIGKILL escalation on cancellation.
- This package is designed to work the same way on Linux and macOS.
- The child `pi` executable must be available on your `PATH`.

## Release history

### Unreleased

- live role status, activity, elapsed time, and bounded output previews
- expanded round transcripts for command and tool results
- partial role checkpoints and failure reports
- safer timeout defaults, optional disabled timeouts, and a disabled-by-default round cap
- reduced judge and user-direction prompt duplication

### v0.1.0

- initial `spec_debate` tool and `/spec-debate` command
- skeptic / builder / judge debate loop
- structured user-direction checkpoints
- round artifacts written to disk
- per-role and per-round subprocess timeouts
- optional child `web_search` support for skeptic/judge when available
