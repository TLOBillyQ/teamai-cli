import path from 'node:path';
import { autoDetectInit, saveLocalConfig, saveLocalConfigForScope } from './config.js';
import { reconcileHooks, hasTeamaiHooks } from './hooks.js';
import {
  OPENCLAW_HOOK_DIR,
  resolveOpenClawHooksDir,
  resolveOpenclawWorkspaceDir,
} from './openclaw-hooks.js';
import {
  TEAMAI_RULES_START,
  TEAMAI_RULES_END,
  TEAMAI_CULTURE_START,
  TEAMAI_CULTURE_END,
  TEAMAI_CLAUDEMD_START,
  TEAMAI_CLAUDEMD_END,
  TEAMAI_RECALL_RULES_START,
  TEAMAI_RECALL_RULES_END,
  TEAMAI_ENV_START,
  TEAMAI_ENV_END,
  getDataHome,
  getManagedHooksPath,
  isAgentExcluded,
  managedMcpManifestPath,
  resolveBaseDir,
  resolveHookScope,
  resolveLegacyProjectHookScope,
  resolveToolBaseDir,
  scopedToolPaths,
  type GlobalOptions,
  type TeamaiConfig,
  type LocalConfig,
  type Scope,
  type ManagedMcpManifest,
} from './types.js';
import { BUILTIN_RULE_NAMES } from './builtin-rules.js';
import { agentStemFromFilename } from './resources/agent-format.js';
import { listTeamAgentDirs } from './resources/agents.js';
import { ResourceHandler, toolInstallRoot } from './resources/base.js';
import {
  inlinesRulesIntoInstructions,
  instructionInstallRoot,
  legacyInlineRulesDir,
  receivesRecallBlock,
  ruleStemFromFilename,
} from './resources/rule-format.js';
import { BUILTIN_AGENT_NAMES } from './builtin-agents.js';
import { BUILTIN_SKILL_NAMES } from './builtin-skills.js';
import {
  pathExists,
  readFileSafe,
  readJson,
  writeFile,
  remove,
  pruneEmptyDirs,
  listDirs,
  listFiles,
  listFilesRecursive,
  expandHome,
} from './utils/fs.js';
import { log } from './utils/logger.js';
import { askConfirmation } from './utils/prompt.js';
import { getUserHome } from './utils/home.js';
import {
  detectShellProfile,
  extractEnvBlock,
  envBlockReferencesDataHome,
  SHELL_PROFILE_CANDIDATE_NAMES,
} from './utils/shell-profile.js';

// ─── Types ─────────────────────────────────────────────

interface UninstallOptions extends GlobalOptions {
  force?: boolean;
  agent?: string;
}

interface RemovalPlan {
  /** Tool settings files that contain teamai hooks (each with the manifest that
   *  recorded its team hooks — HOME/user or a legacy <projectRoot>/project one). */
  hookFiles: Array<{ path: string; tool: string; manifestPath: string }>;
  /** OpenCode teamai plugin files (.opencode/plugin/teamai-*.ts) to delete. */
  opencodeHookScopes: Array<{ baseDir: string; scope: Scope }>;
  /** Instructions files to clean, mapped to block markers another tool still needs. */
  claudeMdFiles: Map<string, Set<string>>;
  /** Skill directories synced from team repo. */
  skillDirs: string[];
  /** Rule .md files synced from team repo (plus CLI built-in rules). */
  ruleFiles: string[];
  /** Built-in agent .md files deployed by the CLI (e.g. teamai-recall). */
  agentFiles: string[];
  /** teamai-managed MCP servers from managed-mcp.json (`tool/server` or `tool:project/server`). */
  mcpServers: string[];
  /** Shell profile paths carrying a teamai env block (usually one, but see #682/#693). */
  shellProfiles: string[];
  /** The .teamai home directory path. */
  teamaiHome: string;
  /** Exact binding files to retire; never recursively remove the data home. */
  bindingFiles: string[];
  projectRoot?: string;
  /** Whether the current binding is retired (all tools, or the last enabled tool). */
  includeShared: boolean;
  /** Whether this removal targets Hermes (clears its SOUL.md block + config.yaml hook). */
  hermesCleanup: boolean;
  /** Tool root directories (e.g. <base>/.cursor) whose removals may leave an
   *  empty shell; pruned at the end if they ended up with no files at all. */
  toolRootsToPrune: string[];
  /** Scope being uninstalled (issue #73: surfaced to the user). */
  scope: Scope;
}

/** Per-tool findings collected during discovery (tool-specific resources only). */
interface ToolResources {
  hookFiles: Array<{ path: string; tool: string; manifestPath: string }>;
  openclawHookDirs: Array<{ hooksDir: string; tool: string }>;
  opencodeHookScopes: Array<{ baseDir: string; scope: Scope }>;
  ompHookFile: string | null;
  /** Kimi Code CLI config.toml carrying teamai `[[hooks]]` entries (user-level, scope-independent). */
  kimiConfigPath: string | null;
  claudeMdFiles: string[];
  skillDirs: string[];
  ruleFiles: string[];
  agentFiles: string[];
}

