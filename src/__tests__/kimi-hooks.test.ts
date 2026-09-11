import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse as parseToml } from 'smol-toml';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { log } from '../utils/logger.js';
import {
  getKimiHome,
  getKimiConfigPath,
  buildKimiHookEntries,
  injectKimiHooks,
  removeKimiHooks,
  hasKimiTeamaiHooks,
  KIMI_HOOK_COMMAND_PREFIX,
} from '../kimi-hooks.js';
import { injectHooksToAllTools, reconcileHooksToAllTools } from '../hooks.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-kimi-test-'));
  vi.stubEnv('KIMI_CODE_HOME', tmpDir);
  vi.mocked(log.warn).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function configPath(): string {
  return path.join(tmpDir, 'config.toml');
}
function readConfig(): string {
  return fs.readFileSync(configPath(), 'utf-8');
}
function parsedHooks(): Array<Record<string, unknown>> {
  const doc = parseToml(readConfig()) as { hooks?: Array<Record<string, unknown>> };
  return doc.hooks ?? [];
}

// A realistic user config: comments, a provider secret, and the user's own hook.
// The secret must survive untouched (we never rewrite user content).
const USER_CONFIG = `# Kimi Code CLI config
default_model = "kimi-k2"

[providers.moonshot]
type = "kimi"
base_url = "https://api.moonshot.cn/v1"
api_key = "sk-user-secret-do-not-touch"

[[hooks]]
event = "PreToolUse"
matcher = "Bash"
command = "my-guard --check"
timeout = 5
`;

// ─── home / paths ─────────────────────────────────────────────────────────────

describe('getKimiHome', () => {
  it('honours KIMI_CODE_HOME when set', () => {
    expect(getKimiHome()).toBe(path.resolve(tmpDir));
  });

  it('falls back to ~/.kimi-code', () => {
    vi.stubEnv('KIMI_CODE_HOME', '');
    vi.stubEnv('HOME', tmpDir);
    vi.stubEnv('USERPROFILE', tmpDir);
    expect(getKimiHome()).toBe(path.join(tmpDir, '.kimi-code'));
  });

  it('getKimiConfigPath points at <home>/config.toml', () => {
    expect(getKimiConfigPath()).toBe(configPath());
  });
});

// ─── entry shape ──────────────────────────────────────────────────────────────

describe('buildKimiHookEntries', () => {
  it('produces the six built-in hooks with exactly the fields kimi accepts', () => {
    const entries = buildKimiHookEntries();
    expect(entries).toHaveLength(6);
    for (const e of entries) {
      const keys = Object.keys(e).sort();
      const expectedKeys = e.matcher === undefined
        ? ['command', 'event', 'timeout']
        : ['command', 'event', 'matcher', 'timeout'];
      expect(keys).toEqual(expectedKeys);
      expect(e.timeout).toBeGreaterThanOrEqual(1);
      expect(e.timeout).toBeLessThanOrEqual(600);
      expect(Number.isInteger(e.timeout)).toBe(true);
      expect(e.command.startsWith(KIMI_HOOK_COMMAND_PREFIX)).toBe(true);
      // kimi spawns hooks through the system shell (cmd.exe on Windows), so
      // the command must be shell-neutral: no bash wrapper, no POSIX redirects.
      expect(e.command).not.toMatch(/bash|\/dev\/null|\|\|/);
      expect(e.command).toContain('--tool kimi');
    }
  });

  it('maps events, matchers and timeouts per issue #5', () => {
    const entries = buildKimiHookEntries();
    expect(entries).toEqual([
      { event: 'SessionStart', command: 'teamai hook-dispatch session-start --tool kimi', timeout: 15 },
      { event: 'Stop', command: 'teamai hook-dispatch stop --tool kimi', timeout: 15 },
      { event: 'PostToolUse', command: 'teamai hook-dispatch post-tool-use --tool kimi', timeout: 10 },
      { event: 'PostToolUse', matcher: 'Skill', command: 'teamai hook-dispatch post-tool-use --tool kimi --matcher Skill', timeout: 10 },
      { event: 'PostToolUse', matcher: 'TodoList', command: 'teamai hook-dispatch post-tool-use --tool kimi --matcher TodoList', timeout: 3 },
      { event: 'UserPromptSubmit', command: 'teamai hook-dispatch prompt-submit --tool kimi', timeout: 10 },
    ]);
  });
});

// ─── inject ───────────────────────────────────────────────────────────────────

