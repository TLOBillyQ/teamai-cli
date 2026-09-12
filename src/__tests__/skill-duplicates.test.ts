import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

// Directory listing order is filesystem-dependent. Let each test flip it so the
// detector is proven independent of readdir order.
const listing = vi.hoisted(() => ({ reverse: false }));
vi.mock('../utils/fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/fs.js')>();
  return {
    ...actual,
    listDirs: async (dir: string) => {
      const dirs = await actual.listDirs(dir);
      const sorted = [...dirs].sort();
      return listing.reverse ? sorted.reverse() : sorted;
    },
  };
});

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
}));

import { SkillsHandler } from '../resources/skills.js';
import { findDuplicateSkillNames, formatDuplicateSkills } from '../resources/skill-duplicates.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

async function writeSkill(repoPath: string, rel: string): Promise<void> {
  await fse.ensureDir(path.join(repoPath, rel));
  await fse.writeFile(path.join(repoPath, rel, 'SKILL.md'), `# ${rel}`);
}

describe('findDuplicateSkillNames', () => {
  let tmpDir: string;
  let repoPath: string;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;
  const handler = new SkillsHandler();

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-skill-dups-'));
    repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(repoPath, 'skills'));
    teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.example.test/test/repo.git',
      provider: 'git' as const,
      reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
      toolPaths: {},
    } as TeamaiConfig;
    localConfig = {
      repo: { localPath: repoPath, remote: 'https://git.example.test/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'user',
    };
  });

  afterEach(async () => {
    listing.reverse = false;
    await fse.remove(tmpDir);
  });

  async function scanWith(reverse: boolean) {
    listing.reverse = reverse;
    return findDuplicateSkillNames(await handler.scanTeamForPull(teamConfig, localConfig));
  }

  it('reports a skill duplicated across two groups with both paths, regardless of listing order', async () => {
    await writeSkill(repoPath, 'skills/team/code-review');
    await writeSkill(repoPath, 'skills/mattpocock/code-review');
    await writeSkill(repoPath, 'skills/team/unique');

    const expected = [{ name: 'code-review', paths: ['skills/mattpocock/code-review', 'skills/team/code-review'] }];
    expect(await scanWith(false)).toEqual(expected);
    expect(await scanWith(true)).toEqual(expected);
  });

  it('treats a top-level skill as a duplicate of a grouped skill with the same name', async () => {
    await writeSkill(repoPath, 'skills/x');
    await writeSkill(repoPath, 'skills/a/x');

    const expected = [{ name: 'x', paths: ['skills/a/x', 'skills/x'] }];
    expect(await scanWith(false)).toEqual(expected);
    expect(await scanWith(true)).toEqual(expected);
  });

  it('lists every path of a name that appears three times, and every duplicated name', async () => {
    await writeSkill(repoPath, 'skills/c/x');
    await writeSkill(repoPath, 'skills/a/x');
    await writeSkill(repoPath, 'skills/b/x');
    await writeSkill(repoPath, 'skills/b/y');
    await writeSkill(repoPath, 'skills/y');

    const expected = [
      { name: 'x', paths: ['skills/a/x', 'skills/b/x', 'skills/c/x'] },
      { name: 'y', paths: ['skills/b/y', 'skills/y'] },
    ];
    expect(await scanWith(false)).toEqual(expected);
    expect(await scanWith(true)).toEqual(expected);
  });

  it('returns nothing for a repo without conflicts', async () => {
    await writeSkill(repoPath, 'skills/flat');
    await writeSkill(repoPath, 'skills/a/one');
    await writeSkill(repoPath, 'skills/b/two');

    expect(await scanWith(false)).toEqual([]);
  });

  it('does not count the same item twice as a duplicate', () => {
    const item = { name: 'x', relativePath: 'skills/a/x' };
    expect(findDuplicateSkillNames([item, { ...item }])).toEqual([]);
  });

  it('formatDuplicateSkills names the skill, every path, and asks for a rename', () => {
    const message = formatDuplicateSkills([
      { name: 'code-review', paths: ['skills/mattpocock/code-review', 'skills/team/code-review'] },
    ]);
    expect(message).toContain('Duplicate skill "code-review"');
    expect(message).toContain('skills/mattpocock/code-review');
    expect(message).toContain('skills/team/code-review');
    expect(message).toMatch(/rename/i);
  });
});
