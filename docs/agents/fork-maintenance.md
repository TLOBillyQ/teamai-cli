# Fork maintenance

GitHub `TLOBillyQ/teamai-cli` is the primary official fork of `Tencent/teamai-cli`. Git remotes use GitHub: `origin` for the fork and `upstream` for Tencent. Issues and PRs also use GitHub; see [issue-tracker.md](issue-tracker.md). Gitea is used only as the fork package registry.

## Manual upstream updates

Maintain qinyuanj / 覃远杰's changes as a small set of themed commits rebased onto `upstream/main`. Upstream updates are manual: preserve a linear history rather than merging upstream.

1. Work in an isolated worktree with a clean working tree. Verify that remote URLs point to GitHub and fetch `origin` and `upstream`. Record the current `origin/main` tip for the later push lease.
2. Before rewriting history, create a uniquely named `backup/*` branch for the current fork main. Keep the old history available until the updated GitHub fork has been verified.
3. Select the authorized baseline: `upstream/main` for a rolling update or a verified upstream release tag for a release rebuild. Rebase the fork themes onto that baseline. Drop patches already included there; preserve the remaining fork behavior and fold follow-up fixes into their themed commits.
4. Inspect `git log <baseline>..HEAD` and the full fork diff. Every remaining commit must belong to a fork theme. Run `npm run build`, `npx tsc --noEmit`, `npm run lint`, and `npx vitest run`; verify changed runtime behavior with a representative real-CLI run.
5. When publishing the update is authorized, push the validated history to `origin/main` using `--force-with-lease` against the recorded remote tip. If the remote has advanced, inspect those changes before retrying.
6. Verify that `origin/main` points to the validated commit. Preserve historical upstream tags and keep fork package release tags in the `gitea-v*` namespace.

Feature work and PRs start from `origin/main`. Before pushing a feature branch, inspect `git log origin/main..HEAD` and remove unrelated commits by rebasing or cherry-picking.

## Fork publishing

The inherited public npm release workflow is reserved for `Tencent/teamai-cli`; upstream tags and releases do not publish the fork package. Fork packages remain `@agent/teamai-cli` on the Gitea registry.

- A build exactly matching an upstream release uses that upstream version number.
- Between upstream releases, use the next patch with `-gitea.N`, for example `0.24.1-gitea.0`.
- Tag the publishing commit with an annotated `gitea-v<version>` tag.
- Before publishing, build the tagged commit and verify that its package contents match the artifact being published. Verify the resulting registry version after publishing.

Build fork packages from the validated GitHub fork history. Publishing credentials and registry configuration remain specific to Gitea; package publishing does not require a Gitea Git remote.
