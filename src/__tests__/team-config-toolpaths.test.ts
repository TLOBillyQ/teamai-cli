import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadTeamConfig } from '../config.js';
import { DEFAULT_TOOL_PATHS } from '../types.js';

// loadTeamConfig is the seam every consumer (pull, hooks, doctor, status,
// uninstall, push scanning) reads toolPaths through, so the merge must already
// be applied to what it returns — including YAML's `~` / empty-value nulls,
// which keep the default rather than removing anything.
describe('loadTeamConfig toolPaths', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-toolpaths-'));
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  async function load(yaml: string) {
    await fs.writeFile(path.join(repo, 'teamai.yaml'), yaml);
    const config = await loadTeamConfig(repo);
    expect(config).not.toBeNull();
    return config!.toolPaths;
  }

  it('merges a one-field override from teamai.yaml over the defaults', async () => {
    const toolPaths = await load([
      'team: t',
      'repo: https://example.com/t.git',
      'toolPaths:',
      '  claude:',
      '    skills: .claude/custom-skills',
      '',
    ].join('\n'));
    expect(toolPaths.claude).toEqual({ ...DEFAULT_TOOL_PATHS.claude, skills: '.claude/custom-skills' });
    expect(toolPaths.codex).toEqual(DEFAULT_TOOL_PATHS.codex);
    expect(toolPaths.kimi).toEqual(DEFAULT_TOOL_PATHS.kimi);
  });

  it('removes a tool or field set to false', async () => {
    const toolPaths = await load([
      'team: t',
      'repo: https://example.com/t.git',
      'toolPaths:',
      '  kimi: false',
      '  claude:',
      '    rules: false',
      '',
    ].join('\n'));
    expect(toolPaths).not.toHaveProperty('kimi');
    expect(toolPaths.claude).not.toHaveProperty('rules');
    expect(toolPaths.claude.skills).toBe('.claude/skills');
  });

  it('keeps the default for a YAML null (~, an empty value, or only comments)', async () => {
    const toolPaths = await load([
      'team: t',
      'repo: https://example.com/t.git',
      'toolPaths:',
      '  kimi: ~',
      '  dsh:',
      '  codex:',
      '    # rules: .codex/other-rules',
      '  claude:',
      '    rules: null',
      '',
    ].join('\n'));
    expect(toolPaths).toEqual(DEFAULT_TOOL_PATHS);
  });

  it('treats a toolPaths key with every entry commented out as no overrides', async () => {
    const toolPaths = await load([
      'team: t',
      'repo: https://example.com/t.git',
      'toolPaths:',
      '  # claude:',
      '  #   skills: .claude/custom-skills',
      '',
    ].join('\n'));
    expect(toolPaths).toEqual(DEFAULT_TOOL_PATHS);
  });

  it('resolves exactly the built-in table when teamai.yaml has no toolPaths', async () => {
    const toolPaths = await load('team: t\nrepo: https://example.com/t.git\n');
    expect(toolPaths).toEqual(DEFAULT_TOOL_PATHS);
  });
});
