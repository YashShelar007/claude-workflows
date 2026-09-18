# claude-workflows

Claude Code plugins for engineering process. Two so far:

**`blind-review`**: two reviewers from different model families read a PR's
diff and brief and nothing else, in parallel, with byte-identical prompts. Where
they agree, the finding is recorded. Where they disagree, a third model family
adjudicates. Findings without evidence are dropped before anyone reads them.

**`site-preflight`**: the mechanical half of a twenty-item launch checklist,
asked of a live site and answered with the number it was judged on — the status
code, the byte count, the contrast ratio. The six items no script can settle are
put to a human, one at a time. A value it cannot read is `could-not-check`,
which is not a pass.

## Why

When the model that wrote a change also reviews it, the review inherits the
author's blind spots. One reviewer agreeing with itself is not a signal; two
independent reviewers disagreeing is. `blind-review` makes independence a
property of the wiring: a script calls both reviewers with the same bytes, a
test proves the second request contains nothing from the first response, and an
adjudicator is paid only when there is a dispute to settle.

## Install

```
/plugin marketplace add YashShelar007/claude-workflows
/plugin install blind-review@claude-workflows
```

Requirements: Node 22 or newer, `gh` logged in, and an OpenRouter API key in
the environment as `OPENROUTER_API_KEY`. The key is read from the environment
only and never written to disk.

## Configure

Copy the example and pick three models from three different families:

```
cp plugins/blind-review/config/models.example.json plugins/blind-review/config/models.json
```

```json
{
  "a":           { "model": "deepseek/deepseek-v4-pro", "family": "deepseek" },
  "b":           { "model": "openai/gpt-5.4",            "family": "openai" },
  "adjudicator": { "model": "google/gemini-3.8-flash",   "family": "gemini" }
}
```

The script refuses to run if any two roles share a `family`. It also refuses
to run against the example file itself: if `--config` resolves to
`models.example.json`, or the file still carries the `_comment` key (in case
it was copied without cleaning that up), it exits 2 and tells you to copy it
first. Model ids are OpenRouter ids; they go stale, so the example file
carries the date each was chosen and why. Check
`https://openrouter.ai/api/v1/models` before trusting it.

Each role can also set its own `reasoning` field, passed straight through as
OpenRouter's `reasoning` object (`{"effort":"low"|"medium"|"high"|...}` or
`{"max_tokens":N}`; see
[OpenRouter's reasoning tokens docs](https://openrouter.ai/docs/use-cases/reasoning-tokens)).
Without one, reviewers (`a`, `b`) default to `{"effort":"low"}` and the
`adjudicator` to `{"effort":"medium"}` — the first live run had a reviewer
spend ~155k reasoning tokens on a 3-file diff, and this caps that by default.

## First real run

```
gh pr diff 42 > /tmp/pr-42.diff
gh pr view 42 --json body -q .body > /tmp/pr-42-brief.md   # or point at the actual brief file
node plugins/blind-review/scripts/blind-review.mjs \
  --diff /tmp/pr-42.diff \
  --brief /tmp/pr-42-brief.md \
  --config plugins/blind-review/config/models.json \
  --out /tmp/blind-review-42
cat /tmp/blind-review-42/report.md
```

Or, inside Claude Code: `/blind-review:blind-review 42`.

Add `--timeout <seconds>` (default 300) to bound each reviewer and adjudicator
call; a call that runs past it is aborted and that role is recorded as timed
out, rather than the run hanging with no output (the second live run sat for
35 minutes with an empty log before it was killed). While a run is in
progress it prints one line to stderr when each call starts and one when it
finishes, with the role, model, elapsed seconds and token counts; pass
`--quiet` to suppress those.

Exit codes: `0` no findings, `1` at least one agreed or upheld finding, `2`
could not run (missing key, example config, same-family config, a timed-out
call, unparseable reviewer output, adjudicator did not rule). `2` is never a
pass.

## What comes out

`report.json` holds every finding with a status
(`agreed`, `adjudicated-upheld`, `adjudicated-dismissed`, `dropped-no-evidence`,
`dropped-malformed`), the model behind each role, token counts, per-call cost
and the number of calls made per role. `report.md` is the human summary. The
request bodies actually sent are written beside them so independence can be
audited after the fact.

## What it never does

- It never merges, approves, or requests changes on a PR.
- It never comments on a PR unless you ask for that in so many words. By
  default the skill prints the report and stops.
- It never runs on anything but the diff and brief you hand it. No PR comments,
  no prior reviews, no repository access for the reviewers.
- It never writes the API key anywhere. Not to the report, not to the request
  files, not to logs.

## Cost

Reviewer calls carry the whole diff as input. At September 2026 OpenRouter
prices for the example models, a 400-line diff costs roughly one to three cents
per reviewer and the adjudicator a similar amount when it runs. The script
prints per-call cost from OpenRouter's generation metadata after each run; when
that endpoint does not answer, it prints `cost unknown` rather than `$0.00`.

## Also in the plugin

`/blind-review:adversarial` wraps `/codex:adversarial-review` from
[`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) when that
plugin is installed, so a GPT-family challenge review can run beside the blind
pair. If it is not installed, the skill says so and stops with exit 2.

## Development

```
npm test
```

Tests run against recorded fixtures only. There is no network in the test
suite. `CONTRIBUTING.md` has the rules; `CLAUDE.md` is for agents working here.

## License

MIT.
