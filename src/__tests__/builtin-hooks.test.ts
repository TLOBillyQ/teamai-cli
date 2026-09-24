import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import fse from 'fs-extra';
import { builtinHookDefs, applyBuiltinOverride, getDispatchCommand } from '../builtin-hooks.js';
import { isTeamaiHookCommand } from '../hooks.js';

describe('builtinHookDefs — unified built-in hook model', () => {
  it('returns 6 built-in defs in canonical order, all tagged source=builtin', () => {
    const defs = builtinHookDefs('claude');
    expect(defs).toHaveLength(6);
    expect(defs.every((d) => d.source === 'builtin')).toBe(true);
    expect(defs.map((d) => d.event)).toEqual([
      'SessionStart', 'Stop',
      'PostToolUse', 'PostToolUse', 'PostToolUse',
      'UserPromptSubmit',
    ]);
  });

  it('adds a lifecycle-complete SessionEnd hook only for Copilot', () => {
    const defs = builtinHookDefs('copilot');
    expect(defs).toHaveLength(7);
    expect(defs.at(-1)).toEqual(expect.objectContaining({
      event: 'SessionEnd',
      matcher: '*',
      timeout: 15,
      command: expect.stringContaining('hook-dispatch session-end --tool copilot'),
    }));
    expect(builtinHookDefs('claude')).toHaveLength(6);
  });

  it('keeps only observed Codex events while other hosts retain their specialized hooks', () => {
    expect(builtinHookDefs('codex').map((def) => [def.event, def.matcher])).toEqual([
      ['SessionStart', '*'], ['Stop', '*'], ['PostToolUse', '*'], ['UserPromptSubmit', '*'],
    ]);
    expect(builtinHookDefs('claude').some((def) => def.matcher === 'Skill')).toBe(true);
    expect(builtinHookDefs('claude').some((def) => def.matcher === 'TodoWrite')).toBe(true);
  });

  it('Claude defs carry no timeout; Cursor defs carry per-hook timeouts', () => {
    expect(builtinHookDefs('claude').every((d) => d.timeout === undefined)).toBe(true);
    const cursor = builtinHookDefs('cursor');
    expect(cursor.find((d) => d.key === 'Hook dispatch session-start')?.timeout).toBe(15);
    expect(cursor.find((d) => d.key === 'Hook dispatch post-tool-use TodoWrite')?.timeout).toBe(3);
  });

  it('embeds the --tool identifier and [teamai] description marker', () => {
    const def = builtinHookDefs('codebuddy')[0];
    expect(def.command).toContain('--tool codebuddy');
    expect(def.description.startsWith('[teamai] ')).toBe(true);
  });
});

describe('applyBuiltinOverride (§4.8)', () => {
  it('is a no-op for an absent or empty override', () => {
    const defs = builtinHookDefs('cursor');
    expect(applyBuiltinOverride(defs)).toBe(defs);
    expect(applyBuiltinOverride(defs, { disabled: [], overrides: {} })).toEqual(defs);
  });

  it('drops disabled built-in keys', () => {
    const defs = applyBuiltinOverride(builtinHookDefs('claude'), {
      disabled: ['Hook dispatch post-tool-use TodoWrite'],
    });
    expect(defs).toHaveLength(5);
    expect(defs.some((d) => d.key === 'Hook dispatch post-tool-use TodoWrite')).toBe(false);
  });

  it('applies a whitelisted timeout override', () => {
    const defs = applyBuiltinOverride(builtinHookDefs('cursor'), {
      overrides: { 'Hook dispatch stop': { timeout: 99 } },
    });
    expect(defs.find((d) => d.key === 'Hook dispatch stop')?.timeout).toBe(99);
  });
});

// ─── Issue #43: Windows hook commands must not flash console windows ───

describe('getDispatchCommand — Windows console windows (issue #43)', () => {
  const WIN = {
    platform: 'win32' as const,
    entryScript: 'C:\\npm\\teamai-cli\\dist\\index.js',
    nodeBin: 'C:\\Program Files\\nodejs\\node.exe',
  };

  it('invokes node and the entry script directly on Windows — no bash, no cmd shim', () => {
    const cmd = getDispatchCommand('session-start', 'claude', '*', undefined, WIN);
    expect(cmd).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\npm\\teamai-cli\\dist\\index.js" hook-dispatch session-start --tool claude',
    );
    expect(cmd).not.toContain('bash');
    expect(cmd).not.toContain('2>/dev/null');
  });

  it('keeps the matcher argument in the Windows form', () => {
    expect(getDispatchCommand('post-tool-use', 'codex', 'TodoWrite', undefined, WIN))
      .toContain('hook-dispatch post-tool-use --tool codex --matcher TodoWrite');
  });

  it('falls back to the bare teamai command when the entry script cannot be resolved', () => {
    const cmd = getDispatchCommand('stop', 'claude', '*', undefined, { ...WIN, entryScript: null });
    expect(cmd).toBe('teamai hook-dispatch stop --tool claude');
  });

  it('leaves the POSIX command untouched', () => {
    expect(getDispatchCommand('session-start', 'claude', '*', undefined, { ...WIN, platform: 'linux' }))
      .toBe('bash -lc "teamai hook-dispatch session-start --tool claude 2>/dev/null" || true');
  });

  it('is still recognized as a teamai-owned hook, so reconcile can prune it', () => {
    expect(isTeamaiHookCommand(getDispatchCommand('stop', 'claude', '*', undefined, WIN))).toBe(true);
    expect(isTeamaiHookCommand(getDispatchCommand('stop', 'claude', '*', undefined, { ...WIN, platform: 'linux' }))).toBe(true);
    expect(isTeamaiHookCommand('node ./scripts/lint.js')).toBe(false);
  });

  it('does not claim a foreign hook that merely mentions hook-dispatch', () => {
    // Ownership drives pruning, so the bare word must not be enough (#43).
    expect(isTeamaiHookCommand('node ./scripts/my-hook-dispatch.js')).toBe(false);
    expect(isTeamaiHookCommand('node dispatch.js --mode hook-dispatch')).toBe(false);
  });
});

