import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const CLI = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
const tools = { claude: '.claude', codex: '.codex', codebuddy: '.codebuddy', opencode: '.config/opencode' };
let sandbox: string;
afterEach(() => { if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true }); });

describe('pull and doctor share skill selection through the real CLI', () => {
  it.each(['git', 'gitlab', 'github', 'gitea'])('reports collisions and preserves ambiguous copies with provider %s', (provider) => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-selection-'));
    const home = path.join(sandbox, 'home');
    const remote = path.join(sandbox, 'remote');
    const repo = path.join(home, '.teamai/team-repo');
    const env = {
      ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0',
      GIT_AUTHOR_NAME: 'Test', GIT_COMMITTER_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_EMAIL: 'test@example.com',
    };
    const write = (file: string, content: string) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    };
    const skill = (name: string) => `---\nname: ${name}\ndescription: Test skill\n---\n# ${name}\n`;
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' });
    const cli = (...args: string[]) => {
      const result = spawnSync(process.execPath, [CLI, ...args], { cwd: sandbox, env, encoding: 'utf8', timeout: 30_000 });
      expect(result.error).toBeUndefined();
      return { ...result, output: result.stdout + result.stderr };
    };
    write(path.join(remote, 'teamai.yaml'), YAML.stringify({
      team: 'selection', repo: remote, provider, sharing: { env: { injectShellProfile: false } },
    }));
    write(path.join(remote, 'skills/one/clash/SKILL.md'), skill('clash'));
    write(path.join(remote, 'skills/two/clash/SKILL.md'), skill('clash'));
    write(path.join(remote, 'skills/unique/SKILL.md'), skill('unique'));
    git(remote, 'init', '-q', '-b', 'main');
    git(remote, 'add', '.');
    git(remote, 'commit', '-qm', 'Skills with a collision');
    fs.mkdirSync(path.dirname(repo), { recursive: true });
    git(sandbox, 'clone', '-q', remote, repo);
    write(path.join(home, '.teamai/config.yaml'), YAML.stringify({
      repo: { localPath: repo, remote }, username: 'test', updatePolicy: 'auto', scope: 'user',
      enabledAgents: Object.keys(tools), excludedSkills: ['clash'],
    }));
    for (const dir of Object.values(tools)) {
      // Even a byte-identical old copy must survive: no unique source owns it.
      write(path.join(home, dir, 'skills/clash/SKILL.md'), skill('clash'));
    }
    const pulled = cli('pull', '--force');
    expect(pulled.status, pulled.output).toBe(1);
    expect(pulled.output).toContain('Duplicate skill "clash"');
    for (const dir of Object.values(tools)) {
      expect(fs.readFileSync(path.join(home, dir, 'skills/clash/SKILL.md'), 'utf8')).toBe(skill('clash'));
      expect(fs.readFileSync(path.join(home, dir, 'skills/unique/SKILL.md'), 'utf8')).toBe(skill('unique'));
    }
    const diagnosed = cli('doctor', '--json');
    expect(diagnosed.status, diagnosed.output).toBe(1);
    const report = JSON.parse(diagnosed.stdout);
    const collision = report.checks.find((check: { name: string }) => check.name === 'Skills to deliver can be resolved');
    expect(collision, diagnosed.output).toBeDefined();
    expect(collision.fix).toContain('skills/one/clash');
    expect(collision.fix).toContain('skills/two/clash');
  });
});
