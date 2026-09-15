---
description: "Blind two-reviewer review of a PR with a third-family adjudicator on disagreement. Runs plugins/blind-review/scripts/blind-review.mjs on a PR's diff and brief, prints the report, and stops. Comments on the PR only when the user asks for that explicitly. Never merges, approves, or requests changes."
argument-hint: "<pr-number> [--brief <file>] [--config <models.json>] [--comment]"
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(gh pr diff:*), Bash(gh pr view:*), Bash(mkdir:*), Bash(cat:*), Read
---

# Blind review

Two reviewers from different model families see the diff and the brief and
nothing else. They run in parallel with byte-identical requests. Findings
without evidence are dropped. Where the two agree, the finding is recorded;
where they disagree, a third family adjudicates once. You read the result.

You are the operator of this pipeline, not a participant in it. Do not add your
own review to the reviewers' inputs, and do not soften or reinterpret their
findings. Print what came back.

## Arguments

`$ARGUMENTS`

- The first token is the PR number (or a branch name `gh pr diff` accepts).
- `--brief <file>`: the brief the change was built against. If omitted, use the
  PR body via `gh pr view N --json body -q .body`, and say that you did.
- `--config <file>`: model config. Default `${CLAUDE_PLUGIN_ROOT}/config/models.json`;
  if that does not exist, stop and tell the user to copy
  `${CLAUDE_PLUGIN_ROOT}/config/models.example.json` and pick three families.
- `--comment`: only with this flag do you post the report to the PR.

## Steps

1. Confirm `OPENROUTER_API_KEY` is set in the environment (`[ -n "$OPENROUTER_API_KEY" ]`).
   If not, stop and say so. Never ask the user to paste the key into chat; ask
   them to export it in their shell.
2. Fetch the inputs:
   ```
   mkdir -p /tmp/blind-review-<N>
   gh pr diff <N> > /tmp/blind-review-<N>/pr.diff
   gh pr view <N> --json body -q .body > /tmp/blind-review-<N>/brief.md   # unless --brief was given
   ```
3. Run the script:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/blind-review.mjs" \
     --diff /tmp/blind-review-<N>/pr.diff \
     --brief <brief file> \
     --config <config file> \
     --out /tmp/blind-review-<N>
   ```
4. Print `report.md` verbatim, then the exit code and the cost line the script
   printed. `0` means no agreed or upheld findings. `1` means at least one.
   `2` means it could not run; report the message and stop. `2` is never a pass.
5. Stop. Do not merge, approve, request changes, or edit anything in the repo.

## Only when asked

If and only if the user passed `--comment` or says in so many words that they
want the report posted to the PR, run
`gh pr comment <N> --body-file /tmp/blind-review-<N>/report.md`. A green report
is not a request to comment. A request to "review" is not a request to comment.

## What this skill never does

- It never merges, approves, or requests changes.
- It never feeds the reviewers anything but the diff and the brief. No PR
  comments, no earlier reviews, no repository access, no opinion of yours.
- It never stores the API key. It is read from the environment by the script.
- It never runs `gh pr comment` without the explicit request above.
