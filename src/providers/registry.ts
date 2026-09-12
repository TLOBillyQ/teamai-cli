import type { GitProvider } from './types.js';
import { TGitProvider } from './tgit/index.js';
import { GitHubProvider } from './github/index.js';
import { CNBProvider } from './cnb/index.js';
import { GitLabProvider } from './gitlab/index.js';
import { GitCodeProvider } from './gitcode/index.js';
import { GiteaProvider } from './gitea/index.js';
import { GenericGitProvider } from './git/index.js';
import { getCurrentPackageName } from '../package-info.js';
import { probeSelfHostedGitLab } from './gitlab/probe.js';

// ─── Provider Detection ──────────────────────────────────
//
//  Input URL / short format        Detected provider
//  ────────────────────────────    ──────────────────
//  https://github.com/o/r          github
//  git@github.com:o/r.git          github
//  https://git.woa.com/o/r         tgit
//  git@git.woa.com:o/r.git         tgit
//  owner/repo (bare)               <fallback — see getDefaultProvider>
//  https://<unknown-host>/o/r      git (transport-only generic provider)
//
// The fallback is based on which distribution channel the CLI was installed
// from:
//   - `teamai-cli`          (public npm)  → github
//   - `@tencent/teamai-cli` (internal tnpm) → tgit
// The tnpm publish pipeline rewrites the package name at build time (see
// `.coding-ci.yaml`), so reading `name` from the installed package.json at
// runtime is a reliable signal. `TEAMAI_DEFAULT_PROVIDER` can override for
// tests or special environments.
//

/** Known host → provider name mapping. */
const HOST_MAP: Record<string, string> = {
  'github.com': 'github',
  'git.woa.com': 'tgit',
  'cnb.cool': 'cnb',
  'gitlab.com': 'gitlab',
  'gitcode.com': 'gitcode',
};

/** Providers we are willing to accept as a default override. */
const KNOWN_PROVIDERS = new Set(['github', 'tgit', 'cnb', 'gitlab', 'gitcode', 'gitea']);

/**
 * Decide the fallback provider used when the input URL host is unknown or
 * when the user provides a bare `owner/repo`.
 *
 * Precedence:
 *   1. `TEAMAI_DEFAULT_PROVIDER` env var (must be a known provider)
 *   2. Current CLI package name — `@tencent/teamai-cli` → tgit, else github
 *   3. `github` as the ultimate safe default (open-source usage)
 */
export function getDefaultProvider(): string {
  const override = process.env.TEAMAI_DEFAULT_PROVIDER?.trim();
  if (override && KNOWN_PROVIDERS.has(override)) return override;

  try {
    const pkgName = getCurrentPackageName();
    if (pkgName.startsWith('@tencent/')) return 'tgit';
  } catch {
    // package.json is unavailable (rare — only unusual test harnesses hit
    // this). Fall through to github so the CLI remains usable.
  }
  return 'github';
}

/**
 * Detect which git provider to use based on a repo URL or short format.
 * Returns a registered provider name
 * ('github' | 'tgit' | 'cnb' | 'gitlab' | 'git').
 *
 * - Full URL (HTTPS or SSH): matched by host. Unknown hosts use the generic
 *   Git transport provider.
 * - Bare `owner/repo`: uses the distribution-based default so `@tencent/`
 *   tnpm users get tgit automatically without having to type the full URL.
 *
 * Self-hosted GitLab instances are detected when the URL host matches the host
 * of the `GITLAB_URL` env var (e.g. `GITLAB_URL=https://gitlab.example.com`),
 * or via the `TEAMAI_GITLAB_HOST` override (see providers/gitlab/repo-url.ts).
 * Gitea works the same way via `GITEA_URL` / `TEAMAI_GITEA_HOST`; it has no
 * public host, so an unconfigured Gitea URL falls through to the generic
 * provider.
 */