describe('injectKimiHooks', () => {
  it('creates config.toml with six [[hooks]] entries when none exists', async () => {
    const written = await injectKimiHooks();
    expect(written).toBe(true);
    const hooks = parsedHooks();
    expect(hooks).toHaveLength(6);
    expect(hooks).toEqual(buildKimiHookEntries());
  });

  it('appends to an existing config without touching user content', async () => {
    fs.writeFileSync(configPath(), USER_CONFIG);
    await injectKimiHooks();
    const text = readConfig();
    expect(text.startsWith(USER_CONFIG)).toBe(true);
    expect(text).toContain('api_key = "sk-user-secret-do-not-touch"');
    const hooks = parsedHooks();
    expect(hooks).toHaveLength(7);
    expect(hooks[0]).toEqual({ event: 'PreToolUse', matcher: 'Bash', command: 'my-guard --check', timeout: 5 });
    expect(hooks.slice(1)).toEqual(buildKimiHookEntries());
  });

  it('is idempotent: a second run is a byte-for-byte no-op', async () => {
    fs.writeFileSync(configPath(), USER_CONFIG);
    await injectKimiHooks();
    const first = readConfig();
    const written = await injectKimiHooks();
    expect(written).toBe(false);
    expect(readConfig()).toBe(first);
    expect(parsedHooks()).toHaveLength(7);
  });

  it('replaces stale teamai entries instead of duplicating them', async () => {
    fs.writeFileSync(configPath(), USER_CONFIG + `
[[hooks]]
event = "Stop"
command = "teamai hook-dispatch stop --tool kimi --legacy-flag"
timeout = 30

[[hooks]]
event = "Notification"
command = "echo user-hook-after"
`);
    await injectKimiHooks();
    const hooks = parsedHooks();
    const teamai = hooks.filter(h => String(h.command).startsWith(KIMI_HOOK_COMMAND_PREFIX));
    expect(teamai).toEqual(buildKimiHookEntries());
    expect(hooks.filter(h => h.event === 'Notification')).toHaveLength(1);
    expect(hooks.filter(h => h.matcher === 'Bash')).toHaveLength(1);
    expect(readConfig()).not.toContain('--legacy-flag');
  });

  it('refuses to touch a config that does not parse', async () => {
    const broken = 'default_model = "kimi-k2\n[[hooks]\n';
    fs.writeFileSync(configPath(), broken);
    const written = await injectKimiHooks();
    expect(written).toBe(false);
    expect(readConfig()).toBe(broken);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('config.toml'));
  });

  it('refuses when hooks is declared as an inline static array', async () => {
    const inline = 'hooks = [{ event = "Stop", command = "echo hi" }]\n';
    fs.writeFileSync(configPath(), inline);
    const written = await injectKimiHooks();
    expect(written).toBe(false);
    expect(readConfig()).toBe(inline);
    expect(log.warn).toHaveBeenCalled();
  });

  it('keeps CRLF line endings when the existing config uses them', async () => {
    const crlf = USER_CONFIG.replace(/\n/g, '\r\n');
    fs.writeFileSync(configPath(), crlf);
    await expect(injectKimiHooks()).resolves.toBe(true);
    const text = readConfig();
    expect(text.startsWith(crlf)).toBe(true);
    expect(text).not.toMatch(/[^\r]\n/);
    expect(parsedHooks()).toHaveLength(7);
    await expect(injectKimiHooks()).resolves.toBe(false);
    expect(readConfig()).toBe(text);
    await expect(removeKimiHooks()).resolves.toBe(true);
    expect(readConfig()).toBe(crlf);
  });

  it('recognizes quoted [[hooks]] headers', async () => {
    fs.writeFileSync(configPath(), "[['hooks']]\nevent = \"Stop\"\ncommand = \"echo bye\"\n");
    await expect(injectKimiHooks()).resolves.toBe(true);
    expect(parsedHooks()).toHaveLength(7);
    await removeKimiHooks();
    expect(parsedHooks()).toEqual([{ event: 'Stop', command: 'echo bye' }]);
  });
});

// ─── remove ───────────────────────────────────────────────────────────────────

