/**
 * Cross-platform command lookup: resolve a CLI name to the absolute path that
 * Node can actually launch on the current platform.
 *
 * Extracted from `utils/ai-client.ts`. The same pitfalls (`which` printing an
 * MSYS path on Windows, the extension-less npm shim sorting first) showed up
 * again in the provider CLI wrappers (`providers/github/gh-cli.ts`,
 * `providers/cnb/cnb-cli.ts`), so the logic lives in one place.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Timeout (ms) for a single probe so execFileSync can never hang the CLI. */
export const CLI_DETECT_TIMEOUT_MS = 5_000;

/**
 * Windows executable extensions that CreateProcess can start directly, in
 * PATHEXT priority order.
 *
 * `npm install -g` on Windows emits three shims: an extension-less POSIX
 * script, `<cmd>.cmd`, and `<cmd>.ps1`. The extension-less one cannot be
 * launched by CreateProcess.
 */
export const WIN_EXEC_EXTENSIONS = ['.exe', '.cmd', '.bat'] as const;

/**
 * Only plain command names are accepted. The POSIX strategies interpolate the
 * name into `command -v <cmd>` inside a login shell, so anything with shell
 * metacharacters or path separators must be rejected up front.
 */
const SAFE_COMMAND_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * Per-process cache keyed by `<platform>:<cmd>`. Resolving on POSIX spawns a
 * login shell (sourcing ~/.bash_profile, nvm, etc.), which easily costs
 * hundreds of milliseconds; callers such as `ghExec` / `cnbExec` resolve on
 * every invocation, so the result is memoised for the lifetime of the process.
 * A miss (`null`) is cached too — `resetCliPathCache()` clears it after an
 * install step so the next probe sees the new binary.
 */
const cache = new Map<string, string | null>();

/** Forget every cached lookup (used after installing a CLI, and by tests). */
export function resetCliPathCache(): void {
  cache.clear();
}

/**
 * Pick the launchable entry from `where <cmd>` output.
 *
 * `where` lists every match, and the extension-less POSIX shim usually comes
 * first (e.g. `C:\npm\claude` before `C:\npm\claude.cmd`). That file cannot be
 * started by CreateProcess, so only executable extensions are accepted.
 *
 * @param whereOutput  raw stdout of `where <cmd>`
 * @returns            first launchable path, or null when none has an executable extension
 */
export function pickWindowsCommand(whereOutput: string): string | null {
  const lines = whereOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const ext of WIN_EXEC_EXTENSIONS) {
    const hit = lines.find((line) => line.toLowerCase().endsWith(ext));
    if (hit !== undefined) return hit;
  }
  return null;
}

/**
 * Resolve a CLI with the native Windows `where` command, which returns real
 * Windows paths (`C:\...\claude.cmd`) that the Windows API understands.
 *
 * @param cmd  command name
 * @returns    existing, launchable absolute path; null when not installed
 */
function whereOnWindows(cmd: string): string | null {
  try {
    const out = execFileSync('where', [cmd], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: false,
      timeout: CLI_DETECT_TIMEOUT_MS,
    });
    const p = pickWindowsCommand(out);
    return p !== null && existsSync(p) ? p : null;
  } catch {
    // `where` exits non-zero when nothing matches ("INFO: Could not find files...").
    return null;
  }
}

/**
 * POSIX strategy chain. Each shell environment is tried in turn and the first
 * path that resolves and exists wins:
 *   1. `bash -lc command -v <cmd>` — login shell, covers ~/.nvm/ and friends
 *   2. `zsh -lc command -v <cmd>`  — macOS default shell fallback
 *   3. `which <cmd>`               — last resort, plain process.env.PATH lookup
 *
 * @param cmd  command name
 * @returns    existing absolute path; null when all three strategies fail
 */
function whichOnPosix(cmd: string): string | null {
  // Strategy 1: bash login shell (shell: false is the execFileSync default; stated explicitly).
  try {
    const p = execFileSync('bash', ['-lc', `command -v ${cmd}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: false,
      timeout: CLI_DETECT_TIMEOUT_MS,
    }).trim();
    if (p && existsSync(p)) return p;
  } catch {
    // fall through to the next strategy
  }

  // Strategy 2: zsh login shell (macOS default, or when bash is unavailable).
  try {
    const p = execFileSync('zsh', ['-lc', `command -v ${cmd}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: false,
      timeout: CLI_DETECT_TIMEOUT_MS,
    }).trim();
    if (p && existsSync(p)) return p;
  } catch {
    // fall through to the next strategy
  }

  // Strategy 3: `which` against process.env.PATH (fish, CI containers, ...).
  try {
    const p = execFileSync('which', [cmd], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: false,
      timeout: CLI_DETECT_TIMEOUT_MS,
    }).trim();
    if (p && existsSync(p)) return p;
  } catch {
    // none of the strategies worked
  }

  return null;
}

/**
 * Resolve a CLI command name to an existing absolute path.
 *
 * Windows must go through `where`: `bash` / `which` there come from Git Bash
 * or WSL and print MSYS-style paths (`/c/Users/me/AppData/Roaming/npm/claude`)
 * for which `existsSync` is always false and spawn cannot start anything, so
 * the POSIX strategies can never succeed on Windows (WSL's bash would even
 * return an unusable Linux path).
 *
 * `platform` is injectable because CI only runs on ubuntu / macos: with
 * process.platform hard-coded the Windows branch would have no test coverage,
 * which is exactly why the original bug went unnoticed for so long.
 *
 * Results are memoised per process; see `resetCliPathCache()`.
 *
 * @param cmd       command name (plain name only, no path or shell syntax)
 * @param platform  target platform, defaults to the current process platform
 * @returns         existing absolute path; null when unavailable on that platform
 */
export function resolveCliPath(
  cmd: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!SAFE_COMMAND_NAME.test(cmd)) return null;

  const key = `${platform}:${cmd}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const resolved = platform === 'win32' ? whereOnWindows(cmd) : whichOnPosix(cmd);
  cache.set(key, resolved);
  return resolved;
}
