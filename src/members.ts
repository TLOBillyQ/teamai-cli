import YAML from 'yaml';
import path from 'node:path';
import { requireInit, detectProjectConfig } from './config.js';
import { readFileSafe, listFiles, ensureDir, pathExists, writeFile } from './utils/fs.js';
import { pullRepo, getGitIdentity, commitAndPushFiles } from './utils/git.js';
import { log } from './utils/logger.js';
import { MemberConfigSchema } from './types.js';
import type { GlobalOptions, LocalConfig, MemberConfig } from './types.js';

/** Command the user runs to retry a registration that did not reach the remote. */
const RETRY_HINT = 'Run `teamai members register` to retry once it is fixed.';

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

export async function listMembers(options: GlobalOptions): Promise<void> {
  const projectConfig = await detectProjectConfig();
  const localConfig = projectConfig ?? (await requireInit()).localConfig;

  // Members live on the teamai-reports orphan branch in self mode; read them from
  // the reports worktree (refreshed from origin) instead of the team repo clone.
  let repoPath: string;
  if (localConfig.repo.kind === 'self') {
    const { ensureReportsWorktree, refreshReportsWorktree } = await import('./utils/reports-branch.js');
    await refreshReportsWorktree(localConfig);
    repoPath = await ensureReportsWorktree(localConfig);
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
  const isSelfMode = localConfig.repo.kind === 'self';

  // HTTP team repos are read-only consumers: there is no clone to commit into.
  if (localConfig.repo.kind === 'http') {
    log.error('This install uses a read-only HTTP team repo, which has no member roster to push to.');
    log.info('Ask a team admin to add you, or re-init against the git repo to register yourself.');
    process.exitCode = 1;
    return;
  }

  // Members live on the teamai-reports orphan branch in self mode.
  let repoPath: string;
  if (isSelfMode) {
    const { ensureReportsWorktree, refreshReportsWorktree } = await import('./utils/reports-branch.js');
    await refreshReportsWorktree(localConfig);
    repoPath = await ensureReportsWorktree(localConfig);
  } else {
    repoPath = localConfig.repo.localPath;
    await pullRepo(repoPath);
  }

  // Preflight: git refuses to commit without an author, which is exactly how
  // registration fails during init. Say so before writing anything.
  const identity = await getGitIdentity(repoPath);
  if (!identity.email || !identity.name) {
    log.error('Git identity is not configured, so the registration commit cannot be authored.');
    log.info('  git config --global user.name "Your Name"');
    log.info('  git config --global user.email "you@example.com"');
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
    if (isSelfMode) {
      const { commitAndPushReports } = await import('./utils/reports-branch.js');
      const pushed = await commitAndPushReports(localConfig, message, ['members/']);
      // commitAndPushReports also returns false when there was nothing to commit,
      // which for an already-registered member is the success case.
      if (!pushed && !alreadyLocal) {
        log.error(`Member registration could not be pushed for ${username}.`);
        log.info(`Check connectivity and write access to the team repo. ${RETRY_HINT}`);
        process.exitCode = 1;
        return;
      }
    } else {
      const confirmed = await commitAndPushFiles(repoPath, message, ['members/']);
      if (!confirmed) {
        log.error(`Member registration was pushed but origin does not have it for ${username}.`);
        log.info(`Check write access to the team repo. ${RETRY_HINT}`);
        process.exitCode = 1;
        return;
      }
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
