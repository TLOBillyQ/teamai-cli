# Issue tracker: Gitea

Issues and specs for this repo live as Gitea issues on the `origin` remote: `agent/teamai-cli` at `http://lzxsvn:3000`. Use the `tea` CLI for all operations (login `qinyuanj` is already configured; `tea` picks it up from the git remote when run inside the clone).

Note: `upstream` (`Tencent/teamai-cli` on GitHub) is **not** the issue tracker and **not** a PR target. Issues, triage labels, triage comments, and code PRs all live on the Gitea fork; nothing is submitted to GitHub upstream.

## Conventions

- **Create an issue**: `tea issues create --title "..." --description "..." --labels "..."` (labels are comma-separated).
- **Read an issue**: `tea issues <number> --comments`. Add `-f index,state,author,title,body,labels,created,updated` to control fields, or `-o json` for structured output.
- **List issues**: `tea issues list --state open --labels "needs-triage" -f index,title,labels,updated --limit 50`. Filters: `--keyword`, `--author`, `--from`/`--until` (activity date), `--state all|open|closed`.
- **Comment on an issue**: `tea comment <number> "<body>"` (shorthand for `tea comments add`). Comments are plain text bodies; write multi-line bodies via a shell heredoc.
- **Apply / remove labels**: `tea issues edit <number> --add-labels "a,b"` / `--remove-labels "a"`.
- **Close**: comment first (`tea comment <number> "..."`), then `tea issues close <number>`. Reopen with `tea issues reopen <number>`.
- **List / create labels**: `tea labels list`; `tea labels create --name "..." --color "#ededed"`. The triage label set (`bug`, `enhancement`, `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`) already exists on the repo.

Pass `-r agent/teamai-cli` when running outside the clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `tea pulls` equivalents:

- **Read a PR**: `tea pulls <number>` for metadata and `tea pulls --help` for checkout/diff helpers (`tea pr checkout <number>`).
- **List PRs for triage**: `tea issues list --kind pulls --state open -f index,title,author,labels,updated`.
- **Comment / label / close**: `tea comment <number>`, `tea issues edit <number> --add-labels/--remove-labels`, `tea issues close <number>` work on PR indices too.

Gitea shares one number space across issues and PRs, so a bare `#42` may be either: resolve with `tea issues list --kind all --keyword ...` or try `tea issues <n>` (the `kind` field says `issue` or `pull`).

## When a skill says "publish to the issue tracker"

Create a Gitea issue with `tea issues create`.

## When a skill says "fetch the relevant ticket"

Run `tea issues <number> --comments`.