function hasToolResources(r: ToolResources): boolean {
  return (
    r.hookFiles.length > 0 ||
    r.openclawHookDirs.length > 0 ||
    r.opencodeHookScopes.length > 0 ||
    r.ompHookFile !== null ||
    r.kimiConfigPath !== null ||
    r.claudeMdFiles.length > 0 ||
    r.skillDirs.length > 0 ||
    r.ruleFiles.length > 0 ||
    r.agentFiles.length > 0
  );
}

// ─── Helpers ───────────────────────────────────────────

const CLAUDEMD_MARKER_PAIRS: Array<[string, string]> = [
  [TEAMAI_RULES_START, TEAMAI_RULES_END],
  [TEAMAI_CULTURE_START, TEAMAI_CULTURE_END],
  [TEAMAI_CLAUDEMD_START, TEAMAI_CLAUDEMD_END],
  [TEAMAI_RECALL_RULES_START, TEAMAI_RECALL_RULES_END],
];

/**
 * Collect team repo skill names, handling both flat and namespaced layouts.
 * A directory is a namespace if it does NOT contain SKILL.md.
 */
async function collectTeamSkillNames(repoPath: string): Promise<Set<string>> {
  const teamSkillsDir = path.join(repoPath, 'skills');
  if (!await pathExists(teamSkillsDir)) return new Set();

  const names = new Set<string>();
  const topDirs = await listDirs(teamSkillsDir);

  for (const dir of topDirs) {
    const dirPath = path.join(teamSkillsDir, dir);
    const hasSkillMd = await pathExists(path.join(dirPath, 'SKILL.md'));
    if (hasSkillMd) {
      // Flat skill
      names.add(dir);
    } else {
      // Namespace directory — add sub-skills
      const subDirs = await listDirs(dirPath);
      for (const sub of subDirs) {
        names.add(sub);
      }
    }
  }

  return names;
}

/**
 * Collect team repo rule names (relative paths without .md extension).
 */
async function collectTeamRuleNames(repoPath: string): Promise<Set<string>> {
  const teamRulesDir = path.join(repoPath, 'rules');
  if (!await pathExists(teamRulesDir)) return new Set();

  const files = await listFilesRecursive(teamRulesDir);
  return new Set(
    files
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, '')),
  );
}

/**
 * Collect custom agent names from canonical YAML and legacy Markdown files,
 * at the root and one level of `agents/<namespace>/` (role-scoped agents
 * deploy flattened, so their stems are removal candidates too).
 */
async function collectTeamAgentNames(repoPath: string): Promise<Set<string>> {
  const teamAgentsDir = path.join(repoPath, 'agents');
  if (!await pathExists(teamAgentsDir)) return new Set();

  const names = new Set<string>();
  for (const { dir } of await listTeamAgentDirs(teamAgentsDir)) {
    for (const file of await listFiles(dir)) {
      if (file.endsWith('.yaml') || file.endsWith('.md')) names.add(file.replace(/\.(yaml|md)$/, ''));
    }
  }
  return names;
}

/** Detect hooks cleared to empty arrays — a residue of prior teamai installation. */
function isEmptyHooksResidue(parsed: Record<string, unknown> | null): boolean {
  if (parsed == null || !('hooks' in parsed) || typeof parsed.hooks !== 'object' || parsed.hooks == null) return false;
  const entries = Object.values(parsed.hooks as Record<string, unknown>);
  return entries.length > 0 && entries.every((v) => Array.isArray(v) && v.length === 0);
}

/**
 * OpenCode plugin locations to sweep on uninstall.
 *
 * teamai writes a single plugin into the user dir (`~/.config/opencode/plugin`),
 * so that one is always checked. A project-scope uninstall additionally checks
 * `<projectRoot>/.opencode/plugin`, where an earlier layout wrote a second copy
 * that OpenCode would load alongside the user one.
 */
function opencodePluginTargets(baseDir: string, scope: Scope): Array<{ baseDir: string; scope: Scope }> {
  const home = getUserHome();
  const targets: Array<{ baseDir: string; scope: Scope }> = [{ baseDir: home, scope: 'user' }];
  if (scope === 'project' && path.resolve(baseDir) !== path.resolve(home)) {
    targets.push({ baseDir, scope: 'project' });
  }
  return targets;
}

// ─── Discovery ─────────────────────────────────────────

