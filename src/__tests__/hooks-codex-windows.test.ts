import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { reconcileHooks, removeHooks } from '../hooks.js';

const canExecute = process.platform !== 'win32' && spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0;
import { getDispatchCommand, _resetShellCache } from '../builtin-hooks.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  _resetShellCache();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Windows Codex hook execution', () => {
  it('replaces all six legacy commands, preserves user hooks, and remains removable and idempotent', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-codex-migrate-'));
    dirs.push(root);
    const hooksPath = path.join(root, 'hooks.json');
    const user = { hooks: [{ type: 'command', command: 'echo user' }] };
    const old = (event: string, matcher = '*') => ({ matcher, hooks: [{ type: 'command',
      command: `"C:/Program Files/Git/bin/bash.exe" -lc "teamai hook-dispatch ${event} --tool codex 2>/dev/null" || true`,
    }] });
    fs.writeFileSync(hooksPath, JSON.stringify({ hooks: {
      SessionStart: [user, old('session-start')], Stop: [old('stop')],
      PostToolUse: [old('post-tool-use'), old('post-tool-use', 'Skill'), old('post-tool-use', 'TodoWrite')],
      UserPromptSubmit: [old('prompt-submit')],
    } }));
    const bash = path.join(root, 'Git', 'bin', 'bash.exe');
    fs.mkdirSync(path.dirname(bash), { recursive: true });
    fs.writeFileSync(bash, '');
    vi.stubEnv('ProgramFiles', root);
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    await reconcileHooks(hooksPath, 'codex', []);
    const first = fs.readFileSync(hooksPath, 'utf8');
    const hooks = JSON.parse(first).hooks as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    expect(hooks.SessionStart[0]).toEqual(user);
    const commands = Object.values(hooks).flat().map(entry => entry.hooks[0].command).filter(command => command !== 'echo user');
    expect(commands).toHaveLength(8);
    expect(hooks.SubagentStop).toHaveLength(1);
    expect(hooks.SubagentStart).toHaveLength(1);
    expect(hooks.SessionStart[1].hooks[0]).toMatchObject({ additionalContextLimit: 0 });
    expect(hooks.SubagentStart[0].hooks[0]).toMatchObject({ additionalContextLimit: 0 });
    expect(commands.every(command => command.startsWith('powershell.exe -NoProfile -NonInteractive -Command '))).toBe(true);
    expect(hooks.PostToolUse.map(entry => entry.matcher)).toEqual([undefined, 'Skill', 'TodoWrite']);
    await reconcileHooks(hooksPath, 'codex', []);
    expect(fs.readFileSync(hooksPath, 'utf8')).toBe(first);
    await removeHooks(hooksPath, 'codex');
    expect(JSON.parse(fs.readFileSync(hooksPath, 'utf8')).hooks.SessionStart).toEqual([user]);
  });
  it.skipIf(!canExecute)('dispatches through PowerShell with a spaced Bash path and fails open', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai $codex '));
    dirs.push(root);
    const bash = path.join(root, 'Git', 'bin', 'bash.exe');
    fs.mkdirSync(path.dirname(bash), { recursive: true });
    fs.symlinkSync('/bin/bash', bash);
    vi.stubEnv('ProgramFiles', root);
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const probe = path.join(root, 'probe');
    fs.writeFileSync(probe, '#!/bin/bash\ncat\nprintf "%s\\n" "$@"\necho hidden >&2\nexit 7\n', { mode: 0o755 });
    const command = getDispatchCommand('stop', 'codex', 'Skill', `'${probe}'`);
    vi.restoreAllMocks();
    // Use the local PowerShell executable to run the generated payload.
    expect(command).toMatch(/^powershell\.exe -NoProfile -NonInteractive -Command /);
    const payload = command.slice(command.indexOf('-Command ') + 9);
    const expected = 'stdin payloadhook-dispatch\nstop\n--tool\ncodex\n--matcher\nSkill\n';
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', JSON.parse(payload)], {
      encoding: 'utf8', input: 'stdin payload',
    });
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 0, stdout: expected, stderr: '',
    });
    const launcher = path.join(root, 'powershell.exe');
    fs.writeFileSync(launcher, '#!/bin/sh\nexec pwsh "$@"\n', { mode: 0o755 });
    for (const host of ['bash', 'pwsh']) {
      const outer = spawnSync(host, host === 'bash' ? ['-c', command] : ['-NoProfile', '-Command', command], {
        encoding: 'utf8', input: 'stdin payload', env: { ...process.env, PATH: `${root}:${process.env.PATH}` },
      });
      expect({ status: outer.status, stdout: outer.stdout, stderr: outer.stderr }).toEqual({
        status: 0, stdout: expected, stderr: '',
      });
    }
  });
});
