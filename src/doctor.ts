import path from 'node:path';
import YAML from 'yaml';
import { detectProjectConfig, loadLocalConfig, loadTeamConfig } from './config.js';
import { pathExists, readFileSafe } from './utils/fs.js';
import { log, setStderrOnly } from './utils/logger.js';
import type { GlobalOptions } from './types.js';
import {
  COPILOT_TOOL_ID,
  TeamaiConfigSchema,
  resolveHookScope,
  resolveToolBaseDir,
  isAgentExcluded,
  scopedToolPaths,
  getDataHome,
  isAgentDisabled,
  type LocalConfig,
  type TeamaiConfig,
} from './types.js';
import { isToolInstalledForConfig } from './resources/base.js';
import { skillsDirForTool } from './resources/skills.js';
import { TEAMAI_HOOK_SUBCOMMANDS, isCodexTrustGatedTool, codexTrustReminder } from './hooks.js';
import {
  buildDeliveryChecks,
  buildRulesDeliveryChecks,
  buildAgentsDeliveryChecks,
  buildMcpDeliveryChecks,
  buildEnvDeliveryCheck,
  buildDocsCheck,
} from './doctor-delivery.js';

/**
 * Where a check gets its answer. `provider` checks shell out to a provider CLI
 * or the network; `local` checks only read this machine. Callers that run the
 * registry outside `teamai doctor` filter on it — see the post-pull pass in
 * `pull()`, which has just used the provider successfully and must not pay for
 * an auth probe on every sync.
 */
export type CheckSource = 'local' | 'provider';

export interface Check {
  name: string;
  source: CheckSource;
  /**
   * Names something `teamai pull` says in its own words, better than a static
   * `fix` can: the queue warning carries the push error, which `doctor` cannot
   * learn without attempting a push of its own, and a read-only diagnostic must
   * not. The post-pull pass drops a check whose topic that run actually
   * reported. Not every run does: a scope whose team repo fails to refresh
   * returns before the publish step, and a publish that throws is swallowed
   * into a debug line. On those paths nobody has spoken, so the check is the
   * only voice left and must be heard.
   */
  reportedByPull?: string;
  /**
   * True for a check whose failure is a cleanup opportunity, not a sign that
   * anything a user asked for is actually broken. `doctor` still reports it
   * like any other check; `pull`'s post-pull summary excludes it from the
   * "N check(s) failed" count so a healthy delivery is not announced as
   * broken because of unrelated leftover state (#693 review round 6).
   */
  informational?: boolean;
  check: () => Promise<boolean>;
  fix?: string;
}

/**
 * Everything the check registry needs to describe this machine. Resolved once
 * by `resolveDoctorContext`, then passed to `buildChecks` — so any caller
 * (doctor, and later a post-pull run) builds the same checks the same way.
 */
export interface DoctorContext {
  localConfig: LocalConfig;
  teamConfig: TeamaiConfig | null;
  /** Tool paths already narrowed to the enabled, non-excluded agents. */
  toolPaths: TeamaiConfig['toolPaths'];
  /** Where hooks are actually injected — see `resolveHookScope` (#264). */
  baseDir: string;
}

export interface DoctorOptions extends GlobalOptions {
  /** Emit the report as JSON on stdout instead of the human rendering. */
  json?: boolean;
}

/** One check after it ran. */
export interface CheckResult {
  name: string;
  ok: boolean;
  fix?: string;
}

/** What `doctor --json` prints. One object, one place that builds it. */
export interface DoctorReport {
  ok: boolean;
  /** null before initialization, when there is no config to scope. */
  scope: string | null;
  checks: CheckResult[];
  /** Present only when the team repo declares packages. Human text, not checks. */
  packages?: { ok: boolean; lines: string[] };
  /** Advisories that are not checks — today, the Codex trust-gate reminder. */
  notes?: string[];
}

