// Defense-in-depth: even a valid HMAC isn't enough — the event must target a
// repo on the explicit allowlist. Protects against a leaked webhook secret.

export interface RepoShape {
  repository?: { full_name?: string };
}

/** Returns true when the event targets a whitelisted repo (caller should keep it). */
export function isAllowedRepo(payload: RepoShape, allowed: ReadonlySet<string>): boolean {
  const fullName = payload.repository?.full_name;
  if (!fullName) return false;
  return allowed.has(fullName);
}