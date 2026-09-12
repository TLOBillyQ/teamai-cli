import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';

// ── Mocks ────────────────────────────────────────────────

// Identity preflight before member registration; configured by default.
const configuredIdentity = async (key: string) => ({
  value: key === 'user.email' ? 'testuser@example.com' : 'testuser',
});

const mockGit = {
  init: vi.fn(),
  addRemote: vi.fn(),
  addConfig: vi.fn(),
  add: vi.fn(),
  status: vi.fn().mockResolvedValue({ staged: [] }),
  commit: vi.fn(),
  push: vi.fn(),
  pull: vi.fn().mockResolvedValue({
    summary: { changes: 0, insertions: 0, deletions: 0 },
  }),
  revparse: vi.fn().mockResolvedValue('main'),
  getConfig: vi.fn(configuredIdentity),
  // `git remote get-url` — no origin by default, so getRemoteUrl() returns null.
  raw: vi.fn().mockRejectedValue(new Error('no such remote')),
};

vi.mock('simple-git', () => ({
  default: () => mockGit,
}));

vi.mock('yaml', () => ({
  default: {
    stringify: (obj: unknown) => JSON.stringify(obj),
    parse: (str: string) => JSON.parse(str),
  },
}));

vi.mock('fs-extra', () => ({
  default: {
    ensureDir: vi.fn(),
    pathExists: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    readdir: vi.fn().mockResolvedValue([]),
  },
}));

// One shared spinner so tests can assert what init reported (e.g. "Using Git identity").
const mockSpinner = vi.hoisted(() => {
  const s: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const m of ['start', 'succeed', 'fail', 'info', 'warn']) s[m] = vi.fn(() => s);
  return s;
});

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
  spinner: () => mockSpinner,
}));

const mockGfRepoClone = vi.fn();
const mockGfCreateRepo = vi.fn();
const mockGfIsAuthenticated = vi.fn().mockReturnValue(true);
const mockGfAuthWhoami = vi.fn().mockReturnValue('testuser');
const mockEnsureGfInstalled = vi.fn();

// ── CNB provider mocks ───────────────────────────────────
const mockCnbRepoClone = vi.fn();
const mockCnbCreateRepo = vi.fn();
const mockCnbOrganizationExists = vi.fn();
const mockEnsureCnbInstalled = vi.fn();

// The anonymous self-hosted GitLab probe would otherwise hit `fetch` for every
// unknown host; these tests assert on the provider API calls only.
vi.mock('../providers/gitlab/probe.js', () => ({
  probeSelfHostedGitLab: vi.fn().mockResolvedValue(null),
}));

// Mock the provider-level gf-cli module (init.ts now uses providers)
vi.mock('../providers/tgit/gf-cli.js', () => {
  class RepoNotFoundError extends Error {
    constructor(repo: string) {
      super(`Repo "${repo}" not found on TGit.`);
      this.name = 'RepoNotFoundError';
    }
  }
  return {
    gfRepoClone: (...args: unknown[]) => mockGfRepoClone(...args),
    gfCreateRepo: (...args: unknown[]) => mockGfCreateRepo(...args),
    gfIsAuthenticated: () => mockGfIsAuthenticated(),
    gfAuthWhoami: () => mockGfAuthWhoami(),
    gfGetOAuthToken: vi.fn().mockReturnValue('mock-oauth-token'),
    ensureGfInstalled: () => mockEnsureGfInstalled(),
    ensureAuthenticated: vi.fn().mockReturnValue('testuser'),
    isGfInstalled: vi.fn().mockReturnValue(true),
    RepoNotFoundError,
  };
});

vi.mock('../providers/cnb/cnb-cli.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    cnbRepoClone: (...args: unknown[]) => mockCnbRepoClone(...args),
    cnbCreateRepo: (...args: unknown[]) => mockCnbCreateRepo(...args),
    cnbOrganizationExists: (...args: unknown[]) => mockCnbOrganizationExists(...args),
    cnbOrganizationCreateUrl: () => 'https://cnb.cool/new/groups',
    cnbIsAuthenticated: () => true,
    cnbWhoami: () => 'testuser',
    ensureCnbAuthenticated: () => 'testuser',
    ensureCnbInstalled: () => mockEnsureCnbInstalled(),
  };
});

vi.mock('../config.js', () => ({
  saveLocalConfig: vi.fn(),
  saveLocalConfigForScope: vi.fn(),
  loadLocalConfigForScope: vi.fn().mockResolvedValue(null),
  loadTeamConfig: vi.fn().mockResolvedValue(null),
  loadStateForScope: vi.fn().mockRejectedValue(new Error('no state')),
  saveStateForScope: vi.fn(),
  resolveProjectDataHome: vi.fn(async (projectRoot: string) => `${projectRoot}/.teamai`),
}));

