import YAML from 'yaml';
import path from 'node:path';
import { requireInit, detectProjectConfig } from './config.js';
import { readFileSafe, listFiles, ensureDir, pathExists, writeFile } from './utils/fs.js';
import { pullRepo, getGitIdentity } from './utils/git.js';
import { log } from './utils/logger.js';
import { MemberConfigSchema } from './types.js';
import type { GlobalOptions, LocalConfig, MemberConfig } from './types.js';

/** Command the user runs to retry a registration that did not reach the remote. */
export const RETRY_HINT = 'Run `teamai members register` to retry once it is fixed.';

/**
 * Why a registration commit cannot be made: git has no author identity.
 * `teamai init` and `teamai members register` both report exactly this line.
 */
export const MISSING_GIT_IDENTITY = 'Git identity is not configured, so the registration commit cannot be authored.';

/** Print the commands that fix MISSING_GIT_IDENTITY. */
export function logGitIdentityFix(): void {
  log.info('  git config --global user.name "Your Name"');
  log.info('  git config --global user.email "you@example.com"');
}

/**
 * Preflight for a registration commit. Git refuses to commit without an author
 * ("Author identity unknown"), so callers check before writing anything and
 * print a fix instead of a raw git error.
 *
 * @param repoPath - Repo the commit would be made in (local config applies).
 * @returns MISSING_GIT_IDENTITY when user.name or user.email is unset, else null.
 */
export async function checkGitIdentity(repoPath: string): Promise<string | null> {
  const identity = await getGitIdentity(repoPath);
  return identity.name && identity.email ? null : MISSING_GIT_IDENTITY;
}

/**
 * Render the `members/<username>.yaml` payload. Every registration path (init,
 * clone bootstrap, and the retry command) writes the same shape, so they share
 * this one definition.
 */
export function buildMemberYaml(username: string): string {
  return YAML.stringify({
    username,
    displayName: username,
    registeredAt: new Date().toISOString(),
  });
}

/**
 * Read a specific member's config from the repo.
 */
export async function getMemberConfig(repoPath: string, username: string): Promise<MemberConfig | null> {
  const memberPath = path.join(repoPath, 'members', `${username}.yaml`);
  const content = await readFileSafe(memberPath);
  if (!content) return null;
  try {
    const raw = YAML.parse(content);
    return MemberConfigSchema.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Merge a member's roster entry with newly-active role/projects, returning the
 * updated config and whether anything changed. Projects use **append + dedupe**
 * (the roster is "every project I've participated in" across directories);
 * `role` is overwritten when a non-empty one is supplied. `registeredAt` is
 * preserved for an existing member. Pure — callers persist + push the result.
 */
export function mergeMemberConfig(
  existing: MemberConfig | null,
  input: { username: string; role?: string; projects?: string[] },
): { config: MemberConfig; changed: boolean } {
  const prevProjects = existing?.projects ?? [];
  const mergedProjects: string[] = [...prevProjects];
  const seen = new Set(prevProjects);
  for (const p of input.projects ?? []) {
    if (!seen.has(p)) {
      seen.add(p);
      mergedProjects.push(p);
    }
  }

  const role = input.role ?? existing?.role;

  const config: MemberConfig = {
    username: input.username,
    displayName: existing?.displayName || input.username,
    registeredAt: existing?.registeredAt ?? new Date().toISOString(),
    ...(role ? { role } : {}),
    ...(mergedProjects.length > 0 ? { projects: mergedProjects } : {}),
  };

  const changed =
    !existing ||
    mergedProjects.length !== prevProjects.length ||
    (role ?? '') !== (existing.role ?? '');

  return { config, changed };
}

export async function listMembers(options: GlobalOptions): Promise<void> {
  const projectConfig = await detectProjectConfig();
  const localConfig = projectConfig ?? (await requireInit()).localConfig;

  // Members live on the teamai-reports orphan branch for non-HTTP repos; read
  // them from the reports worktree (refreshed from origin). Leftover members/
  // on the default-branch clone is ignored. HTTP keeps the clone/API path.
  // Listing is read-only: never publish a missing reports branch.
  let repoPath: string;
  const { usesBranchWorktree } = await import('./types.js');
  if (usesBranchWorktree(localConfig)) {
    const { ensureReportsWorktree, refreshReportsWorktree } = await import('./utils/reports-branch.js');
    await refreshReportsWorktree(localConfig, { pushIfCreated: false });
    repoPath = await ensureReportsWorktree(localConfig, { pushIfCreated: false });
  } else {
    repoPath = localConfig.repo.localPath;
    await pullRepo(repoPath);
  }

  const membersDir = path.join(repoPath, 'members');
  const files = await listFiles(membersDir);
  const yamlFiles = files.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));

  if (yamlFiles.length === 0) {
    log.info('No team members registered');
    return;
  }

  console.log('');
  console.log(`Team members (${yamlFiles.length}):`);
  console.log('');

  for (const file of yamlFiles) {
    const content = await readFileSafe(path.join(membersDir, file));
    if (!content) continue;
    try {
      const raw = YAML.parse(content);
      const member = MemberConfigSchema.parse(raw);
      const isSelf = member.username === localConfig.username;
      const marker = isSelf ? ' (you)' : '';
      const display = member.displayName ? ` — ${member.displayName}` : '';
      console.log(`  ${member.username}${display}${marker}`);
      if (options.verbose) {
        console.log(`    registered: ${member.registeredAt}`);
      }
    } catch {
      log.warn(`Invalid member file: ${file}`);
    }
  }
  console.log('');
}

