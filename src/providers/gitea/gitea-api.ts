import { spawnSync } from 'node:child_process';
import { RepoNotFoundError, type PrCreateOptions } from '../types.js';

import { sanitizeGitUrl } from '../../utils/redact.js';
import { nonInteractiveGitEnv } from '../../utils/git-env.js';
import { giteaHost, parseGiteaRepoInput } from './repo-url.js';

/**
 * Gitea REST API client (API v1).
 *
 * Gitea exposes a GitHub-shaped REST API under `/api/v1` and needs no external
 * CLI — only an access token. The token is sent via the `Authorization: token`
 * header, which is Gitea's own scheme (not `Bearer`).
 *
 * Auth env-var conventions:
 *   - `GITEA_URL`: base URL of the instance. Gitea has no default host, so it is
 *     required except where a caller passes a base derived from the team repo URL
 *     (`teamai init` against a repo whose teamai.yaml declares `provider: gitea`).
 *   - `GITEA_TOKEN` (primary), `GITEA_ACCESS_TOKEN`, `GITEA_PAT` (aliases)
 *   - `GITEA_USER`: optional Basic-auth username for git-over-HTTP (see below)
 */

// ─── Config ──────────────────────────────────────────────

/**
 * Base URL of the Gitea instance, e.g. https://gitea.example.com.
 *
 * Resolved lazily rather than at module load: an invalid GITEA_URL must fail
 * the Gitea operation that needs it, not crash every module that transitively
 * imports this one.
 *
 * `instanceBaseUrl` is a base derived from the team repo URL (see
 * `deriveGiteaBaseUrl`). It is used only when GITEA_URL is unset, so an
 * explicitly configured instance always wins.
 */
export function giteaBaseUrl(instanceBaseUrl?: string): string {
  const giteaUrl = process.env.GITEA_URL?.trim();
  if (giteaUrl) {
    // Reject a value `new URL()` cannot parse (most often a missing scheme).
    // Without this every fetch throws "Failed to parse URL" from deep inside
    // undici instead of naming the offending env var.
    try {
      const parsed = new URL(giteaUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('unsupported protocol');
      }
    } catch {
      throw new Error(
        `Invalid GITEA_URL: "${giteaUrl}". Expected a full base URL including the `
          + 'scheme, e.g. https://gitea.example.com',
      );
    }
    return giteaUrl.replace(/\/+$/, '');
  }

  if (instanceBaseUrl) return instanceBaseUrl.replace(/\/+$/, '');

  // TEAMAI_GITEA_HOST carries no scheme. Self-hosted Gitea is often plain http,
  // but guessing wrong here silently breaks every API call, so require the
  // full URL instead of assuming.
  const host = giteaHost();
  if (host) {
    throw new Error(
      `Gitea host "${host}" is configured via TEAMAI_GITEA_HOST, which carries no scheme. `
        + 'Set GITEA_URL to the full base URL (e.g. https://' + host + ') for API access.',
    );
  }
  throw new Error(
    'No Gitea instance configured. Set GITEA_URL, e.g. https://gitea.example.com',
  );
}

/** Base URL for REST API calls (Gitea mounts the API under /api/v1). */
function giteaApiBase(instanceBaseUrl?: string): string {
  return `${giteaBaseUrl(instanceBaseUrl)}/api/v1`;
}

/** Resolve the Gitea token from env, honouring the documented aliases. */
export function getGiteaToken(): string | null {
  // Trim and treat blank as absent: CI often declares GITEA_TOKEN with an unset
  // secret (empty string), and `$(cat token)` leaves a trailing newline that
  // undici rejects as an invalid header value.
  for (const raw of [
    process.env.GITEA_TOKEN,
    process.env.GITEA_ACCESS_TOKEN,
    process.env.GITEA_PAT,
  ]) {
    const token = raw?.trim();
    if (token) return token;
  }
  return null;
}

function requireToken(): string {
  const token = getGiteaToken();
  if (!token) {
    throw new Error(
      'Gitea authentication unavailable. Set the GITEA_TOKEN environment variable '
        + '(a Gitea access token with repo scope). GITEA_ACCESS_TOKEN and GITEA_PAT '
        + 'are accepted as aliases.',
    );
  }
  return token;
}

