// Worker env-var loading. Mirrors receiver/src/config.ts so misconfiguration
// fails fast at boot rather than mid-run.

export interface WorkerConfig {
  githubToken: string;
  anthropicApiKey: string;
  triggerLabel: string;
  botMention: string;
  maxCostUsd: number;
  maxStageRetries: number;
  maxVerifyRetries: number;
  enablePlanChallenge: boolean;
  pipelineScript: string;
  workspaceDir: string;
  pollIntervalMs: number;
}

const DEFAULTS = {
  triggerLabel: 'agent:run',
  botMention: 'remote-agent',
  maxCostUsd: 5.0,
  maxStageRetries: 3,
  maxVerifyRetries: 1,
  enablePlanChallenge: true,
  pipelineScript: '/pipeline/pipeline.sh',
  workspaceDir: '/workspace',
  pollIntervalMs: 5000,
} as const;

function required(name: string, value: string | undefined): string {
  if (value === undefined || value === '') {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

function numberOrExit(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  if (raw === '') {
    console.error(`${name} must not be empty`);
    process.exit(1);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.error(`${name} must be a number, got: ${raw}`);
    process.exit(1);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return {
    githubToken: required('GITHUB_TOKEN', env.GITHUB_TOKEN),
    anthropicApiKey: required('ANTHROPIC_API_KEY', env.ANTHROPIC_API_KEY),
    triggerLabel: env.TRIGGER_LABEL ?? DEFAULTS.triggerLabel,
    botMention: env.BOT_MENTION ?? DEFAULTS.botMention,
    maxCostUsd: numberOrExit('MAX_COST_USD', env.MAX_COST_USD, DEFAULTS.maxCostUsd),
    maxStageRetries: numberOrExit('MAX_STAGE_RETRIES', env.MAX_STAGE_RETRIES, DEFAULTS.maxStageRetries),
    maxVerifyRetries: numberOrExit('MAX_VERIFY_RETRIES', env.MAX_VERIFY_RETRIES, DEFAULTS.maxVerifyRetries),
    enablePlanChallenge: (env.ENABLE_PLAN_CHALLENGE ?? String(DEFAULTS.enablePlanChallenge)) !== 'false',
    pipelineScript: env.PIPELINE_SCRIPT ?? DEFAULTS.pipelineScript,
    workspaceDir: env.WORKSPACE_DIR ?? DEFAULTS.workspaceDir,
    pollIntervalMs: numberOrExit('POLL_INTERVAL_MS', env.POLL_INTERVAL_MS, DEFAULTS.pollIntervalMs),
  };
}