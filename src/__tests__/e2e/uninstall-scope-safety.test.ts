import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { createHash } from 'node:crypto';

const CLI = process.env.TEAMAI_TEST_CLI ?? fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
const sandboxes: string[] = [];

function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) files[file] = fs.readlinkSync(file);
    else if (entry.isDirectory()) Object.assign(files, snapshot(file));
    else files[file] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
  return files;
}

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-uninstall-55-'));
  sandboxes.push(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home,
    APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'), KIMI_CODE_HOME: path.join(home, '.kimi-code'),
    CODEX_HOME: path.join(home, '.codex'), COPILOT_HOME: path.join(home, '.copilot'),
    TEAMAI_NO_UPDATE_CHECK: '1', FORCE_COLOR: '0' };
  const write = (rel: string, content: string) => {
    const file = path.join(home, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  const run = (args: string[], cwd = home, input = '') => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: 'pipe', timeout: 30_000 });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    child.on('error', reject);
    child.on('close', (code) => {
      try { expect(code, output).toBe(0); resolve(output); } catch (error) { reject(error); }
    });
    child.stdin.end(input);
  });
  return { home, write, run, env };
}

afterEach(() => {
  for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('uninstall scope safety (real CLI)', () => {
  it.each(['git', 'gitlab', 'github', 'gitea'])('keeps installed project resources and shared dispatch for provider %s', async (provider) => {
    const { home, write, run, env } = fixture();
    const tools = ['claude', 'codex', 'codebuddy', 'opencode', 'kimi'];
    const repo = path.join(home, 'team');
    const project = path.join(home, 'project');
    write('team/teamai.yaml', JSON.stringify({ team: 'safety', repo: 'https://example.test/team.git', provider }));
    write('team/skills/scope-proof/SKILL.md', '---\nname: scope-proof\ndescription: Project safety proof\n---\n# Keep project resources\n');
    write('team/hooks/hooks.yaml', 'hooks:\n  - id: proof\n    description: Scope proof\n    event: Stop\n    command: echo scope-proof\n');
    for (const cwd of [repo, project]) {
      fs.mkdirSync(cwd, { recursive: true });
      execFileSync('git', ['init', '--initial-branch=main'], { cwd, env, stdio: 'ignore' });
    }
    execFileSync('git', ['add', '.'], { cwd: repo, env, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture'], { cwd: repo, env, stdio: 'ignore' });
    const remote = path.join(home, 'remote.git');
    execFileSync('git', ['clone', '--bare', repo, remote], { cwd: home, env, stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: repo, env, stdio: 'ignore' });
    const config = { scope: 'user', username: 'fixture', updatePolicy: 'skip', enabledAgents: tools,
      repo: { localPath: repo, remote: 'https://example.test/team.git' } };
    write('.teamai/config.yaml', JSON.stringify(config));
    write('project/.teamai/config.yaml', JSON.stringify({ ...config, scope: 'project', projectRoot: project }));
    for (const tool of tools) {
      fs.mkdirSync(path.join(home, tool === 'kimi' ? '.kimi-code' : `.${tool}`), { recursive: true });
      fs.mkdirSync(path.join(project, tool === 'kimi' ? '.kimi-code' : `.${tool}`), { recursive: true });
    }
    write('.claude/settings.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo personal-hook' }] }] } }));
    if (process.platform === 'win32') {
      // Existing CodeBuddy injection requires /bin/sh on Windows; model an already installed dispatcher.
      write('.codebuddy/settings.json', JSON.stringify({ hooks: { SessionStart: [{ description: '[teamai] Auto-pull', hooks: [{ type: 'command', command: 'teamai hook-dispatch session-start --tool codebuddy' }] }] } }));
    }
    await run(['pull', '--force']);
    const pullOutput = await run(['pull', '--force'], project);
    expect(fs.existsSync(path.join(project, '.claude/skills/scope-proof/SKILL.md')), pullOutput).toBe(true);
    // CLI startup migrates the legacy project fixture into its real partition.
    const partitions = path.join(home, '.teamai/projects');
    const partition = fs.readdirSync(partitions).map((name) => path.join(partitions, name)).find((dir) => fs.existsSync(path.join(dir, 'config.yaml')))!;
    expect(partition).toBeTruthy();
    const projectConfig = fs.readFileSync(path.join(partition, 'config.yaml'), 'utf8');
    const sentinel = write('.teamai/cache/keep.txt', 'shared cache');
    const beforePreview = snapshot(home);
    const preview = await run(['--dry-run', 'uninstall']);
    expect(snapshot(home)).toEqual(beforePreview);
    expect(preview).toContain('user scope');
    expect(preview).toContain('Preserved');
    if (provider === 'gitlab') {
      for (const [index, tool] of tools.entries()) {
        await run(['uninstall', '--agent', tool, '--force']);
        if (index < tools.length - 1) {
          const remaining = YAML.parse(fs.readFileSync(path.join(home, '.teamai/config.yaml'), 'utf8'));
          expect(remaining.disabledAgents).toContain(tool);
        }
        expect(fs.readFileSync(path.join(partition, 'config.yaml'), 'utf8')).toBe(projectConfig);
      }
    } else {
      await run(['uninstall', '--force']);
    }
    expect(fs.existsSync(path.join(home, '.teamai/config.yaml'))).toBe(false);
    expect(fs.readFileSync(path.join(partition, 'config.yaml'), 'utf8')).toBe(projectConfig);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('shared cache');
    for (const tool of tools) {
      expect(fs.existsSync(path.join(project, `${tool === 'kimi' ? '.kimi-code' : '.' + tool}/skills/scope-proof/SKILL.md`)), tool).toBe(true);
    }
    const claude = fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8');
    expect(claude).toContain('personal-hook');
    expect(claude).toContain('hook-dispatch');
    const manifest = JSON.parse(fs.readFileSync(path.join(home, '.teamai/managed-hooks.json'), 'utf8'));
    expect(manifest.claude).toHaveLength(1);
    expect(manifest.claude[0].command).toContain('if [');
    for (const file of ['.codex/hooks.json', '.codebuddy/settings.json', '.config/opencode/plugin/teamai-hooks.ts', '.kimi-code/config.toml']) {
      expect(fs.readFileSync(path.join(home, file), 'utf8'), file).toContain('hook-dispatch');
    }
    // Publish a real revision so the incremental pull has new work to dispatch.
    for (const tool of tools) {
      const skill = `${tool === 'kimi' ? '.kimi-code' : '.' + tool}/skills/scope-proof/SKILL.md`;
      write('team/skills/scope-proof/SKILL.md', `---\nname: scope-proof\ndescription: Project safety proof\n---\n# Revision for ${tool}\n`);
      execFileSync('git', ['add', '.'], { cwd: repo, env, stdio: 'ignore' });
      execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', tool], { cwd: repo, env, stdio: 'ignore' });
      execFileSync('git', ['push', 'origin', 'main'], { cwd: repo, env, stdio: 'ignore' });
      fs.unlinkSync(path.join(project, skill));
      const dispatch = await run(['--verbose', 'hook-dispatch', 'session-start', '--tool', tool, '--bg-only'], home, JSON.stringify({ cwd: project }));
      expect(fs.existsSync(path.join(project, skill)), dispatch).toBe(true);
    }
    await run(['uninstall', '--force']);
    const restoredUser = write('.teamai/config.yaml', JSON.stringify(config));
    const otherProject = write('.teamai/projects/other/config.yaml', JSON.stringify({ ...config, scope: 'project', projectRoot: path.join(home, 'other') }));
    const otherBytes = fs.readFileSync(otherProject, 'utf8');
    await run(['uninstall', '--force'], project);
    expect(fs.readFileSync(restoredUser, 'utf8')).toBe(JSON.stringify(config));
    expect(fs.readFileSync(otherProject, 'utf8')).toBe(otherBytes);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('shared cache');
  }, 120_000);

  it('retires a valid user binding without deleting shared or unowned data', async () => {
    const { home, write, run } = fixture();
    write('team/teamai.yaml', JSON.stringify({ team: 'safety', repo: 'https://example.test/team.git', provider: 'git' }));
    const config = write('.teamai/config.yaml', JSON.stringify({
      scope: 'user', username: 'fixture', updatePolicy: 'skip',
      repo: { localPath: path.join(home, 'team'), remote: 'https://example.test/team.git' },
    }));
    write('team/manifest/roles.yaml', JSON.stringify({ version: 1, roles: [{ id: 'hai', resources: { knowledge: [], skills: [] } }] }));
    const files = ['projects/fixture/config.yaml', 'projects/fixture/state.json', 'cache/keep.txt', 'credentials.json', 'personal.txt', 'docs/personal.md', 'local-agent/manifest.json'];
    const paths = files.map((name) => write(`.teamai/${name}`, `keep ${name}`));
    const before = snapshot(home);
    const preview = await run(['--dry-run', 'uninstall']);
    expect(snapshot(home)).toEqual(before);
    expect(fs.existsSync(config)).toBe(true);
    await run(['uninstall', '--force']);
    expect(fs.existsSync(config)).toBe(false);
    paths.forEach((file, i) => expect(fs.readFileSync(file, 'utf8')).toBe(`keep ${files[i]}`));
    expect(preview).toContain('Preserved');
    await run(['uninstall', '--force']);
  });

  it.each(['missing', 'corrupt', 'unreadable team'])('preserves all data with %s user configuration', async (kind) => {
    const { home, write, run } = fixture();
    if (kind === 'corrupt') write('.teamai/config.yaml', '[invalid yaml');
    if (kind === 'unreadable team') write('.teamai/config.yaml', JSON.stringify({ scope: 'user', username: 'fixture', repo: { localPath: path.join(home, 'missing-repo'), remote: 'https://example.test/team.git' } }));
    const files = ['projects/fixture/config.yaml', 'projects/fixture/state.json', 'cache/keep.txt', 'credentials.json', 'personal.txt'];
    const paths = files.map((name) => write(`.teamai/${name}`, `keep ${name}`));
    const before = snapshot(home);
    const preview = await run(['--dry-run', 'uninstall']);
    expect(snapshot(home)).toEqual(before);
    expect(preview).toContain('user scope');
    expect(preview).toContain('Preserved');
    await run(['uninstall', '--force']);
    const after = snapshot(home);
    delete after[path.join(home, '.teamai/debug.log')];
    expect(after).toEqual(before);
    paths.forEach((file, i) => expect(fs.readFileSync(file, 'utf8')).toBe(`keep ${files[i]}`));
  });
});
