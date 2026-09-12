# dsh in agent auto-detection

`dsh` (DeepSeek Harness) is not part of the agent auto-detection candidate set
(`SELF_MODE_AGENT_CHOICES`), and we do not plan to add it.

## Why this is out of scope

The auto-detection candidate list is deliberately small — it exists to guess
"the common coding agents" in non-interactive contexts (clone-time bootstrap,
TTY-less `teamai init .`) and to populate the interactive picker's options. It
is not meant to mirror the full `KNOWN_AGENTS` list.

`dsh` is already fully supported as an explicit target: `--agent dsh` works,
its `skillsPath` (`.dsh/skills`) is registered in `KNOWN_AGENTS`, and the
provider side knows about it. The only gap is that auto-detection never picks
it on its own, and the remedy is a one-word explicit flag rather than growing
a list whose whole point is to stay small. The behavior is documented in
`docs/usage-guide.md` (single-repo mode, "Choosing which AI tools to set up").

A secondary consideration: upstream (`Tencent/teamai-cli`) also omits `dsh`
from this list, and this fork does not send issues or PRs upstream. Patching
the list locally would be a standing divergence from upstream for marginal
gain. If upstream ever drives the candidate set from `KNOWN_AGENTS` wholesale,
the gap closes on rebase for free.

## Prior requests

- #48: "SELF_MODE_AGENT_CHOICES 不含 dsh：非交互自动检测永远挑不到 DeepSeek Harness"
