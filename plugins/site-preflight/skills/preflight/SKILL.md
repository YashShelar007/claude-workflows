---
description: "Run the launch checklist against a live site. Runs plugins/site-preflight/scripts/preflight.mjs on a URL, prints the report, then asks the six items no script can judge one at a time and appends the answers. Judges nothing on the user's behalf and changes nothing on the site."
argument-hint: "<url> [--max-pages N] [--out <dir>]"
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(mkdir:*), Bash(cat:*), Read, Write
---

# Site preflight

Fourteen of the twenty checklist items can be settled by asking the site. Six
cannot. The script does the fourteen and prints the number behind each verdict;
you ask the six, one at a time, and write down what you were told.

You are the operator here. Do not answer a human item from what you can see in
the markup, do not soften a failure, and do not mark anything as passed that the
script called `could-not-check`. `could-not-check` means the script refused to
guess, and a guess from you is worth less than the script's refusal.

## Arguments

`$ARGUMENTS`

- The first token is the origin to check, for example `https://example.com`.
- `--max-pages N`: how many pages to crawl. Default 20.
- `--out <dir>`: where the report goes. Default `/tmp/site-preflight-<host>`.

## Steps

1. Run the script:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/preflight.mjs" --url <url> --out <out dir>
   ```
2. Print `report.md` verbatim. Then say the exit code and what it means:
   `0` every mechanical item passed or did not apply; `1` at least one failed or
   could not be checked; `2` the origin could not be reached or a check threw.
   On `2`, print the message and stop. `2` is never a pass, and a site you could
   not reach has not been checked.
3. Ask the six human items **one at a time**, in these words, waiting for an
   answer before asking the next:
   1. Is there a privacy policy page, and is it linked from the site?
   2. Is there a terms and conditions page, and is it linked from the site?
   3. Does the page have one clear call to action, and can you say in a sentence
      what it is?
   4. Do the forms have spam protection, and which kind?
   5. Do the forms validate input and show the visitor what went wrong?
   6. Is analytics set up, and which? "None, on purpose" is a valid answer.

   For each, record `pass` with what the user said as the evidence, `fail` with
   the reason, or `n/a` with the reason — "there are no forms on this site" is a
   perfectly good `n/a` for the two form questions. A question the user skips
   stays unanswered; it does not become a pass.
4. Append the six rows to `report.md` under a heading `## Answered by the
   operator`, each row carrying the date, the question, the verdict, and the
   answer in the user's own words. Do not rewrite the mechanical half of the
   file: append to it.
5. Print the combined count — how many of the twenty-one rows passed, failed,
   were not applicable, and were left unchecked — and stop.

## Rules

- **Never fill in a human item yourself.** Not from the markup, not from a
  previous run, not from what is obviously true. If the user does not answer,
  the row says so.
- **Never upgrade a `could-not-check`.** Report it with the script's reason.
- **Never change the site.** This skill reads. It does not open pull requests,
  edit files, deploy, or file issues unless asked separately and explicitly.
- Do not log in, submit a form, or send anything the site would treat as a real
  request. A gated site returns a lot of `n/a` and that is the honest answer.
- Do not paste a credential the secret check finds. The script prints the file,
  the line and the first four characters; that is all anyone needs to go and
  rotate it, and it is all you should repeat.
