/**
 * Kimi Code CLI hook injection (issue #5).
 *
 * Kimi Code CLI reads hooks from the `[[hooks]]` array-of-tables in its
 * user-level `config.toml` (`$KIMI_CODE_HOME/config.toml`, default
 * `~/.kimi-code/config.toml`). The project-level `.kimi-code/local.toml`
 * has no hooks support, so every scope installs into the user config.
 *
 * Entry schema (kimi validates it strictly — unknown keys are rejected):
 *   event    SessionStart | Stop | PostToolUse | UserPromptSubmit | ...
 *   matcher  optional regex tested against the tool name (omit = wildcard)
 *   command  spawned through the system shell (`cmd.exe` on Windows)
 *   timeout  optional integer seconds, 1..600
 *
 * Because the file typically carries provider secrets and hand-written
 * comments, we never re-serialize the whole document. Instead the file is
 * edited textually: `[[hooks]]` blocks whose command starts with
 * `teamai hook-dispatch` are cut out, and fresh teamai blocks are appended at
 * the end. smol-toml is used to validate the document before and after, and to
 * identify which `[[hooks]]` block is ours (by array index, not by regex).
 */

import path from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { BUILTIN_HOOK_SPECS } from './builtin-hooks.js';
import { getUserHome } from './utils/home.js';
import { readFileSafe, writeFile } from './utils/fs.js';
import { log } from './utils/logger.js';

/** Tool id passed as `--tool` so hook-dispatch formats output for kimi. */
const KIMI_TOOL_ID = 'kimi';

/** Every teamai-managed `[[hooks]]` entry has a command starting with this. */
export const KIMI_HOOK_COMMAND_PREFIX = 'teamai hook-dispatch';

/**
 * Claude-style matcher names → kimi tool names. Kimi calls its todo tool
 * `TodoList`; hook-dispatch normalizes it back to `TodoWrite` at runtime.
 */
const KIMI_MATCHER_NAMES: Record<string, string> = {
  TodoWrite: 'TodoList',
};

/** Exact on-disk shape of one teamai `[[hooks]]` entry. Key order matters for output. */
export interface KimiHookEntry {
  event: string;
  matcher?: string;
  command: string;
  timeout: number;
}

/**
 * Resolve the Kimi Code CLI home directory: `KIMI_CODE_HOME` when set,
 * otherwise `~/.kimi-code` (mirrors kimi's own resolution).
 */
export function getKimiHome(): string {
  const fromEnv = process.env.KIMI_CODE_HOME;
  if (fromEnv && fromEnv.trim() !== '') {
    return path.resolve(fromEnv);
  }
  return path.join(getUserHome(), '.kimi-code');
}

/** Absolute path of kimi's user-level config.toml. */
export function getKimiConfigPath(): string {
  return path.join(getKimiHome(), 'config.toml');
}

/**
 * Build the six built-in hook entries for kimi from the shared spec table.
 * Commands are shell-neutral (no `bash -lc`, no redirects) because kimi spawns
 * them via the platform shell, and a non-zero exit is logged but never blocks.
 */
export function buildKimiHookEntries(): KimiHookEntry[] {
  return BUILTIN_HOOK_SPECS.map((spec) => {
    const matcher = spec.matcher === '*' ? undefined : (KIMI_MATCHER_NAMES[spec.matcher] ?? spec.matcher);
    const matcherArg = matcher ? ` --matcher ${matcher}` : '';
    return {
      event: spec.event,
      ...(matcher ? { matcher } : {}),
      command: `${KIMI_HOOK_COMMAND_PREFIX} ${spec.dispatchEvent} --tool ${KIMI_TOOL_ID}${matcherArg}`,
      timeout: spec.timeoutSec,
    };
  });
}

function isTeamaiHook(entry: unknown): boolean {
  return typeof entry === 'object' && entry !== null
    && typeof (entry as { command?: unknown }).command === 'string'
    && (entry as { command: string }).command.startsWith(KIMI_HOOK_COMMAND_PREFIX);
}

