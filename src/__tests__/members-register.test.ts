import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import YAML from 'yaml';

vi.mock('../config.js', () => ({
  requireInit: vi.fn(),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
}));

vi.mock('../utils/git.js', () => ({
  pullRepo: vi.fn().mockResolvedValue('Already up to date.'),
  getGitIdentity: vi.fn().mockResolvedValue({ name: 'Alice', email: 'alice@example.com' }),
}));

vi.mock('../utils/reports-branch.js', () => ({
  ensureReportsWorktree: vi.fn(),
  refreshReportsWorktree: vi.fn().mockResolvedValue(undefined),
  commitAndPushReports: vi.fn().mockResolvedValue(true),
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
  })),
}));

import { registerMember } from '../members.js';
import { requireInit } from '../config.js';
import { getGitIdentity } from '../utils/git.js';
import { ensureReportsWorktree, commitAndPushReports } from '../utils/reports-branch.js';
import { log } from '../utils/logger.js';

function loggedLines(fn: { mock: { calls: unknown[][] } }): string[] {
  return fn.mock.calls.map((c) => String(c[0]));
}

function mockInit(repoPath: string, kind?: 'self' | 'http') {
  vi.mocked(requireInit).mockResolvedValue({
    localConfig: {
      repo: {
        localPath: repoPath,
        remote: 'https://git.example.com/team/repo.git',
        ...(kind ? { kind } : {}),
      },
      username: 'alice',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'user',
    },
    teamConfig: {
      team: 'test',
      description: '',
      repo: 'https://git.example.com/team/repo.git',
      provider: 'git' as const,
      reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
      toolPaths: {},
    },
  } as Awaited<ReturnType<typeof requireInit>>);
}

describe('registerMember', () => {
  let tmpDir: string;
  let repoPath: string;
  let worktree: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-register-'));
    repoPath = path.join(tmpDir, 'team-repo');
    worktree = path.join(tmpDir, 'reports-wt');
    await fse.ensureDir(repoPath);
    await fse.ensureDir(worktree);
    mockInit(repoPath);
    // Per-test defaults: mockResolvedValue survives clearAllMocks, so a test
    // that overrides one of these must not leak into the next.
    vi.mocked(getGitIdentity).mockResolvedValue({ name: 'Alice', email: 'alice@example.com' });
    vi.mocked(ensureReportsWorktree).mockResolvedValue(worktree);
    vi.mocked(commitAndPushReports).mockResolvedValue(true);
    process.exitCode = undefined;
  });

  afterEach(async () => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    await fse.remove(tmpDir);
  });

  it('writes the member file on the reports branch and pushes it when not registered yet', async () => {
    await registerMember();

    const memberPath = path.join(worktree, 'members', 'alice.yaml');
    expect(await fse.pathExists(memberPath)).toBe(true);
    expect(await fse.pathExists(path.join(repoPath, 'members', 'alice.yaml'))).toBe(false);
    const member = YAML.parse(await fse.readFile(memberPath, 'utf-8'));
    expect(member.username).toBe('alice');
    expect(member.registeredAt).toBeTruthy();

    expect(commitAndPushReports).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('alice'),
      ['members/'],
    );
    expect(loggedLines(vi.mocked(log.success)).some((l) => l.includes('alice'))).toBe(true);
    expect(process.exitCode).toBeFalsy();
  });

  it('is idempotent: a second run keeps one member file and succeeds with nothing new to push', async () => {
    await registerMember();
    vi.mocked(commitAndPushReports).mockResolvedValue(false);
    await registerMember();

    const files = await fse.readdir(path.join(worktree, 'members'));
    expect(files.filter((f) => f.endsWith('.yaml'))).toEqual(['alice.yaml']);
    expect(commitAndPushReports).toHaveBeenCalledTimes(2);
    expect(process.exitCode).toBeFalsy();
  });

  it('refuses to push and explains how to fix a missing git identity', async () => {
    vi.mocked(getGitIdentity).mockResolvedValue({ name: 'Alice', email: null });

    await registerMember();

    const errors = loggedLines(vi.mocked(log.error));
    const hints = [...errors, ...loggedLines(vi.mocked(log.info))];
    expect(errors.some((l) => l.includes('Git identity'))).toBe(true);
    expect(hints.some((l) => l.includes('git config --global user.email'))).toBe(true);
    expect(hints.some((l) => l.includes('teamai members register'))).toBe(true);
    expect(commitAndPushReports).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('surfaces the push failure reason and stays retryable', async () => {
    vi.mocked(commitAndPushReports).mockRejectedValue(new Error('Author identity unknown'));

    await registerMember();

    const errors = loggedLines(vi.mocked(log.error));
    expect(errors.some((l) => l.includes('Author identity unknown'))).toBe(true);
    expect(
      [...errors, ...loggedLines(vi.mocked(log.info))].some((l) => l.includes('teamai members register')),
    ).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it('fails a first registration whose push did not land', async () => {
    vi.mocked(commitAndPushReports).mockResolvedValue(false);

    await registerMember();

    expect(loggedLines(vi.mocked(log.error)).some((l) => l.includes('could not be pushed'))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it('refuses a read-only HTTP team repo', async () => {
    mockInit(repoPath, 'http');

    await registerMember();

    expect(ensureReportsWorktree).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
