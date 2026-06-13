# pi-spec-debate

A Pi package for running a small multi-model debate over a markdown feasibility/spec document until it reaches consensus, stalls, or needs explicit user direction.

## What it adds

- `/spec-debate <file>` command
- `spec_debate` tool for the main agent to invoke
- `spec-review-rubric` skill

The workflow runs three isolated Pi subprocesses per round:

- **skeptic**: finds holes, risks, and ambiguities
- **builder**: rewrites the document
- **judge**: decides whether the revised draft is good enough to stop or whether it needs explicit user direction

## Install

From a git repo:

```bash
pi install git:github.com/you/pi-spec-debate
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
- `round-01-*.md/json` — per-round artifacts
- `round-01-user.md` — user direction requested or provided in that round, when applicable

In interactive TUI/RPC use, the debate can pause mid-run to ask the user for architectural, technical, design, product, or rollout direction, then continue with that answer integrated into the spec. In non-interactive mode, it stops with `needs-user-input` and writes the pending questions to disk.

The original source file is left untouched.

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
    "skepticMs": 90000,
    "builderMs": 150000,
    "judgeMs": 60000,
    "roundMs": 300000,
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

By default, child skeptic/judge runs will use `web_search` if that tool is installed and available in Pi. Builder stays tool-free by default.

Per-command arguments override config.

## Notes

- Child debate agents remain isolated by default. When `web_search` is available, skeptic/judge child runs allowlist only that tool and exclude `spec_debate` to avoid recursion.
- Child subprocesses support per-role timeouts, a per-round timeout, and SIGTERM→SIGKILL escalation on cancellation.
- This package is designed to work the same way on Linux and macOS.
- The child `pi` executable must be available on your `PATH`.
