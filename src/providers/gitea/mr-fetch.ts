import { type MRData } from '../../types.js';
import { log } from '../../utils/logger.js';
import { getGiteaToken } from './gitea-api.js';
import { giteaHost } from './repo-url.js';

/** Gitea PR URL 解析结果 */
interface ParsedGiteaPR {
  /** API base derived from the PR URL's own origin, e.g. http://host:3000/api/v1 */
  apiBase: string;
  owner: string;
  repo: string;
  index: string;
}

/**
 * 从 Gitea PR URL 解析出 owner / repo / PR index。
 *
 * 支持格式：`https://<host>/<owner>/<repo>/pulls/<index>`
 * 注意与 GitHub 的 `/pull/<n>`（单数）区分——Gitea 用的是复数 `/pulls/`。
 * 解析失败时抛出 Error。
 */
export function parseGiteaPRUrl(url: string): ParsedGiteaPR {
  const match = url.match(/^(https?):\/\/([^/]+)\/([^/]+)\/([^/]+)\/pulls\/(\d+)/i);
  if (!match) {
    throw new Error(`Invalid Gitea PR URL: ${url}`);
  }
  const [, scheme, host, owner, repo, index] = match;

  // Only ever send the token to the *configured* instance. The API base still
  // comes from the URL's own origin (so a self-hosted instance keeps its scheme
  // and port), but the host must match the configured one — otherwise a
  // hand-crafted PR URL on an attacker-controlled host would receive the token
  // (SSRF / credential exfiltration).
  const configured = giteaHost();
  if (!configured) {
    throw new Error(
      'No Gitea instance configured. Set GITEA_URL / TEAMAI_GITEA_HOST before importing '
        + 'a Gitea PR.',
    );
  }
  if (normalizeHost(host) !== normalizeHost(configured)) {
    throw new Error(
      `Refusing to fetch Gitea PR from "${host}": it does not match the configured Gitea `
        + `instance "${configured}". Set GITEA_URL / TEAMAI_GITEA_HOST to this instance if `
        + 'it is trusted.',
    );
  }

  return { apiBase: `${scheme.toLowerCase()}://${host}/api/v1`, owner, repo, index };
}

/** Normalize a host for comparison: lowercase, drop a leading `www.`. Ports must match. */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^www\./, '');
}

/** Gitea REST API 返回的 PR 元信息（仅使用的字段） */
interface GiteaPR {
  title: string;
  body: string | null;
  user?: { login?: string };
  merged_at?: string | null;
}

/** Gitea REST API 返回的 commit（仅使用的字段） */
interface GiteaCommit {
  sha: string;
  commit?: { message?: string };
}

function authHeaders(token: string): Record<string, string> {
  return { 'Authorization': `token ${token}`, 'Accept': 'application/json' };
}

/**
 * 通过 Gitea REST API（<host>/api/v1）获取 PR 的完整数据。
 *
 *   1. GET /repos/{owner}/{repo}/pulls/{index} 获取元信息
 *   2. GET /repos/{owner}/{repo}/pulls/{index}/commits 获取提交列表
 *   3. GET /repos/{owner}/{repo}/pulls/{index}.diff 获取 diff
 *      （截断至 50KB，失败非致命）
 *
 * @param url - Gitea PR 完整 web URL，例如
 *   https://gitea.example.com/owner/repo/pulls/42
 * @returns 包含标题、描述、提交列表、diff 的 MRData 对象
 * @throws Error 当 URL 格式不合法、未配置 token 或 API 调用失败时
 */
export async function fetchGiteaPR(url: string): Promise<MRData> {
  const { apiBase, owner, repo, index } = parseGiteaPRUrl(url);
  const token = getGiteaToken();
  if (!token) {
    throw new Error('GITEA_TOKEN is not set.');
  }

  const path = `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const headers = authHeaders(token);
  log.debug(`fetchGiteaPR: ${owner}/${repo}#${index}`);

  // ── 1. 获取元信息 ──────────────────────────────────────────
  const resp = await fetch(`${apiBase}/repos/${path}/pulls/${index}`, {
    headers,
    redirect: 'manual',
  });
  if (!resp.ok) {
    throw new Error(`Gitea API error ${resp.status}: ${await resp.text()}`);
  }
  const pr = (await resp.json()) as GiteaPR;

  // ── 2. 获取提交列表（失败非致命） ──────────────────────────
  let commits: Array<{ hash: string; message: string }> = [];
  try {
    const commitsResp = await fetch(
      `${apiBase}/repos/${path}/pulls/${index}/commits?limit=50`,
      { headers, redirect: 'manual' },
    );
    if (commitsResp.ok) {
      const raw = (await commitsResp.json()) as GiteaCommit[];
      commits = raw.map((c) => ({
        hash: c.sha,
        // Only the subject line — matches the GitLab provider's `title`.
        message: (c.commit?.message ?? '').split('\n')[0],
      }));
    }
  } catch (err) {
    log.debug(`Gitea PR commits 获取异常，commits 将为空：${(err as Error).message}`);
  }

  // ── 3. 获取 diff（截断至 50KB，失败非致命） ────────────────
  // Gitea serves the raw unified diff at `<pr>.diff`; unlike GitLab there is no
  // JSON changes endpoint, so this response is plain text.
  let diff = '';
  try {
    const diffResp = await fetch(`${apiBase}/repos/${path}/pulls/${index}.diff`, {
      headers: { 'Authorization': `token ${token}`, 'Accept': 'text/plain' },
      redirect: 'manual',
    });
    if (diffResp.ok) {
      diff = (await diffResp.text()).slice(0, 50000);
    } else {
      log.debug(`Gitea PR diff 获取失败（${diffResp.status}），diff 将为空`);
    }
  } catch (err) {
    log.debug(`Gitea PR diff 获取异常，diff 将为空：${(err as Error).message}`);
  }

  return {
    title: pr.title,
    description: pr.body ?? '',
    author: pr.user?.login,
    mergedAt: pr.merged_at ?? undefined,
    commits,
    diff,
    url,
  };
}
