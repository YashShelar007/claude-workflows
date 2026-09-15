# Contributing

Thanks for looking. This repo is small on purpose.

## Ground rules

- **Nothing personal.** No real names, employers, private repository paths, or
  credentials in any form. The test suite and CI both check; a PR that trips
  either will not be merged, and the fix is removal.
- **Synthetic fixtures.** Invent a project. Do not paste a real diff, even a
  public one, into `fixtures/`.
- **Node builtins only** in `plugins/*/scripts/`. Node 22 is the floor.
- **Offline tests.** Every test must pass with no network and no API key.

## Making a change

1. Branch from `main`.
2. `npm test` must pass before and after.
3. Add or update a fixture when behaviour changes. If you fix a bug, add the
   fixture that would have caught it.
4. Small conventional commits. The body explains why, not what.
5. Open a PR. Say what you verified by running it, and what you did not.

## Adding a plugin

```
plugins/<name>/
  .claude-plugin/plugin.json
  README.md
  skills/<skill>/SKILL.md
  scripts/            (optional; builtins only)
  fixtures/           (optional; synthetic)
```

Register it in `.claude-plugin/marketplace.json`. Skills with side effects get
`disable-model-invocation: true`.

## Model ids

`config/models.example.json` names OpenRouter model ids. They go stale. If you
update one, record the date and the one-line reason beside it, and check the id
exists at `https://openrouter.ai/api/v1/models` first.
