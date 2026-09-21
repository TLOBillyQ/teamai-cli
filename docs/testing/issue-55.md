# Issue #55: uninstall scope safety

Verified on Windows on 2026-09-22, on branch `codex/issue-55-uninstall`, based on
`db938ba23130a8457b8237932e75d8dd66721d9b` (`origin/main`).

## Behavior

Uninstall retires the active binding's `config.yaml` and generated `env.sh`,
removes its tool resources and recorded team hooks, and retains the data home.
Project partitions, caches, credentials, docs, repository clones, local-agent
plugins and shared hook dispatchers remain. Unknown ownership is not grounds for
recursive cleanup. Missing/invalid configuration authorizes no deletion.
Preview does not migrate configuration or write debug logs.

## Verification record

- `npm run build`: passed.
- `npx tsc --noEmit`: passed.
- Targeted Vitest suites: uninstall, hook scope reconciliation, partition,
  logger and roles; 129 tests passed.
- `uninstall-scope-safety.test.ts` against built `dist/index.js`: 8 tests passed.
  Temporary HOME, USERPROFILE, app-data directories and tool homes were isolated.
  Fixture configurations were installed with real CLI `pull --force`; the CLI
  migrated the project into its real partition. User uninstall preserved that
  configuration and project resources. Subsequent Git revisions were delivered
  by `hook-dispatch session-start --bg-only` for Claude, Codex, CodeBuddy,
  OpenCode and Kimi, using the project cwd in the hook payload.
- Provider configuration matrix: `git`, `gitlab`, `github`, `gitea`, all passed.
  Each uses a local bare Git remote. This verifies uninstall and dispatch paths,
  **not hosted provider authentication or API availability**.
- The `gitlab` configuration case sequentially uninstalls all five tools,
  checking exclusions on non-last removals and binding retirement on the last.
  Project uninstall also preserves a restored user binding and another project
  partition. Repeated user uninstall is safe.
- Missing config, corrupt YAML and unreadable team config retain sentinel
  project files, cache, credentials and personal content. Preview snapshots are
  byte-identical; actual invalid-config commands may append diagnostic logs.
- A legacy user role profile is not migrated during preview. The valid-binding
  case additionally preserves docs and local-agent sentinel files.

The Windows CodeBuddy injector currently requires `/bin/sh`. This fixture seeds
an already-installed CodeBuddy dispatcher, verifies it survives uninstall, and
executes the real dispatcher. The other four adapters are installed by the CLI.
No interactive AI-tool application sessions were launched. No real HOME cleanup
or dependent business-project changes were performed.

## Suite and review results

`npx vitest run --maxWorkers 4`: 254 files passed, 29 failed; 3949 tests passed,
73 failed and 4 skipped. All reported failure names also reproduce on the
unchanged base commit. Rerunning those 29 files there yielded 74 failures and
724 passes (one additional intermittent init failure). Windows POSIX permission,
path and newline assumptions account for several failures; the suite is **not
fully green**. No new failure name appeared in the final comparison.

The existing real-CLI MCP uninstall and managed-resource uninstall suites also
passed (2 tests): managed MCP removal retains user servers; agent/skill removal
retains user-owned artifacts. Standards review's stale ZCode/OMP documentation
finding was fixed and rechecked; Standards and Spec have no remaining findings.

## Release and migration

The fix is included in `@agent/teamai-cli@0.24.4`, tagged `gitea-v0.24.4`.
Published `0.24.2` and `0.24.3` remain unsuitable for this migration. Release
verification uses the packed CLI via `TEAMAI_TEST_CLI`; published-package
integrity and smoke-test results are recorded in the Gitea release notes.
The dependent projects still need to perform their own migration acceptance.

Safe migration after installing the verified fixed package:

1. Install the specifically verified fixed release and check `teamai --version`.
2. From HOME, run `teamai --dry-run uninstall`. Confirm **user scope**, explicit
   binding-file removal, and preservation of projects, credentials and shared hooks.
3. Run `teamai uninstall` and confirm the previewed operation. Do not manually
   delete `.teamai`, retained clones or runtime dependencies.
4. In each retained project, run `teamai status` and `teamai pull --force`, then
   verify a new tool session still dispatches project hooks. If configuration
   is invalid, repair it before retrying; uninstall intentionally leaves data alone.
