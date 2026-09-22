# Issue #55：卸载 scope 安全验证

2026-09-22 在 Windows 验证，分支 `codex/issue-55-uninstall`，基于
`db938ba23130a8457b8237932e75d8dd66721d9b`（`origin/main`）。

## 行为

卸载退出当前绑定，删除其 `config.yaml`、生成的 `env.sh`、工具资源及有归属记录的团队 hooks，保留数据根目录。
项目分区、缓存、凭据、docs、仓库克隆、local-agent 插件及共享 dispatcher 均保留。
不能因为无法确认归属而递归清理。配置缺失或无效时不删除；预览不迁移配置、不写调试日志。

## 验证记录

- `npm run build`：通过。
- `npx tsc --noEmit`：通过。
- uninstall、hook scope reconciliation、partition、logger、roles 定向测试：129 项通过。
- 构建后 `dist/index.js` 的 `uninstall-scope-safety.test.ts`：8 项通过。
  隔离临时 HOME、USERPROFILE、应用数据和工具 HOME。用真实 CLI `pull --force` 安装配置夹具，
  CLI 将项目迁移到真实分区。卸载 user 后项目配置和资源保留；再提交 Git 新版本，
  通过携带项目 cwd 的 `hook-dispatch session-start --bg-only` 验证
  Claude、Codex、CodeBuddy、OpenCode、Kimi 继续分发项目资源。
- Provider 配置矩阵 `git`、`gitlab`、`github`、`gitea` 全部通过。
  使用本地裸 Git remote，验证卸载及分发路径，**不代表托管平台认证或 API 可用性验证**。
- `gitlab` 配置用例按顺序卸载五种工具，检查非最后工具的持久排除与最后工具的绑定退出。
  项目卸载还验证恢复的 user 绑定和另一项目分区不受影响；重复 user 卸载安全。
- 缺失配置、损坏 YAML、团队配置不可读时，项目文件、缓存、凭据和个人内容哨兵保留。
  预览前后快照逐字节一致；实际无效配置命令可能追加诊断日志。
- 预览不迁移旧 user role 配置；有效绑定用例还验证 docs 和 local-agent 哨兵保留。

Windows CodeBuddy 自动注入目前依赖 `/bin/sh`，夹具预置已有 dispatcher，验证卸载后保留并调用真实分发入口；
其余四种适配器由 CLI 安装。未启动交互式 AI 工具会话，未清理真实 HOME，也未修改依赖业务项目。

## 全量测试与审查

`npx vitest run --maxWorkers 4`：254 个文件通过、29 个失败；3949 项通过、73 项失败、4 项跳过。
所有报告的失败名称也在未修改基线复现。在基线重跑这 29 个文件，结果为 74 项失败、724 项通过
（多一个间歇性 init 失败）。部分失败来自 Windows 上的 POSIX 权限、路径和换行假设；
全量测试**并非全绿**。最终对比未出现新的失败名称。

既有真实 CLI MCP 卸载和受管资源卸载套件也通过（2 项）：移除受管 MCP 时保留用户服务器，
移除 agent/skill 时保留用户自建资源。规范审查发现的 ZCode/OMP 旧文档已修正并复核；
Standards 与 Spec 均无剩余发现。

## 发布与迁移

修复包含在 `@agent/teamai-cli@0.24.4`，标签为 `gitea-v0.24.4`。
已发布 `0.24.2` 和 `0.24.3` 均不可用于此次迁移。发布验证通过 `TEAMAI_TEST_CLI`
运行打包后的 CLI；发布包完整性和冒烟验证结果记录在 Gitea release notes。
依赖项目仍需执行各自的迁移验收。

安装已验证的修复包后，安全迁移步骤如下：

1. 安装明确验证过的修复版本，检查 `teamai --version`。
2. 从 HOME 执行 `teamai --dry-run uninstall`，确认显示 **user scope**、具体绑定文件删除清单，
   并保留项目、凭据及共享 hooks。
3. 执行 `teamai uninstall` 并确认预览操作。不要手动删除 `.teamai`、保留的克隆或运行依赖。
4. 在每个保留项目执行 `teamai status`、`teamai pull --force`，再验证新工具会话仍分发项目 hooks。
   若配置无效，先修复配置再重试；卸载会有意保留无法确认归属的数据。
