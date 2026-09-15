# site-preflight

A twenty-item launch checklist, ticked from evidence instead of memory.

Fourteen of the items can be settled by asking the site: a script fetches the
pages, reads the bytes, and writes down the number it judged each item on. Six
cannot be settled that way at all, so the skill asks a human, one at a time, and
records the answer beside the rest. Nothing in between: the script never guesses
at a human item, and it never reports a verdict it could not measure.

```
.claude-plugin/plugin.json      manifest
scripts/preflight.mjs           the checks; node builtins only
scripts/preflight.test.mjs      fixtures only, loopback only, no public network
scripts/make-fixtures.mjs       generates the two fixture images
fixtures/pass-site/             a made-up bakery that clears every check
fixtures/broken-site/           the same shop with eleven checks broken on purpose
skills/preflight/SKILL.md       /site-preflight:preflight <url>   (explicit-only)
```

## Install

```
/plugin marketplace add YashShelar007/claude-workflows
/plugin install site-preflight@claude-workflows
```

Requirements: Node 22 or newer. No API key, no configuration, no dependencies.

## Run

```
node plugins/site-preflight/scripts/preflight.mjs --url https://example.com --out /tmp/preflight
cat /tmp/preflight/report.md
```

Or, inside Claude Code: `/site-preflight:preflight https://example.com`, which
runs the script and then asks the six human items.

| Flag | Default | What it does |
|---|---|---|
| `--url <origin>` | — | the site to check |
| `--out <dir>` | — | where `report.json` and `report.md` go |
| `--max-pages <n>` | 20 | how many HTML pages the crawl will visit |
| `--ttfb-ms <n>` | 800 | time-to-first-byte threshold |
| `--max-bytes <n>` | 2097152 | landing-page weight threshold |
| `--max-image-bytes <n>` | 307200 | per-image weight threshold |
| `--fixture <dir>` | — | serve a local directory and check that instead |

Exit `0` when every mechanical item passed or did not apply, `1` when any item
failed **or could not be checked**, `2` when the origin could not be reached or
a check threw. `2` is never a pass, and neither is `1`: an item the script could
not read is an item nobody has checked.

## The fourteen mechanical items

| Item | Passes when |
|---|---|
| Force HTTPS | `http://host/` answers 301 or 308 to `https://` on the same host. `n/a` on an http origin. |
| Sitemap and robots.txt | `/robots.txt` is 200 with at least one parseable directive, and every `<loc>` in `/sitemap.xml` returns 200. |
| Meta title and description | Every crawled page has a title of 10–70 characters and a description of 50–160. Lengths are printed for every page either way. |
| Social preview image | `og:title`, `og:description`, `og:image` and `twitter:card` are present, and the image fetches as an image of at least 1200×630 when its dimensions can be read from the bytes. |
| Favicon | The declared `<link rel="icon">` returns 200, or `/favicon.ico` does. |
| Mobile friendly | Every crawled page carries a `<meta name="viewport">`. |
| Custom 404 page | A path that does not exist returns 404 — not 200 — and the body carries the site title or a link back into the site rather than the server's own default. |
| No broken links | Every same-origin `<a href>` found in the crawl returns under 400. Failures name the page that linked them. |
| Alt text on images | Every `<img>` has a non-empty `alt`, or `alt=""` together with `role="presentation"`. |
| Image compression | No image exceeds the per-image byte threshold. The byte count is printed for every image either way. |
| Page load speed | Time to first byte and landing-page bytes are both under their thresholds. Both numbers are printed either way. |
| Secrets off the frontend | No credential-shaped string in any same-origin script or inline script. Findings name the file, the line, and the first four characters — never the value. |
| Colour contrast | Every text/background pair written as literal colours reaches 4.5:1. Pairs that resolve only through variables or inheritance are `could-not-check`. |
| No mixed content | No `http://` asset referenced from an https page. On an http origin the verdict is `n/a` and the references are still listed. |
| Security headers | Report only. `Content-Security-Policy` and `X-Content-Type-Options` are printed whether present or absent; the checklist does not require either, so this row always passes. |

That is fifteen rows from fourteen checks: alt text and image weight come off
one crawl of the images but are separate rows, because they fail for unrelated
reasons and get fixed by different people.

## The six a script cannot answer

Privacy policy page · terms and conditions page · one clear call to action ·
spam protection on forms · form validation · analytics set up.

The skill asks these in the checklist's own words, one at a time, and records
what it was told. "None, on purpose" is a pass for analytics. A question nobody
answered stays unanswered.

## What this cannot judge, and why

- **Whether a cookie consent banner is required, or correct.** That turns on
  jurisdiction and on what the page actually sets before consent, and no amount
  of markup reading settles it. It is the one checklist item neither half of
  this plugin covers; decide it with a lawyer, not a script.
- **A colour that comes from a CSS variable, a class applied at runtime, or an
  inherited background.** The script reports the count and refuses to guess.
  Resolving these properly needs a rendering engine; this has none.
- **Whether a page *looks* right on a phone.** It checks for a viewport tag,
  which is necessary and nowhere near sufficient.
- **Real-world load time.** Time to first byte and transferred bytes are two
  numbers from the machine you ran it on, over the connection you ran it on.
  They are not a Lighthouse score and they are not a field measurement.
- **Images referenced by `srcset`, CSS `background-image`, or JavaScript.** Only
  `<img src>` is walked.
- **Anything behind a login.** The script never authenticates. A gated site
  returns a page of `n/a` and redirects, which is the honest answer, not a pass.
- **Whether a 404 page is *good*.** It checks the status code and looks for the
  site's title or a link home. A styled page saying nothing useful still passes.

## Fixtures

`fixtures/pass-site/` is Maple and Rye, a made-up bakery that clears every
check. `fixtures/broken-site/` is Clover Lane, the same shop with eleven checks
broken on purpose: no robots or sitemap, a four-character title, no description,
no `og:image`, no `twitter:card`, no favicon, a page with no viewport, a soft 404
that answers 200 for everything, a dead internal link, an image with no `alt`, an
image over the weight threshold, a 2.49:1 contrast pair, an `http://` stylesheet
and a placeholder key in the served JavaScript.

Two images are generated rather than committed — one has to be 1200×630 and the
other has to weigh more than the threshold it exists to breach, and a third of a
megabyte of incompressible noise does not belong in a git history:

```
node plugins/site-preflight/scripts/make-fixtures.mjs
node plugins/site-preflight/scripts/preflight.mjs --fixture plugins/site-preflight/fixtures/broken-site --out /tmp/preflight-broken
```

The test suite generates them itself, so `npm test` needs no setup.

## Notes for anyone changing this

- Collection and verdict are separate functions. Two checks — the https redirect
  and mixed content — cannot fail against a fixture served over plain http, so
  their failing cases are proven on the verdict function directly. Keep that
  split if you add a check that needs TLS, a real browser, or a third party.
- `could-not-check` is load-bearing. It exits 1, not 0. If a change makes an
  unreadable value quietly resolve to a plausible one, that is the bug.
- The secret patterns are assembled from string fragments so this plugin does
  not read as a credential to the repository's own secret scan, and so the
  hygiene test that greps the tree keeps meaning something.