async function discoverToolResources(
  tool: string,
  toolPath: TeamaiConfig['toolPaths'][string],
  baseDir: string,
  teamSkillNames: Set<string>,
  teamRuleNames: Set<string>,
  teamAgentNames: Set<string>,
  hookTargets: Array<{ baseDir: string; manifestPath: string }>,
  standaloneHookManifestPath: string,
  scope: Scope,
): Promise<ToolResources> {
  const res: ToolResources = {
    hookFiles: [], openclawHookDirs: [], opencodeHookScopes: [], ompHookFile: null, kimiConfigPath: null,
    claudeMdFiles: [], skillDirs: [], ruleFiles: [], agentFiles: [],
  };

  // (a) Hooks — settings.json / hooks.json
  if (tool === 'kimi') {
    // Kimi Code CLI keeps hooks in its user-level config.toml regardless of
    // scope; list it only when teamai entries are actually present.
    const { getKimiConfigPath, hasKimiTeamaiHooks } = await import('./kimi-hooks.js');
    if (await hasKimiTeamaiHooks()) res.kimiConfigPath = getKimiConfigPath();
  } else if (toolPath.hooks) {
    const hooksPath = path.join(baseDir, toolPath.hooks);
    if (await pathExists(hooksPath)
      && (await hasTeamaiHooks(hooksPath, tool, standaloneHookManifestPath)
        || isEmptyHooksResidue(await readJson<Record<string, unknown>>(hooksPath)))) {
      res.hookFiles.push({
        path: hooksPath,
        tool,
        manifestPath: standaloneHookManifestPath,
      });
    }
  } else if (tool === 'opencode') {
    // OpenCode has no settings file; its teamai hooks are plugin .ts files under
    // <base>/.config/opencode/plugin (where teamai writes them) or
    // <base>/.opencode/plugin (a project-scope copy from an earlier layout).
    const { resolveOpencodePluginDir, OPENCODE_HOOK_FILE } = await import('./opencode-hooks.js');
    for (const target of opencodePluginTargets(baseDir, scope)) {
      const pluginDir = resolveOpencodePluginDir(target.baseDir, target.scope);
      if (await pathExists(path.join(pluginDir, OPENCODE_HOOK_FILE))) {
        res.opencodeHookScopes.push(target);
      } else if (await pathExists(pluginDir)) {
        // Agent-hook plugins (teamai-agent-*.ts) may exist without the main hook file.
        const files = await listFilesRecursive(pluginDir);
        if (files.some((f) => path.basename(f).startsWith('teamai-agent-'))) {
          res.opencodeHookScopes.push(target);
        }
      }
    }
  } else if (tool === 'omp') {
    // OMP hooks are a single teamai-managed TS extension in the user agent dir
    // (~/.omp/agent/extensions/teamai-hooks.ts) — the adapter never writes a
    // project copy, so there is just the one place to look.
    const { resolveOmpExtensionsDir, OMP_HOOK_FILE } = await import('./omp-hooks.js');
    const extFile = path.join(resolveOmpExtensionsDir(), OMP_HOOK_FILE);
    if (await pathExists(extFile)) {
      res.ompHookFile = extFile;
    }
  } else if (toolPath.settings) {
    // Hooks live where resolveHookScope injected them (HOME for a non-self
    // project scope, per #370) — plus any legacy <projectRoot> copy. Scan every
    // target and tag each match with the manifest that recorded its team hooks,
    // so removal strips the right entries at each location.
    for (const { baseDir: hookBaseDir, manifestPath } of hookTargets) {
      const settingsPath = path.join(hookBaseDir, toolPath.settings);
      if (await pathExists(settingsPath)
        && (await hasTeamaiHooks(settingsPath, tool, manifestPath)
          || isEmptyHooksResidue(await readJson<Record<string, unknown>>(settingsPath)))) {
        res.hookFiles.push({ path: settingsPath, tool, manifestPath });
      }
    }
  } else {
    // OpenClaw-style agents (no settings file) inject a HOOK.md + handler.ts
    // under <hooksDir>/<OPENCLAW_HOOK_DIR>. Check the default path, the
    // OPENCLAW_STATE_DIR override (imate containers), and the resolved
    // workspace dir — injection now targets `<workspace>/hooks`, so teardown
    // must cover it too, otherwise the hook is orphaned on uninstall.
    const defaultHooksDir = path.join(baseDir, `.${tool}`, 'hooks');
    const resolvedHooksDir = resolveOpenClawHooksDir(tool);
    const dirsToCheck = new Set([defaultHooksDir, resolvedHooksDir]);
    const workspaceDir = await resolveOpenclawWorkspaceDir();
    if (workspaceDir) {
      dirsToCheck.add(path.join(workspaceDir, 'hooks'));
    }
    for (const hooksDir of dirsToCheck) {
      if (await pathExists(path.join(hooksDir, OPENCLAW_HOOK_DIR))) {
        res.openclawHookDirs.push({ hooksDir, tool });
      }
    }
  }

  // (b) CLAUDE.md teamai section blocks
  if (toolPath.claudemd) {
    const claudeMdPath = path.join(baseDir, toolPath.claudemd);
    const content = await readFileSafe(claudeMdPath);
    if (content && CLAUDEMD_MARKER_PAIRS.some(([start]) => content.includes(start))) {
      res.claudeMdFiles.push(claudeMdPath);
    }
  }

  // (c) Skills — only those matching team repo
  if (toolPath.skills) {
    const skillRoots = new Set([path.join(baseDir, toolPath.skills)]);
    if (tool === 'openclaw') {
      const workspaceDir = await resolveOpenclawWorkspaceDir();
      if (workspaceDir) skillRoots.add(path.join(workspaceDir, 'skills'));
    }
    for (const skillsDir of skillRoots) {
      if (await pathExists(skillsDir)) {
        const dirs = await listDirs(skillsDir);
        for (const dir of dirs) {
          if (teamSkillNames.has(dir)) {
            res.skillDirs.push(path.join(skillsDir, dir));
          }
        }
      }
    }
  }

  // (d) Rules — team-synced rules plus CLI built-in rules (teamRuleNames
  // now includes BUILTIN_RULE_NAMES). User-authored rules are left alone.
  // Codex's `.codex/rules/` may still hold `.md` copies from before rules were
  // inlined; the same name match leaves its Starlark `.rules` files alone.
  const rulesPath = toolPath.rules ?? legacyInlineRulesDir(tool, toolPath);
  if (rulesPath) {
    const rulesDir = path.join(baseDir, rulesPath);
    if (await pathExists(rulesDir)) {
      const files = await listFilesRecursive(rulesDir);
      for (const file of files) {
        // Cursor's copies are `.mdc`; match by stem so both extensions are
        // collected and uninstall does not leave team rules behind.
        const ruleName = ruleStemFromFilename(file);
        if (ruleName === null) continue;
        if (teamRuleNames.has(ruleName)) {
          res.ruleFiles.push(path.join(rulesDir, file));
        }
      }
    }
  }

  // (d2) Team-synced custom agents plus CLI built-ins. Native output uses
  // .agent.md for Copilot, .md for most tools, .toml for Codex, and .json for
  // Kiro, so match by stem.
  if (toolPath.agents) {
    const agentsDir = path.join(baseDir, toolPath.agents);
    if (await pathExists(agentsDir)) {
      for (const file of await listFiles(agentsDir)) {
        const name = agentStemFromFilename(path.basename(file));
        if (name === null) continue;
        if (!teamAgentNames.has(name) && !BUILTIN_AGENT_NAMES.has(name)) continue;
        res.agentFiles.push(path.join(agentsDir, file));
      }
    }
  }

  return res;
}

