import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

import {
  findOrphanedAgentDirs,
  describeOrphanedAgentDir,
  orphanFix,
  formatOrphanedAgentDir,
} from '../orphaned-agent-dirs.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

describe('findOrphanedAgentDirs', () => {
  let tmp: string;
  let repoRoot: string;
  let teamConfig: TeamaiConfig;

  function makeConfig(local: { enabledAgents?: string[]; disabledAgents?: string[] }): LocalConfig {
    return {
      repo: { localPath: path.join(repoRoot, '.teamai'), remote: 'r', kind: 'self', businessRepoRoot: repoRoot },
      username: 'alice',
      scope: 'project',
      projectRoot: repoRoot,
      additionalRoles: [],
      ...local,
    };
  }

  async function writeSkill(tool: string, skill: string): Promise<void> {
    const dir = path.join(repoRoot, `.${tool}`, 'skills', skill);
    await fse.ensureDir(dir);
    await fse.writeFile(path.join(dir, 'SKILL.md'), `# ${skill}\n`);
  }

  beforeEach(async () => {
    tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-orphan-'));
    repoRoot = path.join(tmp, 'biz');
    await fse.ensureDir(repoRoot);
    teamConfig = {
      team: 't', description: '', repo: 'r', provider: 'github' as const, reviewers: [],
      sharing: { skills: {}, docs: { localDir: '' }, env: { injectShellProfile: true } },
      toolPaths: {
        claude: { skills: '.claude/skills' },
        cursor: { skills: '.cursor/skills' },
      },
    };
  });

  afterEach(async () => {
    await fse.remove(tmp);
  });

  it('reports nothing when enabledAgents is undefined (all tools synced)', async () => {
    await writeSkill('cursor', 'team-skill');
    expect(await findOrphanedAgentDirs(makeConfig({}), teamConfig)).toEqual([]);
  });

  it('reports an excluded tool whose skills dir still holds files', async () => {
    await writeSkill('claude', 'team-skill');
    await writeSkill('cursor', 'team-skill');
    const orphans = await findOrphanedAgentDirs(makeConfig({ enabledAgents: ['claude'] }), teamConfig);
    expect(orphans).toHaveLength(1);
    expect(orphans[0].tool).toBe('cursor');
    expect(orphans[0].skillsDir).toBe(path.join(repoRoot, '.cursor', 'skills'));
    expect(orphans[0].fileCount).toBe(1);
    expect(orphans[0].disabled).toBe(false);
  });

  it('reports every tool with leftovers when enabledAgents is empty', async () => {
    await writeSkill('claude', 'team-skill');
    await writeSkill('cursor', 'team-skill');
    const orphans = await findOrphanedAgentDirs(makeConfig({ enabledAgents: [] }), teamConfig);
    expect(orphans.map((o) => o.tool).sort()).toEqual(['claude', 'cursor']);
  });

  it('marks a tool excluded via disabledAgents as disabled', async () => {
    await writeSkill('cursor', 'team-skill');
    const orphans = await findOrphanedAgentDirs(makeConfig({ disabledAgents: ['cursor'] }), teamConfig);
    expect(orphans).toHaveLength(1);
    expect(orphans[0].disabled).toBe(true);
  });

  it('ignores an empty skills dir (no resources left)', async () => {
    await fse.ensureDir(path.join(repoRoot, '.cursor', 'skills'));
    expect(await findOrphanedAgentDirs(makeConfig({ enabledAgents: ['claude'] }), teamConfig)).toEqual([]);
  });

  it('ignores a tool with no skills dir on disk', async () => {
    expect(await findOrphanedAgentDirs(makeConfig({ enabledAgents: ['claude'] }), teamConfig)).toEqual([]);
  });
});

describe('orphan hint wording', () => {
  const orphan = {
    tool: 'cursor',
    skillsDir: path.join('C:\\', 'repo', '.cursor', 'skills'),
    fileCount: 13,
    disabled: false,
  };

  it('names the tool, the exact path, the file count and the remedy', () => {
    const line = formatOrphanedAgentDir(orphan);
    expect(line).toContain('cursor:');
    expect(line).toContain(path.join('C:\\', 'repo', '.cursor', 'skills'));
    expect(line).toContain('13 teamai-managed file(s)');
    expect(line).toContain('cursor is not in enabledAgents');
    expect(line).toContain('teamai uninstall --agent cursor');
  });

  it('splits into a doctor check name and a fix line', () => {
    expect(describeOrphanedAgentDir(orphan)).not.toContain('uninstall');
    expect(orphanFix(orphan)).toBe('Run `teamai uninstall --agent cursor` to stop syncing to it and remove them');
  });

  it('says disabledAgents when the tool is disabled', () => {
    expect(describeOrphanedAgentDir({ ...orphan, disabled: true })).toContain('cursor is in disabledAgents');
  });
});
