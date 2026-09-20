import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'node:child_process';
import { shallowClone } from '../clone.js';

/**
 * Issue #49: a clone whose credential the CLI supplies itself (an
 * `http.extraHeader` token, an OAuth URL) must not hand the failure to a
 * credential prompt — a login dialog cannot supply a PAT. The generic `git`
 * provider is the opposite case on purpose: it delegates authentication to the
 * user's credential helper, and that interactive first clone has to keep working.
 */

const mockedSpawn = spawn as unknown as Mock;
const origEnv = { ...process.env };

/** A child that reports `git clone` success (and a HEAD for the follow-up calls). */
function stubGit(): void {
  mockedSpawn.mockImplementation((_cmd: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => undefined;
    setImmediate(() => {
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') child.stdout.emit('data', Buffer.from('main\n'));
      else if (args[0] === 'rev-parse') child.stdout.emit('data', Buffer.from('abcdef1\n'));
      child.emit('close', 0);
    });
    return child;
  });
}

/** Env handed to the `git clone` spawn of the last shallowClone call. */
function cloneEnv(): NodeJS.ProcessEnv | undefined {
  const call = mockedSpawn.mock.calls.find((c) => (c[1] as string[]).includes('clone'));
  expect(call, 'no git clone was spawned').toBeDefined();
  return (call![2] as { env?: NodeJS.ProcessEnv }).env;
}

describe('shallowClone git environment (issue #49)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shallow-clone-'));
    mockedSpawn.mockReset();
    stubGit();
    process.env = { ...origEnv };
  });

  afterEach(() => {
    process.env = { ...origEnv };
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('suppresses prompting when the token comes from our own auth header', async () => {
    process.env.GITLAB_TOKEN = 'glpat_secret';
    await shallowClone('https://gitlab.example.com/org/repo.git', path.join(tmp, 'repo'), 'gitlab');

    expect(cloneEnv()).toMatchObject({
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
    });
  });

  it('leaves the credential helper in charge for the generic git provider', async () => {
    // No token provider, no token in the URL: the user's own credential helper
    // (or ~/.netrc) is the intended auth path, prompts included.
    await shallowClone('https://code.internal:3000/team/skills.git', path.join(tmp, 'repo'), 'git');

    expect(cloneEnv()).toBeUndefined();
  });

  it('leaves prompting alone when a token provider has no token to offer', async () => {
    delete process.env.GITLAB_TOKEN;
    delete process.env.GITLAB_PRIVATE_TOKEN;
    delete process.env.GITLAB_PAT;
    await shallowClone('https://gitlab.example.com/org/repo.git', path.join(tmp, 'repo'), 'gitlab');

    expect(cloneEnv()).toBeUndefined();
  });
});