/**
 * Check that every tool the team declares and the user enabled is actually here.
 * Scope note: the loop is over `ctx.toolPaths`, already narrowed to the enabled,
 * non-excluded agents, so a name in `enabledAgents` that `teamai.yaml` declares
 * no paths for is out of scope — nothing would be written to it either way.
 *
 * That list is the user's own claim that they use the tool, and every writer —
 * skills, rules, agents, hooks — silently skips a tool whose root is missing.
 * Answering the claim with silence reproduces inside `doctor` the skip #574
 * reports in `pull`: "Synced N" while the tool receives nothing. Without
 * `enabledAgents` the team's tool list is aspirational, so an absent tool stays
 * silent, as it always has.
 *
 * The probe uses a resource path rather than the settings path: resources land
 * under `resolveToolBaseDir` (the project root in project scope), which is the
 * root a pull would have to write into.
 */
async function buildEnabledToolChecks(ctx: DoctorContext): Promise<Check[]> {
  const { localConfig, toolPaths } = ctx;
  if (!localConfig.enabledAgents) return [];

  const checks: Check[] = [];
  for (const [tool, paths] of Object.entries(toolPaths)) {
    // Copilot counts itself installed as soon as enabledAgents names it
    // (isToolInstalledForConfig), so this check could never fail for it. Its
    // delivery check still reports what did not arrive.
    if (tool === COPILOT_TOOL_ID) continue;

    const probePath = paths.skills ?? paths.rules ?? paths.agents ?? paths.settings ?? paths.hooks;
    if (!probePath) continue;

    // A tool that receives skills is asked the way the skills write path asks:
    // OpenClaw lives at its workspace directory, not at the tool root, so the
    // generic probe passes for a `~/.openclaw` with no workspace while delivery
    // silently skips it — the same "reported success, received nothing" this
    // check exists to catch. A tool with no skills path (rules only) has no
    // such resolver, so it keeps the generic probe.
    const skillsPath = paths.skills;
    const isInstalled = skillsPath
      ? async (): Promise<boolean> => await skillsDirForTool(tool, skillsPath, localConfig) !== null
      : (): Promise<boolean> => isToolInstalledForConfig(tool, probePath, localConfig);

    // Pushed whether or not it passes. Every other check in the registry
    // reports both ways, and `doctor --json` is consumed by hooks and CI, where
    // a missing entry cannot be told apart from one that passed.
    checks.push({
      name: `${tool} is installed`,
      source: 'local',
      check: isInstalled,
      fix: `enabledAgents lists ${tool}, but it has no directory under `
        + `${resolveToolBaseDir(tool, localConfig)}, so a pull delivers nothing to it. `
        + `Install ${tool} (in project scope, opening a session there creates its root), `
        + `or run \`teamai uninstall --agent ${tool}\` to stop syncing to it.`,
    });
  }

  return checks;
}

/**
 * Flag tools this scope no longer syncs to whose skills directory still holds
 * files from an earlier sync (#45). The post-pull pass prints these dimmed
 * (informational): a leftover is a cleanup opportunity, not a failed delivery.
 * Only orphans are pushed as checks, and their `check` always fails — the
 * filesystem scan already ran in `findOrphanedAgentDirs`, same as the delivery
 * checks that stat during the build.
 */
async function buildOrphanedAgentDirChecks(ctx: DoctorContext): Promise<Check[]> {
  const { localConfig, teamConfig } = ctx;
  if (!teamConfig) return [];
  const { findOrphanedAgentDirs, describeOrphanedAgentDir, orphanFix } = await import('./orphaned-agent-dirs.js');
  const orphans = await findOrphanedAgentDirs(localConfig, teamConfig);
  return orphans.map((orphan) => ({
    name: describeOrphanedAgentDir(orphan),
    source: 'local' as const,
    informational: true,
    check: async () => false,
    fix: orphanFix(orphan),
  }));
}

/**
 * Build hook checks for tools whose settings parent directory already exists
 * (i.e. the tool is installed). Tools that are not installed are skipped.
 */
