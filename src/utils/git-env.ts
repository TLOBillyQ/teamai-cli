/**
 * Environment overlay for a git command whose credential the CLI supplies
 * itself — a PAT in `http.extraHeader`, or a credential embedded in the remote
 * URL.
 *
 * Such a command must never ask a human: a credential dialog cannot supply a
 * PAT, so an expired token turns a prompt into a dead end that blocks the
 * command instead of reporting the problem. `GIT_TERMINAL_PROMPT=0` alone does
 * not get there — it only silences git's own terminal prompt, while a GUI
 * credential helper (Git Credential Manager on Windows, osxkeychain, …) or an
 * askpass program still opens a window of its own. Hence the two config entries
 * below, which git reads at command-line priority:
 *
 *   - `credential.helper=` resets the helper list, so every helper from the
 *     system / global / local config drops out for this invocation;
 *   - `core.askPass=` (with an empty `GIT_ASKPASS`, which means "no askpass
 *     program") removes the askpass fallback.
 *
 * What is left is git's error message. Commands where the user's own credential
 * flow is the point — the generic `git` provider, or a GitLab clone without a
 * token — deliberately do not use this overlay.
 */
export function nonInteractiveGitEnv(): NodeJS.ProcessEnv {
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'core.askPass',
    GIT_CONFIG_VALUE_1: '',
  };
}