/**
 * For each CLAUDE.md file used by `agentFilter`, the start markers of blocks
 * that other enabled, installed tools pointing at the same file still need:
 * culture and shared instructions for any of them, the rules block for tools
 * that get rules inlined, and the recall block for tools pull injects it for.
 */
async function sharedClaudeMdMarkers(
  scoped: TeamaiConfig['toolPaths'],
  localConfig: LocalConfig,
  baseDir: string,
  agentFilter: string,
): Promise<Map<string, Set<string>>> {
  const target = scoped[agentFilter]?.claudemd;
  const result = new Map<string, Set<string>>();
  if (!target) return result;
  const targetPath = path.join(baseDir, target);

  for (const [tool, toolPath] of Object.entries(scoped)) {
    if (tool === agentFilter || !toolPath.claudemd) continue;
    if (path.join(baseDir, toolPath.claudemd) !== targetPath) continue;
    if (isAgentExcluded(localConfig, tool)) continue;
    // Same gate pull applies before injecting culture / shared instructions:
    // tools without an install root (hermes) are written ungated, so they count.
    const installRoot = instructionInstallRoot(tool, toolPath);
    if (installRoot && !await ResourceHandler.isToolInstalled(installRoot, baseDir)) continue;

    const keep = result.get(targetPath) ?? new Set<string>();
    keep.add(TEAMAI_CULTURE_START);
    keep.add(TEAMAI_CLAUDEMD_START);
    if (inlinesRulesIntoInstructions(tool)) keep.add(TEAMAI_RULES_START);
    if (receivesRecallBlock(toolPath, localConfig.scope)) keep.add(TEAMAI_RECALL_RULES_START);
    result.set(targetPath, keep);
  }
  return result;
}

