import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const CLI = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
const toolDirs = ['.claude', '.codex', '.codebuddy', '.config/opencode'];
let sandbox: string;
afterEach(() => { if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true }); });

describe('Git-renamed skill leftovers through the real CLI (#46)', () => {
  it.each(['git', 'gitlab', 'github', 'gitea'])('separates leftovers with provider %s across four agents', (provider) => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-leftovers-'));
    const home = path.join(sandbox, 'home');
    const remote = path.join(sandbox, 'remote');
    const repo = path.join(home, '.teamai/team-repo');
    const env = {
      ...process.env, HOME: home, FORCE_COLOR: '0',
      GIT_AUTHOR_NAME: 'Test', GIT_COMMITTER_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_EMAIL: 'test@example.com',
    };
    const write = (file: string, content: string) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    };
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' });
    const runCLI = (args: string[], expectedCode = 0) => {
      const result = spawnSync(process.execPath, [CLI, ...args], { cwd: sandbox, env, encoding: 'utf8', timeout: 30_000 });
      const output = result.stdout + result.stderr;
      expect(result.status, output).toBe(expectedCode);
      return output;
    };
    const cli = (...args: string[]) => runCLI(args);
    write(path.join(remote, 'teamai.yaml'), YAML.stringify({ team: 'leftovers', repo: remote, provider }));
    write(path.join(remote, 'skills/old-name/SKILL.md'), '---\nname: old-name\ndescription: Old skill\n---\n# Old\n');
    git(remote, 'init', '-q', '-b', 'main');
    git(remote, 'add', '.');
    git(remote, 'commit', '-qm', 'Initial skill');
    fs.mkdirSync(path.dirname(repo), { recursive: true });
    git(sandbox, 'clone', '-q', remote, repo);
    write(path.join(home, '.teamai/config.yaml'), YAML.stringify({
      repo: { localPath: repo, remote }, username: 'test', updatePolicy: 'auto', scope: 'user',
      enabledAgents: ['claude', 'codex', 'codebuddy', 'opencode'],
    }));
    // The separately installed teamai helper is outside this regression.
    write(path.join(home, '.teamai/pushignore'), 'teamai\n');
    for (const dir of toolDirs) fs.mkdirSync(path.join(home, dir), { recursive: true });
    cli('pull');
    for (const dir of toolDirs) expect(fs.existsSync(path.join(home, dir, 'skills/old-name/SKILL.md'))).toBe(true);
    git(remote, 'mv', 'skills/old-name', 'skills/new-name');
    write(path.join(remote, 'skills/new-name/SKILL.md'), '---\nname: new-name\ndescription: Renamed skill\n---\n# Renamed\n');
    git(remote, 'add', '.');
    git(remote, 'commit', '-qm', 'Rename without tombstone');

    const pulled = cli('pull');
    expect(pulled).toContain('Suspected skill leftovers');
    expect(pulled).toContain('old-name');
    expect(pulled).toContain('delete manually');
    for (const dir of toolDirs) {
      expect(fs.existsSync(path.join(home, dir, 'skills/old-name/SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(home, dir, 'skills/new-name/SKILL.md'))).toBe(true);
    }
    // Even a no-op pull must keep the warning visible.
    expect(cli('pull')).toContain('Suspected skill leftovers');
    const onlyLeftovers = cli('status', '--verbose');
    expect(onlyLeftovers).toContain('[skills] 1 suspected leftover');
    expect(onlyLeftovers).not.toMatch(/\[skills\] \d+ new/);
    const skipped = cli('push', '--all');
    expect(skipped).toContain('Skipped suspected skill leftover: old-name');
    expect(git(remote, 'branch', '--list', 'teamai/*')).toBe('');

    write(path.join(home, '.claude/skills/fresh/SKILL.md'), '---\nname: fresh\ndescription: Fresh skill\n---\n# Fresh\n');
    const status = cli('status', '--verbose');
    expect(status).toContain('[skills] 1 new');
    expect(status).toContain('[skills] 1 suspected leftover');
    const preview = cli('push', '--all', '--dry-run');
    expect(preview).toMatch(/\[skills\] fresh/);
    expect(preview).not.toMatch(/\[skills\] old-name/);
    // The existing explicit-path option is the intentional recovery route.
    const explicit = cli('push', '--skill', path.join(home, '.claude/skills/old-name'), '--dry-run');
    expect(explicit).toMatch(/\[skills\] old-name/);
    if (provider === 'git') {
      // Plain Git pushes the branch but exits 1 because no hosting service
      // can create a PR for this local filesystem remote.
      const pushed = runCLI(['push', '--all'], 1);
      const branch = /Branch (\S+) has been pushed/.exec(pushed)?.[1];
      expect(branch, pushed).toBeTruthy();
      const files = git(remote, 'ls-tree', '-r', '--name-only', branch!);
      expect(files).toContain('skills/fresh/SKILL.md');
      expect(files).not.toContain('skills/old-name/SKILL.md');
      // Branch names have second precision; use a distinct contributor so
      // back-to-back pushes cannot collide in a fast test run.
      const configPath = path.join(home, '.teamai/config.yaml');
      const config = YAML.parse(fs.readFileSync(configPath, 'utf8'));
      write(configPath, YAML.stringify({ ...config, username: 'reuse-test' }));
      const reused = runCLI(['push', '--all', '--skill', path.join(home, '.claude/skills/old-name')], 1);
      const reusedBranch = /Branch (\S+) has been pushed/.exec(reused)?.[1];
      expect(reusedBranch, reused).toBeTruthy();
      expect(git(remote, 'ls-tree', '-r', '--name-only', reusedBranch!)).toContain('skills/old-name/SKILL.md');
    }

  }, 60_000);
});
