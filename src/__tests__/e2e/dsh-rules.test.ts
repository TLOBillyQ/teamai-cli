import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const CLI = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
const START = '<!-- [teamai:rules:start] -->';
const END = '<!-- [teamai:rules:end] -->';

// Exercise the built CLI with local Git transport: provider credentials and
// remote hosting APIs are deliberately outside this rule-delivery regression.
describe('DSH project rules through pull and uninstall (#47)', () => {
  let sandbox: string;
  let project: string;
  let home: string;
  let repo: string;

  function enable(agents: string[]) {
    for (const agent of agents) fs.mkdirSync(path.join(project, `.${agent === 'kimi' ? 'kimi-code' : agent}`, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(project, '.teamai/config.yaml'), YAML.stringify({
      repo: { localPath: repo, remote: repo },
      username: 'test', updatePolicy: 'auto', scope: 'project', projectRoot: project,
      enabledAgents: agents, recallEnabled: false,
    }));
  }

  function cli(...args: string[]) {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      cwd: project, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), FORCE_COLOR: '0' },
    });
    const output = result.stdout + result.stderr;
    expect(result.status, output).toBe(0);
    return output;
  }

  function rules() {
    const content = fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8');
    expect(content).toContain('# Personal notes');
    expect(content.split(START)).toHaveLength(2);
    expect(content.split(END)).toHaveLength(2);
    expect(content).toContain('Always explain the change.');
    expect(content).toContain('Keep all team instructions.');
    expect(content).not.toContain('paths:');
    expect(fs.existsSync(path.join(project, '.dsh/rules'))).toBe(false);
    return content;
  }

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-dsh-'));
    home = path.join(sandbox, 'home');
    project = path.join(sandbox, 'project');
    repo = path.join(project, '.teamai/team-repo');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(repo, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'teamai.yaml'), YAML.stringify({ team: 'dsh-regression', repo, provider: 'git', sharing: { recall: { enabled: false } } }));
    fs.writeFileSync(path.join(repo, 'rules/first.md'), '---\npaths: ["src/**"]\n---\nAlways explain the change.\n');
    fs.writeFileSync(path.join(repo, 'rules/second.md'), 'Keep all team instructions.\n');
    fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Personal notes\n');
    const git = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git(['init', '-q']);
    git(['add', '.']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture']);
    git(['remote', 'add', 'origin', repo]);
    git(['branch', '--set-upstream-to=HEAD']);
  });

  afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  it('delivers full rules with only Kimi and DSH enabled', () => {
    enable(['kimi', 'dsh']);
    cli('pull', '--force');
    rules();
    expect(fs.existsSync(path.join(project, '.codex'))).toBe(false);
  });

  it('keeps rules after trimming Claude and Codex from the enabled agents', () => {
    enable(['kimi', 'claude', 'codex', 'dsh']);
    cli('pull', '--force');
    rules();
    enable(['kimi', 'dsh']);
    cli('pull', '--force');
    rules();
    expect(fs.readFileSync(path.join(project, '.kimi-code/AGENTS.md'), 'utf8')).toContain('Keep all team instructions.');
  });

  it.each([
    ['codex', 'dsh'], ['dsh', 'codex'], ['zcode', 'dsh'], ['dsh', 'zcode'],
  ])('preserves the shared block when uninstalling %s while %s remains', (removed, remaining) => {
    enable([removed, remaining]);
    cli('pull', '--force');
    rules();
    cli('uninstall', '--agent', removed, '--force');
    rules();
    cli('pull', '--force');
    rules();
  });

  it('cleans the last DSH rules block through the visible removal plan', () => {
    enable(['dsh']);
    cli('pull', '--force');
    rules();
    const output = cli('uninstall', '--agent', 'dsh', '--force');
    expect(output).toContain('CLAUDE.md rule blocks');
    expect(output).toContain(path.join(project, 'AGENTS.md'));
    expect(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8')).toBe('# Personal notes\n');
  });

  it.each(['git', 'gitlab', 'github', 'gitea'])('leaves excluded DSH untouched with %s provider configuration', (provider) => {
    const configPath = path.join(repo, 'teamai.yaml');
    const config = YAML.parse(fs.readFileSync(configPath, 'utf8'));
    config.provider = provider;
    fs.writeFileSync(configPath, YAML.stringify(config));
    enable(['claude', 'codex', 'codebuddy', 'opencode']);
    cli('pull', '--force');
    rules();
    expect(fs.existsSync(path.join(project, '.dsh'))).toBe(false);
    for (const agent of ['claude', 'codebuddy', 'opencode']) {
      expect(fs.readFileSync(path.join(project, `.${agent}/rules/first.md`), 'utf8')).toContain('Always explain the change.');
    }
    // An installed but excluded DSH must not claim a shared rules block either.
    fs.mkdirSync(path.join(project, '.dsh/skills'), { recursive: true });
    cli('pull', '--force');
    expect(fs.readdirSync(path.join(project, '.dsh/skills'))).toEqual([]);
    cli('uninstall', '--agent', 'codex', '--force');
    expect(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8')).not.toContain(START);
  });

});