/** Gitea's token scheme is `Authorization: token <t>` — `Bearer` is rejected. */
function authHeaders(token: string): Record<string, string> {
  return {
    'Authorization': `token ${token}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

// ─── Auth ────────────────────────────────────────────────

/** True when a Gitea token is configured (no network check). */
export function giteaIsAuthenticated(): boolean {
  return getGiteaToken() !== null;
}

/** Fetch the authenticated Gitea username, or null when unavailable. */
export async function giteaWhoami(instanceBaseUrl?: string): Promise<string | null> {
  const token = getGiteaToken();
  if (!token) return null;
  try {
    const resp = await fetch(`${giteaApiBase(instanceBaseUrl)}/user`, {
      headers: authHeaders(token),
      redirect: 'manual',
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { login?: string; username?: string };
    // Gitea returns `login`; `username` is kept for older/forked instances.
    return data.login ?? data.username ?? null;
  } catch {
    return null;
  }
}

/**
 * Ensure Gitea is usable. There is no CLI to install — only a token is needed,
 * which `authenticate` then verifies against /user.
 */
export async function ensureGiteaAvailable(): Promise<void> {
  if (getGiteaToken()) return;
  throw new Error(
    'Gitea authentication unavailable. Set GITEA_TOKEN (or GITEA_ACCESS_TOKEN / GITEA_PAT).',
  );
}

// ─── Repo operations ─────────────────────────────────────

/**
 * HTTP Basic auth header for a Gitea access token, passed to git via
 * `-c http.extraHeader=...` so the token stays out of the remote URL and out of
 * the cloned repo's `.git/config`.
 *
 * Gitea accepts the token as the Basic *username* with an empty password (the
 * documented `https://<token>@host/...` form). Some instances behind a reverse
 * proxy that rewrites auth want a real username instead — set `GITEA_USER` for
 * those and the token becomes the password.
 */
export function giteaAuthHeaderArg(token: string): string {
  return `http.extraHeader=${giteaAuthHeaderValue(token)}`;
}

/** The bare `Authorization: Basic ...` value, for callers that build their own -c arg. */
export function giteaAuthHeaderValue(token: string): string {
  const user = process.env.GITEA_USER?.trim();
  const pair = user ? `${user}:${token}` : `${token}:`;
  return `Authorization: Basic ${Buffer.from(pair).toString('base64')}`;
}

/**
 * Clone a Gitea repo to localPath. The token is injected via http.extraHeader
 * rather than embedded in the remote URL, so it is not persisted to
 * `.git/config` for subsequent git operations.
 */
export function giteaRepoClone(repo: string, localPath: string): void {
  const token = getGiteaToken();
  const remoteUrl = parseGiteaRepoInput(repo).httpsUrl;

  // `-c <key>=<val>` is a git-level option and must precede the `clone`
  // subcommand, matching the http.extraHeader pattern in clone.ts.
  const args: string[] = [];
  if (token) args.push('-c', giteaAuthHeaderArg(token));
  args.push('clone', '--', remoteUrl, localPath);

  const result = spawnSync('git', args, {
    windowsHide: true,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 120_000,
    // The token is ours, so a rejected one must not fall back to a credential
    // prompt (see nonInteractiveGitEnv); an anonymous clone keeps that flow.
    env: token ? { ...process.env, ...nonInteractiveGitEnv() } : undefined,
  });
  if (result.status === 0) return;

  const allOutput = `${result.stderr ?? ''} ${result.stdout ?? ''}`;
  if (
    allOutput.includes('not found')
    || allOutput.includes('does not exist')
    || allOutput.includes('Repository not found')
    || allOutput.includes('could not be found')
  ) {
    throw new RepoNotFoundError(repo);
  }
  throw new Error(`git clone failed: ${sanitizeGitUrl(allOutput).trim()}`);
}

/** True when `owner` is an organization on this instance (as opposed to a user). */
async function isOrg(owner: string, token: string): Promise<boolean> {
  try {
    const resp = await fetch(`${giteaApiBase()}/orgs/${encodeURIComponent(owner)}`, {
      headers: authHeaders(token),
      redirect: 'manual',
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Create a private Gitea repo.
 *
 * Gitea splits creation across two endpoints: `/user/repos` always creates
 * under the authenticated user, `/orgs/{org}/repos` under an organization.
 * Picking the wrong one silently creates the repo in the wrong namespace, so
 * an owner that is neither the current user nor a visible org is an error
 * rather than a fallback.
 */
export async function giteaCreateRepo(owner: string, repo: string): Promise<void> {
  const token = requireToken();
  const login = await giteaWhoami();
  const body = JSON.stringify({ name: repo, private: true, auto_init: false });

  let endpoint: string;
  if (login && login.toLowerCase() === owner.toLowerCase()) {
    endpoint = `${giteaApiBase()}/user/repos`;
  } else if (await isOrg(owner, token)) {
    endpoint = `${giteaApiBase()}/orgs/${encodeURIComponent(owner)}/repos`;
  } else {
    throw new Error(
      `Cannot create Gitea repo: "${owner}" is neither the authenticated user nor an `
        + 'organization visible to this token. Check the owner name and the token scope.',
    );
  }

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: authHeaders(token),
    body,
    redirect: 'manual',
  });
  if (!resp.ok) {
    throw new Error(
      `Failed to create Gitea repo: ${resp.status} ${await resp.text().catch(() => '')}`,
    );
  }
}

// ─── Pull requests ───────────────────────────────────────

/**
 * Create a Pull Request via the Gitea REST API.
 * Returns the PR web URL on success.
 */
export async function giteaPrCreate(opts: PrCreateOptions): Promise<string> {
  const token = requireToken();
  const { owner, repo } = parseGiteaRepoInput(opts.repo);
  const path = `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  const resp = await fetch(`${giteaApiBase()}/repos/${path}/pulls`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      head: opts.source,
      base: opts.target,
      title: opts.title,
      body: opts.description ?? '',
    }),
    redirect: 'manual',
  });
  if (!resp.ok) {
    throw new Error(
      `Failed to create Gitea PR: ${resp.status} ${await resp.text().catch(() => '')}`,
    );
  }

  const pr = (await resp.json()) as { html_url?: string; number?: number };
  await requestReviewers(path, pr.number, opts.reviewers, token);

  if (pr.html_url) return pr.html_url;
  if (pr.number) return `${giteaBaseUrl()}/${owner}/${repo}/pulls/${pr.number}`;
  throw new Error('Gitea PR created but response did not include html_url.');
}

/**
 * Request reviewers on a freshly created PR.
 *
 * Separate call because Gitea has no `reviewers` field on PR creation, and
 * non-fatal: an unassignable reviewer must not lose the PR that already exists.
 */
async function requestReviewers(
  path: string,
  number: number | undefined,
  reviewers: string[] | undefined,
  token: string,
): Promise<void> {
  if (!number || !reviewers?.length) return;
  try {
    await fetch(`${giteaApiBase()}/repos/${path}/pulls/${number}/requested_reviewers`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ reviewers }),
      redirect: 'manual',
    });
  } catch {
    // Non-fatal — the PR exists; reviewers can be added in the web UI.
  }
}
