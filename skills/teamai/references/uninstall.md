# Scenario: Uninstall — leave the active TeamAI binding

The user wants to remove TeamAI. **You run the command for them** — they should not
have to type `teamai uninstall` themselves. Everything you say goes in the user's
language (global rule 1); only the commands stay verbatim.

## Step 1 — Confirm scope first (ASK — this is destructive)

Uninstalling removes hooks and synced resources from the machine and cannot be
undone with a single button, so confirm before running anything. Ask ONE question:

*"Do you want to remove TeamAI from **just this AI tool**, or from **all tools in the current binding**?"*

- **Just this tool** → `--agent <tool>` (use the tool this conversation runs in,
  e.g. `claude`). The binding is retired only if it is the last enabled tool.
- **All tools in this binding** → no `--agent` flag.

Reassure them (in their language): *"This only removes things from your computer.
Your team's repo on the website is untouched — you can rejoin any time with
`/teamai` and the repo URL."*

## Step 2 — Preview the scope, then run it

Run `teamai uninstall --dry-run` from the intended directory. For user scope, use
HOME; for project scope, use that workspace. Check the displayed scope and paths.
`--agent` selects a tool within that scope, not a different scope. Missing or
invalid configuration causes no deletion: report that outcome instead of deleting
`.teamai` manually. Project partitions, caches, credentials, docs, local-agent
plugins and shared dispatchers are preserved.

All tools in the active binding:

```bash
teamai uninstall
```

Just the current tool (example for Claude Code):

```bash
teamai uninstall --agent claude
```

`teamai uninstall` asks for a confirmation of its own. Let the user answer that
prompt. Only add `--force` (skips the prompt) if the user has already clearly told
you to go ahead without further confirmation:

```bash
teamai uninstall --force
```

## Step 3 — Report the result in the user's language

Tell them what was removed and remind them, in one line, how to come back:
*"Done — The active TeamAI binding has been removed; shared project data and dispatchers are retained. To rejoin later, run `/teamai`
and give it your team repo URL."*

## Notes

- Do **not** delete the team repo on the Git platform — uninstall never touches it,
  and neither should you.
- If the user only wants to stop auto-sync for one tool but keep TeamAI otherwise,
  that is the `--agent <tool>` form, not a full uninstall.