async function buildRemovalPlan(
  localConfig: LocalConfig,
  teamConfig: TeamaiConfig,
  agentFilter?: string,
): Promise<RemovalPlan> {
  const baseDir = resolveBaseDir(localConfig);
  const teamaiHome = getDataHome(localConfig);
  const standaloneHookManifestPath = getManagedHooksPath(
    localConfig.scope,
    localConfig.projectRoot,
  );

  // Discover team repo resource names for targeted removal. CLI built-in
  // resources (recall agent/rule, share-learnings skill, …) are deployed by
  // the CLI itself rather than synced from the team repo, so fold their names
  // in explicitly — otherwise uninstall leaks them (they match neither the
  // team-repo set nor a user-authored resource).
  const repoPath = localConfig.repo.localPath;
  const teamSkillNames = await collectTeamSkillNames(repoPath);
  for (const name of BUILTIN_SKILL_NAMES) teamSkillNames.add(name);
  const teamRuleNames = await collectTeamRuleNames(repoPath);
  for (const name of BUILTIN_RULE_NAMES) teamRuleNames.add(name);
  const teamAgentNames = await collectTeamAgentNames(repoPath);

  // Discover per-tool resources. Hooks are discovered at the injection target
  // resolveHookScope reports (HOME + user manifest for a non-self project scope,
  // #370) — the previous code scanned <projectRoot>, so uninstall silently left
  // the SessionStart hook live in HOME forever. A legacy <projectRoot> copy from
  // a pre-#370 CLI is swept too, tagged with its project manifest.
  const primaryHookScope = resolveHookScope(localConfig);
  const hookTargets = [primaryHookScope];
  const legacyHookScope = resolveLegacyProjectHookScope(localConfig);
  if (legacyHookScope) hookTargets.push(legacyHookScope);
  const perTool = new Map<string, ToolResources>();
  for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
    perTool.set(
      tool,
      await discoverToolResources(
        tool,
        toolPath,
        resolveToolBaseDir(tool, localConfig),
        teamSkillNames,
        teamRuleNames,
        teamAgentNames,
        hookTargets,
        standaloneHookManifestPath,
        localConfig.scope,
      ),
    );
  }

  // Decide which tools to merge and whether to include shared resources
  let includeShared: boolean;
  let toolsToMerge: string[];
  if (agentFilter) {
    toolsToMerge = [agentFilter];
    const targetRes = perTool.get(agentFilter);
    const targetHasResources = targetRes ? hasToolResources(targetRes) : false;
    // Other tools still have teamai resources → keep shared resources.
    const othersHaveResources = [...perTool.entries()]
      .some(([t, r]) => t !== agentFilter && !isAgentExcluded(localConfig, t) && hasToolResources(r));
    // Remove shared resources only when the target itself has resources AND is
    // the last tool using teamai. Targeting a tool with no teamai resources is a
    // no-op for shared resources; the tool exclusion can still be persisted.
    includeShared = targetHasResources && !othersHaveResources;
  } else {
    toolsToMerge = [...perTool.keys()];
    includeShared = true;
  }

  // Tool roots whose resource removals may leave an empty shell behind (e.g.
  // <base>/.cursor/skills with nothing else under .cursor). Recorded now and
  // pruned after execution, only if they truly end up holding no files (#45).
  const scopedPaths = scopedToolPaths(teamConfig, localConfig);
  const toolRootsToPrune = [...new Set(
    toolsToMerge
      .map((tool) => {
        const paths = scopedPaths[tool];
        const anyPath = paths?.skills ?? paths?.rules ?? paths?.agents ?? paths?.settings ?? paths?.hooks;
        if (!anyPath) return null;
        return path.join(resolveToolBaseDir(tool, localConfig), toolInstallRoot(anyPath));
      })
      .filter((root): root is string => root !== null),
  )];

  const plan: RemovalPlan = {
    hookFiles: [],
    opencodeHookScopes: [],
    claudeMdFiles: new Map(),
    skillDirs: [],
    ruleFiles: [],
    agentFiles: [],
    mcpServers: [],
    shellProfiles: [],
    teamaiHome,
    bindingFiles: includeShared
      ? (await Promise.all(['config.yaml', 'env.sh'].map(async (name) => {
          const file = path.join(teamaiHome, name);
          return await pathExists(file) ? file : null;
        }))).filter((file): file is string => file !== null)
      : [],
    projectRoot: localConfig.projectRoot,
    includeShared,
    hermesCleanup: localConfig.scope === 'user' && toolsToMerge.includes('hermes'),
    toolRootsToPrune,
    scope: localConfig.scope,
  };

  // Merge tool-specific resources for selected tools
  for (const tool of toolsToMerge) {
    const res = perTool.get(tool);
    if (!res) continue;
    plan.hookFiles.push(...res.hookFiles);
    // Machine-wide adapters also dispatch for legacy/unregistered projects.
    // Their ownership cannot be inferred from this binding; retain them.
    plan.opencodeHookScopes.push(...res.opencodeHookScopes.filter((target) => target.scope === 'project'));


    for (const claudeMdPath of res.claudeMdFiles) {
      plan.claudeMdFiles.set(claudeMdPath, new Set());
    }
    plan.skillDirs.push(...res.skillDirs);
    plan.ruleFiles.push(...res.ruleFiles);
    plan.agentFiles.push(...res.agentFiles);
  }

  // A targeted uninstall must not strip blocks another tool still reads from
  // the same file (the workspace-root AGENTS.md is shared by ZCode, WorkBuddy
  // and Hermes). Files left with nothing to strip drop out of the plan.
  if (agentFilter) {
    const scoped = scopedToolPaths(teamConfig, localConfig);
    const keepMarkers = await sharedClaudeMdMarkers(scoped, localConfig, baseDir, agentFilter);
    for (const claudeMdPath of plan.claudeMdFiles.keys()) {
      const keep = keepMarkers.get(claudeMdPath);
      if (!keep) continue;
      const content = (await readFileSafe(claudeMdPath)) ?? '';
      if (CLAUDEMD_MARKER_PAIRS.some(([start]) => !keep.has(start) && content.includes(start))) {
        plan.claudeMdFiles.set(claudeMdPath, keep);
      } else {
        plan.claudeMdFiles.delete(claudeMdPath);
      }
    }
  }

  if (includeShared) {
    // (d3) teamai-managed MCP servers, tracked in managed-mcp.json (same
    // ownership model as hooks). Project scope reads THIS worktree's own
    // per-worktree manifest; user scope reads the single global file.
    const mcpManifestPath = expandHome(
      managedMcpManifestPath(
        getDataHome(localConfig),
        localConfig.scope === 'project' ? localConfig.projectRoot : undefined,
      ),
    );
    const mcpManifest = (await readJson<ManagedMcpManifest>(mcpManifestPath)) ?? {};
    for (const [toolKey, records] of Object.entries(mcpManifest)) {
      for (const rec of records ?? []) {
        if (rec?.name) plan.mcpServers.push(`${toolKey}/${rec.name}`);
      }
    }
    plan.mcpServers.sort();

    // (e) Shell profile env block(s). Scan every profile file teamai could
    // ever have written to, not just the one detectShellProfile() resolves to
    // today: the Windows fix (#682) changed which file `pull` prefers, so a
    // machine last pulled with an older CLI can carry a stale block in a file
    // the current resolution no longer points at, and a plain uninstall would
    // silently leave that managed block behind.
    //
    // A candidate only counts if its block actually names THIS scope's
    // env.sh (envBlockReferencesDataHome) — matching on the marker alone
    // would let this uninstall delete a different scope's still-active block
    // just because it also happens to live in one of the candidate
    // filenames. This check is deliberately looser than doctor's "does it
    // load" check: a legacy block written by a pre-#661/#682 CLI (raw
    // backslashes, or the MSYS drive form) still belongs to this scope and
    // still has to be found and removed, even though it never worked.
    const configuredProfilePath = teamConfig.sharing.env.shellProfilePath
      ? expandHome(teamConfig.sharing.env.shellProfilePath)
      : await detectShellProfile();
    const home = getUserHome();
    const envShPath = path.join(getDataHome(localConfig), 'env.sh');
    const candidateProfilePaths = Array.from(new Set([
      configuredProfilePath,
      ...SHELL_PROFILE_CANDIDATE_NAMES.map((name) => path.join(home, name)),
    ]));
    for (const candidate of candidateProfilePaths) {
      const profileContent = await readFileSafe(candidate);
      const block = profileContent ? extractEnvBlock(profileContent) : null;
      if (block && envBlockReferencesDataHome(block, envShPath)) {
        plan.shellProfiles.push(candidate);
      }
    }

    // The docs destination may contain personal files or be shared by scopes.
    // Without a per-file ownership manifest it is not a recursive removal target.
  }

  return plan;
}

