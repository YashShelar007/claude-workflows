# blind-review

Two blind reviewers, one adjudicator, evidence or nothing. The repository
[README](../../README.md) has install, configuration and cost. This file is the
plugin's own map.

```
.claude-plugin/plugin.json      manifest
config/models.example.json      three roles, three families, dated reasons
scripts/blind-review.mjs        the pipeline; node builtins only
scripts/adversarial.mjs         detector for openai/codex-plugin-cc
scripts/blind-review.test.mjs   fixtures only, no network
fixtures/                       a synthetic project with a planted bug and a planted false positive
skills/blind-review/SKILL.md    /blind-review:blind-review <pr>  (explicit-only)
skills/adversarial/SKILL.md     /blind-review:adversarial        (explicit-only)
```

## How a run goes

```
diff + brief ─┬─▶ reviewer A ──▶ findings A ─┐
              └─▶ reviewer B ──▶ findings B ─┤      (parallel, identical bodies)
                                             ▼
                          drop evidence-less · match · split
                                             │
                        agreed ──────────────┼──────────── disputed
                           │                                 │
                        record                     adjudicator, once, fresh
                           │                                 │
                           └──────────▶ report.json / report.md ◀──┘
```

Matching: same `path` with `line` within 3, or normalised claim text with
Jaccard at least 0.6. Same finding at the same severity is agreed; anything
else is disputed. The adjudicator sees the brief, the diff, and each disputed
finding with both sides' claims and evidence, and rules on each id. If it fails
to rule on one, the run exits 2.

## Evidence shapes

A finding is kept only if its `evidence` is one of:

1. `path:line`, for example `src/cache.js:13`
2. a test name prefixed `test:`, for example `test: get returns undefined after ttl`
3. a command and its output, for example `$ node -e "..."` followed by the output on the next line

Anything else is dropped and counted under `dropped-no-evidence`.

## Fixtures

`fixtures/` describes MintCache, a made-up LRU cache. The diff adds a `ttl`
option documented in seconds and compares it against a millisecond difference
(`src/cache.js:13`): the planted bug. It also deletes and re-inserts a key on
every `get` to bump recency, which looks wrong and is not: the planted false
positive. `fixtures/responses/` holds recorded reviewer and adjudicator answers
for three scenarios (`clean`, `agreed`, `disputed`) that the tests drive with
`--dry-run --responses <dir>`.

## Running the fixtures yourself

```
node plugins/blind-review/scripts/blind-review.mjs \
  --diff plugins/blind-review/fixtures/diff.patch \
  --brief plugins/blind-review/fixtures/brief.md \
  --config plugins/blind-review/fixtures/config/three-families.json \
  --out /tmp/blind-review-fixture \
  --dry-run --responses plugins/blind-review/fixtures/responses/disputed
```
