import type { GitProvider, PrCreateOptions, RepoInfo, OrgRepoInfo } from '../types.js';
import { RepoNotFoundError } from '../types.js';
import type { MRData } from '../../types.js';
import {
  ensureGiteaAvailable,
  giteaIsAuthenticated,
  giteaWhoami,
  giteaRepoClone,
  giteaCreateRepo,
  giteaPrCreate,
  GiteaRepoNotFoundError,
} from './gitea-api.js';
import { giteaListOrgRepos } from './org.js';
import { fetchGiteaPR } from './mr-fetch.js';
import { parseGiteaRepoInput } from './repo-url.js';

/**
 * Gitea provider (self-hosted instances only — Gitea has no public platform).
 *
 * Uses the Gitea REST API v1 directly — no external CLI is required, only an
 * access token (see gitea-api.ts for env-var conventions).
 */
export class GiteaProvider implements GitProvider {
  readonly name = 'gitea';

  parseRepoInput(input: string): RepoInfo {
    return parseGiteaRepoInput(input);
  }

  isAuthenticated(): boolean {
    return giteaIsAuthenticated();
  }

  async authenticate(): Promise<string> {
    if (this.isAuthenticated()) {
      const username = await giteaWhoami();
      if (username) return username;
    }
    await ensureGiteaAvailable();
    const username = await giteaWhoami();
    if (!username) {
      throw new Error('Gitea authentication failed. Please run `teamai init` again.');
    }
    return username;
  }

  async ensureInstalled(): Promise<void> {
    await ensureGiteaAvailable();
  }

  cloneRepo(repo: string, localPath: string): void {
    try {
      giteaRepoClone(repo, localPath);
    } catch (e) {
      if (e instanceof GiteaRepoNotFoundError) {
        throw new RepoNotFoundError(repo);
      }
      throw e;
    }
  }

  async createRepo(owner: string, repo: string): Promise<void> {
    await giteaCreateRepo(owner, repo);
  }

  async createPullRequest(opts: PrCreateOptions): Promise<string> {
    return giteaPrCreate({
      repo: opts.repo,
      source: opts.source,
      target: opts.target,
      title: opts.title,
      description: opts.description,
      reviewers: opts.reviewers,
      cwd: opts.cwd,
    });
  }

  async fetchMergeRequest(url: string): Promise<MRData> {
    return fetchGiteaPR(url);
  }

  async listOrgRepos(org: string, opts?: { maxRepos?: number }): Promise<OrgRepoInfo[]> {
    return giteaListOrgRepos(org, opts);
  }

  getDefaultEmailDomain(): string | null {
    return null;
  }
}

export { giteaIsAuthenticated, getGiteaToken, giteaBaseUrl } from './gitea-api.js';
export { giteaHost, parseGiteaRepoInput } from './repo-url.js';