async function buildHookChecks(
  toolPaths: TeamaiConfig['toolPaths'],
  baseDir: string,
  localConfig: LocalConfig,
): Promise<Check[]> {
  const checks: Check[] = [];
  for (const [tool, paths] of Object.entries(toolPaths)) {
    const hookPath = paths.hooks
      ? path.join(resolveToolBaseDir(tool, localConfig), paths.hooks)
      : paths.settings
        ? path.join(baseDir, paths.settings)
        : undefined;
    if (!hookPath) continue;
    const settingsPath = hookPath;
    const parentDir = path.dirname(settingsPath);
    const installed = tool === COPILOT_TOOL_ID
      ? await isToolInstalledForConfig(tool, paths.hooks ?? paths.settings ?? '', localConfig)
      : await pathExists(parentDir);
    // An uninstalled tool has no hooks to check. Whether it should be installed
    // at all is a different question — see buildEnabledToolChecks.
    if (!installed) continue;
    checks.push({
      name: `teamai hooks in ${tool} settings`,
      source: 'local',
      check: async () => {
        if (!await pathExists(settingsPath)) return false;
        const content = await readFileSafe(settingsPath);
        if (!content) return false;

        // The Windows dispatch command names node + the entry script instead of
        // the `teamai` bin (issue #43), so match on the subcommand plus its
        // `--tool` argument instead of requiring the bin name.
        const missing = TEAMAI_HOOK_SUBCOMMANDS.filter(
          (sub) => !new RegExp(`${sub}\\s+[\\w-]+\\s+--tool\\b`).test(content),
        );
        return missing.length === 0;
      },
      fix: 'Run `teamai hooks inject` to inject/update hooks',
    });
  }
  return checks;
}


/**
 * Kimi Code keeps its hooks in the user-level config.toml rather than a
 * toolPaths settings file, so buildHookChecks never sees it. Check it when kimi
 * is enabled explicitly or its home exists, because pull only warns about a
 * missing kimi home and moves on (issue #12).
 */
async function buildKimiHookChecks(
  toolPaths: TeamaiConfig['toolPaths'],
  localConfig: LocalConfig | null,
): Promise<Check[]> {
  if (!('kimi' in toolPaths)) return [];
  if (localConfig && isAgentDisabled(localConfig, 'kimi')) return [];
  const { getKimiHome, getKimiConfigPath, hasKimiTeamaiHooks } = await import('./kimi-hooks.js');
  const kimiHome = getKimiHome();
  const homeExists = await pathExists(kimiHome);
  if (!homeExists && !localConfig?.enabledAgents?.includes('kimi')) return [];
  return [{
    name: `teamai hooks in kimi config (${getKimiConfigPath()})`,
    source: 'local',
    check: hasKimiTeamaiHooks,
    fix: homeExists
      ? 'Run `teamai hooks inject` to inject/update hooks'
      : `Run Kimi Code once to create ${kimiHome}, then run \`teamai hooks inject\``,
  }];
}

/**
 * True if a trust-gated Codex tool (the public `codex`) already has teamai hooks
 * installed on disk (settings file exists and contains the hook-dispatch
 * command). Used to emit a lightweight reminder that Codex may still require the
 * user to trust them. Read-only — never inspects or modifies Codex's
 * [hooks.state] trust store. Internal variants are excluded (no trust gate).
 */
async function hasInstalledCodexHooks(toolPaths: TeamaiConfig['toolPaths'], baseDir: string): Promise<boolean> {
  for (const [tool, paths] of Object.entries(toolPaths)) {
    if (!isCodexTrustGatedTool(tool) || !paths.settings) continue;
    const settingsPath = path.join(baseDir, paths.settings);
    if (!await pathExists(settingsPath)) continue;
    const content = await readFileSafe(settingsPath);
    // The Windows form carries no `teamai` token (#43), so match the dispatch
    // argument shape rather than the bin name.
    if (content && /hook-dispatch\s+[\w-]+\s+--tool\b/.test(content)) return true;
  }
  return false;
}

/**
 * Top-level teamai.yaml keys the current schema does not declare. zod strips them
 * silently on load, so without this a misspelled or removed key goes unnoticed.
 * Returns [] when teamai.yaml is missing or unparseable — the validity check
 * reports that case.
 */
