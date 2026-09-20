import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// NOTE: no vi.mock('node:child_process') here — this file exercises a REAL git
// spawn, and reads back what that process was handed from git's own trace2 log
// (see the GIT_TRACE2_EVENT comment below). A PATH-injected fake `git` cannot
// stand in for it on Windows: an extension-less shell script is not an executable
// CreateProcess will start, and `spawnSync` refuses a `.cmd`/`.bat` shim with
// EINVAL. A shim that silently fails to intercept is exactly how this test used
// to clone gitlab.com for real.
import { gitlabRepoClone } from '../providers/gitlab/gitlab-api.js';

/** Nothing listens on 127.0.0.1:1, so the clone fails without touching the network. */
const UNREACHABLE_PORT = 1;
const TOKEN = 'glpat_e2e_secret';

describe('gitlabRepoClone — real spawn (e2e)', () => {
  let tmp: string;
  let traceFile: string;
  const origEnv = { ...process.env };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-clone-e2e-'));
    traceFile = path.join(tmp, 'trace.json');
    // Test-local git config: a developer's proxy must not absorb the loopback
    // clone (that would hang instead of failing), and no credential helper may
    // answer it.
    const gitConfig = path.join(tmp, 'gitconfig');
    fs.writeFileSync(gitConfig, '[http]\n\tproxy =\n[credential]\n\thelper =\n');
    process.env.GIT_CONFIG_GLOBAL = gitConfig;
    process.env.GITLAB_URL = `http://127.0.0.1:${UNREACHABLE_PORT}`;
    process.env.GITLAB_TOKEN = TOKEN;
    // git records its own argv — `-c` options included — in this trace2 event log,
    // which is what the assertions read. Unlike a fake git on PATH, the recorder
    // cannot be bypassed silently: no log means no spawn, and the test fails.
    process.env.GIT_TRACE2_EVENT = traceFile;
  });

  afterEach(() => {
    process.env = { ...origEnv };
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** argv of the top-level git process, as the real binary recorded it. */
  function recordedArgv(): string[] {
    const starts = fs
      .readFileSync(traceFile, 'utf-8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { event?: string; sid?: string; argv?: string[] })
      // Children (git-remote-http, credential helpers) carry a "/"-suffixed sid.
      .filter((event) => event.event === 'start' && event.argv && !event.sid?.includes('/'));
    expect(starts.length, 'git recorded no start event — did a real git run?').toBe(1);
    return starts[0].argv!;
  }

  it('never passes the token in the clone URL/argv and reports a clean error', () => {
    let err: Error | null = null;
    try {
      gitlabRepoClone('org/repo', path.join(tmp, 'dest'));
    } catch (e) {
      err = e as Error;
    }

    const argv = recordedArgv();
    const urlArg = argv.find((a) => a.endsWith('.git'));
    const expectedUrl = `http://127.0.0.1:${UNREACHABLE_PORT}/org/repo.git`;
    expect(urlArg).toBe(expectedUrl);

    // Token travels only inside the http.extraHeader arg (base64), never plaintext
    // and never in the URL.
    const headerArg = argv.find((a) => a.startsWith('http.extraHeader=Authorization: Basic '));
    expect(headerArg).toBeDefined();
    const decoded = Buffer.from(headerArg!.slice('http.extraHeader=Authorization: Basic '.length), 'base64').toString('utf-8');
    expect(decoded).toBe(`oauth2:${TOKEN}`);
    expect(urlArg).not.toContain(TOKEN);
    expect(urlArg).not.toContain('oauth2:');
    // git's record of every process it spawned holds the token nowhere in plaintext.
    expect(fs.readFileSync(traceFile, 'utf-8')).not.toContain(TOKEN);

    // The clone reached the endpoint, failed, and reported the failure with the
    // URL that failed — no token, no credential prompt (the guard env and the
    // provider's own suppression are what keep this run interactive-free).
    expect(err).not.toBeNull();
    expect(err!.message).toContain('git clone failed:');
    expect(err!.message).toContain(expectedUrl);
    expect(err!.message).not.toContain(TOKEN);
  });
});