export function detectProvider(input: string): string {
  const trimmed = input.trim();

  // HTTPS URL: extract host
  const httpsMatch = trimmed.match(/^https?:\/\/([^/]+)\//i);
  if (httpsMatch) {
    const host = httpsMatch[1].toLowerCase();
    return resolveHostProvider(host);
  }

  // ssh:// URL: extract host through URL parsing.
  if (/^ssh:\/\//i.test(trimmed)) {
    try {
      const host = new URL(trimmed).hostname.toLowerCase();
      return resolveHostProvider(host);
    } catch {
      return 'git';
    }
  }

  // SSH URL: extract host
  const sshMatch = trimmed.match(/^[^@\s]+@([^:\s]+):/);
  if (sshMatch) {
    const host = sshMatch[1].toLowerCase();
    return resolveHostProvider(host);
  }

  // Bare owner/repo — use distribution-based default.
  return getDefaultProvider();
}

/**
 * Interactive initialization can probe an otherwise unknown host. Do not just
 * return "gitlab": its API client needs an explicitly configured instance URL
 * on subsequent runs too, otherwise it would silently target gitlab.com.
 */
export async function detectProviderForInit(input: string): Promise<string> {
  const provider = detectProvider(input);
  if (provider !== 'git') return provider;
  const detected = await probeSelfHostedGitLab(input);
  if (detected) {
    throw new Error(
      `Detected self-hosted GitLab at ${detected.baseUrl}. `
      + `Set GITLAB_URL=${detected.baseUrl} (use the full instance base URL for a subpath deployment) `
      + 'and GITLAB_TOKEN (a Personal Access Token with api scope), then run teamai init again.',
    );
  }
  return provider;
}

/**
 * Resolve a URL host to a provider name: a known platform host wins, then a
 * configured self-hosted instance (GitLab, then Gitea), then the transport-only
 * generic provider for arbitrary hosts.
 *
 * GitLab is checked first only because it predates Gitea support here; the two
 * are configured by distinct env vars, so pointing both at the same host is a
 * user error rather than an ordering question.
 */
function resolveHostProvider(host: string): string {
  return HOST_MAP[host]
    ?? detectSelfHostedHost(host, 'gitlab', 'TEAMAI_GITLAB_HOST', 'GITLAB_URL')
    ?? detectSelfHostedHost(host, 'gitea', 'TEAMAI_GITEA_HOST', 'GITEA_URL')
    ?? 'git';
}

/**
 * Map a host to `provider` when it matches that provider's configured
 * self-hosted instance, otherwise return null.
 *
 * The configured host comes from (in priority order):
 *   1. `hostVar` — explicit host override (e.g. TEAMAI_GITLAB_HOST)
 *   2. host parsed from `urlVar` — the platform's standard base-URL env var
 *
 * Callers extract the host differently per URL form: the HTTPS branch keeps any
 * `:port`, while `ssh://` (URL.hostname) and scp-style `git@host:path` never
 * carry one. Both the port-qualified and bare forms of the configured host are
 * therefore compared, so `GITLAB_URL=https://gl.example.com:8443` still matches
 * `git@gl.example.com:group/repo.git`.
 */
function detectSelfHostedHost(
  host: string,
  provider: string,
  hostVar: string,
  urlVar: string,
): string | null {
  for (const configured of configuredHosts(hostVar, urlVar)) {
    if (configured === host) return provider;
    // Strip a port from the configured host so the bare-host URL forms match.
    if (configured.replace(/:\d+$/, '') === host) return provider;
  }
  return null;
}

/** Configured self-hosted hosts for one provider, highest precedence first. */
function configuredHosts(hostVar: string, urlVar: string): string[] {
  const hosts: string[] = [];

  const override = process.env[hostVar]?.trim().toLowerCase();
  if (override) hosts.push(override);

  const baseUrl = process.env[urlVar]?.trim();
  if (baseUrl) {
    try {
      hosts.push(new URL(baseUrl).host.toLowerCase());
    } catch {
      // ignore a malformed base URL — the provider's own resolver reports it
    }
  }
  return hosts;
}

// ─── Provider Factory ────────────────────────────────────

/** Registry of available providers. */
const PROVIDERS: Record<string, () => GitProvider> = {
  tgit: () => new TGitProvider(),
  github: () => new GitHubProvider(),
  cnb: () => new CNBProvider(),
  gitlab: () => new GitLabProvider(),
  gitcode: () => new GitCodeProvider(),
  gitea: () => new GiteaProvider(),
  git: () => new GenericGitProvider(),
};

/**
 * Get a provider instance by name.
 * Defaults to the distribution-based default provider when no name is given.
 */
export function getProvider(providerName?: string): GitProvider {
  const name = providerName ?? getDefaultProvider();
  const factory = PROVIDERS[name];
  if (!factory) {
    throw new Error(
      `Unknown git provider: "${name}". Available: ${Object.keys(PROVIDERS).join(', ')}`,
    );
  }
  return factory();
}

/**
 * Get a provider instance by detecting the platform from a repo URL.
 */
export function getProviderFromUrl(repoUrl: string): GitProvider {
  const name = detectProvider(repoUrl);
  return getProvider(name);
}