// ─── Summary ───────────────────────────────────────────

function isPlanEmpty(plan: RemovalPlan): boolean {
  return (
    plan.hookFiles.length === 0 &&
    plan.opencodeHookScopes.length === 0 &&
    plan.claudeMdFiles.size === 0 &&
    plan.skillDirs.length === 0 &&
    plan.ruleFiles.length === 0 &&
    plan.agentFiles.length === 0 &&
    plan.mcpServers.length === 0 &&
    plan.shellProfiles.length === 0 &&
    plan.bindingFiles.length === 0
  );
}

function printSummary(plan: RemovalPlan, agentFilter?: string): void {
  console.log('');
  console.log(`⚠  Uninstalling ${plan.scope} scope — ${plan.teamaiHome}`);
  if (agentFilter) {
    const sharedNote = plan.includeShared
      ? ' (last tool — binding files and scope-owned resources removed too)'
      : ' (shared resources kept for remaining tools)';
    console.log(`⚠  Uninstalling tool only: ${agentFilter}${sharedNote}`);
  }
  console.log('⚠  The following teamai resources will be removed:');
  console.log('');

  if (plan.hookFiles.length > 0) {
    console.log(`   Reconcile scope-owned team hook entries (${plan.hookFiles.length} files; shared dispatchers kept):`);
    for (const { path: p } of plan.hookFiles) {
      console.log(`     ${p}`);
    }
    console.log('');
  }

  if (plan.opencodeHookScopes.length > 0) {
    console.log(`   OpenCode Hooks (${plan.opencodeHookScopes.length} plugin dirs):`);
    for (const { baseDir, scope } of plan.opencodeHookScopes) {
      const configDir = scope === 'project' ? '.opencode' : path.join('.config', 'opencode');
      console.log(`     ${path.join(baseDir, configDir, 'plugin')}/teamai-*.ts`);
    }
    console.log('');
  }

  if (plan.claudeMdFiles.size > 0) {
    console.log(`   CLAUDE.md rule blocks (${plan.claudeMdFiles.size} files):`);
    for (const p of plan.claudeMdFiles.keys()) {
      console.log(`     ${p}`);
    }
    console.log('');
  }

  if (plan.skillDirs.length > 0) {
    console.log(`   Skills (${plan.skillDirs.length} directories):`);
    for (const skillDir of plan.skillDirs) {
      console.log(`     ${skillDir}`);
    }
    console.log('');
  }

  if (plan.ruleFiles.length > 0) {
    console.log(`   Rules (${plan.ruleFiles.length} files)`);
    console.log('');
  }

  if (plan.agentFiles.length > 0) {
    console.log(`   Agents (${plan.agentFiles.length} files):`);
    for (const agentFile of plan.agentFiles) {
      console.log(`     ${agentFile}`);
    }
    console.log('');
  }

  if (plan.mcpServers.length > 0) {
    console.log(`   MCP servers (${plan.mcpServers.length}):`);
    for (const entry of plan.mcpServers) {
      console.log(`     ${entry}`);
    }
    console.log('');
  }

  if (plan.shellProfiles.length > 0) {
    console.log(`   Shell profile env blocks (${plan.shellProfiles.length}):`);
    for (const profilePath of plan.shellProfiles) {
      console.log(`     ${profilePath}`);
    }
    console.log('');
  }

  if (plan.bindingFiles.length > 0) {
    console.log('   Binding files:');
    for (const file of plan.bindingFiles) console.log(`     ${file}`);
  }
  console.log('   Preserved: project partitions, caches, credentials, repository clones, docs and unowned content.');
  console.log('   Preserved: shared hook dispatchers, runtime dependencies and local-agent plugins.');

}

// ─── Execution ─────────────────────────────────────────

