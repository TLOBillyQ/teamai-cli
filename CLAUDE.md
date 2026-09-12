# TeamAI CLI

CLI for syncing team skills, rules, docs, and env across AI coding tools. Package: [`teamai-cli`](https://www.npmjs.com/package/teamai-cli).

TypeScript, Node 20+, tsup (ESM), Vitest. Commands: `npm run build`, `npx tsc --noEmit`, `npx vitest run`.

## Git

- Default branch: `main`. Worktrees and PRs based on `origin/main`.
- PR 只提到 Gitea fork（`origin` = `agent/teamai-cli`），**不向 GitHub 上游（`Tencent/teamai-cli`）提 PR**。Before push, check `git log origin/main..HEAD`; rebase or cherry-pick if unrelated commits appear.
- **必须使用 Worktree**：改代码前先 `EnterWorktree`，禁止在主工作目录修改。
- **本 fork 的提交历史**（`origin` = `agent/teamai-cli`，`upstream` = `Tencent/teamai-cli`）：qinyuanj / 覃远杰 的改动始终以一组精简的、按主题整合的提交 **rebase 在 `upstream/main` 之上**，不 merge 上游、不留 merge commit，方便后续更新上游。同一主题的后续修改 fixup 进已有提交（`git commit --fixup` + `git rebase -i --autosquash upstream/main`），不追加零碎提交；已并入上游的 cherry-pick 在 rebase 时直接丢掉。更新上游：`git fetch upstream && git rebase upstream/main`，跑完 `npm run build` / `npx tsc --noEmit` / `npx vitest run` 后 `git push --force-with-lease origin main`；改写前先打 `backup/*` 分支。
- **本 fork 的发布**（`@agent/teamai-cli`，Gitea registry）：正好基于上游 release 构建时沿用其版本号（如 `0.24.0`）；两次上游 release 之间的 Gitea 版本用下一个 patch 加 `-gitea.N`（如 `0.24.1-gitea.0`）。发布提交打 annotated tag `gitea-v<version>`，不用 `v*`，避免和上游 tag 撞名。发布前确认 tag 所指提交的 `npm run build` 产物与要发布的包一致。

## Rules

- CLI user-facing output must be English. No Chinese in production code. Tests assert English output.
- Keep bilingual docs in sync (`README` / `*.zh-CN.md`, `docs/usage-guide.*`). Behavior changes must update every affected doc (including `docs/designs/`); grep old wording before opening the PR.
- **README 精简**：尽量少改动 README，保持简洁。确需改动时，所有语言版本（`README.md` 及全部 `README.*.md`，改前先 `ls README*` 确认清单）必须全部改完并保持一致。
- **奥卡姆剃刀**：避免过早添加新 CLI 命令；非必要不加；优先复用或扩展现有命令与选项。

## PR 前测试

`npm run build` 后用真实 CLI 对本次改动做完整端到端验证（不能只跑 type check / unit test）。Test Plan 每一项必须实际通过，测试报告贴进 PR。

- Agent：Claude、Codex、CodeBuddy、OpenCode
- Provider：`git`、`gitlab`、`github`、`gitea`

## Agent skills

### Issue tracker

Issues are tracked on the Gitea fork (`agent/teamai-cli` at http://lzxsvn:3000) via the `tea` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `bug` / `enhancement` (categories) plus `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
