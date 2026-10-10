# Fork maintenance

GitHub `TLOBillyQ/teamai-cli` is the primary official fork of `Tencent/teamai-cli`. Use these remote roles: `origin` for the GitHub fork, `upstream` for Tencent, and `gitea` for the `agent/teamai-cli` code mirror at `http://lzxsvn:3000`. Issues and PRs use GitHub; see [issue-tracker.md](issue-tracker.md).

## Manual upstream updates

Maintain qinyuanj / 覃远杰's changes as a small set of themed commits rebased onto `upstream/main`. Upstream updates are manual: preserve a linear history rather than merging upstream.

1. Work in an isolated worktree with a clean working tree. Verify remote URLs and fetch `origin`, `upstream`, and `gitea`. Record the current remote main tips for the later push leases.
2. Before rewriting history, create uniquely named `backup/*` branches for the current fork main and any distinct Gitea mirror tip. Keep the old history available until the updated fork and mirror have been verified.
3. Select the authorized baseline: `upstream/main` for a rolling update or a verified upstream release tag for a release rebuild. Rebase the fork themes onto that baseline. Drop patches already included there; preserve the remaining fork behavior and fold follow-up fixes into their themed commits.
4. Inspect `git log <baseline>..HEAD` and the full fork diff. Every remaining commit must belong to a fork theme. Run `npm run build`, `npx tsc --noEmit`, `npm run lint`, and `npx vitest run`; verify changed runtime behavior with a representative real-CLI run.
5. When publishing the update is authorized, push the validated history to `origin/main` using `--force-with-lease` against the recorded remote tip. Synchronize that same history to `gitea/main` with its own recorded-tip lease. If either remote has advanced, inspect those changes before retrying.
6. Verify that both remote main branches point to the validated commit. Preserve historical upstream tags and keep fork release tags in the `gitea-v*` namespace.

Feature work and PRs start from `origin/main`. Before pushing a feature branch, inspect `git log origin/main..HEAD` and remove unrelated commits by rebasing or cherry-picking.

## Fork publishing

The inherited public npm release workflow is reserved for `Tencent/teamai-cli`; upstream tags and releases do not publish the fork package. Fork packages remain `@agent/teamai-cli` on the Gitea registry.

- A build exactly matching an upstream release uses that upstream version number.
- Between upstream releases, use the next patch with `-gitea.N`, for example `0.24.1-gitea.0`.
- Tag the publishing commit with an annotated `gitea-v<version>` tag.
- Before publishing, build the tagged commit and verify that its package contents match the artifact being published. Verify the resulting registry version after publishing.

Use the same validated source history for the primary GitHub fork and Gitea mirror. Publishing credentials and registry configuration remain specific to Gitea.

## 0.27.0 rebuild

The local rebuild uses the official upstream `v0.27.0` commit `40f36f02faf70f393ee3e71bf1a4c017f0106fc2`, excluding commits after that tag. The previous fork history is retained on `backup/fork-before-0.27.0-20261010-0ed2190`.

Codex uses upstream project session hooks and its own user `AGENTS.md`. Kimi, ZCode and DSH keep inline rules, integrated with the upstream instruction lifecycle and shared-file ownership. Gitea, merged `toolPaths`, recall markers and Windows Codex launchers remain fork themes.

For this local rebuild, the user requested quick verification instead of the full validation matrix. `npm run build`, `npx tsc --noEmit` and `npm run lint` passed on the final runtime changes (lint used `rtk proxy npm run lint` because the RTK lint-output parser failed). These exact focused groups passed:

```sh
# 145 passed: fork configuration, providers, onboarding, Kimi and markers
npx vitest run src/__tests__/team-config-toolpaths.test.ts src/__tests__/gitea-provider.test.ts src/__tests__/init-outcome.test.ts src/__tests__/members-register.test.ts src/__tests__/kimi-hooks.test.ts src/__tests__/managed-block-markers.test.ts src/__tests__/zcode.test.ts
# 89 passed: final inline doctor missing/stale/empty checks and Codex hooks
npx vitest run src/__tests__/project-hook-rules.test.ts src/__tests__/codex-hook-rules.test.ts src/__tests__/doctor-delivery.test.ts
```

Targeted shared ZCode/DSH uninstall ownership checks also passed. `npx vitest run src/__tests__/hooks-codex-windows.test.ts` passed the migration/idempotence/removal case; its POSIX-only cross-shell probe was skipped on Windows.

Representative real-CLI verification passed after building:

```sh
npx vitest run --config vitest.e2e.config.ts src/__tests__/e2e/dsh-rules.test.ts -t "delivers full rules with only Kimi and DSH enabled"
```

That case launches the built `dist/index.js` with `pull --force`, verifies complete Kimi/DSH inline rules and preserved personal content, and confirms no Codex delivery. One case passed; the remaining cases were intentionally not run.

A broader exploratory rules test run reported seven OpenCode expectations using Windows backslashes where generated globs use forward slashes, and one WorkBuddy check lacked a shell in its test environment. These failures are recorded rather than claimed green. Full tests and release validation remain outside this run. No push, publication or release tag is part of this update.
