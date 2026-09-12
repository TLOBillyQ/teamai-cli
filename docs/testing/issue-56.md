# Issue #56: Kimi Markdown agent permissions

Validation date: 2026-09-22. Base: `a06490e` (`origin/main`).
Windows; Node 24.19.0; Kimi CLI 2.0.2; installed Desktop ProductVersion
1.0.2.0 (Desktop UI was not exercised). TeamAI was built from this worktree,
initial package version 0.24.4, not the globally installed executable. The
release version is 0.24.5, requested after review. The full-suite limitations
below remain disclosed; the version change does not alter runtime code.

## Contract and compatibility

The [current Markdown contract](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/agents)
uses exact tool names and MCP globs. The
[legacy Python contract](https://github.com/MoonshotAI/kimi-cli/blob/main/docs/en/customization/agents.md)
uses a separate `version`/`agent` YAML document. TeamAI's Kimi target emits
Markdown; it does not implement the old Python format. The legacy id map is
retained only to migrate previous TeamAI output, not as a promise of Python
runtime support. No runtime detection or new CLI option was added.

Known legacy ids and `Task` are normalized when rendering allow/deny lists,
including Kimi overrides. Unknown names and MCP patterns are preserved.
Explicit empty lists remain empty. Reverse sync accepts list and comma-separated
forms. Upgrade TeamAI and run `teamai pull --force` to refresh installed agents.
Existing design documents contain no Kimi format contract requiring changes;
both usage guides were updated, and README files were left untouched.

## Executed checks

- `npm run build`: passed.
- `npx tsc --noEmit`: passed.
- `npx vitest run src/__tests__/agent-format.test.ts`: 79 passed.
  Short-name output, empty permissions and legacy override/string parsing tests
  were observed failing before their corresponding implementation changes.
- `npx vitest run --config vitest.e2e.config.ts src/__tests__/e2e/kimi-agents.test.ts --retry 0`:
  4 passed. Each provider configuration (`git`, `gitlab`, `github`, `gitea`)
  uses a local bare Git remote and runs the built CLI. Each covers Kimi,
  Claude, Codex, CodeBuddy and OpenCode installation; both ordinary and built-in
  Kimi agents; replacing installed files with legacy ids; refresh and repeat
  pull. The Git case also verifies a real reverse-sync branch and its contents.
  A local bare remote cannot create a hosted PR: push's expected exit 1 and
  `Invalid Git repo URL` are asserted after verifying the branch was pushed.
  These are provider-configuration checks, not live hosted-provider API tests.
- Full `npx vitest run`: 254 files passed, 29 failed; 3950 tests passed,
  75 failed, 4 skipped. Baseline comparison of failed files is recorded below;
  the full suite must not be reported as green.

### Baseline comparison

The 29 failing files were rerun on both this branch and an isolated checkout of
`a06490e`, using `--maxWorkers 4 --testTimeout 30000`. Both runs executed 798
tests: baseline 724 passed / 74 failed, this branch 723 passed / 75 failed.
All 74 baseline failures also occurred on this branch. The sole extra failure
was `local-agent: emitBindingHint via reportAndSyncLocalAgent > emits hint only
once per sessionId`; rerunning that exact test alone passed on both checkouts.
The comparison therefore found no reproducible new failure, but does not make
the full suite green. The original full run also included timeouts and Windows
permission/path failures. No unrelated modules were changed to mask them.
Local JSON reports: `baseline-results.json` and `recheck-results.json` under
`.scratch/issue-56/`.

## Real Kimi execution

An isolated local Git team repo contains one synthetic learning,
`learnings/issue56-ability.md`, with title `SE Lua 技能 ability fixture`, tags
`SE, Lua, 技能, ability`, and body-only probe `SE56-TRIGGER-742`.
This does not reproduce or claim access to the original business corpus.
An isolated HOME and PATH shim direct `teamai` to this worktree's built CLI.
The parent profile permits only `Agent`, delegates to installed `teamai-recall`,
and asks it to run the original query and a full context recall.

Session evidence (under the local Kimi sessions directory, child `agent-0`):

| Case | Session ID | Actual child tool snapshot | Result |
| --- | --- | --- | --- |
| New installation | `session_d0e1af0a-6189-4f09-9875-ae18d621aa3f` | `Bash, Glob, Grep, Read` | Bash precheck and recall, Read fixture, returned `SE56-TRIGGER-742` and `issue56-ability` |
| Legacy installed ids | `session_dc794e4d-0150-4edd-b315-1f1b10a36698` | `[]` | No callable tools, no real retrieval |
| After `pull --force` | `session_4f787ecc-4cb9-4fa0-b0c4-38d3f143e4c6` | `Bash, Glob, Grep, Read` | Both Bash commands exited 0; returned matching document |
| Refreshed agent with explicit body read | `session_1e7dbf19-37da-4a43-a5a1-0ec5cd16028a` | `Bash, Glob, Grep, Read` | Both commands exited 0; Read returned `SE56-TRIGGER-742` and `issue56-ability` |

The initial standalone old-profile probe also had `tools: []` in
`session_ce9f0cfa-7f94-4ddb-9252-4a54f13ddff1` and returned `NO_TOOLS`.
Snapshots and actual `agent.message.appended` tool calls/results were inspected,
not just the parent model's final claim.

Actual precheck output:

```text
RELEVANT score=10.2 threshold=4.0 title="SE Lua 技能 ability fixture" matched=SE,Lua,技能,ability
```

Actual context recall found one learning, `issue56-ability.md`, score 10.2.
Reading its body verifies the probe identifier; the query and parent prompt do
not supply that identifier. Local raw logs and fixture are in
`.scratch/issue-56/` and are not committed.

## Review

Independent Standards and Spec reviews used `a06490e...HEAD`. Neither found a
blocking implementation defect. Standards requested this baseline comparison
(now included) and suggested renaming `toKimiToolId`; the existing exported
helper name was retained to keep the change focused. Spec confirmed the scope,
but full-suite acceptance remains limited by the failures recorded above.
