import path from 'node:path';
import matter from 'gray-matter';
import { isToolInstalledForConfig, ResourceHandler } from './base.js';
import { mergeManagedBlock } from '../utils/claudemd.js';
import type { ResourceItem, ResourceItemStatus, DeliveryTarget, TeamaiConfig, LocalConfig } from '../types.js';
import { listFilesRecursive, pathExists, copyFile, ensureDir, remove, fileContentEqual, getFileMtime, listDirs, readFileSafe, writeFile } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { TEAMAI_RULES_START, TEAMAI_RULES_END, resolveBaseDir, resolveToolBaseDir, isAgentExcluded, scopedToolPaths } from '../types.js';
import { EXCLUDED_RULE_NAMES } from '../builtin-rules.js';
import { teamRuleToCursorMdc, mergeCursorBodyIntoTeamMd, cursorMdcBodyEqualsTeamMd } from './cursor-mdc.js';
import {
  copilotInstructionsBodyEqualsTeamMd,
  mergeCopilotBodyIntoTeamMd,
  teamRuleToCopilotInstructions,
} from './copilot-instructions.js';
import { assertWithinRoot } from '../utils/path-safety.js';
import {
  ruleFileExtensionForTool,
  ruleStemFromFilename,
  usesCursorMdcRules,
  usesCopilotInstructions,
  isLegacyCursorRuleFile,
  inlinesRulesIntoInstructions,
  instructionInstallRoot,
  legacyInlineRulesDir,
} from './rule-format.js';

export class RulesHandler extends ResourceHandler {
  readonly type = 'rules' as const;

  /**
   * Scan for local rule .md files that are new or modified compared to the team repo.
   * Looks in ALL tool's configured rules/ directories and compares each against the
   * team repo version. When multiple tool dirs have a modified copy, picks the one
   * with the latest mtime.
   */
  async scanLocalForPush(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<ResourceItem[]> {
    const teamRulesDir = path.join(localConfig.repo.localPath, 'rules');
    // Recursively list team repo rules to support subdirectories
    const teamRules = new Set(
      (await pathExists(teamRulesDir))
        ? (await listFilesRecursive(teamRulesDir)).filter((f) => f.endsWith('.md'))
        : [],
    );

    // Read tombstones to skip previously deleted resources
    const tombstones = await this.readTombstones(localConfig);

    // Collect the best candidate for each rule name across all tool directories
    const candidates = new Map<string, { sourcePath: string; mtime: number; status: ResourceItemStatus }>();
    // One read per team rule, shared across every tool dir that compares against it.
    const teamContentCache = new Map<string, string>();
    const readTeamRule = async (filePath: string): Promise<string> => {
      const cached = teamContentCache.get(filePath);
      if (cached !== undefined) return cached;
      const content = (await readFileSafe(filePath)) ?? '';
      teamContentCache.set(filePath, content);
      return content;
    };

    // Scan each tool's rules/ directory (recursively)
    for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
      const rulesPath = toolPath.rules;
      if (!rulesPath) continue;
      const rulesDir = path.join(resolveToolBaseDir(tool, localConfig), rulesPath);
      if (!await pathExists(rulesDir)) continue;

      // Some tools require native rule extensions and derived frontmatter.
      const ext = ruleFileExtensionForTool(tool);
      const isMdcTool = usesCursorMdcRules(tool);
      const isCopilotTool = usesCopilotInstructions(tool);

      const files = await listFilesRecursive(rulesDir);
      for (const file of files) {
        if (!file.endsWith(ext)) continue;
        // name includes subdirectory path, e.g. "common/coding-standards"
        const name = file.slice(0, -ext.length);
        if (tombstones.has(name)) continue;
        if (EXCLUDED_RULE_NAMES.has(name)) continue; // Skip CLI built-in and legacy rules

        const localFilePath = path.join(rulesDir, file);
        // Team repo always stores `.md`, keyed by rule name.
        const teamFileName = `${name}.md`;

        if (teamRules.has(teamFileName)) {
          // File exists in team repo — check if content differs
          const teamFilePath = path.join(teamRulesDir, teamFileName);
          // For native formats, compare markdown bodies only: frontmatter is
          // machine-derived on pull, so a clean round trip is not a change.
          const localRule = (await readFileSafe(localFilePath)) ?? '';
          const teamRule = await readTeamRule(teamFilePath);
          const equal = isMdcTool
            ? cursorMdcBodyEqualsTeamMd(
                localRule,
                teamRule,
              )
            : isCopilotTool
              ? copilotInstructionsBodyEqualsTeamMd(localRule, teamRule)
            : await fileContentEqual(localFilePath, teamFilePath);
          if (equal) continue; // This tool dir's copy is identical, skip

          // Content differs — candidate for "modified"
          const mtime = await getFileMtime(localFilePath);
          const existing = candidates.get(name);
          if (!existing || mtime > existing.mtime) {
            candidates.set(name, { sourcePath: localFilePath, mtime, status: 'modified' });
          }
        } else {
          // File does not exist in team repo — candidate for "new".
          // Native rule directories can also contain personal rules created by
          // the target tool. Unknown files there are user-owned and stay local:
          // the .mdc and Copilot-instructions dirs, plus OMP's native rules dir
          // (the same ownership policy the pull-side sweep applies to OMP).
          if (isMdcTool || isCopilotTool || tool === 'omp') continue;
          const existing = candidates.get(name);
          if (!existing) {
            const mtime = await getFileMtime(localFilePath);
            candidates.set(name, { sourcePath: localFilePath, mtime, status: 'new' });
          } else if (existing.status === 'new') {
            // Multiple tool dirs have the same new file — pick latest mtime
            const mtime = await getFileMtime(localFilePath);
            if (mtime > existing.mtime) {
              candidates.set(name, { sourcePath: localFilePath, mtime, status: 'new' });
            }
          }
        }
      }
    }

    // Convert candidates map to items array
    const items: ResourceItem[] = [];
    for (const [name, candidate] of candidates) {
      items.push({
        name,
        type: 'rules',
        sourcePath: candidate.sourcePath,
        relativePath: `rules/${name}.md`,
        status: candidate.status,
      });
    }

    return items;
  }