/** Matches a `[[hooks]]` array-of-tables header (optionally quoted / commented). */
const HOOKS_HEADER_RE = /^\s*\[\[\s*["']?hooks["']?\s*\]\]\s*(#.*)?$/;
/** Matches any table / array-of-tables header, i.e. the end of the previous block. */
const ANY_HEADER_RE = /^\s*\[/;

function isBlankOrComment(line: string): boolean {
  const t = line.trim();
  return t === '' || t.startsWith('#');
}

interface HooksLayout {
  /** Parsed `hooks` array (empty when absent). */
  hooks: unknown[];
  /** Line ranges [start, end) of each `[[hooks]]` block, in document order. */
  blocks: Array<{ start: number; end: number }>;
}

/**
 * Parse the document and locate every `[[hooks]]` block.
 * Throws when the document is invalid or `hooks` cannot be extended (inline
 * static array, or a shape we cannot map back to text).
 */
function analyzeHooks(text: string, lines: string[]): HooksLayout {
  const doc = parseToml(text) as Record<string, unknown>;
  const hooks = doc.hooks === undefined ? [] : doc.hooks;
  if (!Array.isArray(hooks)) {
    throw new Error('the "hooks" key is not an array');
  }
  const blocks: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!HOOKS_HEADER_RE.test(lines[i])) continue;
    let end = i + 1;
    while (end < lines.length && !ANY_HEADER_RE.test(lines[end])) end++;
    // A comment run sitting just above the next header documents *that*
    // header, so leave it (and the blank lines before it) with the next block.
    let tail = end;
    while (tail > i + 1 && isBlankOrComment(lines[tail - 1])) tail--;
    const tailHasComment = lines.slice(tail, end).some((l) => l.trim().startsWith('#'));
    blocks.push({ start: i, end: tailHasComment ? tail : end });
  }
  if (blocks.length !== hooks.length) {
    throw new Error(
      hooks.length > 0 && blocks.length === 0
        ? 'the "hooks" key is an inline array; teamai only manages [[hooks]] tables'
        : 'could not map the "hooks" entries back to [[hooks]] tables',
    );
  }
  return { hooks, blocks };
}

/**
 * Return the LF-normalized document with every teamai-owned `[[hooks]]` block
 * removed and trailing blank lines trimmed, plus whether any were removed.
 */
function stripTeamaiBlocks(text: string): { body: string; removed: boolean } {
  const lines = text.split('\n');
  const { hooks, blocks } = analyzeHooks(text, lines);
  const drop = new Set<number>();
  hooks.forEach((h, idx) => {
    if (!isTeamaiHook(h)) return;
    const { start, end } = blocks[idx];
    for (let l = start; l < end; l++) drop.add(l);
  });
  const kept = lines.filter((_, idx) => !drop.has(idx));
  let body = kept.join('\n').replace(/\s+$/, '');
  // When the document opened with a teamai block, drop the blank lines that
  // separated it from whatever now comes first.
  if (drop.has(0)) body = body.replace(/^\s*\n/, '');
  return { body, removed: drop.size > 0 };
}

/** Refresh or remove only teamai's hooks, preserving the user's TOML text. */
async function updateKimiHooks(action: 'injection' | 'removal'): Promise<boolean> {
  const configPath = getKimiConfigPath();
  const current = (await readFileSafe(configPath)) ?? '';
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  let next: string;
  try {
    const { body, removed } = stripTeamaiBlocks(current.replace(/\r\n/g, '\n'));
    if (action === 'removal' && !removed) return false;
    const appendix = action === 'injection' ? stringifyToml({ hooks: buildKimiHookEntries() }) : '';
    next = appendix ? (body ? `${body}\n\n${appendix}` : appendix) : (body ? `${body}\n` : '');
    next = next.replace(/\n/g, eol);
    if (next === current) return false;
    // Validate the rewritten document before touching disk.
    parseToml(next);
  } catch (e) {
    log.warn(`Skipping Kimi Code hook ${action}: cannot safely update ${configPath}: ${(e as Error).message}`);
    return false;
  }

  await writeFile(configPath, next);
  log.success(action === 'injection'
    ? 'Injected teamai Kimi Code hooks into ' + configPath
    : 'Removed teamai Kimi Code hooks from ' + configPath);
  return true;
}

/** Refresh built-in hooks; false means unchanged or unsafe to edit. */
export function injectKimiHooks(): Promise<boolean> {
  return updateKimiHooks('injection');
}

/**
 * True when kimi's config.toml currently carries at least one teamai entry.
 * Falls back to a text scan when the document does not parse, so uninstall
 * still lists the file (removal itself re-validates and warns).
 */
export async function hasKimiTeamaiHooks(): Promise<boolean> {
  const current = await readFileSafe(getKimiConfigPath());
  if (!current) return false;
  try {
    const doc = parseToml(current) as { hooks?: unknown };
    return Array.isArray(doc.hooks) && doc.hooks.some(isTeamaiHook);
  } catch {
    return current.includes(KIMI_HOOK_COMMAND_PREFIX);
  }
}

/**
 * Remove every teamai-owned `[[hooks]]` entry from kimi's config.toml,
 * leaving user entries and the rest of the document untouched.
 * Returns true when the file was rewritten.
 */
export function removeKimiHooks(): Promise<boolean> {
  return updateKimiHooks('removal');
}
