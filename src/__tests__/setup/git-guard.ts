/**
 * Suite-wide guard: no test may leave git waiting for a human.
 *
 * Issue #49: on Windows a unit test that accidentally reached a real remote ran
 * a real `git clone`, whose 401 was answered by a Git Credential Manager login
 * dialog — a GUI window in the middle of `npx vitest run`, blocking the run until
 * someone closed it. A test that silently escapes its isolation should instead
 * fail fast with a git error.
 *
 * `GIT_TERMINAL_PROMPT=0` alone is not enough: it only covers git's own terminal
 * prompt, while a GUI credential helper (Git Credential Manager on Windows,
 * osxkeychain, …) or an askpass program still opens a window of its own. So the
 * guard also
 *   - resets `credential.helper` through GIT_CONFIG_* — read at command-line
 *     priority, that clears the helper list contributed by the system, global and
 *     local config files (verified against a system-installed `manager` helper);
 *   - removes the askpass fallback: an empty `GIT_ASKPASS` means "no askpass
 *     program", and an empty `core.askPass` takes the config-provided one away
 *     from older git that still consults it.
 *
 * The developer's git config is deliberately left in place rather than replaced
 * with a temp `GIT_CONFIG_GLOBAL`: the reset above is enough, and CI runners put
 * the commit identity (and things like `protocol.file.allow`) in that file.
 *
 * The same overlay ships in `src/utils/git-env.ts` for the CLI's own
 * token-authenticated clones; it is spelled out separately here so the harness
 * keeps working — and keeps failing loudly — even if production code changes.
 */

// An empty string is a value, not "unset": that is what makes git ignore the
// developer's own askpass program (and GIT_ASKPASS_REQUIRE=never does not).
process.env.GIT_TERMINAL_PROMPT = '0';
process.env.GIT_ASKPASS = '';
process.env.GIT_CONFIG_COUNT = '2';
process.env.GIT_CONFIG_KEY_0 = 'credential.helper';
process.env.GIT_CONFIG_VALUE_0 = '';
process.env.GIT_CONFIG_KEY_1 = 'core.askPass';
process.env.GIT_CONFIG_VALUE_1 = '';