  async scanTeamForPull(_teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<ResourceItem[]> {
    const rulesDir = path.join(localConfig.repo.localPath, 'rules');
    if (!await pathExists(rulesDir)) return [];

    const files = await listFilesRecursive(rulesDir);
    return files
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({
        name: f.replace(/\.md$/, ''),
        type: 'rules' as const,
        sourcePath: path.join(rulesDir, f),
        relativePath: `rules/${f}`,
      }));
  }

  async pushItem(item: ResourceItem, _teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<void> {
    const rulesRoot = path.join(localConfig.repo.localPath, 'rules');
    const dest = path.resolve(localConfig.repo.localPath, item.relativePath);
    assertWithinRoot(
      rulesRoot,
      dest,
      `Invalid rule destination outside team repo rules directory: ${item.relativePath}`,
    );
    if (item.sourcePath !== dest) {
      if (item.sourcePath.endsWith('.mdc')) {
        // Source is a tool-native `.mdc`. Only its markdown body is pushed: the
        // tool frontmatter is machine-derived, and the team file keeps its own
        // tool-neutral frontmatter (`paths:`, …) — dropping that would silently
        // un-scope the rule for the whole team on the next pull.
        const raw = await readFileSafe(item.sourcePath);
        if (raw === null) {
          // Never turn an unreadable source into an empty team rule.
          throw new Error(`Cannot read rule source ${item.sourcePath}`);
        }
        await writeFile(dest, mergeCursorBodyIntoTeamMd(raw, await readFileSafe(dest)));
      } else if (item.sourcePath.endsWith('.instructions.md')) {
        const raw = await readFileSafe(item.sourcePath);
        if (raw === null) {
          throw new Error(`Cannot read rule source ${item.sourcePath}`);
        }
        await writeFile(dest, mergeCopilotBodyIntoTeamMd(raw, await readFileSafe(dest)));
      } else {
        await copyFile(item.sourcePath, dest);
      }
    }
    log.debug(`Copied rule ${item.name} → team repo`);
  }

  /**
   * Where `item` lands for each tool that receives rules. The filename is
   * tool-dependent — `.md` verbatim, `.mdc` for Cursor-compatible tools,
   * `.instructions.md` for Copilot — so a reader cannot derive it from the
   * rule's name alone.
   */
  async deliveryTargets(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
    item: ResourceItem,
  ): Promise<DeliveryTarget[]> {
    // The bytes as well as the path: Cursor and Copilot read frontmatter this
    // derives from the team `.md`, so a copy whose `globs`, `alwaysApply` or
    // `applyTo` no longer match the source is inert in exactly the way a
    // missing file is. Only a comparison against the render can see that, and
    // the render belongs here rather than in a second copy inside `doctor`.
    const source = await readFileSafe(item.sourcePath);
    const targets: DeliveryTarget[] = [];
    const claudeUsesProjectRules = await this.claudeUsesInlinedProjectRules(teamConfig, localConfig);
    for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
      if (isAgentExcluded(localConfig, tool)) continue;
      if (!toolPath.rules) continue;
      if (tool === 'claude' && claudeUsesProjectRules) continue;

      // Skip tools that are not installed
      if (!await isToolInstalledForConfig(tool, toolPath.rules, localConfig)) {
        log.debug(`Skipping rule sync for ${tool}: tool not installed`);
        continue;
      }

      const destDir = path.join(resolveToolBaseDir(tool, localConfig), toolPath.rules);
      targets.push({
        tool,
        dest: path.join(destDir, `${item.name}${ruleFileExtensionForTool(tool)}`),
        content: source === null ? undefined : renderRuleForTool(tool, source),
      });
    }
    return targets;
  }