/**
 * Register the current user as a team member, idempotently.
 *
 * `teamai init` registers as a side effect, but its push is best-effort: a
 * machine without a git identity (or offline) ends up initialized yet unlisted,
 * and re-running init aborts on the existing config. This is the retry entry
 * point — it only touches `members/<username>.yaml`, so it is safe to run any
 * number of times, and it re-pushes a file an earlier attempt left local-only.
 */
export async function registerMember(): Promise<void> {
  const projectConfig = await detectProjectConfig();
  const localConfig: LocalConfig = projectConfig ?? (await requireInit()).localConfig;
  const { username } = localConfig;

  // HTTP team repos are read-only consumers: there is no clone to commit into.
  if (localConfig.repo.kind === 'http') {
    log.error('This install uses a read-only HTTP team repo, which has no member roster to push to.');
    log.info('Ask a team admin to add you, or re-init against the git repo to register yourself.');
    process.exitCode = 1;
    return;
  }

  // Members live on the teamai-reports orphan branch (see listMembers).
  const { ensureReportsWorktree, refreshReportsWorktree, commitAndPushReports } = await import('./utils/reports-branch.js');
  await refreshReportsWorktree(localConfig);
  const repoPath = await ensureReportsWorktree(localConfig);

  // Preflight (shared with init): say so before writing anything.
  const identityError = await checkGitIdentity(repoPath);
  if (identityError) {
    log.error(identityError);
    logGitIdentityFix();
    log.info(RETRY_HINT);
    process.exitCode = 1;
    return;
  }

  const memberPath = path.join(repoPath, 'members', `${username}.yaml`);
  const alreadyLocal = await pathExists(memberPath);
  if (!alreadyLocal) {
    await ensureDir(path.dirname(memberPath));
    await writeFile(memberPath, buildMemberYaml(username));
  }

  const message = `[teamai] Register member: ${username}`;
  try {
    const pushed = await commitAndPushReports(localConfig, message, ['members/']);
    // commitAndPushReports also returns false when there was nothing to commit,
    // which for an already-registered member is the success case.
    if (!pushed && !alreadyLocal) {
      log.error(`Member registration could not be pushed for ${username}.`);
      log.info(`Check connectivity and write access to the team repo. ${RETRY_HINT}`);
      process.exitCode = 1;
      return;
    }
  } catch (e) {
    log.error(`Member registration failed to push: ${(e as Error).message}`);
    log.info(RETRY_HINT);
    process.exitCode = 1;
    return;
  }

  if (alreadyLocal) {
    log.success(`Member ${username} is registered.`);
  } else {
    log.success(`Registered as team member: ${username}`);
  }
  log.info('Run `teamai members` to see the full roster.');
}
