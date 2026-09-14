/**
 * Per-tool on-disk format for rule files.
 *
 * The team repo always stores rules as tool-neutral `<name>.md`. Most tools take
 * a verbatim `.md` copy. Cursor and JoyCode use `.mdc` rules, while GitHub
 * Copilot CLI uses `.instructions.md`; those copies carry native frontmatter.
 *
 * This module is the single place that decision lives, mirroring
 * `agentFileExtensionForTool` in `./agent-format.ts`. Every site that writes,
 * scans, or deletes files in a tool's rules directory must go through it, so a
 * new per-tool extension never has to be re-discovered call site by call site.
 */

import path from 'node:path';
import type { Scope } from '../types.js';

const CURSOR_MDC_RULE_TOOLS = new Set(['cursor', 'joycode']);
const COPILOT_INSTRUCTIONS_RULE_TOOLS = new Set(['copilot']);

/** Extension teamai writes rules with for a given tool. */
export function ruleFileExtensionForTool(tool: string): '.md' | '.mdc' | '.instructions.md' {
  if (usesCursorMdcRules(tool)) return '.mdc';
  return usesCopilotInstructions(tool) ? '.instructions.md' : '.md';
}

/** True when the tool stores rules in Cursor-compatible `.mdc` format. */
export function usesCursorMdcRules(tool: string): boolean {
  return CURSOR_MDC_RULE_TOOLS.has(tool);
}

/** True when the tool stores rules as GitHub Copilot instruction files. */
export function usesCopilotInstructions(tool: string): boolean {
  return COPILOT_INSTRUCTIONS_RULE_TOOLS.has(tool);
}

/**
 * Tools with no instructions rules directory. Kimi Code CLI, ZCode, Codex and DSH
 * only load instructions from AGENTS.md, and none expands `@file` references
 * there, so the only way a team rule reaches the model is its full text inside
 * that file. For these tools teamai inlines every rule body into a managed
 * block in the tool's `claudemd` file instead of copying files (which the tool
 * would silently ignore).
 */
const INLINE_INSTRUCTION_RULE_TOOLS = new Set(['kimi', 'zcode', 'codex', 'dsh']);

/** True when the tool receives team rules inlined into its instructions file. */
export function inlinesRulesIntoInstructions(tool: string): boolean {
  return INLINE_INSTRUCTION_RULE_TOOLS.has(tool);
}

/**
 * Rules directories older teamai versions copied `.md` rules into, for tools
 * that now get rules inlined. Codex never read them: `.codex/rules/` holds its
 * Starlark `.rules` command policies. Pull and uninstall remove teamai's copies
 * there and leave every other file alone.
 */
const LEGACY_INLINE_RULE_DIRS: Readonly<Record<string, string>> = { codex: '.codex/rules' };

/** Legacy rules directory teamai's `.md` copies may still sit in, if any. */
export function legacyInlineRulesDir(tool: string, toolPath: { rules?: string }): string | undefined {
  // A team that still configures a rules dir for the tool keeps using it.
  return toolPath.rules ? undefined : LEGACY_INLINE_RULE_DIRS[tool];
}

/**
 * Directory whose presence decides whether instruction-file injection (culture,
 * shared instructions) is allowed for a tool. Tools with a rules dir are gated
 * on it, as before. Tools that inline rules have no rules dir, so their skills
 * root stands in — otherwise a non-user would get `.kimi-code/AGENTS.md`
 * conjured. Every other tool keeps its historical ungated behaviour.
 */
export function instructionInstallRoot(
  tool: string,
  toolPath: { rules?: string; skills?: string },
): string | undefined {
  if (toolPath.rules) return toolPath.rules;
  return inlinesRulesIntoInstructions(tool) ? toolPath.skills : undefined;
}

/**
 * True when the teamai-recall block belongs in the tool's instructions file:
 * the tool has both an instructions file and subagents. The workspace-root
 * AGENTS.md (ZCode's and Codex's project-scope instructions file) is also read
 * by tools without a teamai-recall subagent (WorkBuddy, Hermes), so it is
 * excluded.
 */
export function receivesRecallBlock<T extends { claudemd?: string; agents?: string }>(
  toolPath: T,
  scope: Scope,
): toolPath is T & { claudemd: string; agents: string } {
  if (!toolPath.claudemd || !toolPath.agents) return false;
  return !(scope === 'project' && path.posix.normalize(toolPath.claudemd.replaceAll('\\', '/')) === 'AGENTS.md');
}

/**
 * Every extension a rule file may carry on disk, newest layout first.
 *
 * Writers use `ruleFileExtensionForTool`; scanners and deleters use this list so
 * they also see copies left by an older teamai layout (e.g. `.cursor/rules/*.md`
 * written before Cursor rules moved to `.mdc`).
 */
export const RULE_FILE_EXTENSIONS = ['.instructions.md', '.mdc', '.md'] as const;

/**
 * Extract a rule name stem from a filename, accepting any supported extension.
 * Returns null for files that are not rule files.
 */
export function ruleStemFromFilename(filename: string): string | null {
  if (filename.endsWith('.instructions.md')) return filename.slice(0, -'.instructions.md'.length);
  if (filename.endsWith('.mdc')) return filename.slice(0, -'.mdc'.length);
  if (filename.endsWith('.md')) return filename.slice(0, -'.md'.length);
  return null;
}

/**
 * True when `filename` is a copy left in an `.mdc` rules directory by an older
 * teamai layout: the target tool never reads `.md` there, so such a file is inert
 * leftover rather than an active rule.
 */
export function isLegacyCursorRuleFile(tool: string, filename: string): boolean {
  return usesCursorMdcRules(tool) && filename.endsWith('.md');
}