describe('removeKimiHooks', () => {
  it('removes exactly the teamai entries and leaves valid TOML', async () => {
    fs.writeFileSync(configPath(), USER_CONFIG);
    await injectKimiHooks();
    await removeKimiHooks();
    const text = readConfig();
    expect(text).not.toContain(KIMI_HOOK_COMMAND_PREFIX);
    expect(text).toContain('api_key = "sk-user-secret-do-not-touch"');
    expect(parsedHooks()).toEqual([
      { event: 'PreToolUse', matcher: 'Bash', command: 'my-guard --check', timeout: 5 },
    ]);
  });

  it('keeps user hooks that sit after the teamai entries', async () => {
    await injectKimiHooks();
    fs.appendFileSync(configPath(), '\n[[hooks]]\nevent = "Stop"\ncommand = "echo bye"\n');
    await removeKimiHooks();
    expect(parsedHooks()).toEqual([{ event: 'Stop', command: 'echo bye' }]);
  });

  it('is a no-op when config.toml is missing or has no teamai entries', async () => {
    await expect(removeKimiHooks()).resolves.toBe(false);
    expect(fs.existsSync(configPath())).toBe(false);
    fs.writeFileSync(configPath(), USER_CONFIG);
    await expect(removeKimiHooks()).resolves.toBe(false);
    expect(readConfig()).toBe(USER_CONFIG);
  });

  it('leaves an empty document when teamai hooks were the only content', async () => {
    await injectKimiHooks();
    await removeKimiHooks();
    expect(readConfig()).toBe('');
    expect(parseToml(readConfig())).toEqual({});
  });

  it('keeps a comment that documents the user block following a teamai block', async () => {
    await injectKimiHooks();
    fs.appendFileSync(configPath(), '\n# my own stop hook\n[[hooks]]\nevent = "Stop"\ncommand = "echo bye"\n');
    await removeKimiHooks();
    expect(readConfig()).toBe('# my own stop hook\n[[hooks]]\nevent = "Stop"\ncommand = "echo bye"\n');
  });
});

describe('hasKimiTeamaiHooks', () => {
  it('reports whether teamai entries are present', async () => {
    expect(await hasKimiTeamaiHooks()).toBe(false);
    fs.writeFileSync(configPath(), USER_CONFIG);
    expect(await hasKimiTeamaiHooks()).toBe(false);
    await injectKimiHooks();
    expect(await hasKimiTeamaiHooks()).toBe(true);
  });
});

// ─── reconcile / inject wiring ────────────────────────────────────────────────

describe('hooks reconcile — kimi branch', () => {
  // Kimi's toolPaths entry only carries `skills`; the hooks reconciler ignores it.
  const toolPaths: Record<string, { settings?: string }> = { kimi: {} };
  let baseDir: string;
  let manifest: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-kimi-base-'));
    manifest = path.join(baseDir, 'managed-hooks.json');
  });
  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('installs into the kimi user config when the kimi home exists', async () => {
    fs.writeFileSync(configPath(), USER_CONFIG);
    await reconcileHooksToAllTools(toolPaths, baseDir, [], manifest, {});
    expect(parsedHooks()).toHaveLength(7);
    // Nothing is written under baseDir: kimi hooks are user-level regardless of scope.
    expect(fs.readdirSync(baseDir)).toEqual([]);
  });

  it('does not create a kimi home for users without Kimi Code CLI', async () => {
    const missing = path.join(tmpDir, 'not-installed');
    vi.stubEnv('KIMI_CODE_HOME', missing);
    await reconcileHooksToAllTools(toolPaths, baseDir, [], manifest, {});
    expect(fs.existsSync(missing)).toBe(false);
  });

  it('removeAll strips the teamai entries and keeps the user ones', async () => {
    fs.writeFileSync(configPath(), USER_CONFIG);
    await reconcileHooksToAllTools(toolPaths, baseDir, [], manifest, {});
    await reconcileHooksToAllTools(toolPaths, baseDir, [], manifest, { removeAll: true });
    expect(parsedHooks()).toHaveLength(1);
    expect(readConfig()).not.toContain(KIMI_HOOK_COMMAND_PREFIX);
  });

  it('settingsOnly sweeps skip kimi (global adapter, no baseDir)', async () => {
    fs.writeFileSync(configPath(), USER_CONFIG);
    await reconcileHooksToAllTools(toolPaths, baseDir, [], manifest, { removeAll: true, settingsOnly: true });
    await reconcileHooksToAllTools(toolPaths, baseDir, [], manifest, { settingsOnly: true });
    expect(readConfig()).toBe(USER_CONFIG);
  });

  it('filterAgents excluding kimi leaves the config untouched', async () => {
    fs.writeFileSync(configPath(), USER_CONFIG);
    await reconcileHooksToAllTools(toolPaths, baseDir, [], manifest, { filterAgents: ['claude'] });
    expect(readConfig()).toBe(USER_CONFIG);
  });

  it('injectHooksToAllTools (legacy pull path) also installs kimi hooks', async () => {
    await injectHooksToAllTools(toolPaths, baseDir);
    expect(parsedHooks()).toHaveLength(6);
  });
});
