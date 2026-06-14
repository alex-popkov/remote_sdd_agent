
## Multi-Agent Pipeline (for Complex Features)

The pipeline implements a **spec-driven development** approach. Each complex feature progresses through research, planning, and execution stages, ending with a permanent specification document that serves as the authoritative record of what was built.

This is a **spec-first** flow: every stage produces a specification that serves as input for the next. Research notes specify *what exists in the codebase and how it works*. The plan specifies *what needs to change and in what order*. These artifacts are themselves the specification that the executor follows when writing the code — no agent writes code without a spec to guide it. After implementation, the specification agent distills everything into a single permanent spec document, which is preserved for future AI sessions to read as stable context when working on related features, refactors, or extensions.

For complex features, use the 5-step pipeline:

```
@task-researcher  →  research/
       ↓
@task-planner     →  plans/ + details/ + prompts/
       ↓
@task-executor    →  changes/ (writes real code)
       ↓
@task-verifier    →  verification/ (independent PASS/FAIL verdict)
       ↓  (on FAIL → back to @task-executor; on PASS → continue)
@specification-from-artifacts  →  spec/<module>/spec-design-*.md  ← permanent source of truth
       ↓
.claude/sdd-tracking/ artifacts can be deleted
```

The agents are **stack-agnostic** — they discover the target repository's language, frameworks, and conventions (from `CLAUDE.md`, project skills, and the code itself) rather than assuming a fixed stack. Project-specific guidance is supplied per-repository via that repo's own `CLAUDE.md` and skills.

### Step 1 — Research

```
@task-researcher "Research how to implement the task..."
```

The researcher digs into the codebase and writes findings to `.claude/sdd-tracking/research/`.

### Step 2 — Plan

```
@task-planner "Create an implementation plan for task..."
```

The planner produces a checklist and implementation brief — no code yet. Writes to `.claude/sdd-tracking/plans/`, `details/`, and `prompts/`.

### Step 3 — Execute

```
@task-executor "Use .claude/sdd-tracking/prompts/... and execute the plan"
```

The executor follows the plan, writes real code, and tracks every change made in `.claude/sdd-tracking/changes/`.

### Step 4 — Verify

```
@task-verifier "Verify the implementation against the plan and acceptance criteria"
```

The verifier independently checks the executor's work against the plan, details, and acceptance criteria, runs the repository's own build/lint/tests, and writes an evidence-based `PASS`/`FAIL` verdict to `.claude/sdd-tracking/verification/`. It is deliberately adversarial and fixes nothing itself. On `FAIL`, the executor runs again to address the blocking findings; on `PASS`, the pipeline continues to specification.

### Step 5 — Specification

```
@specification-from-artifacts "Generate a spec for the <feature name>"
```

After execution is complete, the specification agent distills all artifacts from `.claude/sdd-tracking/` into a permanent, self-contained spec document at `spec/<module>/spec-design-<module>-<feature>.md`.

After this step, `.claude/sdd-tracking/` artifacts can be deleted.

### Tracking artifacts structure

While the pipeline runs, `.claude/sdd-tracking/` looks like this:

```
.claude/sdd-tracking/
├── changes/
│   └── 20260224-client-summary-export-button-changes.md
├── details/
│   └── 20260224-client-summary-export-button-details.md
├── plans/
│   └── 20260224-client-summary-export-button-plan.instructions.md
├── prompts/
│   └── implement-client-summary-export-button.prompt.md
├── research/
│   └── 20260224-client-summary-export-research.md
└── verification/
    └── 20260224-client-summary-export-button-verification.md
```

All `.claude/sdd-tracking/` files are in `.gitignore` — they're working artifacts, not part of the repo.

### Why the artifacts matter

The intermediate files are not throwaway. They're the unprocessed value generated during the pipeline — model tokens were spent, developer time was spent. Future agents need a clean entry point: the specification distills everything into a permanent, structured form.

---

## The Spec Folder

After the pipeline completes, the final spec lives in `spec/`:

- The folder mirrors the application module structure (`spec/home/`, `spec/news/`, etc.)
- The spec becomes the authoritative document and replaces all tracking files
- AI agents can read it in future sessions as stable context
- There is an `index.md` file for quick navigation

**Example `index.md`:**

| Module | File                                    | Title                          | Tags                     | Last Updated |
| ------ | --------------------------------------- | ------------------------------ | ------------------------ | ------------ |
| auth   | spec-design-token-refresh-retry.md      | Auth — Token Refresh Retry     | design, auth, resilience | 2026-02-26   |

The `index.md` is maintained by `@specification-from-artifacts`.