import { spawn } from 'node:child_process';
import fs from 'node:fs';

/**
 * Thin async wrapper around child_process.spawn.
 *
 * Always invoked with an argv array and no shell, so untrusted issue text
 * (titles, bodies) can never be interpreted by a shell. Callers are
 * responsible for not logging secrets — `run()` itself never logs the
 * command or its arguments.
 */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to the child's stdin, then closed. */
  input?: string;
  /** Append combined stdout+stderr to this file (the stage/naive log). */
  logFile?: string;
}

/**
 * Worker secrets withheld from agent sessions. The agent runs arbitrary shell
 * commands on untrusted issue text (prompt injection), so it must not be able
 * to read these. It never needs them: clone, push, PR creation and issue
 * comments all run in the worker, outside the agent sessions.
 */
const AGENT_WITHHELD_ENV = ['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_WEBHOOK_SECRET'];

/** `env` minus AGENT_WITHHELD_ENV — the base environment for agent processes. */
export function agentEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const key of AGENT_WITHHELD_ENV) delete out[key];
  return out;
}

export function run(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const logStream = options.logFile
      ? fs.createWriteStream(options.logFile, { flags: 'a' })
      : null;

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      logStream?.write(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      logStream?.write(chunk);
    });

    child.on('error', err => {
      logStream?.end();
      reject(err);
    });

    child.on('close', code => {
      logStream?.end();
      resolve({ code: code ?? -1, stdout, stderr });
    });

    if (options.input !== undefined) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
}

/**
 * Like `run()` but rejects if the process exits non-zero. `label` is used in
 * the error message; the failing command's stderr is appended for context.
 */
export async function runOrThrow(
  label: string,
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    throw new Error(`${label} failed (exit ${result.code}): ${result.stderr.trim()}`);
  }
  return result;
}