import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';

const CLI = path.resolve('dist/index.js');

describe('Kimi agent permissions (built CLI)', () => {
  it.each(['git', 'gitlab', 'github', 'gitea'])('installs and refreshes agents with %s configuration', (provider) => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-kimi-agents-'));
    const home = path.join(sandbox, 'home');
    const seed = path.join(sandbox, 'seed');
    const remote = path.join(sandbox, 'remote.git');
    const clone = path.join(home, '.teamai/team-repo');
    const env = { ...process.env, HOME: home, USERPROFILE: home, KIMI_CODE_HOME: path.join(home, '.kimi-code'),
      FORCE_COLOR: '0', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
    const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
    const cli = (...args: string[]) => {
      const result = spawnSync(process.execPath, [CLI, ...args], { cwd: home, env, encoding: 'utf8', input: '', timeout: 30000 });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      return result.stdout + result.stderr;
    };
    const tools = ['Bash', 'Read', 'Grep', 'Glob'];
    try {
      fs.mkdirSync(home, { recursive: true });
      write(path.join(seed, 'teamai.yaml'), JSON.stringify({ team: 'kimi-fixture', repo: remote, provider, usageReport: false,
        sharing: { recall: { enabled: true }, env: { injectShellProfile: false } },
        toolPaths: { opencode: { agents: '.opencode/agents' } } }));
      write(path.join(seed, 'agents/reviewer.yaml'), JSON.stringify({ name: 'reviewer', description: 'Review code',
        instructions: 'Review the code.', tools }));
      git(seed, 'init', '-b', 'main');
      git(seed, 'add', '.');
      git(seed, 'commit', '-m', 'fixture');
      git(sandbox, 'clone', '--bare', seed, remote);
      fs.mkdirSync(path.dirname(clone), { recursive: true });
      git(sandbox, 'clone', '-b', 'main', remote, clone);
      write(path.join(home, '.teamai/config.yaml'), JSON.stringify({ repo: { localPath: clone, remote },
        username: 'tester', updatePolicy: 'skip', scope: 'user', enabledAgents: ['kimi', 'claude', 'codex', 'codebuddy', 'opencode'] }));
      for (const tool of ['.kimi-code', '.claude', '.codex', '.codebuddy', '.config/opencode']) {
        fs.mkdirSync(path.join(home, tool), { recursive: true });
      }
      cli('pull', '--force');
      const kimiFiles = ['reviewer', 'teamai-recall'].map(name => path.join(home, '.kimi-code/agents', `${name}.md`));
      const installed = kimiFiles.map(file => fs.readFileSync(file, 'utf8'));
      for (const content of installed) expect(matter(content).data.tools).toEqual(tools);
      for (const file of ['.claude/agents/reviewer.md', '.codebuddy/agents/reviewer.md', '.codex/agents/reviewer.toml', '.config/opencode/agents/reviewer.md']) {
        expect(fs.readFileSync(path.join(home, file), 'utf8')).toContain('Review the code.');
      }
      for (const file of kimiFiles) {
        write(file, fs.readFileSync(file, 'utf8').replace('  - Bash', '  - kimi_cli.tools.shell:Shell')
          .replace('  - Read', '  - kimi_cli.tools.file:ReadFile')
          .replace('  - Grep', '  - kimi_cli.tools.file:Grep').replace('  - Glob', '  - kimi_cli.tools.file:Glob'));
      }
      cli('pull', '--force');
      expect(kimiFiles.map(file => fs.readFileSync(file, 'utf8'))).toEqual(installed);
      cli('pull', '--force');
      expect(kimiFiles.map(file => fs.readFileSync(file, 'utf8'))).toEqual(installed);
      // Reverse-sync an actual local edit through the built CLI, with only the
      // generic Git provider so this fixture never opens an external PR.
      if (provider === 'git') {
        write(kimiFiles[0], installed[0].replace('Review the code.', 'Review the changed code.'));
        const push = spawnSync(process.execPath, [CLI, 'push', '--all'], { cwd: home, env, encoding: 'utf8', input: '', timeout: 30000 });
        // A local bare remote accepts the branch but cannot host a pull request.
        expect(push.status, push.stdout + push.stderr).toBe(1);
        expect(push.stdout + push.stderr).toContain('has been pushed');
        expect(push.stdout + push.stderr).toContain('Invalid Git repo URL');
        const branches = git(remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/teamai/push/').split('\n').filter(Boolean);
        expect(branches).toHaveLength(1);
        const pushed = git(remote, 'show', `${branches[0]}:agents/reviewer.yaml`);
        expect(pushed).toContain('Review the changed code.');
        expect(pushed).not.toContain('kimi_cli');
      }
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  }, 120000);
});