vi.mock('../hooks.js', () => ({
  injectHooksToAllTools: vi.fn(),
  reconcileTeamHooksForConfig: vi.fn(),
}));

const mockDeployBuiltinSkills = vi.fn().mockResolvedValue(0);
vi.mock('../builtin-skills.js', () => ({
  deployBuiltinSkills: (...args: unknown[]) => mockDeployBuiltinSkills(...args),
}));

vi.mock('../roles.js', () => ({
  loadRolesManifest: vi.fn().mockResolvedValue({
    version: 1,
    roles: [
      {
        id: 'hai',
        name: 'HAI R&D',
        description: 'HyperAI research and development resources',
        resources: {
          knowledge: ['common', 'hai'],
          skills: ['common', 'hai'],
          learnings: ['common', 'hai'],
        },
      },
      {
        id: 'pm',
        name: 'Product Manager',
        description: 'Product planning and collaboration resources',
        resources: {
          knowledge: ['common', 'pm'],
          skills: ['common', 'pm'],
          learnings: ['common', 'pm'],
        },
      },
      {
        id: 'thpc',
        name: 'THPC R&D',
        description: 'THPC project resources',
        resources: {
          knowledge: ['common', 'thpc'],
          skills: ['common', 'thpc'],
          learnings: ['common', 'thpc'],
        },
      },
    ],
    defaults: { shareTarget: 'primary-role' },
  }),
  describeRoles: vi.fn((roles: Array<{ id: string; name: string; description?: string }>) =>
    roles.map((role) => role.description ? `${role.id} - ${role.name}: ${role.description}` : `${role.id} - ${role.name}`),
  ),
}));

// Track pathExists calls to simulate directory states
let pathExistsFn: (p: string) => boolean = () => false;

const mockRemove = vi.fn();

vi.mock('../utils/fs.js', () => ({
  ensureDir: vi.fn(),
  writeFile: vi.fn(),
  pathExists: vi.fn(async (p: string) => pathExistsFn(p)),
  expandHome: (p: string) => {
    if (p.startsWith('~/') || p === '~') {
      return (process.env.HOME ?? '') + p.slice(1);
    }
    return p;
  },
  readFileSafe: vi.fn().mockResolvedValue(null),
  remove: (p: string) => mockRemove(p),
}));

// Member registration lands on the teamai-reports worktree beside the clone.
vi.mock('../utils/reports-branch.js', () => ({
  updateReports: vi.fn(async (
    cfg: { repo: { localPath: string } },
    update: (worktree: string) => Promise<unknown>,
  ) => {
    await update(`${cfg.repo.localPath}-reports`);
    return true;
  }),
}));

vi.mock('../types.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    // The machine home is now a runtime getter (issue #374 P3), so override the
    // getter instead of the removed TEAMAI_HOME const to isolate onto /tmp.
    getTeamaiHomeDir: () => '/tmp/test-teamai-home',
  };
});

// Mock prompt to auto-answer prompts
let questionAnswers: string[] = [];
vi.mock('../utils/prompt.js', () => ({
  askQuestion: vi.fn((_prompt: string, defaultValue?: string) => {
    const answer = questionAnswers.shift();
    return Promise.resolve(answer ?? defaultValue ?? '');
  }),
  askConfirmation: vi.fn((_prompt: string, defaultValue?: boolean) => {
    const answer = questionAnswers.shift();
    if (answer !== undefined) {
      return Promise.resolve(answer.toLowerCase() === 'y');
    }
    return Promise.resolve(defaultValue ?? false);
  }),
  closePrompt: vi.fn(),
}));

// Prevent process.exit from actually exiting
const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

import { init } from '../init.js';
import { RepoNotFoundError, OrganizationNotFoundError, RepoCreatePermissionError } from '../providers/types.js';
import { CnbRepoNotFoundError } from '../providers/cnb/cnb-cli.js';
import { saveLocalConfig } from '../config.js';
import fse from 'fs-extra';