  /**
   * Pull a single rule file to all configured AI tool rules/ directories.
   */
  async pullItem(item: ResourceItem, teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<void> {
    for (const { tool, dest, content } of await this.deliveryTargets(teamConfig, localConfig, item)) {
      const destDir = path.dirname(dest);
      try {
        if (content === undefined) {
          // Never write a stub always-on rule in place of an unreadable source.
          throw new Error(`Cannot read rule source ${item.sourcePath}`);
        }
        await ensureDir(destDir);
        await writeFile(dest, content);
        // Drop the `.md` copy left by an older layout; a tool that reads a
        // derived extension does not read it, and it would outlive the rule.
        const legacyCopy = path.join(destDir, `${item.name}.md`);
        if (dest !== legacyCopy) await remove(legacyCopy);
        log.debug(`Synced rule ${item.name} → ${tool}`);
      } catch (e) {
        log.warn(`Failed to sync rule ${item.name} to ${tool}: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Remove a rule from the team repo and all local AI tool rules/ directories.
   */
  async removeItem(name: string, teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<string[]> {
    const removed: string[] = [];

    // Remove from team repo (always `.md`)
    const teamFile = path.join(localConfig.repo.localPath, 'rules', `${name}.md`);
    if (await pathExists(teamFile)) {
      await remove(teamFile);
      removed.push(teamFile);
    }

    // Record tombstone so the resource won't be re-pushed
    await this.addTombstone(name, localConfig);

    // Remove from each tool's rules directory. `.mdc` tools may have an older
    // teamai layout wrote `.md` there, so both are removed — otherwise `remove`
    // would report success while leaving the rule on disk.
    for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
      if (!toolPath.rules) continue;
      // Not ours to write to, so not ours to delete from. Same gate as the
      // tombstone pass in pull.
      if (isAgentExcluded(localConfig, tool)) continue;
      const baseDir = resolveToolBaseDir(tool, localConfig);
      const extensions = new Set<string>([ruleFileExtensionForTool(tool), '.md']);
      for (const extension of extensions) {
        const filePath = path.join(baseDir, toolPath.rules, `${name}${extension}`);
        if (await pathExists(filePath)) {
          await remove(filePath);
          removed.push(filePath);
          log.debug(`Removed rule ${name} from ${tool}`);
        }
      }
    }

    // Refresh CLAUDE.md references
    await this.pullAllRules(teamConfig, localConfig);

    return removed;
  }

  /**
   * Distribute rule files to each tool's rules/ directory, then update
   * CLAUDE.md with a lightweight reference list instead of inlining content.
   */
  async pullAllRules(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
    filteredRules?: ResourceItem[],
  ): Promise<void> {
    const rules = filteredRules ?? await this.scanTeamForPull(teamConfig, localConfig);

    // Hermes: inline all team rules into a teamai-managed block in SOUL.md
    // (user-level standing instructions). Only when Hermes is actually
    // installed — never create ~/.hermes for users who don't use it.
    if (!isAgentExcluded(localConfig, 'hermes')) {
      const { getHermesHome } = await import('../hermes-home.js');
      if (await pathExists(getHermesHome())) {
        const { upsertSoulRules } = await import('../hermes-config.js');
        await upsertSoulRules(await hermesRulesText(rules));
      }
    }

    // OpenCode does not auto-scan a rules directory: the .md files are inert
    // until referenced from `instructions` in opencode.json. Activate (or, when
    // there are no team rules, deactivate) that glob. Runs before the empty-set
    // early return so removing the last rule also removes the glob.
    await this.activateOpencodeInstructions(teamConfig, localConfig, rules.length > 0);

    // Kimi Code CLI, ZCode and Codex have no rules directory: inline the rule
    // bodies into a managed block of their AGENTS.md. Also before the early
    // return so the block disappears when the team's last rule is removed.
    await this.inlineRulesIntoInstructionFiles(teamConfig, localConfig, rules);
    await this.removeLegacyInlineRuleCopies(teamConfig, localConfig, rules);

    // Claude loads the root AGENTS.md through @AGENTS.md. Remove team rule
    // copies from its rules directory when that file already has the same block.
    if (await this.claudeUsesInlinedProjectRules(teamConfig, localConfig)) {
      const claudeRules = scopedToolPaths(teamConfig, localConfig).claude?.rules;
      if (claudeRules) {
        const dir = path.join(resolveBaseDir(localConfig), claudeRules);
        for (const rule of rules) await remove(path.join(dir, `${rule.name}.md`));
        await this.removeEmptyDirs(dir);
      }
    }

    // Empty set = the team has no rules right now. We deliberately do NOT run the
    // aggressive stale-file cleanup below in that case, because it would treat a
    // user's own personal rule files as stale and delete them. Explicit team
    // removals are handled by the tombstone cleanup in pull.ts instead. The
    // OpenCode glob deactivation above still runs, so the (now unmanaged) rules
    // stop being auto-loaded.
    if (rules.length === 0) return;

    // 1. Distribute rule files to each tool's rules/ directory
    for (const rule of rules) {
      await this.pullItem(rule, teamConfig, localConfig);
    }

    // 1.5. Clean up stale local rule files not present in team repo
    const teamRuleNames = new Set(rules.map((r) => r.name));
    const tombstones = await this.readTombstones(localConfig);
    for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
      if (!toolPath.rules) continue;
      // `pullItem` above skips excluded tools, so this pass must skip them too.
      // Without it the stale sweep deletes from a directory teamai never wrote.
      if (isAgentExcluded(localConfig, tool)) continue;
      if (!await isToolInstalledForConfig(tool, toolPath.rules, localConfig)) continue;

      const baseDir = resolveToolBaseDir(tool, localConfig);
      const destDir = path.join(baseDir, toolPath.rules);
      if (!await pathExists(destDir)) continue;

      const ext = ruleFileExtensionForTool(tool);
      const localFiles = await listFilesRecursive(destDir);
      for (const localFile of localFiles) {
        const ruleName = ruleStemFromFilename(localFile);
        if (ruleName === null) continue;

        // JoyCode's, OMP's, and Copilot's rules directories are shared with
        // user-authored rules (OMP's native rules dirs are exactly where its
        // users keep personal rules). Absence from the current team set is not
        // proof of TeamAI ownership (including legacy .md files). Only explicit
        // team removals authorize cleanup. Cursor is deliberately absent —
        // teamai owns .cursor/rules and sweeps it.
        if ((tool === 'joycode' || tool === 'omp' || usesCopilotInstructions(tool)) && !tombstones.has(ruleName)) continue;

        // `.mdc` tools only read `.mdc`, so any `.md` here is inert leftover from the
        // layout that predates it — removed whether or not the rule is still
        // active, and ahead of the built-in check, since built-ins now deploy to
        // target tool as `.mdc` too.
        if (isLegacyCursorRuleFile(tool, localFile)) {
          await remove(path.join(destDir, localFile));
          log.debug(`Removed legacy .md rule ${localFile} from ${tool}`);
          continue;
        }

        if (!localFile.endsWith(ext)) continue;
        // Skip built-in and legacy rules (managed by CLI, not team repo)
        if (EXCLUDED_RULE_NAMES.has(ruleName)) continue;
        if (!teamRuleNames.has(ruleName)) {
          const fullPath = path.join(destDir, localFile);
          await remove(fullPath);
          log.debug(`Removed stale rule ${localFile} from ${tool}`);
        }
      }

      // Clean up empty subdirectories
      await this.removeEmptyDirs(destDir);
    }

    // 2. Remove legacy rules section from CLAUDE.md (no longer injected). Files
    // that get rules inlined use the same markers on purpose, so they are
    // excluded by path — the workspace-root AGENTS.md can belong to ZCode and
    // to a non-inlining tool (WorkBuddy, Hermes) at the same time.
    const inlinedFiles = new Set((await this.inlineRuleTargets(teamConfig, localConfig)).map((t) => t.filePath));
    for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
      if (!toolPath.claudemd) continue;
      const baseDir = resolveToolBaseDir(tool, localConfig);
      const claudeMdPath = path.join(baseDir, toolPath.claudemd);
      if (inlinedFiles.has(claudeMdPath)) continue;
      try {
        const content = await readFileSafe(claudeMdPath);
        if (!content || !content.includes(TEAMAI_RULES_START)) continue;
        const startIdx = content.indexOf(TEAMAI_RULES_START);
        const endIdx = content.indexOf(TEAMAI_RULES_END);
        if (startIdx === -1 || endIdx === -1) continue;
        const before = content.substring(0, startIdx).replace(/\n+$/, '\n');
        const after = content.substring(endIdx + TEAMAI_RULES_END.length).replace(/^\n+/, '\n');
        const newContent = (before + after).trim();
        if (newContent.length === 0) {
          await remove(claudeMdPath);
        } else {
          await writeFile(claudeMdPath, newContent + '\n');
        }
        log.debug(`Removed legacy rules section from ${claudeMdPath}`);
      } catch {
        // Best-effort cleanup
      }
    }
  }

  /**
   * Inline every team rule body into a teamai-managed block of the instructions
   * file (`claudemd`) of tools that have no rules directory (Kimi Code CLI,
   * ZCode). An empty rule set removes the block. Only touches tools that are
   * installed for this scope — never creates `.kimi-code/` or `.zcode/` for
   * someone who doesn't use them.
   */
  private async inlineRulesIntoInstructionFiles(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
    rules: ResourceItem[],
  ): Promise<void> {
    let bodies: string[] | null = null;

    for (const { tool, filePath } of await this.inlineRuleTargets(teamConfig, localConfig)) {
      if (bodies === null) {
        bodies = [];
        for (const rule of rules) {
          const raw = await readFileSafe(rule.sourcePath);
          if (raw === null) continue;
          // Team rules may carry tool-neutral frontmatter (`paths:` …) that means
          // nothing inside a system prompt; keep only the markdown body. Marker
          // lines inside a rule would corrupt the block boundary, so drop them.
          const body = matter(raw).content
            .split('\n')
            .filter((line) => line.trim() !== TEAMAI_RULES_START && line.trim() !== TEAMAI_RULES_END)
            .join('\n')
            .trim();
          if (body !== '') bodies.push(body);
        }
      }

      const blockBody = bodies.length > 0
        ? ['<!-- DO NOT EDIT: This section is auto-managed by teamai -->', '', ...bodies.flatMap((b) => [b, ''])].join('\n')
        : '';
      try {
        const existing = (await readFileSafe(filePath)) ?? '';
        const merged = mergeManagedBlock(existing, TEAMAI_RULES_START, TEAMAI_RULES_END, blockBody);
        if (merged === existing.trim()) continue;
        if (merged === '') {
          if (await pathExists(filePath)) await remove(filePath);
        } else {
          await ensureDir(path.dirname(filePath));
          await writeFile(filePath, merged + '\n');
        }
        log.debug(`Inlined ${bodies.length} rule(s) into ${tool} instructions at ${filePath}`);
      } catch (e) {
        log.warn(`Failed to inline rules into ${tool} instructions at ${filePath}: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Delete the `.md` rule copies older teamai versions wrote into the rules
   * directory of a tool that now gets rules inlined (Codex's `.codex/rules/`).
   * Only files named after a current team rule, a tombstoned rule, or a CLI
   * built-in are teamai's; Starlark `.rules` files and user notes stay.
   */
  private async removeLegacyInlineRuleCopies(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
    rules: ResourceItem[],
  ): Promise<void> {
    const baseDir = resolveBaseDir(localConfig);
    let owned: Set<string> | null = null;

    for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
      if (!inlinesRulesIntoInstructions(tool)) continue;
      if (isAgentExcluded(localConfig, tool)) continue;
      const legacyDir = legacyInlineRulesDir(tool, toolPath);
      if (!legacyDir) continue;
      const dir = path.join(baseDir, legacyDir);
      if (!await pathExists(dir)) continue;

      owned ??= new Set([
        ...rules.map((r) => r.name),
        ...await this.readTombstones(localConfig),
        ...EXCLUDED_RULE_NAMES,
      ]);
      for (const file of await listFilesRecursive(dir)) {
        const ruleName = ruleStemFromFilename(file);
        if (!ruleName || !owned.has(ruleName)) continue;
        await remove(path.join(dir, file));
        log.debug(`Removed legacy rule copy ${file} from ${tool}`);
      }
      await this.removeEmptyDirs(dir);
    }
  }

  /**
   * Instructions files that receive inlined rules in this scope: enabled
   * inline tools whose install root (e.g. `.zcode/`) exists. Gating on the
   * install root rather than the file matters when `claudemd` is the shared
   * workspace-root AGENTS.md, which exists in projects that don't use the tool.
   */
  private async inlineRuleTargets(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
  ): Promise<Array<{ tool: string; filePath: string }>> {
    const baseDir = resolveBaseDir(localConfig);
    const targets: Array<{ tool: string; filePath: string }> = [];
    for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
      if (!inlinesRulesIntoInstructions(tool)) continue;
      if (isAgentExcluded(localConfig, tool)) continue;
      if (!toolPath.claudemd) continue;
      const installRoot = instructionInstallRoot(tool, toolPath) ?? toolPath.claudemd;
      if (!await ResourceHandler.isToolInstalled(installRoot, baseDir)) continue;
      targets.push({ tool, filePath: path.join(baseDir, toolPath.claudemd) });
    }
    return targets;
  }

  private async claudeUsesInlinedProjectRules(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
  ): Promise<boolean> {
    if (localConfig.scope !== 'project' || isAgentExcluded(localConfig, 'claude')) return false;
    const root = resolveBaseDir(localConfig);
    const claudeMd = await readFileSafe(path.join(root, 'CLAUDE.md'));
    if (!claudeMd || !/(^|\s)@AGENTS\.md(?=\s|$)/m.test(claudeMd)) return false;
    const agentsMd = path.join(root, 'AGENTS.md');
    if (!(await this.inlineRuleTargets(teamConfig, localConfig)).some((target) => target.filePath === agentsMd)) return false;
    return (await readFileSafe(agentsMd))?.includes(TEAMAI_RULES_START) ?? false;
  }

  /** Whether local Claude rule copies need reconciling after a skipped pull. */
  async needsClaudeProjectRuleRefresh(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
    rules: ResourceItem[],
  ): Promise<boolean> {
    const claudeRules = scopedToolPaths(teamConfig, localConfig).claude?.rules;
    if (localConfig.scope !== 'project' || !claudeRules || isAgentExcluded(localConfig, 'claude')
      || !await isToolInstalledForConfig('claude', claudeRules, localConfig)) return false;
    const inlined = await this.claudeUsesInlinedProjectRules(teamConfig, localConfig);
    const dir = path.join(resolveBaseDir(localConfig), claudeRules);
    for (const rule of rules) {
      if (await pathExists(path.join(dir, `${rule.name}.md`)) === inlined) return true;
    }
    return false;
  }

  /**
   * Add or remove the teamai rules glob in OpenCode's opencode.json `instructions`
   * array, so copied rule files are actually loaded. No-op for any tool other than
   * opencode, when opencode is disabled, or when opencode is not installed (we
   * never create an opencode.json for a user who doesn't use OpenCode).
   */
  private async activateOpencodeInstructions(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
    present: boolean,
  ): Promise<void> {
    const target = await this.opencodeInstructionsTarget(teamConfig, localConfig);
    if (target === null) return;

    const { reconcileOpencodeInstructions } = await import('./opencode-config.js');
    try {
      await reconcileOpencodeInstructions(target.configFile, target.glob, present);
    } catch (e) {
      log.warn(`Failed to update OpenCode instructions in ${target.configFile}: ${(e as Error).message}`);
    }
  }

  /**
   * The opencode.json this scope activates rules through, and the one glob
   * teamai owns inside it. Null when OpenCode receives no rules here:
   * excluded, not installed, or configured without a rules or config path.
   *
   * Read-only, and public for the same reason `deliveryTargets` is: OpenCode
   * does not auto-scan its rules directory, so a `.md` sitting there is inert
   * until this glob references it. A check that derived the path a second time
   * could look at a different file than the pull writes (#624).
   */
  async opencodeInstructionsTarget(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
  ): Promise<{ configFile: string; glob: string } | null> {
    if (isAgentExcluded(localConfig, 'opencode')) return null;
    const paths = scopedToolPaths(teamConfig, localConfig)['opencode'];
    if (!paths?.rules) return null;

    const baseDir = resolveBaseDir(localConfig);
    // Only touch opencode.json when OpenCode is actually installed for this scope.
    if (!await ResourceHandler.isToolInstalled(paths.rules, baseDir)) return null;

    // The config file mirrors the MCP scope fields: <root>/opencode.json in
    // project scope, ~/.config/opencode/opencode.json in user scope.
    const configRel = localConfig.scope === 'project' ? paths.mcpProject : paths.mcp;
    if (!configRel) return null;

    const configFile = path.join(baseDir, configRel);
    const { opencodeRulesGlob } = await import('./opencode-config.js');
    return { configFile, glob: opencodeRulesGlob(configFile, path.join(baseDir, paths.rules)) };
  }

  /**
   * Recursively remove empty subdirectories under a given directory.
   */
  private async removeEmptyDirs(dir: string): Promise<void> {
    if (!await pathExists(dir)) return;
    const subdirs = await listDirs(dir);
    for (const sub of subdirs) {
      const subPath = path.join(dir, sub);
      await this.removeEmptyDirs(subPath);
      // After cleaning children, check if this dir is now empty
      const remaining = await listFilesRecursive(subPath);
      const remainingDirs = await listDirs(subPath);
      if (remaining.length === 0 && remainingDirs.length === 0) {
        await remove(subPath);
      }
    }
  }
}

/**
 * The bytes a team rule becomes for one tool. `.md` is copied verbatim;
 * Cursor-compatible tools and Copilot read frontmatter derived from the same
 * source, so their file is a render rather than a copy.
 *
 * This is the single spelling of that mapping: `pullItem` writes it and
 * `doctor` compares the delivered file against it, so a stale render is a
 * reported failure rather than a file that merely exists.
 */
function renderRuleForTool(tool: string, source: string): string {
  if (usesCursorMdcRules(tool)) return teamRuleToCursorMdc(source);
  if (usesCopilotInstructions(tool)) return teamRuleToCopilotInstructions(source);
  return source;
}

/**
 * The text `upsertSoulRules` inlines into the teamai block of Hermes SOUL.md.
 *
 * Hermes reads standing instructions from one file rather than a rules
 * directory, so its rules are delivered as this block's contents. `doctor`
 * compares what is in the block with this, the same way it compares a rule
 * file with its render.
 */
export async function hermesRulesText(rules: ResourceItem[]): Promise<string> {
  const bodies: string[] = [];
  for (const rule of rules) {
    const body = await readFileSafe(rule.sourcePath);
    if (body && body.trim() !== '') bodies.push(body.trim());
  }
  return bodies.join('\n\n');
}
