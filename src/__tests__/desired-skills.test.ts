import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

import { resolveDesiredSkills } from '../pull.js';
import type { RolePullContext } from '../pull.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

/**
 * The desired set is what `pull` installs and what `doctor` checks landed. Both
 * read it from here, so this is the one place role namespaces, tag subscriptions
 * and exclusions are combined (#598).
 */
describe('resolveDesiredSkills', () => {
  let tempDir: string;
  let repoPath: string;
  let localConfig: LocalConfig;
  let teamConfig: TeamaiConfig;

  /** A role context activating the given skill namespaces. */
  function rolesOver(namespaces: string[]): RolePullContext {
    return {
      activeNamespaces: { knowledge: [], skills: namespaces, learnings: [], agents: [] },
      activeSkillNames: new Set(),
      inactiveSkillNames: new Set(),
      inactiveSkillSources: new Map(),
    };
  }

  async function writeSkill(namespace: string, name: string): Promise<void> {
    const dir = path.join(repoPath, 'skills', namespace, name);
    await fse.ensureDir(dir);
    await fse.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n`);
  }

  beforeEach(async () => {
    tempDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-desired-skills-'));
    repoPath = path.join(tempDir, 'team-repo');

    await writeSkill('common', 'shared-skill');
    await writeSkill('backend', 'backend-skill');
    await writeSkill('frontend', 'frontend-skill');
    await fse.writeFile(
      path.join(repoPath, 'tags.yaml'),
      'skills:\n  frontend-skill: [ui]\n  backend-skill: [server]\n',
    );

    localConfig = {
      repo: { localPath: repoPath, remote: 'owner/repo' },
      username: 'tester',
      scope: 'user',
      additionalRoles: [],
    };
    teamConfig = {
      team: 'test',
      description: '',
      repo: 'owner/repo',
      provider: 'github',
      reviewers: [],
      sharing: {
        skills: {}, docs: { localDir: '' }, env: { injectShellProfile: true },
      },
      toolPaths: { claude: { skills: '.claude/skills' } },
    };
  });

  afterEach(async () => {
    await fse.remove(tempDir);
  });

  it('takes the union of the active role namespaces and the subscribed tags', async () => {
    localConfig.subscribedTags = ['ui'];

    const { items } = await resolveDesiredSkills(teamConfig, localConfig, rolesOver(['common']));

    expect(items.map((i) => i.name).sort()).toEqual(['frontend-skill', 'shared-skill']);
  });

  it('drops excluded skills from the union', async () => {
    localConfig.subscribedTags = ['ui'];
    localConfig.excludedSkills = ['frontend-skill'];

    const { items } = await resolveDesiredSkills(teamConfig, localConfig, rolesOver(['common']));

    expect(items.map((i) => i.name)).toEqual(['shared-skill']);
  });

  it('without a role context, every skill in the repo is desired', async () => {
    const { items } = await resolveDesiredSkills(teamConfig, localConfig, null);

    expect(items.map((i) => i.name).sort())
      .toEqual(['backend-skill', 'frontend-skill', 'shared-skill']);
  });

  it('reports the whole team repo separately, so cleanup knows what it may prune', async () => {
    const { items, teamItems, skippedByTags } = await resolveDesiredSkills(
      teamConfig,
      localConfig,
      rolesOver(['common']),
    );

    expect(items.map((i) => i.name)).toEqual(['shared-skill']);
    expect(teamItems.map((i) => i.name).sort())
      .toEqual(['backend-skill', 'frontend-skill', 'shared-skill']);
    expect(teamItems.every((i) => i.sourcePath.startsWith(repoPath))).toBe(true);
    // No subscriptions active, so nothing was filtered out by the tag channel.
    expect(skippedByTags).toBe(0);
  });

  it('counts what the tag filter left out', async () => {
    localConfig.subscribedTags = ['ui'];

    const { skippedByTags } = await resolveDesiredSkills(teamConfig, localConfig, rolesOver(['common']));

    // backend-skill carries a tag the user is not subscribed to.
    expect(skippedByTags).toBe(1);
  });

  it('rejects collisions across groups without a role instead of choosing the last copy', async () => {
    await writeSkill('backend', 'shared-skill');
    const { items, duplicates } = await resolveDesiredSkills(teamConfig, localConfig, null);
    expect(items.map((item) => item.name)).not.toContain('shared-skill');
    expect(duplicates).toEqual([{
      name: 'shared-skill', paths: ['skills/backend/shared-skill', 'skills/common/shared-skill'],
    }]);
  });

  it('detects a tag-selected collision with a role-selected skill, but not a repeated path', async () => {
    localConfig.subscribedTags = ['shared'];
    await fse.writeFile(path.join(repoPath, 'tags.yaml'), 'skills:\n  shared-skill: [shared]\n');
    const initial = await resolveDesiredSkills(teamConfig, localConfig, rolesOver(['common']));
    expect(initial.items.map((item) => item.name)).toEqual(['shared-skill']);
    expect(initial.duplicates).toEqual([]);

    await writeSkill('backend', 'shared-skill');
    const collided = await resolveDesiredSkills(teamConfig, localConfig, rolesOver(['common']));
    expect(collided.items).toEqual([]);
    expect(collided.duplicates[0].paths).toEqual(['skills/backend/shared-skill', 'skills/common/shared-skill']);
  });

  it('writes nothing: doctor calls it on a machine it must not change', async () => {
    const before = await fse.readdir(tempDir);

    await resolveDesiredSkills(teamConfig, localConfig, rolesOver(['common']));

    expect(await fse.readdir(tempDir)).toEqual(before);
    expect(await fse.pathExists(path.join(tempDir, '.claude'))).toBe(false);
  });
});
