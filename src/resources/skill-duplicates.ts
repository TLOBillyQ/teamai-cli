import type { ResourceItem } from '../types.js';
import { log } from '../utils/logger.js';

/**
 * Duplicate skill names across skills/ groups.
 *
 * Team repo skills live at skills/<name>/ or skills/<group>/<name>/, but every
 * one installs flat as <toolSkillsDir>/<name>: the group is not part of the
 * installed name. A name that appears at more than one path is therefore
 * ambiguous, and there is no precedence rule between groups — it is an error
 * that the admin resolves by renaming. Commands skip the ambiguous skill,
 * report every conflicting path, and exit non-zero.
 */

/** A skill name that appears more than once among the team repo's skills. */
export interface DuplicateSkill {
  name: string;
  /** Every team-repo relative path carrying this name, sorted. */
  paths: string[];
}

type SkillRef = Pick<ResourceItem, 'name' | 'relativePath'>;

/**
 * Find skill names that appear more than once among the given team skills
 * (top level plus every group). Sorted by name and path, so the result never
 * depends on directory listing order. The same path listed twice is one skill.
 */
export function findDuplicateSkillNames(items: ReadonlyArray<SkillRef>): DuplicateSkill[] {
  const pathsByName = new Map<string, Set<string>>();
  for (const item of items) {
    const paths = pathsByName.get(item.name) ?? new Set<string>();
    paths.add(item.relativePath);
    pathsByName.set(item.name, paths);
  }
  return [...pathsByName]
    .filter(([, paths]) => paths.size > 1)
    .map(([name, paths]) => ({ name, paths: [...paths].sort() }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** `"a" and "b"` / `"a", "b" and "c"` — the role-mode guard's quoting style. */
function joinQuoted(values: string[]): string {
  const quoted = values.map((v) => `"${v}"`);
  return quoted.length <= 2
    ? quoted.join(' and ')
    : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

/**
 * One line per duplicated name, in the role-mode guard's format
 * (`Duplicate skill "<name>" found in ... and ...`), listing every path.
 */
export function formatDuplicateSkills(duplicates: DuplicateSkill[]): string {
  return duplicates
    .map((d) => `Duplicate skill "${d.name}" found in ${joinQuoted(d.paths)}. `
      + 'Skill groups are not part of the installed name; rename one so every skill name is unique across skills/.')
    .join('\n');
}

/** Conflicts already reported in this process (name + paths). */
const reported = new Set<string>();

/**
 * Report ambiguous skill names as an error and mark the run failed. The
 * caller skips those skills and carries on with the rest. Each conflict is
 * printed once per run, however many scans hit it.
 */
export function reportDuplicateSkills(duplicates: DuplicateSkill[], prefix = ''): void {
  if (duplicates.length === 0) return;
  process.exitCode = 1;
  const fresh = duplicates.filter((d) => !reported.has(`${d.name}:${d.paths.join('|')}`));
  if (fresh.length === 0) return;
  for (const d of fresh) reported.add(`${d.name}:${d.paths.join('|')}`);
  log.error(prefix + formatDuplicateSkills(fresh));
}

/** Test hook: forget which conflicts this process has already reported. */
export function resetReportedDuplicateSkills(): void {
  reported.clear();
}