describe('init', () => {
  const HOME = process.env.HOME ?? '';
  const localPath = `${HOME}/.teamai/team-repo`;

  beforeEach(() => {
    vi.clearAllMocks();
    questionAnswers = [];
    pathExistsFn = () => false;
  });

  afterEach(() => {
    mockExit.mockClear();
  });

  it('rejects user-scope inheritance before provider or repository side effects', async () => {
    await init({
      repo: 'https://git.woa.com/HyperAI/teamai-test.git',
      scope: 'user',
      inheritUserScope: true,
    });

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockEnsureGfInstalled).not.toHaveBeenCalled();
    expect(mockGfRepoClone).not.toHaveBeenCalled();
  });

  describe('empty repo fallback', () => {
    it('should call initRepo when clone succeeds but directory does not exist', async () => {
      let pathExistsCallCount = 0;
      pathExistsFn = (p: string) => {
        if (p === localPath) {
          pathExistsCallCount++;
          return pathExistsCallCount > 3;
        }
        return false;
      };

      mockGfRepoClone.mockImplementation(() => {});

      questionAnswers = ['n'];

      await init({ repo: 'https://git.woa.com/HyperAI/teamai-test.git', scope: 'user' });

      expect(mockGfRepoClone).toHaveBeenCalledWith('HyperAI/teamai-test', localPath);
      expect(mockGit.init).toHaveBeenCalled();
      expect(mockGit.addRemote).toHaveBeenCalledWith(
        'origin',
        'https://git.woa.com/HyperAI/teamai-test.git',
      );
    });

    it('should not call initRepo when clone successfully creates the directory', async () => {
      let cloneDone = false;
      pathExistsFn = (p: string) => {
        if (p === localPath) return cloneDone;
        return false;
      };

      mockGfRepoClone.mockImplementation(() => {
        cloneDone = true;
      });

      questionAnswers = ['n'];

      await init({ repo: 'https://git.woa.com/HyperAI/existing-repo.git', scope: 'user' });

      expect(mockGfRepoClone).toHaveBeenCalled();
      expect(mockGit.init).not.toHaveBeenCalled();
      expect(mockGit.addRemote).not.toHaveBeenCalled();
    });
  });

  describe('stale non-git directory', () => {
    it('should remove and re-clone when team-repo exists but is not a git repo', async () => {
      // team-repo dir exists on disk...
      let removed = false;
      pathExistsFn = (p: string) => {
        if (p === localPath) return !removed; // exists until we remove it, then clone recreates handled below
        return false;
      };
      mockRemove.mockImplementation((p: string) => {
        if (p === localPath) removed = true;
      });
      // ...but it has no .git entry → isGitRepo() returns false.
      // isGitRepo calls fse.pathExists twice: dir exists (true), .git missing (false).
      (fse.pathExists as any)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      mockGfRepoClone.mockImplementation(() => {
        removed = false; // clone recreates the directory
      });

      // Answers: configure reviewers (n), primary role (1), no additional roles
      questionAnswers = ['n', '1', ''];

      await init({ repo: 'https://git.woa.com/HyperAI/teamai-test.git', scope: 'user' });

      // Stale dir removed, then a real clone performed.
      expect(mockRemove).toHaveBeenCalledWith(localPath);
      expect(mockGfRepoClone).toHaveBeenCalledWith('HyperAI/teamai-test', localPath);
      expect(mockExit).not.toHaveBeenCalled();
    });

    it('should reuse the existing clone when team-repo is a valid git repo', async () => {
      pathExistsFn = (p: string) => p === localPath; // dir exists
      // isGitRepo: dir exists (true), .git present (true)
      (fse.pathExists as any)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);

      questionAnswers = ['n'];

      await init({ repo: 'https://git.woa.com/HyperAI/teamai-test.git', scope: 'user' });

      // Valid clone → no removal, no re-clone.
      expect(mockRemove).not.toHaveBeenCalled();
      expect(mockGfRepoClone).not.toHaveBeenCalled();
    });
  });

  describe('repo not found — auto create', () => {
    it('should create repo and retry clone when repo not found and user confirms', async () => {
      let cloneCallCount = 0;
      mockGfRepoClone.mockImplementation(() => {
        cloneCallCount++;
        if (cloneCallCount === 1) {
          throw new RepoNotFoundError('HyperAI/new-repo');
        }
        // Second call (after creation) succeeds
      });

      let cloneDone = false;
      pathExistsFn = (p: string) => {
        if (p === localPath) return cloneDone;
        return false;
      };

      // gfCreateRepo succeeds, then second clone creates the dir
      mockGfCreateRepo.mockImplementation(async () => {
        cloneDone = true;
      });

      // Answers: create repo confirm (Y), configure reviewers (n), primary role (1)
      questionAnswers = ['Y', 'n', '1'];

      await init({ repo: 'https://git.woa.com/HyperAI/new-repo.git', scope: 'user' });

      expect(mockGfCreateRepo).toHaveBeenCalledWith('HyperAI', 'new-repo');
      expect(mockGfRepoClone).toHaveBeenCalledTimes(2);
      expect(mockExit).not.toHaveBeenCalled();
    });

    it('should exit when user declines repo creation', async () => {
      mockGfRepoClone.mockImplementation(() => {
        throw new RepoNotFoundError('HyperAI/new-repo');
      });

      pathExistsFn = () => false;

      // Answers: decline creation (n)
      questionAnswers = ['n'];

      await init({ repo: 'https://git.woa.com/HyperAI/new-repo.git', scope: 'user' });

      // process.exit(1) should be called when user declines
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it('should exit when repo creation fails', async () => {
      mockGfRepoClone.mockImplementation(() => {
        throw new RepoNotFoundError('HyperAI/new-repo');
      });

      mockGfCreateRepo.mockRejectedValue(new Error('403 Forbidden'));

      pathExistsFn = () => false;

      // Answers: confirm creation (Y)
      questionAnswers = ['Y'];

      await init({ repo: 'https://git.woa.com/HyperAI/new-repo.git', scope: 'user' });

      expect(mockGfCreateRepo).toHaveBeenCalledWith('HyperAI', 'new-repo');
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe('organization not found — guide to web UI (CNB)', () => {
    /** Collect all log.info lines emitted during a run. */
    const infoLines = async (): Promise<string[]> => {
      const { log } = await import('../utils/logger.js');
      return vi.mocked(log.info).mock.calls.map((c) => String(c[0]));
    };

    it('detects the missing org before prompting to create the repo, prints the URL, and never calls createRepo', async () => {
      mockExit.mockImplementationOnce(() => {
        throw new Error('EXIT');
      });
      mockCnbRepoClone.mockImplementation(() => {
        throw new CnbRepoNotFoundError('my-org/new-repo');
      });
      mockCnbOrganizationExists.mockReturnValue(false); // org missing
      pathExistsFn = () => false;

      await expect(
        init({ repo: 'https://cnb.cool/my-org/new-repo.git', scope: 'user' }),
      ).rejects.toThrow('EXIT');

      // Org checked up front; repo creation never attempted; URL surfaced.
      expect(mockCnbOrganizationExists).toHaveBeenCalledWith('my-org');
      expect(mockCnbCreateRepo).not.toHaveBeenCalled();
      expect(mockExit).toHaveBeenCalledWith(1);
      expect((await infoLines()).some((l) => l.includes('https://cnb.cool/new/groups'))).toBe(true);
    });

    it('proceeds to create the repo when the org exists', async () => {
      let cloneCallCount = 0;
      let cloneDone = false;
      mockCnbRepoClone.mockImplementation(() => {
        cloneCallCount++;
        if (cloneCallCount === 1) {
          throw new CnbRepoNotFoundError('my-org/new-repo');
        }
        cloneDone = true;
      });
      mockCnbOrganizationExists.mockReturnValue(true); // org exists
      mockCnbCreateRepo.mockResolvedValue(undefined);
      pathExistsFn = (p: string) => (p === localPath ? cloneDone : false);

      // Answers: confirm repo creation (Y), skip reviewers (n), primary role (1).
      questionAnswers = ['Y', 'n', '1'];

      await init({ repo: 'https://cnb.cool/my-org/new-repo.git', scope: 'user' });

      expect(mockCnbOrganizationExists).toHaveBeenCalledWith('my-org');
      expect(mockCnbCreateRepo).toHaveBeenCalledWith('my-org', 'new-repo');
      expect(mockExit).not.toHaveBeenCalled();
    });

    it('prints the repo create URL and exits when the org exists but the token cannot create the repo (403)', async () => {
      mockExit.mockImplementationOnce(() => {
        throw new Error('EXIT');
      });
      mockCnbRepoClone.mockImplementation(() => {
        throw new CnbRepoNotFoundError('my-org/new-repo');
      });
      mockCnbOrganizationExists.mockReturnValue(true); // org exists
      mockCnbCreateRepo.mockRejectedValue(
        new RepoCreatePermissionError('my-org/new-repo', 'https://cnb.cool/new/repos'),
      );
      pathExistsFn = () => false;

      // Answer: confirm repo creation (Y). No browser prompt any more.
      questionAnswers = ['Y'];

      await expect(
        init({ repo: 'https://cnb.cool/my-org/new-repo.git', scope: 'user' }),
      ).rejects.toThrow('EXIT');

      expect(mockCnbCreateRepo).toHaveBeenCalledWith('my-org', 'new-repo');
      expect(mockExit).toHaveBeenCalledWith(1);
      expect((await infoLines()).some((l) => l.includes('https://cnb.cool/new/repos'))).toBe(true);
    });
  });

  describe('clone error handling', () => {
    it('should exit when clone fails with a non-NotFound error', async () => {
      pathExistsFn = () => false;

      mockGfRepoClone.mockImplementation(() => {
        throw new Error('gf repo clone failed: network error');
      });

      questionAnswers = [];

      await init({ repo: 'https://git.woa.com/HyperAI/broken-repo.git', scope: 'user' });

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockGfCreateRepo).not.toHaveBeenCalled();
    });
  });

  describe('role persistence', () => {
    it('writes primaryRole and resourceProfileVersion when role is selected', async () => {
      let cloneDone = false;
      pathExistsFn = (p: string) => {
        if (p === localPath) return cloneDone;
        if (p === path.join(localPath, 'members', 'testuser.yaml')) return false;
        return false;
      };

      mockGfRepoClone.mockImplementation(() => {
        cloneDone = true;
      });

      const mockedLoadTeamConfig = vi.mocked(await import('../config.js')).loadTeamConfig;
      mockedLoadTeamConfig
        .mockResolvedValueOnce({
          team: 'my-team',
          repo: 'https://git.woa.com/HyperAI/teamai-test.git',
          provider: 'tgit',
          reviewers: [],
          sharing: {
            skills: {},
            rules: { enforced: [] },
            docs: { localDir: '~/.teamai/docs' },
            env: { injectShellProfile: true },
          },
          toolPaths: {},
        } as never)
        .mockResolvedValueOnce({
          team: 'my-team',
          repo: 'https://git.woa.com/HyperAI/teamai-test.git',
          provider: 'tgit',
          reviewers: [],
          sharing: {
            skills: {},
            rules: { enforced: [] },
            docs: { localDir: '~/.teamai/docs' },
            env: { injectShellProfile: true },
          },
          toolPaths: {},
        } as never);

      questionAnswers = ['n', '1'];

      await init({ repo: 'https://git.woa.com/HyperAI/teamai-test.git', scope: 'user' });

      expect(saveLocalConfig).toHaveBeenCalledWith(expect.objectContaining({
        primaryRole: 'hai',
        additionalRoles: [],
        resourceProfileVersion: 1,
      }));
    });
  });

  describe('provider declared by the team repo', () => {
    const GITEA_REPO = 'http://gitea.example.test:3000/agent/team.git';
    const originalEnv = { ...process.env };

    function teamConfigDeclaring(provider: string) {
      return {
        team: 'my-team',
        repo: GITEA_REPO,
        provider,
        reviewers: [],
        sharing: {
          skills: {},
          rules: { enforced: [] },
          docs: { localDir: '~/.teamai/docs' },
          env: { injectShellProfile: true },
        },
        toolPaths: {},
      } as never;
    }

    /** Simulate an existing clone of the team repo so no real `git clone` runs. */
    function reuseExistingClone(): void {
      pathExistsFn = (p: string) => p === localPath;
      (fse.pathExists as any).mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    }

    beforeEach(() => {
      delete process.env.GITEA_URL;
      delete process.env.TEAMAI_GITEA_HOST;
      delete process.env.GITEA_ACCESS_TOKEN;
      delete process.env.GITEA_PAT;
    });

    afterEach(async () => {
      process.env = { ...originalEnv };
      vi.unstubAllGlobals();
      // clearAllMocks keeps implementations; restore the file-level default.
      vi.mocked((await import('../config.js')).loadTeamConfig).mockResolvedValue(null);
    });

    it('registers the Gitea login, not the git identity, when teamai.yaml declares gitea', async () => {
      process.env.GITEA_TOKEN = 'gta_secret';
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ login: 'qinyuanj' }),
      });
      vi.stubGlobal('fetch', fetchMock);
      reuseExistingClone();
      const { loadTeamConfig } = vi.mocked(await import('../config.js'));
      loadTeamConfig.mockResolvedValue(teamConfigDeclaring('gitea'));
      const { writeFile } = vi.mocked(await import('../utils/fs.js'));
      // --force skips the reviewer prompt; answer the primary-role picker.
      questionAnswers = ['1'];

      await init({ repo: GITEA_REPO, scope: 'user', force: true });

      expect(mockExit).not.toHaveBeenCalled();
      expect(fetchMock.mock.calls[0][0]).toBe('http://gitea.example.test:3000/api/v1/user');
      expect(writeFile).toHaveBeenCalledWith(
        path.join(`${localPath}-reports`, 'members', 'qinyuanj.yaml'),
        expect.any(String),
      );
      expect(saveLocalConfig).toHaveBeenCalledWith(
        expect.objectContaining({ username: 'qinyuanj' }),
      );
    });

    it('exits non-zero naming GITEA_TOKEN, writing no member file or local config, when no token is set', async () => {
      delete process.env.GITEA_TOKEN;
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      reuseExistingClone();
      const { loadTeamConfig } = vi.mocked(await import('../config.js'));
      loadTeamConfig.mockResolvedValue(teamConfigDeclaring('gitea'));
      const { writeFile } = vi.mocked(await import('../utils/fs.js'));
      const { log } = await import('../utils/logger.js');

      await init({ repo: GITEA_REPO, scope: 'user', force: true });

      expect(mockExit).toHaveBeenCalledWith(1);
      const errors = vi.mocked(log.error).mock.calls.map((c) => String(c[0])).join('\n');
      expect(errors).toMatch(/GITEA_TOKEN/);
      const memberWrites = writeFile.mock.calls.filter(([p]) => String(p).includes(`${path.sep}members${path.sep}`));
      expect(memberWrites).toEqual([]);
      expect(saveLocalConfig).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      ['declares provider: git', () => teamConfigDeclaring('git')],
      ['has no teamai.yaml yet', () => null],
    ])('keeps the git identity when the team repo %s', async (_label, config) => {
      process.env.GITEA_TOKEN = 'gta_secret';
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      reuseExistingClone();
      const { loadTeamConfig } = vi.mocked(await import('../config.js'));
      loadTeamConfig.mockResolvedValue(config());
      questionAnswers = ['1'];

      await init({ repo: GITEA_REPO, scope: 'user', force: true });

      expect(mockExit).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockSpinner.succeed).toHaveBeenCalledWith(expect.stringMatching(/^Using Git identity \S+/));
    });
  });

  describe('provider declared by a single-repo .teamai/teamai.yaml (teamai init .)', () => {
    const REMOTE = 'http://gitea.example.test:3000/agent/app.git';
    const cwd = process.cwd();
    const originalEnv = { ...process.env };

    beforeEach(async () => {
      delete process.env.GITEA_URL;
      delete process.env.TEAMAI_GITEA_HOST;
      delete process.env.GITEA_ACCESS_TOKEN;
      delete process.env.GITEA_PAT;
      mockGit.raw.mockResolvedValue(`${REMOTE}\n`);
      // cwd is a git repo whose .teamai/teamai.yaml already exists (a teammate's clone).
      pathExistsFn = (p: string) =>
        p === path.join(cwd, '.git') || p === path.join(cwd, '.teamai', 'teamai.yaml');
      vi.mocked((await import('../config.js')).loadTeamConfig).mockResolvedValue({
        team: 'app',
        mode: 'self',
        repo: REMOTE,
        provider: 'gitea',
        reviewers: [],
        sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: './.teamai/docs' }, env: { injectShellProfile: true } },
        toolPaths: {},
      } as never);
    });

    afterEach(async () => {
      process.env = { ...originalEnv };
      vi.unstubAllGlobals();
      mockGit.raw.mockRejectedValue(new Error('no such remote'));
      vi.mocked((await import('../config.js')).loadTeamConfig).mockResolvedValue(null);
    });

    it('authenticates with the Gitea instance derived from origin and saves that login', async () => {
      process.env.GITEA_TOKEN = 'gta_secret';
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ login: 'qinyuanj' }),
      });
      vi.stubGlobal('fetch', fetchMock);
      const { saveLocalConfigForScope } = vi.mocked(await import('../config.js'));
      questionAnswers = ['1'];

      await init({ repoPositional: '.', force: true, dryRun: true });

      expect(fetchMock.mock.calls[0][0]).toBe('http://gitea.example.test:3000/api/v1/user');
      expect(saveLocalConfigForScope).toHaveBeenCalledWith(
        expect.objectContaining({ username: 'qinyuanj' }),
        'project',
        cwd,
      );
    });

    it('exits non-zero naming GITEA_TOKEN without saving a local config when no token is set', async () => {
      delete process.env.GITEA_TOKEN;
      vi.stubGlobal('fetch', vi.fn());
      const { saveLocalConfigForScope } = vi.mocked(await import('../config.js'));
      const { log } = await import('../utils/logger.js');

      await init({ repoPositional: '.', force: true, dryRun: true });

      expect(mockExit).toHaveBeenCalledWith(1);
      const errors = vi.mocked(log.error).mock.calls.map((c) => String(c[0])).join('\n');
      expect(errors).toMatch(/GITEA_TOKEN/);
      expect(saveLocalConfigForScope).not.toHaveBeenCalled();
    });
  });

  describe('deploys built-in skills after init', () => {
    it('calls deployBuiltinSkills with teamConfig and skipRecall when loadTeamConfig returns non-null', async () => {
      let cloneDone = false;
      pathExistsFn = (p: string) => {
        if (p === localPath) return cloneDone;
        return false;
      };

      mockGfRepoClone.mockImplementation(() => {
        cloneDone = true;
      });

      const mockedLoadTeamConfig = vi.mocked(await import('../config.js')).loadTeamConfig;
      mockedLoadTeamConfig.mockResolvedValue({
        team: 'my-team',
        repo: 'https://git.woa.com/HyperAI/teamai-test.git',
        provider: 'tgit',
        reviewers: [],
        sharing: {
          skills: {},
          rules: { enforced: [] },
          docs: { localDir: '~/.teamai/docs' },
          env: { injectShellProfile: true },
        },
        toolPaths: {},
      } as never);

      questionAnswers = ['n', '1'];

      await init({ repo: 'https://git.woa.com/HyperAI/teamai-test.git', scope: 'user' });

      expect(mockDeployBuiltinSkills).toHaveBeenCalled();
      expect(mockDeployBuiltinSkills).toHaveBeenCalledWith(
        expect.objectContaining({ team: expect.any(String) }),
        expect.anything(),
        expect.objectContaining({ skipRecall: expect.any(Boolean) }),
      );
    });
  });

  describe('member registration', () => {
    afterEach(() => {
      process.exitCode = undefined;
      // clearAllMocks keeps implementations; don't leak a missing identity.
      mockGit.getConfig.mockImplementation(configuredIdentity);
    });

    it('stops before registering when the git identity is missing, with the same fix as `members register`', async () => {
      let cloneDone = false;
      pathExistsFn = (p: string) => (p === localPath ? cloneDone : false);
      mockGfRepoClone.mockImplementation(() => {
        cloneDone = true;
      });
      const { loadTeamConfig } = await import('../config.js');
      vi.mocked(loadTeamConfig).mockResolvedValue({
        team: 'my-team',
        repo: 'https://git.woa.com/HyperAI/teamai-test.git',
        provider: 'tgit',
        reviewers: [],
        sharing: {
          skills: {},
          rules: { enforced: [] },
          docs: { localDir: '~/.teamai/docs' },
          env: { injectShellProfile: true },
        },
        toolPaths: {},
      } as never);
      // user.name is set per-repo by init, but no email anywhere: git would
      // refuse the registration commit with "Author identity unknown".
      mockGit.getConfig.mockImplementation(async (key: string) => ({
        value: key === 'user.email' ? null : 'testuser',
      }) as never);
      // Would configure reviewers if asked: that commit needs an author too.
      questionAnswers = ['y', 'alice'];

      await init({ repo: 'https://git.woa.com/HyperAI/teamai-test.git', scope: 'user', role: 'hai' });

      const { log } = await import('../utils/logger.js');
      const { writeFile } = await import('../utils/fs.js');
      const { askConfirmation } = await import('../utils/prompt.js');
      const prompts = vi.mocked(askConfirmation).mock.calls.map((c) => String(c[0]));
      expect(prompts.some((p) => p.includes('reviewers'))).toBe(false);
      const errors = vi.mocked(log.error).mock.calls.map((c) => String(c[0]));
      const hints = [...errors, ...vi.mocked(log.info).mock.calls.map((c) => String(c[0]))];

      expect(errors.some((l) => l.includes('Git identity is not configured'))).toBe(true);
      expect(hints.some((l) => l.includes('git config --global user.email'))).toBe(true);
      expect(hints.some((l) => l.includes('teamai members register'))).toBe(true);
      // Nothing half-registered: no member file written, no commit attempted.
      const memberWrites = vi.mocked(writeFile).mock.calls.filter((c) => String(c[0]).includes(`${path.sep}members${path.sep}`));
      expect(memberWrites).toEqual([]);
      expect(mockGit.commit).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(mockExit).not.toHaveBeenCalled();
    });
  });

  describe('scope path display', () => {
    it('persists explicit user-resource inheritance in project config', async () => {
      const projectLocalPath = path.join(process.cwd(), '.teamai', 'team-repo');
      let cloneDone = false;
      pathExistsFn = (p: string) => {
        if (p === projectLocalPath) return cloneDone;
        if (p.endsWith(`${path.sep}.git`) || p.endsWith('/.git')) return true;
        return false;
      };
      mockGfRepoClone.mockImplementation(() => { cloneDone = true; });
      questionAnswers = ['n', '1'];

      const { saveLocalConfigForScope } = await import('../config.js');
      await init({
        repo: 'https://git.woa.com/HyperAI/teamai-test.git',
        inheritUserScope: true,
      });

      expect(saveLocalConfigForScope).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: 'project',
          projectRoot: process.cwd(),
          inheritUserScope: true,
        }),
        'project',
        process.cwd(),
      );
    });

    it('should default to project scope and print summary when --scope is omitted', async () => {
      const projectLocalPath = path.join(process.cwd(), '.teamai', 'team-repo');
      let cloneDone = false;
      pathExistsFn = (p: string) => {
        if (p === projectLocalPath) return cloneDone;
        // Treat cwd as inside a git repo so E2 warn is skipped in this test
        if (p.endsWith(`${path.sep}.git`) || p.endsWith('/.git')) return true;
        return false;
      };

      mockGfRepoClone.mockImplementation(() => {
        cloneDone = true;
      });

      // Answers: configure reviewers (n), primary role (1) — no scope prompt
      questionAnswers = ['n', '1'];

      const { log } = await import('../utils/logger.js');
      const { saveLocalConfigForScope } = await import('../config.js');

      await init({ repo: 'https://git.woa.com/HyperAI/teamai-test.git' });

      expect(log.info).toHaveBeenCalledWith(expect.stringMatching(/^Scope: project /));
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('config    →'));
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('--scope user'));
      expect(saveLocalConfigForScope).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'project', projectRoot: process.cwd() }),
        'project',
        process.cwd(),
      );
    });

    it('should print scope summary without interactive Select scope when --scope is provided', async () => {
      let cloneDone = false;
      pathExistsFn = (p: string) => {
        if (p === localPath) return cloneDone;
        return false;
      };

      mockGfRepoClone.mockImplementation(() => {
        cloneDone = true;
      });

      // Answers: configure reviewers (n), primary role (1)
      questionAnswers = ['n', '1'];

      const { log } = await import('../utils/logger.js');
      vi.mocked(log.info).mockClear();

      await init({ repo: 'https://git.woa.com/HyperAI/teamai-test.git', scope: 'user' });

      expect(log.info).toHaveBeenCalledWith(expect.stringMatching(/^Scope: user$/));
      const infoCalls = vi.mocked(log.info).mock.calls.map(c => String(c[0]));
      expect(infoCalls.some((msg) => msg.includes('Select scope:'))).toBe(false);
      expect(infoCalls.some((msg) => msg.includes('Scope [1/2]'))).toBe(false);
    });

    it('should ignore remote teamai.yaml.scope and succeed with local project scope', async () => {
      const projectLocalPath = path.join(process.cwd(), '.teamai', 'team-repo');
      let cloneDone = false;
      pathExistsFn = (p: string) => {
        if (p === projectLocalPath) return cloneDone;
        if (p.endsWith(`${path.sep}.git`) || p.endsWith('/.git')) return true;
        return false;
      };

      mockGfRepoClone.mockImplementation(() => {
        cloneDone = true;
      });

      const { loadTeamConfig, saveLocalConfigForScope } = await import('../config.js');
      vi.mocked(loadTeamConfig).mockResolvedValue({
        team: 'remote-team',
        description: '',
        repo: 'https://git.woa.com/HyperAI/teamai-test.git',
        provider: 'tgit',
        scope: 'user',
        reviewers: [],
        sharing: { rules: { enforced: [] }, docs: {}, env: { injectShellProfile: true } },
        toolPaths: {},
      } as never);

      questionAnswers = ['n', '1'];

      await init({ repo: 'https://git.woa.com/HyperAI/teamai-test.git' });

      expect(mockExit).not.toHaveBeenCalled();
      expect(saveLocalConfigForScope).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'project' }),
        'project',
        process.cwd(),
      );
    });
  });

  describe('single-repo mode', () => {
    it('accepts an existing HTTP origin without persisting its credentials', async () => {
      pathExistsFn = (p: string) => p.endsWith(`${path.sep}.git`) || p.endsWith('/.git');
      mockGit.raw.mockResolvedValue(
        'http://user:token-must-not-appear@git.example.com/group/repo.git\n',
      );

      const { log } = await import('../utils/logger.js');
      const { loadTeamConfig, saveLocalConfigForScope } = await import('../config.js');
      vi.mocked(loadTeamConfig).mockResolvedValue({
        team: 'repo',
        description: '',
        repo: 'http://git.example.com/group/repo.git',
        provider: 'git',
        reviewers: [],
        sharing: { rules: { enforced: [] }, docs: {}, env: { injectShellProfile: true } },
        toolPaths: {},
      } as never);

      await init({ repo: '.', dryRun: true });

      const errorCalls = vi.mocked(log.error).mock.calls.map(([message]) => String(message));
      const debugCalls = vi.mocked(log.debug).mock.calls.map(([message]) => String(message));
      expect(mockExit).not.toHaveBeenCalled();
      expect(errorCalls).not.toContainEqual(expect.stringContaining('Could not parse the business repo remote'));
      expect(errorCalls.join('\n')).not.toContain('token-must-not-appear');
      expect(debugCalls.join('\n')).not.toContain('token-must-not-appear');
      expect(saveLocalConfigForScope).toHaveBeenCalledWith(
        expect.objectContaining({
          repo: expect.objectContaining({ remote: 'http://git.example.com/group/repo.git' }),
        }),
        'project',
        process.cwd(),
      );
    });
  });
});
