import fs from 'node:fs';
import path from 'node:path';
import { agentEnv, run } from './exec';
import type { RunDirs } from './runWorkspace';
import type { WorkerConfig } from './config';
import type { TaskTrigger } from '../../shared/src/types';

/** Compiled stage recorder (recordStage.ts) invoked by pipeline.sh after each stage. */
const RECORD_STAGE_JS = path.join(__dirname, 'recordStage.js');

/** pipeline.sh exit code for "MAX_COST_USD reached" (sdd-pipeline spec). */
export const COST_ABORT_EXIT_CODE = 42;

/**
 * M5: run the agent-based SDD pipeline (`pipeline/pipeline.sh`) as a fresh
 * process, with the flattened TaskTrigger fields and run paths exported as
 * environment variables (the contract in `sdd-pipeline` spec §"Working
 * directory and environment per stage").
 *
 * Returns the pipeline's exit code: 0 = completed (the verdict is read
 * separately from the verification artifact), 42 = cost ceiling reached,
 * other non-zero = a stage hard-failed.
 */
export async function runPipeline(
  dirs: RunDirs,
  trigger: TaskTrigger,
  config: WorkerConfig,
): Promise<number> {
  const env: NodeJS.ProcessEnv = {
    ...agentEnv(),
    ANTHROPIC_API_KEY: config.anthropicApiKey,
    RUN_DIR: dirs.root,
    MAX_STAGE_RETRIES: String(config.maxStageRetries),
    MAX_VERIFY_RETRIES: String(config.maxVerifyRetries),
    ENABLE_PLAN_CHALLENGE: String(config.enablePlanChallenge),
    MAX_COST_USD: String(config.maxCostUsd),
    // Per-stage cost accounting (run.json) + the kill-switch need the compiled
    // recorder; absent (e.g. running from .ts sources) → pipeline skips both.
    ...(fs.existsSync(RECORD_STAGE_JS) ? { RECORD_STAGE_JS } : {}),
    // Flattened TaskTrigger — consumed by pipeline.sh / the agents.
    TRIGGER_ID: trigger.triggerId,
    TRIGGER_SOURCE: trigger.source,
    ACTOR: trigger.actor,
    ISSUE_NUMBER: String(trigger.issue.number),
    ISSUE_TITLE: trigger.issue.title,
    ISSUE_BODY: trigger.issue.body,
    ISSUE_URL: trigger.issue.url,
    ISSUE_AUTHOR: trigger.issue.author,
    REPO_OWNER: trigger.repo.owner,
    REPO_NAME: trigger.repo.name,
  };

  const { code } = await run('bash', [config.pipelineScript], {
    cwd: dirs.repo,
    env,
    logFile: path.join(dirs.logs, 'pipeline.log'),
  });
  return code;
}

export type Verdict = 'PASS' | 'FAIL';

export interface PipelineOutcome {
  verdict: Verdict;
  /** Markdown PR body assembled from the agent artifacts. */
  prBody: string;
}

/** Newest file in `dir` whose name ends with `suffix`, or null. */
function latestArtifact(dir: string, suffix: string): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const matches = entries
    .filter(name => name.endsWith(suffix))
    .map(name => path.join(dir, name))
    .map(file => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return matches[0]?.file ?? null;
}

function readArtifact(dir: string, suffix: string): string | null {
  const file = latestArtifact(dir, suffix);
  if (!file) return null;
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Read the agent artifacts (via the `artifacts/` → `.claude/sdd-tracking`
 * symlink) and compose the verdict + PR body.
 *
 * Verdict comes from the first line of the latest verification report
 * (`VERDICT: PASS|FAIL`); anything else (missing/unparseable) is treated as
 * FAIL so a questionable run lands as a draft rather than a confident PR.
 */
export function readPipelineOutcome(dirs: RunDirs, trigger: TaskTrigger): PipelineOutcome {
  const artifacts = dirs.artifacts; // symlink to repo/.claude/sdd-tracking
  const plan = readArtifact(path.join(artifacts, 'plans'), '-plan.instructions.md');
  const details = readArtifact(path.join(artifacts, 'details'), '-details.md');
  const changes = readArtifact(path.join(artifacts, 'changes'), '-changes.md');
  const verification = readArtifact(path.join(artifacts, 'verification'), '-verification.md');
  // The committed permanent spec (M6) lives outside sdd-tracking, under the
  // repo's .claude/specs/ tree; read the latest spec file recursively.
  const spec = readLatestSpec(path.join(dirs.repo, '.claude', 'specs'));

  const verdict: Verdict = readVerdict(verification);

  const prBody = composePrBody(trigger, verdict, { plan, details, changes, verification, spec });
  return { verdict, prBody };
}

/**
 * Verdict = the first `VERDICT: PASS|FAIL` line anywhere in the report. The
 * verifier is asked to put it on line 1 but sometimes prepends a markdownlint
 * comment / blank line, so scan rather than trust line 0 (mirrors pipeline.sh's
 * read_verdict). Missing/unparseable → FAIL, so a questionable run lands as a
 * draft rather than a confident PR.
 */
function readVerdict(verification: string | null): Verdict {
  if (!verification) return 'FAIL';
  const line = verification.split('\n').find(l => /^\s*VERDICT:/i.test(l));
  return line && /^\s*VERDICT:\s*PASS\b/i.test(line) ? 'PASS' : 'FAIL';
}

/** Newest *.md under specsDir (recursively), or null. Excludes INDEX.md. */
function readLatestSpec(specsDir: string): string | null {
  const found: Array<{ file: string; mtime: number }> = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.md') && e.name !== 'INDEX.md') {
        found.push({ file: full, mtime: fs.statSync(full).mtimeMs });
      }
    }
  };
  walk(specsDir);
  if (found.length === 0) return null;
  const latest = found.sort((a, b) => b.mtime - a.mtime)[0];
  try {
    return fs.readFileSync(latest.file, 'utf-8');
  } catch {
    return null;
  }
}

function section(title: string, content: string | null): string {
  if (!content) return `## ${title}\n\n_(not produced)_`;
  return `## ${title}\n\n${content.trim()}`;
}

function composePrBody(
  trigger: TaskTrigger,
  verdict: Verdict,
  parts: {
    plan: string | null;
    details: string | null;
    changes: string | null;
    verification: string | null;
    spec: string | null;
  },
): string {
  const header = [
    `Generated by the remote SDD agent for issue #${trigger.issue.number}.`,
    '',
    verdict === 'PASS'
      ? '✅ **Verification: PASS**'
      : '⚠️ **Verification: FAIL** — opened as a draft; see the verification report below.',
    '',
    `Closes #${trigger.issue.number}.`,
  ].join('\n');

  const verificationBlock = parts.verification
    ? `<details>\n<summary>Verification report</summary>\n\n${parts.verification.trim()}\n\n</details>`
    : '## Verification\n\n_(not produced)_';

  const blocks = [
    header,
    section('Plan', parts.plan),
  ];
  // Details can be long — keep it collapsed when present.
  if (parts.details) {
    blocks.push(`<details>\n<summary>Plan details</summary>\n\n${parts.details.trim()}\n\n</details>`);
  }
  blocks.push(section('Changes', parts.changes));
  // The permanent spec only exists on a PASS run (specification stage).
  if (parts.spec) blocks.push(section('Specification', parts.spec));
  blocks.push(verificationBlock);

  return blocks.join('\n\n');
}