async function findUnrecognizedTeamConfigKeys(repoPath: string): Promise<string[]> {
  const content = await readFileSafe(path.join(repoPath, 'teamai.yaml'));
  if (!content) return [];
  let raw: unknown;
  try {
    raw = YAML.parse(content);
  } catch {
    return [];
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const known = new Set(Object.keys(TeamaiConfigSchema.shape));
  return Object.keys(raw).filter((key) => !known.has(key));
}

/**
 * Resolve the local/team configuration the checks run against. Returns null
 * when TeamAI is not initialized here — the caller decides how to report that.
 */
export async function resolveDoctorContext(): Promise<DoctorContext | null> {
  const projectConfig = await detectProjectConfig();
  const localConfig = projectConfig ?? (await loadLocalConfig());
  if (!localConfig) return null;

  const teamConfig = await loadTeamConfig(localConfig.repo.localPath);
  const toolPaths: TeamaiConfig['toolPaths'] = teamConfig
    ? Object.fromEntries(
      Object.entries(scopedToolPaths(teamConfig, localConfig))
        .filter(([tool]) => !isAgentExcluded(localConfig, tool)),
    )
    : {};
  // Hook checks must look where hooks are actually injected. resolveHookScope
  // maps a non-self project scope to HOME (#264), matching the injection path in
  // init/pull/hooks-cmd — otherwise doctor checks <projectRoot>/.claude while the
  // hooks live in ~/.claude and always reports them missing.
  const baseDir = resolveHookScope(localConfig).baseDir;

  return { localConfig, teamConfig, toolPaths, baseDir };
}

/**
 * Which caller the registry is being built for.
 *
 * `pull` runs the registry again at the end of an interactive sync, under a
 * budget that covers building it as well as running it. Skills and docs cost a
 * stat per item; rules cost a read per rule per tool and agents parse every
 * spec. Spending the budget on those loses the cheap checks that catch the bug
 * this whole line of work exists for, so they are `doctor`-only.
 *
 * The stage is a property of the caller, not of a check, which is why it is an
 * argument here rather than a third optional flag on `Check` beside `source`
 * and `reportedByPull`.
 */
export type CheckStage = 'pull' | 'doctor';

/**
 * The check registry. Exported so callers other than `teamai doctor` can run
 * the same diagnostics and act on the result.
 */
export async function buildChecks(ctx: DoctorContext, stage: CheckStage = 'doctor'): Promise<Check[]> {
  const { localConfig, teamConfig, toolPaths, baseDir } = ctx;
  const providerName = teamConfig?.provider;
  const checks: Check[] = [];

  // Provider-specific checks: gf CLI only needed for TGit, gh CLI for GitHub
  if (providerName === 'tgit') {
    // Dynamic import to avoid loading gf-cli code when not needed
    const { isGfInstalled, gfIsAuthenticated } = await import('./providers/tgit/index.js');
    checks.push(
      {
        name: 'gf CLI is installed',
        source: 'provider',
        check: async () => isGfInstalled(),
        fix: 'Run `teamai init` to install gf CLI automatically',
      },
      {
        name: 'gf CLI is authenticated',
        source: 'provider',
        check: async () => gfIsAuthenticated(),
        fix: 'Run `teamai init` to authenticate via gf auth login',
      },
    );
  } else if (providerName === 'github') {
    // Dynamic import to avoid loading gh-cli code when not needed
    const { isGhInstalled, ghIsAuthenticated } = await import('./providers/github/index.js');
    checks.push(
      {
        name: 'gh CLI is installed',
        source: 'provider',
        check: async () => isGhInstalled(),
        fix: 'Install from https://cli.github.com/ or run `brew install gh`',
      },
      {
        name: 'gh CLI is authenticated',
        source: 'provider',
        check: async () => ghIsAuthenticated(),
        fix: 'Run `gh auth login` to authenticate',
      },
    );
  } else if (providerName === 'gitlab') {
    // GitLab needs no CLI — only a Personal Access Token.
    const { gitlabIsAuthenticated } = await import('./providers/gitlab/index.js');
    checks.push({
      name: 'GitLab token is configured',
      source: 'provider',
      check: async () => gitlabIsAuthenticated(),
      fix: 'Export GITLAB_TOKEN (a Personal Access Token with `api` scope). '
        + 'GITLAB_PRIVATE_TOKEN and GITLAB_PAT are accepted as aliases.',
    });
  } else if (providerName === 'gitea') {
    // Gitea needs no CLI — only an access token plus the instance base URL.
    const { giteaIsAuthenticated } = await import('./providers/gitea/index.js');
    checks.push(
      {
        name: 'Gitea instance URL is configured',
        source: 'provider',
        check: async () => Boolean(process.env.GITEA_URL?.trim()),
        fix: 'Export GITEA_URL, e.g. https://gitea.example.com. Gitea has no public host, '
          + 'so the base URL is required for API access.',
      },
      {
        name: 'Gitea token is configured',
        source: 'provider',
        check: async () => giteaIsAuthenticated(),
        fix: 'Export GITEA_TOKEN (a Gitea access token with repo scope). '
          + 'GITEA_ACCESS_TOKEN and GITEA_PAT are accepted as aliases.',
      },
    );
  } else if (providerName === 'gitcode') {
    // GitCode needs no CLI — only a Personal Access Token (env or ~/.netrc).
    const { gitcodeIsAuthenticated } = await import('./providers/gitcode/index.js');
    checks.push({
      name: 'GitCode token is configured',
      source: 'provider',
      check: async () => gitcodeIsAuthenticated(),
      fix: 'Export GITCODE_TOKEN (a GitCode Personal Access Token), or run `teamai init` '
        + 'to paste one interactively. GC_TOKEN is accepted as an alias.',
    });
  }

  checks.push(
    {
      name: 'Team repo exists locally',
      source: 'local',
      check: async () => pathExists(localConfig.repo.localPath),
      fix: 'Run `teamai init` to clone the team repo',
    },
    {
      name: 'Team config (teamai.yaml) is valid',
      source: 'local',
      check: async () => {
        const config = await loadTeamConfig(localConfig.repo.localPath);
        return config !== null;
      },
      fix: 'Check teamai.yaml in team repo for syntax errors',
    },
    ...await buildKimiHookChecks(toolPaths, localConfig),
    {
      // A contribution is kept locally when it cannot be published. Without
      // this check a member whose pushes are rejected queues notes forever and
      // is told each time that the next pull will retry.
      name: 'Contributed learnings are published',
      source: 'local',
      // pullForScope warns about the queue on its own, with the push error
      // attached; this check is the standing version of it for `teamai doctor`.
      reportedByPull: 'pending-learnings',
      check: async () => {
        const { listPendingLearnings } = await import('./utils/pending-learnings.js');
        return (await listPendingLearnings(localConfig)).length === 0;
      },
      fix: 'Run `teamai pull` to publish them. If they stay queued, check that you '
        + 'can push to the team repo (run with --verbose to see the push error).',
    },
    ...await buildEnabledToolChecks(ctx),
    ...await buildOrphanedAgentDirChecks(ctx),
    ...await buildHookChecks(toolPaths, baseDir, localConfig),
    ...await buildDeliveryChecks(ctx),
    // Built only for `doctor`: the work is in building these, not in running
    // them, so skipping them post-pull is what keeps the budget for the rest.
    ...(stage === 'doctor' ? await buildRulesDeliveryChecks(ctx) : []),
    ...(stage === 'doctor' ? await buildAgentsDeliveryChecks(ctx) : []),
    ...await buildMcpDeliveryChecks(ctx),
    ...await buildDocsCheck(ctx),
    ...await buildEnvDeliveryCheck(ctx),
  );

  return checks;
}

/**
 * Run every check once, in registry order. `onResult` reports each one as it
 * lands, so the human rendering keeps streaming while a slow check (a provider
 * CLI auth probe) is still running.
 */
export async function runChecks(
  checks: Check[],
  onResult?: (result: CheckResult) => void,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const { name, check, fix } of checks) {
    const ok = await check();
    const result: CheckResult = ok ? { name, ok } : { name, ok, fix };
    results.push(result);
    onResult?.(result);
  }
  return results;
}

