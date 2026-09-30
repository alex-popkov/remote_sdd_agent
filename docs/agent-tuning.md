# Agent tuning

How to change what the pipeline agents do, re-run one stage against a real run
without paying for the whole pipeline, and check a change didn't blow up token
usage or cost.

The pipeline is `pipeline/pipeline.sh`. Each stage is a fresh
`claude -p --agent <name>` session driven by a markdown agent definition in
`pipeline/agents/`; stages talk to each other only through files under
`repo/.claude/sdd-tracking/` (see `spec.md` and `pipeline/agents/readme.md`).

| Stage | Agent | Primary artifact (`.claude/sdd-tracking/…`) |
|---|---|---|
| `task-researcher` | `task-researcher` | `research/*-research.md` |
| `task-planner` | `task-planner` | `plans/*-plan.instructions.md` |
| `plan-challenge` | `task-planner` (critique instruction) | plan/details rewritten in place |
| `task-executor` | `task-executor` | `changes/*-changes.md` + repo edits |
| `task-verifier` | `task-verifier` | `verification/*-verification.md` (`VERDICT: PASS\|FAIL`) |
| `specification` | `specification-from-artifacts` | `.claude/specs/INDEX.md` (committed) |

## 1. Edit an agent

An agent is a markdown file with frontmatter (`name`, `description`, `tools`,
`model`) and a body that is its system prompt.

- **Behaviour** — edit the body of `pipeline/agents/<agent>.md`.
- **Model** — the `model:` frontmatter field. An alias (`opus`, `sonnet`)
  resolves to whatever the worker image's pinned `CLAUDE_CODE_VERSION` maps it
  to; a full model id pins it exactly. Add any new model id to
  `worker/src/pricing.ts` so its cost is tracked at the right rate (unknown ids
  are priced at the most expensive rate).
- **Per-run instruction** — the short task text each stage receives (issue
  context + "write X to Y") lives in `stage_instruction()` in
  `pipeline/pipeline.sh`, not in the agent file.

Rules that keep the pipeline working:

- Keep agents **stack-agnostic**: they discover the language, tooling and test
  commands from the target repo and its `CLAUDE.md`, never hardcode them.
- Don't change where an agent writes its primary artifact, or the filename
  pattern — `run_stage` decides success by finding that file (table above).
- The verifier's `VERDICT: PASS` / `VERDICT: FAIL` line is the one
  machine-parsed contract; it decides a normal vs. draft PR.
- Agents run non-interactively. Anything like "ask the user if unsure" must be
  overridden to "decide and proceed", or the session stalls.

`./pipeline` is bind-mounted read-only into the worker at `/pipeline`, so agent
and `pipeline.sh` edits take effect on the next stage — no rebuild. Changes
under `worker/`, `receiver/` or `shared/` still need
`docker compose up -d --build`.

## 2. Re-run a single stage in isolation

Sourcing `pipeline.sh` (rather than executing it) defines the stage functions
without running the pipeline, so you can replay one stage on top of an
existing run's artifacts. Do it inside the worker container, where `claude`,
the API key and the paths all exist:

```bash
ID=acme__widgets__42__1717000000000          # a run under workspace/runs/
Q=$(ls workspace/queue/*/"$ID".json)         # its TaskTrigger (done/ or failed/)

docker compose exec \
  -e RUN_DIR=/workspace/runs/$ID \
  -e ISSUE_NUMBER="$(jq -r .issue.number "$Q")" \
  -e ISSUE_TITLE="$(jq -r .issue.title "$Q")" \
  -e ISSUE_BODY="$(jq -r .issue.body "$Q")" \
  -e RECORD_STAGE_JS=/app/worker/dist/worker/src/recordStage.js \
  worker bash -c 'source /pipeline/pipeline.sh && setup_workspace &&
    run_stage task-planner "$SDD_DIR/plans" "*-plan.instructions.md"'
```

- `setup_workspace` re-copies `pipeline/agents/*.md` into the run's
  `repo/.claude/agents/`, so the session uses your edited agent.
- Swap the last line for the stage you're tuning:
  - `run_stage task-researcher "$SDD_DIR/research" "*-research.md"`
  - `run_plan_challenge`
  - `run_stage task-executor "$SDD_DIR/changes" "*-changes.md"`
  - `run_stage task-verifier "$SDD_DIR/verification" "*-verification.md" && read_verdict`
  - `run_specification`
- Output goes to the same places as a full run: the session log is appended to
  `logs/<stage>.log`, the artifact lands in `artifacts/` (→
  `repo/.claude/sdd-tracking/`), and — with `RECORD_STAGE_JS` set — a stage
  record is appended to `run.json`. Drop `RECORD_STAGE_JS` to leave `run.json`
  untouched.
- Downstream stages read upstream artifacts, so to compare two versions of an
  agent, copy the run dir first (`cp -a workspace/runs/$ID workspace/runs/$ID-b`)
  and replay the stage in the copy.
- Replaying the executor edits `repo/` in place; `git -C workspace/runs/$ID/repo
  diff` shows the result and `git checkout .` resets it.

For a prompt-only experiment you can also skip the pipeline entirely:
`cd workspace/runs/$ID/repo && claude -p "<instruction>" --agent task-planner`.

## 3. Inspect `run.json` for cost / token regressions

Every stage appends a record to `workspace/runs/<id>/run.json` (tokens across
all attempts, cost, duration, exit code, models used). Per-attempt raw CLI
results are kept in `logs/usage/NN-<stage>.json`.

```bash
R=workspace/runs/$ID/run.json

# Stage table
jq -r '["STAGE","ATT","IN","CACHE_RD","OUT","USD","SEC","EXIT","MODELS"],
  (.stages[] | [.name, .attempts, .inputTokens, (.cacheReadTokens // 0), .outputTokens,
   .costUsd, (.durationMs/1000|floor), .exitCode, ((.models // [])|join(","))]) | @tsv' "$R" \
  | column -t

# Run total + outcome
jq '{status, totalCostUsd, failureReason, prUrl}' "$R"

# Totals across every run, most expensive first
for f in workspace/runs/*/run.json; do
  jq -r '[.triggerId, .status, .totalCostUsd] | @tsv' "$f"; done | sort -t$'\t' -k3 -rn

# Compare a stage across two runs (e.g. before/after an agent edit)
jq -s 'map(.stages[] | select(.name=="task-planner") | {costUsd, inputTokens, outputTokens})' \
  workspace/runs/$ID/run.json workspace/runs/$ID-b/run.json
```

What to look for:

- **`attempts` > 1** — the stage didn't produce its artifact first time;
  check `logs/<stage>.log` for why (often the agent wrote to the wrong path).
- **`inputTokens` jumping** — an agent is reading far more of the repo than
  before. Most input should be `cacheReadTokens`; a low cache share inflates cost.
- **Unexpected `models`** — an alias resolved to a different model than you
  meant, or a subagent spawned a different one.
- **`plan-challenge` dominating** — it re-reads everything; it can be switched
  off with `ENABLE_PLAN_CHALLENGE=false`.
- **Budget headroom** — `MAX_COST_USD` (default `5.00`) aborts the run between
  stages once `totalCostUsd` reaches it (`status: "aborted-cost"`). If typical
  runs sit close to it, tune the expensive stage before raising the ceiling.
