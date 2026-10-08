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
