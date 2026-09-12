import type { RepoInfo } from '../types.js';

/**
 * Git host for Gitea repos.
 *
 * Gitea has no public flagship instance, so unlike GitLab there is no sensible
 * default host: an unconfigured Gitea is a configuration error, not a fallback
 * to some public platform. `giteaHost` therefore returns null and every caller
 * that needs a host reports the missing config.
 *
 * Configuration (priority order):
 *   - `TEAMAI_GITEA_HOST`: direct host override (mirrors TEAMAI_GITLAB_HOST).
 *   - `GITEA_URL`: base URL of the instance, e.g. `https://gitea.example.com`
 *     or `http://gitea.internal:3000` → host including the port.
 *   - An explicit full URL in parseRepoInput always wins over both.
 *
 * Read at call time rather than at module load so tests and long-lived
 * processes see env changes, matching gitlabBaseUrl()'s lazy resolution.
 */
export function giteaHost(): string | null {
  const direct = process.env.TEAMAI_GITEA_HOST?.trim();
  if (direct) return direct;

  const giteaUrl = process.env.GITEA_URL?.trim();
  if (giteaUrl) {
    try {
      const host = new URL(giteaUrl).host;
      if (host) return host;
    } catch {
      // ignore malformed GITEA_URL — giteaBaseUrl() reports it with a better message
    }
  }
  return null;
}

/**
 * Base URL of the Gitea instance that hosts `repoUrl`: its scheme, host and
 * port, e.g. `http://lzxsvn:3000/agent/repo.git` → `http://lzxsvn:3000`.
 *
 * Used when a team repo declares `provider: gitea` but GITEA_URL is unset, so
 * the instance is taken from the URL the user actually cloned. Returns null for
 * SSH and bare `owner/repo` input: neither carries the http(s) scheme and port
 * the REST API lives on, and guessing them would send requests to the wrong
 * place. Credentials embedded in the URL are dropped.
 */
export function deriveGiteaBaseUrl(repoUrl: string): string | null {
  const trimmed = repoUrl.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

function requireHost(): string {
  const host = giteaHost();
  if (!host) {
    throw new Error(
      'No Gitea instance configured. Set GITEA_URL (e.g. https://gitea.example.com) '
        + 'or TEAMAI_GITEA_HOST before using a bare owner/repo, or pass the full repo URL.',
    );
  }
  return host;
}

/**
 * Parse user input into a standardized RepoInfo structure for Gitea.
 * Supports:
 *   - Short format: `owner/repo` (requires GITEA_URL / TEAMAI_GITEA_HOST)
 *   - HTTPS / HTTP URL, on any self-hosted host and port
 *   - SSH URL (`git@host:owner/repo.git`)
 *
 * Unlike GitLab, Gitea has no subgroups: a repo path is always exactly two
 * segments, `owner/repo`. Extra trailing segments are a web route, not a
 * namespace, so they are stripped by `stripGiteaRoutePath` rather than folded
 * into the owner.
 */
export function parseGiteaRepoInput(input: string, instanceBaseUrl?: string): RepoInfo {
  const trimmed = stripGiteaRoutePath(input.trim());

  // Full URL — host (and port) come from the URL itself.
  const httpsMatch = trimmed.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (httpsMatch) {
    return buildRepoInfo(httpsMatch[1], httpsMatch[2], httpsMatch[3], schemeOf(trimmed));
  }

  const sshMatch = trimmed.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (sshMatch) {
    return buildRepoInfo(sshMatch[1], sshMatch[2], sshMatch[3], 'https');
  }

  // Short format: owner/repo (host = configured instance, else the instance
  // derived from the team repo URL).
  const shortMatch = trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (shortMatch) {
    // Same precedence as giteaBaseUrl(): only GITEA_URL beats the derived base.
    const derived = process.env.GITEA_URL?.trim() ? null : parseInstanceBase(instanceBaseUrl);
    if (derived) {
      return buildRepoInfo(derived.host, shortMatch[1], shortMatch[2], derived.scheme);
    }
    return buildRepoInfo(requireHost(), shortMatch[1], shortMatch[2], schemeForConfiguredHost());
  }

  const hostHint = giteaHost() ?? 'gitea.example.com';
  throw new Error(
    `Unrecognized Gitea repo format: "${trimmed}"\n`
      + '  Supported formats:\n'
      + '    owner/repo\n'
      + `    https://${hostHint}/owner/repo.git\n`
      + `    git@${hostHint}:owner/repo.git`,
  );
}

/** Gitea web routes that may follow a repo root in a copied browser URL. */
const GITEA_ROUTE_SEGMENTS = [
  'src', 'pulls', 'issues', 'commit', 'commits', 'releases', 'wiki', 'actions',
  'raw', 'compare', 'settings', 'activity', 'projects', 'packages', 'milestone',
  'tags', 'branches', 'find', 'blame', 'stars', 'watchers', 'forks',
].join('|');

const GITEA_ROUTE_RE = new RegExp(
  `^(https?://[^/]+/[^/]+/[^/]+)/(?:${GITEA_ROUTE_SEGMENTS})(?:/|$)`,
  'i',
);

/**
 * Strip Gitea web routes that follow the repo root — `/src/branch/main`,
 * `/pulls/42`, `/issues`, `/commit/<sha>`.
 *
 * Without this, `https://host/owner/repo/pulls/42` fails the strict
 * two-segment URL pattern and the user gets a format error for a URL they
 * legitimately copied from the browser.
 */
function stripGiteaRoutePath(input: string): string {
  const match = input.match(GITEA_ROUTE_RE);
  return match ? match[1] : input;
}

/** Split an instance base URL (from deriveGiteaBaseUrl) into host and scheme. */
function parseInstanceBase(
  instanceBaseUrl: string | undefined,
): { host: string; scheme: 'http' | 'https' } | null {
  if (!instanceBaseUrl) return null;
  try {
    const url = new URL(instanceBaseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return { host: url.host, scheme: url.protocol === 'http:' ? 'http' : 'https' };
  } catch {
    return null;
  }
}

function schemeOf(url: string): 'http' | 'https' {
  return /^http:\/\//i.test(url) ? 'http' : 'https';
}

/**
 * Scheme to use for the configured instance when the user typed a bare
 * `owner/repo`. Taken from GITEA_URL because self-hosted Gitea on an internal
 * network is very often plain http; defaulting to https would produce a clone
 * URL that cannot connect.
 */
function schemeForConfiguredHost(): 'http' | 'https' {
  const giteaUrl = process.env.GITEA_URL?.trim();
  if (giteaUrl) {
    try {
      if (new URL(giteaUrl).protocol === 'http:') return 'http';
    } catch {
      // fall through to https
    }
  }
  return 'https';
}

function buildRepoInfo(
  host: string,
  owner: string,
  repo: string,
  scheme: 'http' | 'https',
): RepoInfo {
  return {
    owner,
    repo,
    httpsUrl: `${scheme}://${host}/${owner}/${repo}.git`,
    // Gitea addresses repos as /repos/{owner}/{repo}, not by an encoded id, but
    // projectId is part of the shared RepoInfo shape; keep it consistent with
    // the other providers so callers that log or key off it still work.
    projectId: encodeURIComponent(`${owner}/${repo}`),
  };
}