async function executeRemoval(plan: RemovalPlan): Promise<void> {
  // (a) Remove hooks from tool settings (built-in A + team B via the manifest).
  // Each entry carries the manifest for its own location (HOME/user or a legacy
  // <projectRoot>/project copy), so team hooks are stripped correctly at both.
  for (const { path: settingsPath, tool, manifestPath } of plan.hookFiles) {
    try {
      const shared = path.resolve(manifestPath) === path.resolve(getManagedHooksPath('user'));
      await reconcileHooks(settingsPath, tool, [], {
        removeAll: true, manifestPath,
        ...(shared ? {
          removeTeamOnly: true,
          teamHookProjectRoot: plan.scope === 'project' ? plan.projectRoot : undefined,
        } : {}),
      });
    } catch (e) {
      log.warn(`Failed to remove hooks from ${settingsPath}: ${(e as Error).message}`);
    }
  }

  // (a2b) Remove OpenCode teamai plugin files (main hook + any agent-hook plugins).
  for (const { baseDir, scope } of plan.opencodeHookScopes) {
    try {
      const { removeOpencodeHooks, resolveOpencodePluginDir } = await import('./opencode-hooks.js');
      await removeOpencodeHooks(baseDir, scope);
      // Sweep leftover teamai-agent-*.ts plugins not tracked in the agent-hook
      // manifest. listFilesRecursive yields paths relative to pluginDir.
      const pluginDir = resolveOpencodePluginDir(baseDir, scope);
      if (await pathExists(pluginDir)) {
        for (const rel of await listFilesRecursive(pluginDir)) {
          if (path.basename(rel).startsWith('teamai-agent-')) await remove(path.join(pluginDir, rel));
        }
      }
    } catch (e) {
      log.warn(`Failed to remove OpenCode hook (${scope} scope): ${(e as Error).message}`);
    }
  }

  // (b) Clean CLAUDE.md teamai section blocks
  for (const [claudeMdPath, keep] of plan.claudeMdFiles) {
    try {
      const raw = await readFileSafe(claudeMdPath);
      if (!raw) continue;

      let content: string = raw;
      for (const [startMarker, endMarker] of CLAUDEMD_MARKER_PAIRS) {
        if (keep.has(startMarker)) continue;
        const startIdx = content.indexOf(startMarker);
        const endIdx = content.indexOf(endMarker);
        if (startIdx === -1 || endIdx === -1) continue;

        const before = content.substring(0, startIdx).replace(/\n+$/, '\n');
        const after = content.substring(endIdx + endMarker.length).replace(/^\n+/, '\n');
        content = (before + after).trim();
      }

      if (content.length === 0) {
        await remove(claudeMdPath);
      } else {
        await writeFile(claudeMdPath, content + '\n');
      }
      log.success(`Cleaned CLAUDE.md: ${claudeMdPath}`);
    } catch (e) {
      log.warn(`Failed to clean CLAUDE.md ${claudeMdPath}: ${(e as Error).message}`);
    }
  }

  // (c) Remove synced skills
  for (const skillDir of plan.skillDirs) {
    try {
      await remove(skillDir);
    } catch (e) {
      log.warn(`Failed to remove skill ${skillDir}: ${(e as Error).message}`);
    }
  }
  if (plan.skillDirs.length > 0) {
    log.success(`Removed ${plan.skillDirs.length} skill directories`);
  }

  // (d) Remove synced rules
  for (const ruleFile of plan.ruleFiles) {
    try {
      await remove(ruleFile);
    } catch (e) {
      log.warn(`Failed to remove rule ${ruleFile}: ${(e as Error).message}`);
    }
  }
  if (plan.ruleFiles.length > 0) {
    log.success(`Removed ${plan.ruleFiles.length} rule files`);
  }

  // (d2) Remove built-in agent files (e.g. teamai-recall)
  for (const agentFile of plan.agentFiles) {
    try {
      await remove(agentFile);
    } catch (e) {
      log.warn(`Failed to remove agent ${agentFile}: ${(e as Error).message}`);
    }
  }
  if (plan.agentFiles.length > 0) {
    log.success(`Removed ${plan.agentFiles.length} agent files`);
  }

  // (e) Clean shell profile env block(s) — every file discovered in
  // buildRemovalPlan, not just the one detectShellProfile() resolves to today.
  for (const profilePath of plan.shellProfiles) {
    try {
      const content = await readFileSafe(profilePath);
      if (content) {
        const startIdx = content.indexOf(TEAMAI_ENV_START);
        const endIdx = content.indexOf(TEAMAI_ENV_END);
        if (startIdx !== -1 && endIdx !== -1) {
          const before = content.substring(0, startIdx).replace(/\n+$/, '\n');
          const after = content.substring(endIdx + TEAMAI_ENV_END.length).replace(/^\n+/, '\n');
          await writeFile(profilePath, before + after);
          log.success(`Cleaned shell profile: ${profilePath}`);
        }
      }
    } catch (e) {
      log.warn(`Failed to clean shell profile ${profilePath}: ${(e as Error).message}`);
    }
  }

  // (f2) Prune tool directories the removals above may have left as empty
  // shells — a targeted uninstall must not leave <tool>/skills/ behind (#45).
  // pruneEmptyDirs only ever removes directories holding no files at all, so a
  // root the user still uses (own hooks, own skills) is left untouched.
  for (const root of plan.toolRootsToPrune) {
    try {
      if (await pruneEmptyDirs(root)) log.success(`Removed empty directory: ${root}`);
    } catch { /* best effort */ }
  }

  // Retire only the binding, after consumers have read its manifests.
  for (const file of plan.bindingFiles) {
    await remove(file);
    log.success(`Removed ${file}`);
  }

  // Hermes SOUL.md belongs to the user binding; retain its shared dispatcher.
  if (plan.hermesCleanup) {
    try {
      const { removeSoulRules } = await import('./hermes-config.js');
      await removeSoulRules();
    } catch (e) {
      log.debug(`Hermes uninstall cleanup skipped: ${(e as Error).message}`);
    }
  }
}

