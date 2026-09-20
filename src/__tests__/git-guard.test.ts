import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';

/**
 * Issue #49: the overlay in `setup/git-guard.ts` is what stops a test that
 * escapes its isolation (a real remote, a real clone) from blocking the run on a
 * credential dialog. Assert it is still registered — a missing `setupFiles`
 * entry, or an overlay a later change neutralised, would otherwise only show up
 * as a hung test on a developer's machine.
 */

/** Run git with the suite's env, but ask for messages in English (asserted below). */
function git(args: string[], input?: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('git', args, {
    encoding: 'utf-8',
    windowsHide: true,
    timeout: 20_000,
    input,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
  expect(result.error, `failed to run git: ${result.error?.message}`).toBeUndefined();
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

describe('suite-wide git guard (issue #49)', () => {
  it('carries the non-interactive overlay for git spawned with the suite environment', () => {
    expect(process.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(process.env.GIT_ASKPASS).toBe('');
    // The helper/askpass resets travel through GIT_CONFIG_* because config files
    // are where a machine installs its GUI helper (`manager` on a stock Windows
    // Git). `git config` cannot show the reset — it is applied by the credential
    // code path — so the next test asserts the behaviour instead. A test that
    // hands its own GIT_CONFIG_* vars to a child would replace these two keys
    // (GIT_TERMINAL_PROMPT survives that); none of them reaches a remote.
    expect(process.env.GIT_CONFIG_KEY_0).toBe('credential.helper');
    expect(process.env.GIT_CONFIG_VALUE_0).toBe('');
    expect(process.env.GIT_CONFIG_KEY_1).toBe('core.askPass');
    expect(process.env.GIT_CONFIG_VALUE_1).toBe('');
  });

  it('fails a credential lookup instead of prompting for one', () => {
    // `git credential fill` is the local half of any authenticated https clone:
    // it consults helpers, then askpass, then the terminal. With the guard in
    // place each of those is gone, so it comes straight back with git's error —
    // without the guard this call blocks until a human answers a dialog.
    const { stdout, stderr, status } = git(
      ['credential', 'fill'],
      'protocol=https\nhost=gitlab.example.com\n\n',
    );
    expect(stderr).toMatch(/terminal prompts disabled/i);
    expect(status).not.toBe(0);
    expect(stdout.trim()).toBe('');
  });
});
