import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inlinesRulesIntoInstructions } from '../resources/rule-format.js';
import { injectRecallBlockIntoTools } from '../pull.js';
import { scopedToolPaths, TeamaiConfigSchema } from '../types.js';
import type { LocalConfig } from '../types.js';

// Codex loads instructions only from AGENTS.md; `.codex/rules/` holds Starlark
// command policies, so team rules must be inlined rather than copied (#40).
describe('Codex team rules', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('ships Codex without a rules dir, reading ~/.codex/AGENTS.md or the project-root AGENTS.md', () => {
    const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });

    expect(config.toolPaths.codex).not.toHaveProperty('rules');
    expect(scopedToolPaths(config, { scope: 'user' }).codex.claudemd).toBe('.codex/AGENTS.md');
    expect(scopedToolPaths(config, { scope: 'project' }).codex.claudemd).toBe('AGENTS.md');
    expect(inlinesRulesIntoInstructions('codex')).toBe(true);
  });

  it('injects the recall block into ~/.codex/AGENTS.md but not the shared project-root AGENTS.md', async () => {
    const root = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-codex-recall-'));
    try {
      const projectRoot = path.join(root, 'project');
      await fse.ensureDir(path.join(projectRoot, '.codex', 'agents'));
      const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });
      const toolPaths = { codex: config.toolPaths.codex };
      const projectLocal = {
        scope: 'project', projectRoot, recallEnabled: true,
        repo: { localPath: path.join(root, 'repo'), remote: 'r' }, username: 'u', additionalRoles: [],
      } as unknown as LocalConfig;

      await injectRecallBlockIntoTools({ ...config, toolPaths }, projectLocal, 'project');
      expect(await fse.pathExists(path.join(projectRoot, 'AGENTS.md'))).toBe(false);

      const homeDir = path.join(root, 'home');
      await fse.ensureDir(path.join(homeDir, '.codex', 'agents'));
      vi.stubEnv('HOME', homeDir);
      await injectRecallBlockIntoTools({ ...config, toolPaths }, { ...projectLocal, scope: 'user' } as LocalConfig, 'user');
      expect(await fse.readFile(path.join(homeDir, '.codex', 'AGENTS.md'), 'utf-8')).toContain('[teamai:recall-rules:start]');
    } finally {
      await fse.remove(root);
    }
  });
});