// ─── Public API ────────────────────────────────────────

export async function uninstall(opts: UninstallOptions): Promise<void> {
  let localConfig: LocalConfig | null = null;
  let teamConfig: TeamaiConfig | null = null;

  try {
    const result = await autoDetectInit({ readOnly: true });
    localConfig = result.localConfig;
    teamConfig = result.teamConfig;
  } catch {
    log.warn('teamai configuration not found or invalid');
  }

  if (localConfig && teamConfig) {
    // Full uninstall with discovery
    let agentKey: string | undefined = opts.agent;
    if (opts.agent) {
      const tools = Object.keys(teamConfig.toolPaths);
      const matched = tools.find((t) => t.toLowerCase() === opts.agent!.toLowerCase());
      if (!matched) {
        log.error(`Unknown tool "${opts.agent}". Available tools: ${tools.join(', ')}`);
        process.exitCode = 2;
        return;
      }
      agentKey = matched; // normalize to canonical toolPaths key
    }
    const plan = await buildRemovalPlan(localConfig, teamConfig, agentKey);

    if (isPlanEmpty(plan) && (!agentKey || isAgentExcluded(localConfig, agentKey))) {
      log.info('Nothing to uninstall');
      return;
    }

    printSummary(plan, agentKey);

    if (opts.dryRun) {
      log.info('Dry run — no changes made');
      return;
    }

    if (!opts.force) {
      const confirmed = await askConfirmation('Confirm uninstall? [y/N] ');
      if (!confirmed) {
        log.info('Cancelled');
        return;
      }
    }

    // Reconcile MCP ownership while the active binding is still available. Hooks already do this
    // inside executeRemoval for the same reason. MCP servers are shared
    // resources (see buildRemovalPlan), so only reconcile them away when this
    // uninstall includes shared resources — a targeted non-last-tool uninstall
    // must leave the remaining tools' MCP servers intact.
    if (plan.includeShared) {
      try {
        const { reconcileMcpForConfig } = await import('./mcp-reconcile.js');
        // Project scope: the managed-mcp manifests are PER-WORKTREE under the
        // shared partition (#374 P1-2C), and each worktree's MCP config lives in
        // its own checkout. Retiring the shared binding affects every linked
        // worktree, so remove its managed servers from each checkout. User scope
        // has a single global manifest, so the current config is enough.
        const configs: LocalConfig[] = [localConfig];
        if (localConfig.scope === 'project' && localConfig.projectRoot) {
          const { listWorktrees } = await import('./utils/git.js');
          const { resolveProjectDataHome } = await import('./config.js');
          const worktrees = await listWorktrees(localConfig.projectRoot);
          for (const wt of worktrees) {
            if (wt === localConfig.projectRoot) continue;
            const dataHome = await resolveProjectDataHome(wt);
            configs.push({ ...localConfig, projectRoot: wt, dataHome });
          }
        }
        let removedTotal = 0;
        for (const cfg of configs) {
          const { changes } = await reconcileMcpForConfig(teamConfig, cfg, { removeAll: true });
          removedTotal += changes.filter((c) => c.action === 'removed').length;
        }
        if (removedTotal > 0) log.info(`Removed ${removedTotal} teamai-managed MCP server(s)`);
      } catch (e) {
        log.warn(`Failed to remove MCP servers: ${(e as Error).message}`);
      }
    }

    await executeRemoval(plan);

    // Persist the exclusion so the next pull (or another tool's session-start
    // hook) does not resurrect this tool's resources. Only meaningful when the
    // binding survives (non-last-tool uninstall); a last-tool uninstall retires
    // config.yaml, so there is nothing to persist.
    if (agentKey && !plan.includeShared) {
      const cfg = localConfig!;
      // Only prune an existing whitelist. Leaving `enabledAgents` undefined
      // (meaning "all tools") as-is is important: collapsing it to [] would be
      // read by the hook path as "whitelist nothing" and stop hook sync for the
      // remaining tools too. The disabledAgents exclusion below is what actually
      // keeps the uninstalled tool out on the next pull.
      if (cfg.enabledAgents) {
        cfg.enabledAgents = cfg.enabledAgents.filter((t) => t !== agentKey);
      }
      const prevDisabled = cfg.disabledAgents ?? [];
      cfg.disabledAgents = [...new Set([...prevDisabled, agentKey])];
      if (cfg.scope === 'project') {
        await saveLocalConfigForScope(cfg, cfg.scope, cfg.projectRoot);
      } else {
        await saveLocalConfig(cfg);
      }
    }

    log.success('teamai uninstalled');
  } else {
    // Without a valid binding, ownership cannot be established. In particular,
    // HOME/.teamai also contains project partitions and machine-wide data.
    if (opts.agent) {
      log.warn('No valid teamai configuration detected; cannot target a specific tool with --agent');
      process.exitCode = 2;
      return;
    }
    log.info('No valid configuration detected for the current scope; no resources will be removed');
    log.info(`Preserved user scope data and shared resources: ${path.join(getUserHome(), '.teamai')}`);
    if (opts.dryRun) log.info('Dry run — no changes made');
  }
}
