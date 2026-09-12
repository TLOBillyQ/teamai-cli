import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../config.js', () => ({
  requireInit: vi.fn(),
  loadState: vi.fn().mockResolvedValue({ lastPull: null, lastPullRev: null }),
  saveState: vi.fn(),
  loadLocalConfigForScope: vi.fn(),
  loadTeamConfig: vi.fn(),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  loadStateForScope: vi.fn().mockResolvedValue({
    lastPull: null,
    lastPullRev: null,
    lastPush: null,
    pushedRules: [],
    pushedSkills: [],
    pushedEnvVars: [],
    pendingPushes: [],
    lastUpdateCheck: null,
    availableUpdate: null,
  }),
  saveStateForScope: vi.fn(),
}));

vi.mock('../utils/git.js', () => ({
  pullRepo: vi.fn().mockResolvedValue('already up to date'),
  getHeadRev: vi.fn().mockResolvedValue('abc1234'),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  })),
}));

vi.mock('../update.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));

import { pull } from '../pull.js';
import { loadLocalConfigForScope, loadTeamConfig, detectProjectConfig } from '../config.js';
import { log } from '../utils/logger.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

/** Collect every string a log method was called with. */
function loggedLines(fn: { mock: { calls: unknown[][] } }): string[] {
  return fn.mock.calls.map((c) => String(c[0]));
}

describe('pull — uninstalled tool visibility', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-pull-targets-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');

    await fse.ensureDir(path.join(repoPath, 'skills', 'demo-skill'));
    await fse.writeFile(
      path.join(repoPath, 'skills', 'demo-skill', 'SKILL.md'),
      '---\nname: demo-skill\ndescription: demo\n---\n\n# demo\n',
    );

    vi.stubEnv('HOME', homeDir);
    await fse.ensureDir(homeDir);

    teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.example.com/test/repo.git',
      provider: 'git' as const,
      reviewers: [],
      sharing: {
        skills: {},
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        claude: { skills: '.claude/skills', rules: '.claude/rules' },
        kimi: { skills: '.kimi-code/skills' },
      },
    };

    localConfig = {
      repo: { localPath: repoPath, remote: 'https://git.example.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'user',
    };

    vi.mocked(loadLocalConfigForScope).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fse.remove(tmpDir);
  });

  it('reports each skipped target with the missing directory in verbose mode', async () => {
    await fse.ensureDir(path.join(homeDir, '.claude'));

    await pull({ force: true, verbose: true });

    const lines = [...loggedLines(vi.mocked(log.info)), ...loggedLines(vi.mocked(log.warn))];
    const kimiLine = lines.find((l) => l.includes('kimi: skipped'));
    expect(kimiLine).toBeDefined();
    expect(kimiLine).toContain(path.join(homeDir, '.kimi-code'));
    expect(kimiLine).toContain('not found');
    // An installed tool must not be reported as skipped.
    expect(lines.some((l) => l.includes('claude: skipped'))).toBe(false);
  });

  it('summarizes the skipped targets on one line when something did install', async () => {
    await fse.ensureDir(path.join(homeDir, '.claude'));

    await pull({ force: true });

    const lines = loggedLines(vi.mocked(log.info));
    const summary = lines.find((l) => l.includes('skipped — directory not found'));
    expect(summary).toBeDefined();
    expect(summary).toContain('kimi');
    expect(summary).toContain('--verbose');
    // The noisy per-target form stays behind --verbose.
    expect(lines.some((l) => l.includes('kimi: skipped'))).toBe(false);
  });

  it('warns when no tool directory exists at all, instead of reporting a green no-op', async () => {
    await pull({ force: true });

    const warnings = loggedLines(vi.mocked(log.warn));
    expect(warnings.some((l) => l.includes('No AI tool directories'))).toBe(true);
    expect(warnings.some((l) => l.includes('teamai init --agent'))).toBe(true);
  });

  it('does not create the tool directory for an explicitly enabled agent — it reports the skip', async () => {
    vi.mocked(loadLocalConfigForScope).mockResolvedValue({
      ...localConfig,
      enabledAgents: ['kimi'],
    });

    await pull({ force: true });

    // Pull only writes into tool roots that already exist; seeding belongs to
    // init, clone-time bootstrap and the tool's own SessionStart (#45). The
    // missing root is named as a skipped target instead of being created.
    expect(await fse.pathExists(path.join(homeDir, '.kimi-code'))).toBe(false);

    const lines = [...loggedLines(vi.mocked(log.info)), ...loggedLines(vi.mocked(log.warn))];
    expect(lines.some((l) => l.includes('kimi') && l.includes('skipped'))).toBe(true);
  });
});