/** The only writer of the JSON channel. */
function emitReport(report: DoctorReport): void {
  console.log(JSON.stringify(report, null, 2));
}

/**
 * The human rendering of one finished check, as lines. Exported because `pull`
 * prints the same shape through the logger rather than stdout — one definition
 * of the glyphs and the indent, two sinks.
 */
export function formatCheckResult({ name, ok, fix }: CheckResult): string[] {
  if (ok) return [`  ✔ ${name}`];
  return fix ? [`  ✖ ${name}`, `    → ${fix}`] : [`  ✖ ${name}`];
}

function renderResult(result: CheckResult): void {
  for (const line of formatCheckResult(result)) console.log(line);
}

export async function doctor(options: DoctorOptions): Promise<boolean> {
  const jsonMode = options.json === true;
  // In JSON mode stdout is a data channel: route every log line to stderr so a
  // consumer can parse stdout whole (same trick as hook-dispatch commands).
  if (jsonMode) setStderrOnly(true);

  log.info('Running diagnostics...\n');
  const ctx = await resolveDoctorContext();
  if (!ctx) {
    const notInitialized: CheckResult = {
      name: 'TeamAI is not initialized',
      ok: false,
      fix: 'Run `teamai init <repo-url>` in a project, or add `--scope user` for all projects',
    };
    if (jsonMode) {
      emitReport({ ok: false, scope: null, checks: [notInitialized] });
    } else {
      console.log('  Scope: not initialized\n');
      renderResult(notInitialized);
      console.log('');
    }
    log.warn('Initialization is required before diagnostics can run.');
    return false;
  }

  const { localConfig, toolPaths, baseDir } = ctx;
  const scope = localConfig.scope ?? 'user';
  if (!jsonMode) {
    const scopeLabel = `${scope}${scope === 'project' && localConfig.projectRoot ? ` (${localConfig.projectRoot})` : ''}`;
    console.log(`  Scope: ${scopeLabel}\n`);

    // Warning only: team repos are shared across CLI versions, so a key this
    // version does not know may be valid for a newer one. Never fails doctor.
    const unrecognizedKeys = await findUnrecognizedTeamConfigKeys(localConfig.repo.localPath);
    if (unrecognizedKeys.length > 0) {
      console.log(`  ⚠ teamai.yaml has keys this teamai version does not recognize (ignored): ${unrecognizedKeys.join(', ')}`);
    }
  }

  const results = await runChecks(await buildChecks(ctx), jsonMode ? undefined : renderResult);
  let allPassed = results.every((r) => r.ok);

  const { pkgDoctorReport } = await import('./pkg/commands.js');
  const packageReport = await pkgDoctorReport(localConfig, process.cwd());
  if (packageReport && !packageReport.allPassed) allPassed = false;

  // Codex trust-gate reminder: even when hooks are installed, Codex may not run
  // them until the user reviews/trusts them. Note only — teamai never writes
  // [hooks.state] to auto-trust.
  const codexNote = await hasInstalledCodexHooks(toolPaths, baseDir)
    ? codexTrustReminder()
    : null;

  if (jsonMode) {
    emitReport({
      ok: allPassed,
      scope,
      checks: results,
      // pkgDoctorReport renders its own lines; they are human text, not checks.
      ...(packageReport ? { packages: { ok: packageReport.allPassed, lines: packageReport.lines } } : {}),
      ...(codexNote ? { notes: [codexNote] } : {}),
    });
    return allPassed;
  }

  if (packageReport) {
    for (const line of packageReport.lines) console.log(line);
  }

  if (codexNote) {
    console.log('');
    log.info(codexNote);
  }

  console.log('');
  if (allPassed) {
    log.success('All checks passed!');
  } else {
    log.warn('Some checks failed. See suggestions above.');
  }
  return allPassed;
}
