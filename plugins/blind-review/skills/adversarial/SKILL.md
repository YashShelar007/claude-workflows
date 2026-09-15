---
description: "Run a GPT-family adversarial review alongside the blind pair by wrapping /codex:adversarial-review from openai/codex-plugin-cc. If that plugin is not installed, say so plainly and stop with exit 2. Review-only; never acts on findings."
argument-hint: "[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [focus ...]"
disable-model-invocation: true
allowed-tools: Bash(node:*), Read
---

# Adversarial review

A third opinion from a different vendor's tooling: OpenAI's own Claude Code
plugin runs the Codex CLI to challenge the implementation approach. This skill
only checks that the plugin is present and hands off to it. It does not
impersonate any client and does not depend on any proxy.

## Steps

1. Run the detector:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/adversarial.mjs" $ARGUMENTS
   ```
2. If it exits `2`, print its output verbatim and stop. Do not attempt to
   install anything on the user's behalf and do not try to substitute your own
   review for the missing one. The blind half of the pipeline still works.
3. If it exits `0`, and `/codex:adversarial-review` is available in your skill
   list, invoke it with the same arguments the user passed
   (`$ARGUMENTS`). Return Codex's output verbatim.
4. If the detector exits `0` but the command is not in your skill list (a stale
   install), say exactly that and stop with the install instructions the
   detector printed.

## Rules

- Review-only. Do not fix, patch, or offer to change anything.
- Do not merge, approve, or comment on a PR from this skill.
- Do not combine this output with the blind review's report yourself; present
  them side by side and let the operator read both.
