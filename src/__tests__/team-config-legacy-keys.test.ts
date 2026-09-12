import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadTeamConfig } from '../config.js';

// Team repos are shared across CLI versions, so teamai.yaml files written for an
// older CLI must keep loading after a key is removed from the schema.
describe('loadTeamConfig with removed legacy keys', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-legacy-keys-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('loads a teamai.yaml that still sets sharing.rules.enforced and drops the key', async () => {
    fs.writeFileSync(
      path.join(dir, 'teamai.yaml'),
      [
        'team: legacy-team',
        'repo: https://git.example.test/e2e/team.git',
        'provider: git',
        'sharing:',
        '  rules:',
        '    enforced: [code-review-guide]',
        '  docs:',
        '    localDir: ~/.teamai/docs',
        '',
      ].join('\n'),
    );

    const config = await loadTeamConfig(dir);

    expect(config).not.toBeNull();
    expect(config?.team).toBe('legacy-team');
    expect(config?.sharing.docs.localDir).toBe('~/.teamai/docs');
    expect(config?.sharing).not.toHaveProperty('rules');
  });

  // `scope` used to be an enum, so `scope: global` made the whole teamai.yaml invalid.
  it('loads a teamai.yaml that still sets scope: global and drops the key', async () => {
    fs.writeFileSync(
      path.join(dir, 'teamai.yaml'),
      [
        'team: legacy-team',
        'repo: https://git.example.test/e2e/team.git',
        'provider: git',
        'scope: global',
        '',
      ].join('\n'),
    );

    const config = await loadTeamConfig(dir);

    expect(config).not.toBeNull();
    expect(config?.team).toBe('legacy-team');
    expect(config).not.toHaveProperty('scope');
  });
});