// ─── Issue #44: the Windows Codex command must parse under `pwsh -Command` ───

describe('getDispatchCommand — Windows Codex command (issue #44)', () => {
  const SPACED = {
    platform: 'win32' as const,
    entryScript: 'C:\\npm\\teamai-cli\\dist\\index.js',
    nodeBin: 'C:\\Program Files\\nodejs\\node.exe',
  };
  const UNSPACED = {
    platform: 'win32' as const,
    entryScript: 'C:\\teamai\\dist\\index.js',
    nodeBin: 'D:\\NodeJS\\node.exe',
  };

  it('prefixes the PowerShell call operator so the command is not a quoted script head', () => {
    expect(getDispatchCommand('session-start', 'codex', '*', undefined, SPACED)).toBe(
      '& "C:\\Program Files\\nodejs\\node.exe" "C:\\npm\\teamai-cli\\dist\\index.js" hook-dispatch session-start --tool codex',
    );
  });

  it('starts with the call operator for an unspaced runtime too, keeping the matcher', () => {
    expect(getDispatchCommand('post-tool-use', 'codex', 'TodoWrite', undefined, UNSPACED)).toBe(
      '& "D:\\NodeJS\\node.exe" "C:\\teamai\\dist\\index.js" hook-dispatch post-tool-use --tool codex --matcher TodoWrite',
    );
  });

  it('leaves every other Windows tool byte-identical (their hook shell is unchanged)', () => {
    // `&` is PowerShell-only, and the #43 form is verified for Claude Code on
    // Windows — a per-tool form must not leak into the others (#44).
    for (const tool of ['claude', 'claude-internal', 'cursor', 'codebuddy', 'tcodex', 'codex-internal']) {
      const cmd = getDispatchCommand('stop', tool, '*', undefined, SPACED);
      expect(cmd).toBe(
        `"C:\\Program Files\\nodejs\\node.exe" "C:\\npm\\teamai-cli\\dist\\index.js" hook-dispatch stop --tool ${tool}`,
      );
    }
  });

  it('leaves the POSIX command byte-identical for every tool', () => {
    for (const tool of ['claude', 'codex']) {
      expect(getDispatchCommand('stop', tool, '*', undefined, { ...SPACED, platform: 'linux' }))
        .toBe(`bash -lc "teamai hook-dispatch stop --tool ${tool} 2>/dev/null" || true`);
    }
  });

  it('never emits a POSIX command on win32, resolved entry script or not', () => {
    for (const env of [SPACED, { ...SPACED, entryScript: null }]) {
      for (const tool of ['claude', 'codex']) {
        const cmd = getDispatchCommand('stop', tool, '*', undefined, env);
        expect(cmd).not.toContain('bash');
        expect(cmd).not.toContain('2>/dev/null');
      }
    }
  });

  it('keeps the no-entry-script fallback a bare command word (a -Command shell still parses it)', () => {
    expect(getDispatchCommand('stop', 'codex', '*', undefined, { ...SPACED, entryScript: null }))
      .toBe('teamai hook-dispatch stop --tool codex');
  });

  it('is still recognized as a teamai-owned hook, so reconcile can prune it', () => {
    expect(isTeamaiHookCommand(getDispatchCommand('stop', 'codex', '*', undefined, SPACED))).toBe(true);
  });
});

/**
 * The unit assertions above only pin the string. This one runs it the way Codex
 * does on Windows — `pwsh -Command "<command>"` — because that is where #44
 * failed: PowerShell rejects a script whose first token is a quoted string.
 * Skipped where pwsh is unavailable (POSIX CI runners may not have it).
 */
const pwshAvailable = (() => {
  try {
    return spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true }).status === 0;
  } catch {
    return false;
  }
})();

describe.skipIf(!pwshAvailable)('getDispatchCommand — real `pwsh -Command` execution (issue #44)', () => {
  it('runs the codex command with spaced node and entry-script paths', async () => {
    // A temp dir with a space, plus a spaced entry-script name: the quoting is
    // load-bearing for the default Windows Node install (`C:\Program Files\…`).
    const dir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai pwsh probe-'));
    try {
      const entry = path.join(dir, 'entry script.js');
      await fse.writeFile(entry, 'process.stdout.write(`hook ran\\n`);\n');
      const cmd = getDispatchCommand('session-start', 'codex', '*', undefined, {
        platform: 'win32',
        entryScript: entry,
        nodeBin: process.execPath,
      });

      const run = spawnSync('pwsh', ['-NoProfile', '-Command', cmd], {
        encoding: 'utf-8',
        windowsHide: true,
      });

      expect(run.stderr).not.toContain('ParserError');
      expect(run.stdout).toContain('hook ran');
      expect(run.status).toBe(0);
    } finally {
      await fse.remove(dir);
    }
  });
});
