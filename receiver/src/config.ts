// Env-var loading + validation per openspec/changes/implement-remote-sdd-agent/specs/agent-configuration.
// Fails fast on missing required vars so misconfiguration surfaces at boot, not on first webhook.

export interface ReceiverConfig {
  webhookSecret: string;
  allowedRepos: ReadonlySet<string>;
  triggerLabel: string;
  statusLabel: string;
  botMention: string;
  port: number;
  workspaceDir: string;
}

const DEFAULTS = {
  triggerLabel: 'agent:run',
  statusLabel: 'status:ready-for-dev',
  botMention: 'remote-agent',
  port: 3000,
  workspaceDir: '/workspace',
} as const;

function required(name: string, value: string | undefined): string {
  // Spec: "Defaults SHALL only be applied when the variable is unset (not when it is set to an empty string)."
  if (value === undefined || value === '') {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ReceiverConfig {
  const webhookSecret = required('GITHUB_WEBHOOK_SECRET', env.GITHUB_WEBHOOK_SECRET);
  const allowedReposRaw = required('ALLOWED_REPOS', env.ALLOWED_REPOS);

  const allowedRepos = new Set(
    allowedReposRaw.split(',').map(s => s.trim()).filter(Boolean),
  );
  if (allowedRepos.size === 0) {
    console.error('ALLOWED_REPOS must contain at least one "owner/name" entry');
    process.exit(1);
  }

  return {
    webhookSecret,
    allowedRepos,
    triggerLabel: env.TRIGGER_LABEL ?? DEFAULTS.triggerLabel,
    statusLabel: DEFAULTS.statusLabel,
    botMention: env.BOT_MENTION ?? DEFAULTS.botMention,
    port: env.PORT ? Number(env.PORT) : DEFAULTS.port,
    workspaceDir: env.WORKSPACE_DIR ?? DEFAULTS.workspaceDir,
  };
}