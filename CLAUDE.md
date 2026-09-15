# CLAUDE.md

How an agent works in this repository.

## What this is

Public Claude Code plugins for engineering process. Today: `blind-review`, a
two-reviewer-plus-adjudicator pipeline over OpenRouter. The pattern is the
product; the plugin ships nothing about any particular person or project.

## Rules

1. **No personal data, ever.** No names beyond the GitHub handle, no employer
   material, no paths from anyone's private repositories, no API keys of any
   shape. `plugins/blind-review/scripts/blind-review.test.mjs` greps the tree for
   a fixed list and CI runs a secret scan on every push. If either fails, the
   fix is to remove the content, not to widen the allowlist.
2. **Fixtures are synthetic.** They describe a made-up project. When you need a
   new fixture, invent one; never paste a real diff.
3. **Node builtins only in `scripts/`.** No `package.json` dependencies. Node 22
   has `fetch`, `node:test`, and everything else these scripts need.
4. **Tests run offline.** Every test uses `--dry-run` with recorded responses.
   A test that needs the network is a test that will not run in CI.
5. **Reviewers stay blind.** Anything that would let reviewer B see reviewer
   A's output, or let either see a PR comment, is a bug. The independence test
   in `blind-review.test.mjs` is the contract; do not weaken it.
6. **The pipeline never acts.** No merge, no approve, no `gh pr review`, no
   automatic comment. It prints. Commenting is a separate, explicit request.
7. **Exit 2 is never a pass.** Anything that stops the pipeline short of a
   verdict exits 2, distinct from 0.
8. **Model choice lives in config, not code.** `config/models.example.json`
   names models with a dated reason. Code never mentions a model id.

## Working here

- Branch from `main`, small conventional commits (`feat:`, `fix:`, `test:`,
  `docs:`, `chore:`) whose bodies say why.
- Run `npm test` before opening a PR. Break one test on purpose and watch it
  fail before trusting it.
- The plugin format: `plugins/<name>/.claude-plugin/plugin.json`, skills under
  `plugins/<name>/skills/<skill>/SKILL.md`, and an entry in
  `.claude-plugin/marketplace.json` at the repo root.
- Skills that do anything with side effects carry
  `disable-model-invocation: true` so they only run when named.
