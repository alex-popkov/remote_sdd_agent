// Shared type definitions used by both the receiver and the worker.
// Source of truth: spec.md §5 and OpenSpec change implement-remote-sdd-agent.
// Note: triggerId format follows the OpenSpec change (owner-prefixed, "__"-separated)
// which supersedes spec.md §5.1.

export interface TaskTrigger {
  /** "<owner>__<repo>__<issue>__<unixMs>" — also the run-directory name. */
  triggerId: string;
  source: 'label' | 'status' | 'mention';
  repo: { owner: string; name: string };
  issue: {
    number: number;
    title: string;
    body: string;
    url: string;
    author: string;
  };
  /** GitHub login that caused the trigger (may differ from issue author). */
  actor: string;
  /** Raw event headers for debugging — pipeline must not depend on this. */
  raw: { event: string; action?: string };
}

export interface Context {
  summary: string;
  acceptanceCriteria: string[];
  constraints: string[];
  links: Array<{ url: string; description: string }>;
  unknowns: string[];
}

export interface StageRecord {
  name: string;
  attempts: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  exitCode: number;
}

export interface RunMetadata {
  triggerId: string;
  startedAt: string;
  endedAt?: string;
  status: 'running' | 'success' | 'failed' | 'aborted-cost';
  stages: StageRecord[];
  totalCostUsd: number;
  prUrl?: string;
  failureReason?: string;
}