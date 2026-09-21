import path from 'node:path';
import {
  isAgentDisabled,
  isAgentExcluded,
  resolveToolBaseDir,
  scopedToolPaths,
  type LocalConfig,
  type TeamaiConfig,
} from './types.js';
import { listFilesRecursive, pathExists } from './utils/fs.js';

/**
 * A tool this scope no longer syncs to whose skills directory still holds
 * files from an earlier sync. "No longer syncs to" is exactly
 * `isAgentExcluded`: outside `enabledAgents` when that whitelist is set
 * (`undefined` = every tool, so nothing is ever an orphan), or named in
 * `disabledAgents`.
 */
export interface OrphanedAgentDir {
  tool: string;
  /** Absolute path of the tool's skills directory. */
  skillsDir: string;
  fileCount: number;
  /** True when excluded via `disabledAgents` rather than `enabledAgents`. */
  disabled: boolean;
}

/**
 * Find tools this scope no longer syncs to that still hold synced files.
 *
 * Only the skills directory is probed: it is what every tool in `toolPaths`
 * receives and what an earlier sync filled, and it is the directory an
 * `uninstall --agent` removes. A directory that exists but is empty (the
 * shell an older uninstall left behind) holds no resources and is not
 * reported.
 *
 * Diagnostics must never break the command that surfaces them, so a tool
 * whose directory cannot be read is skipped rather than reported.
 */
export async function findOrphanedAgentDirs(
  localConfig: LocalConfig,
  teamConfig: TeamaiConfig,
): Promise<OrphanedAgentDir[]> {
  const orphans: OrphanedAgentDir[] = [];
  const seen = new Set<string>();
  for (const [tool, paths] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
    if (!paths.skills) continue;
    if (!isAgentExcluded(localConfig, tool)) continue;
    const skillsDir = path.join(resolveToolBaseDir(tool, localConfig), paths.skills);
    // A team's toolPaths can point two ids at one directory; report it once.
    if (seen.has(skillsDir)) continue;
    seen.add(skillsDir);
    try {
      if (!await pathExists(skillsDir)) continue;
      const fileCount = (await listFilesRecursive(skillsDir)).length;
      if (fileCount === 0) continue;
      orphans.push({ tool, skillsDir, fileCount, disabled: isAgentDisabled(localConfig, tool) });
    } catch {
      continue;
    }
  }
  return orphans;
}

/** The one-line description, without the suggested command. */
export function describeOrphanedAgentDir(orphan: OrphanedAgentDir): string {
  const reason = orphan.disabled
    ? `${orphan.tool} is in disabledAgents`
    : `${orphan.tool} is not in enabledAgents`;
  return `${orphan.tool}: ${orphan.skillsDir} still has ${orphan.fileCount} teamai-managed file(s) from an earlier sync, but ${reason}`;
}

/** The suggested remedy, as a doctor `fix` line. */
export function orphanFix(orphan: OrphanedAgentDir): string {
  return `Run \`teamai uninstall --agent ${orphan.tool}\` to stop syncing to it and remove them`;
}

/** The full one-line hint, for `teamai status`. */
export function formatOrphanedAgentDir(orphan: OrphanedAgentDir): string {
  return `${describeOrphanedAgentDir(orphan)}; run "teamai uninstall --agent ${orphan.tool}" to stop syncing to it and remove them`;
}
