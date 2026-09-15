// Tests for site-preflight. Every end-to-end case spawns the real script
// against a fixture the script itself serves on a loopback port. Nothing here
// reaches the public internet: the fixtures reference no cross-origin asset
// that the script would fetch, and one test asserts that stays true.
//
// Two of the fourteen checks cannot fail against a fixture served over plain
// http — a redirect to https, and mixed content on an https page. Collection
// and verdict are separate functions for exactly that reason, and their
// failing cases are proven on the verdict.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ITEMS,
  HUMAN_ITEMS,
  parsePage,
  parseAttributes,
  parseColour,
  contrastRatio,
  contrastFindings,
  cssRules,
  declarations,
  imageSize,
  scanSecrets,
  maskSecret,
  judgeHttpsRedirect,
  judgeMixedContent,
  judgeSecurityHeaders,
  judgePageLoad,
  judgeMetaLengths,
  looksCustom,
  exitCodeFor,
} from './preflight.mjs';
import { makeFixtures, encodePng } from './make-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, 'preflight.mjs');
const PLUGIN = path.resolve(here, '..');
const REPO = path.resolve(PLUGIN, '..', '..');
const FIX = path.join(PLUGIN, 'fixtures');
const PASS = path.join(FIX, 'pass-site');
const BROKEN = path.join(FIX, 'broken-site');

// The two fixture images are generated, not committed: one is 1200x630, the
// other has to weigh more than the threshold it exists to breach.
await makeFixtures(FIX);

function runScript(args) {
  const out = mkdtempSync(path.join(tmpdir(), 'site-preflight-out-'));
  const r = spawnSync(process.execPath, [SCRIPT, '--out', out, ...args], { encoding: 'utf8' });
  return { ...r, out };
}

function runFixture(dir, extra = []) {
  return runScript(['--fixture', dir, ...extra]);
}

function report(r) {
  return JSON.parse(readFileSync(path.join(r.out, 'report.json'), 'utf8'));
}

function statuses(r) {
  return Object.fromEntries(report(r).results.map((x) => [x.item, x.status]));
}

function evidenceFor(r, item) {
  return report(r).results.find((x) => x.item === item).evidence.join('\n');
}

// A throwaway copy of a fixture with some files replaced or removed, so a
// single defect can be isolated without a second fixture tree to maintain.
function tempSite(source, overrides = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'site-preflight-site-'));
  execFileSync('cp', ['-R', `${source}/.`, dir]);
  for (const [rel, content] of Object.entries(overrides)) {
    const target = path.join(dir, rel);
    if (content === null) {
      rmSync(target, { force: true });
      continue;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return dir;
}

// ---------------------------------------------------------------------------
// The two fixtures, end to end
// ---------------------------------------------------------------------------

test('the passing fixture exits 0 with no fail and nothing unchecked', () => {
  const r = runFixture(PASS);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const rep = report(r);
  assert.equal(rep.counts.fail, 0);
  assert.equal(rep.counts['could-not-check'], 0);
  assert.equal(rep.results.length, ITEMS.length);
  assert.equal(rep.pages.length, 4);
});

test('the broken fixture exits 1 and fails eleven items for eleven separate reasons', () => {
  const r = runFixture(BROKEN);
  assert.equal(r.status, 1, r.stderr || r.stdout);
  const s = statuses(r);
  assert.deepEqual(
    Object.entries(s).filter(([, v]) => v === 'fail').map(([k]) => k).sort(),
    [
      'alt-text', 'broken-links', 'colour-contrast', 'custom-404', 'favicon',
      'image-compression', 'meta-title-description', 'mobile-friendly',
      'robots-sitemap', 'secrets-off-the-frontend', 'social-preview',
    ],
  );
  assert.equal(s['page-load-speed'], 'pass');
  assert.equal(s['security-headers'], 'pass', 'the header check is report-only and never fails');
});

test('every item reports a measured number or a status code, on a pass as much as a failure', () => {
  for (const r of [runFixture(PASS), runFixture(BROKEN)]) {
    for (const item of report(r).results) {
      const text = item.evidence.join(' ');
      assert.ok(item.evidence.length > 0, `${item.item} has no evidence`);
      assert.match(text, /\d/, `${item.item} evidence carries no number: ${text}`);
    }
  }
});

// ---------------------------------------------------------------------------
// One failing case per check. The numbers are the fourteen checks in the brief;
// checks 9a and 9b are the two rows that come off one crawl of the images.
// ---------------------------------------------------------------------------

test('check 1, force https: a site that answers http with 200 fails', () => {
  assert.equal(judgeHttpsRedirect({ baseIsHttps: true, host: 'example.com', status: 200 }).status, 'fail');
  assert.equal(judgeHttpsRedirect({ baseIsHttps: true, host: 'example.com', status: 302, location: 'https://example.com/' }).status, 'fail', '302 is not a permanent redirect');
  assert.equal(judgeHttpsRedirect({ baseIsHttps: true, host: 'example.com', status: 301, location: 'http://example.com/x' }).status, 'fail', 'a redirect that stays on http is not a redirect to https');
  assert.equal(judgeHttpsRedirect({ baseIsHttps: true, host: 'example.com', status: 301, location: 'https://elsewhere.example/' }).status, 'fail', 'a different host is not this site');
  assert.equal(judgeHttpsRedirect({ baseIsHttps: true, host: 'example.com', status: 308, location: '/there' }).status, 'fail', 'a relative Location keeps the http scheme');
  const good = judgeHttpsRedirect({ baseIsHttps: true, host: 'example.com', status: 301, location: 'https://example.com/' });
  assert.equal(good.status, 'pass');
  assert.match(good.evidence[0], /301/);
  assert.equal(judgeHttpsRedirect({ baseIsHttps: false, host: '127.0.0.1:1' }).status, 'na');
  assert.equal(judgeHttpsRedirect({ baseIsHttps: true, host: 'example.com', error: 'connect ECONNREFUSED' }).status, 'could-not-check');
});

test('check 2, robots and sitemap: absent fails, and so does a sitemap URL that 404s', () => {
  const absent = evidenceFor(runFixture(BROKEN), 'robots-sitemap');
  assert.match(absent, /\/robots\.txt returned 404/);
  assert.match(absent, /\/sitemap\.xml returned 404/);

  const dead = tempSite(PASS, {
    'sitemap.xml': '<?xml version="1.0" encoding="UTF-8"?>\n<urlset><url><loc>{{ORIGIN}}/</loc></url><url><loc>{{ORIGIN}}/gone.html</loc></url></urlset>\n',
  });
  const r = runFixture(dead);
  assert.equal(r.status, 1);
  assert.equal(statuses(r)['robots-sitemap'], 'fail');
  assert.match(evidenceFor(r, 'robots-sitemap'), /gone\.html returned 404/);
});

test('check 3, title and description: both bounds and both absences fail, lengths always reported', () => {
  const r = runFixture(BROKEN);
  const evidence = evidenceFor(r, 'meta-title-description');
  assert.match(evidence, /title is 4 chars, outside 10-70/);
  assert.match(evidence, /no <meta name="description">/);
  assert.match(evidence, /title is 97 chars, outside 10-70/);
  assert.match(evidence, /description is 10 chars, outside 50-160/);

  const none = judgeMetaLengths([]);
  assert.equal(none.status, 'could-not-check');
});

test('check 4, social preview: a missing og:image fails, and so does one under 1200x630', () => {
  assert.match(evidenceFor(runFixture(BROKEN), 'social-preview'), /og:image is absent/);

  const small = tempSite(PASS, { 'out/small.png': encodePng(600, 315, () => [10, 20, 30]) });
  const index = readFileSync(path.join(small, 'index.html'), 'utf8').replace('/out/og.png', '/out/small.png');
  writeFileSync(path.join(small, 'index.html'), index);
  const r = runFixture(small);
  assert.equal(statuses(r)['social-preview'], 'fail');
  const evidence = evidenceFor(r, 'social-preview');
  assert.match(evidence, /og:image is 600x315, under 1200x630/);
  assert.match(evidence, /content-type image\/png/);
});

test('check 5, favicon: no link and no /favicon.ico fails', () => {
  const r = runFixture(BROKEN);
  assert.equal(statuses(r).favicon, 'fail');
  assert.match(evidenceFor(r, 'favicon'), /\/favicon\.ico returned 404/);
});

test('check 6, viewport: one page without it fails the site', () => {
  const r = runFixture(BROKEN);
  assert.equal(statuses(r)['mobile-friendly'], 'fail');
  assert.match(evidenceFor(r, 'mobile-friendly'), /1 of 2 page\(s\) have no <meta name="viewport">/);
});

test('check 7, custom 404: a soft 404 fails, and so does a real 404 with a bare body', () => {
  const soft = runFixture(BROKEN);
  assert.equal(statuses(soft)['custom-404'], 'fail');
  assert.match(evidenceFor(soft, 'custom-404'), /status 200 for a path that does not exist is a soft 404/);

  const bare = tempSite(PASS, { '404.html': 'Not Found. The requested resource was not located on this server.\n' });
  const r = runFixture(bare);
  assert.equal(statuses(r)['custom-404'], 'fail');
  assert.match(evidenceFor(r, 'custom-404'), /looks like a bare server default/);

  assert.equal(looksCustom('Not Found', { siteTitle: 'Maple and Rye Bakery' }), false, 'too short to be a page');
  assert.equal(looksCustom('x'.repeat(80), { siteTitle: 'Maple and Rye Bakery' }), false, 'no title and no link');
  assert.equal(looksCustom(`${'x'.repeat(80)} Maple and Rye Bakery`, { siteTitle: 'Maple and Rye Bakery' }), true);
  assert.equal(looksCustom(`${'x'.repeat(80)} <a href="/">home</a>`, { siteTitle: null }), true);
});

test('check 8, internal links: a dead link fails and names the page that linked it', () => {
  const r = runFixture(BROKEN);
  assert.equal(statuses(r)['broken-links'], 'fail');
  assert.match(evidenceFor(r, 'broken-links'), /\/menu\/seasonal\.html returned 404; linked from http:\/\/127\.0\.0\.1:\d+\//);
});

test('check 9a, alt text: only a missing alt attribute fails; alt="" is decorative and counted', () => {
  const broken = runFixture(BROKEN);
  assert.equal(statuses(broken)['alt-text'], 'fail');
  assert.match(evidenceFor(broken, 'alt-text'), /sketch\.svg"> has no alt attribute/);
  assert.match(evidenceFor(broken, 'alt-text'), /2 image\(s\): 1 described, 0 marked decorative with alt="", 1 with no alt attribute/);

  // alt="" alone is the spec-correct marking for a decorative image.
  // role="presentation" adds nothing an assistive technology acts on, so
  // requiring it would fail markup that is already right.
  const r = runFixture(PASS);
  assert.equal(statuses(r)['alt-text'], 'pass');
  const evidence = evidenceFor(r, 'alt-text');
  assert.match(evidence, /leaf\.svg">: alt ""/);
  assert.ok(!/role="presentation"/.test(evidence), 'the passing fixture no longer needs the redundant role');
  assert.match(evidence, /2 image\(s\): 1 described, 1 marked decorative with alt="", 0 with no alt attribute/);
  assert.match(evidence, /whether that is right is a judgement no script makes/);

  // The count is the point: it is what lets a reader notice that a page has
  // declared far more images decorative than a page plausibly should.
  const many = tempSite(PASS, {});
  const index = readFileSync(path.join(many, 'index.html'), 'utf8')
    .replace('<img src="/assets/leaf.svg" alt=""', '<img src="/assets/leaf.svg" alt="" data-n="1"><img src="/assets/leaf.svg" alt="" data-n="2"><img src="/assets/leaf.svg" alt=""');
  writeFileSync(path.join(many, 'index.html'), index);
  const counted = runFixture(many);
  assert.equal(statuses(counted)['alt-text'], 'pass', 'three decorative images is still not a failure');
  assert.match(evidenceFor(counted, 'alt-text'), /4 image\(s\): 1 described, 3 marked decorative/);

  // An alt attribute with nothing but whitespace is decorative, not described.
  const blank = tempSite(PASS, {});
  writeFileSync(
    path.join(blank, 'index.html'),
    readFileSync(path.join(blank, 'index.html'), 'utf8').replace('alt="A scored round sourdough loaf, cooling on a rack"', 'alt="   "'),
  );
  assert.match(evidenceFor(runFixture(blank), 'alt-text'), /0 described, 2 marked decorative/);
});

test('check 9b, image weight: an image over the threshold fails with its byte count', () => {
  const r = runFixture(BROKEN);
  assert.equal(statuses(r)['image-compression'], 'fail');
  assert.match(evidenceFor(r, 'image-compression'), /hero\.png is 3\d{5} bytes, over the 307200 byte threshold/);
  assert.match(evidenceFor(runFixture(PASS), 'image-compression'), /loaf\.svg: 200, \d+ bytes \(threshold 307200\)/);
});

test('check 10, page load: over either threshold fails, and both numbers are printed either way', () => {
  const r = runFixture(PASS, ['--max-bytes', '200']);
  assert.equal(r.status, 1);
  assert.equal(statuses(r)['page-load-speed'], 'fail');
  assert.match(evidenceFor(r, 'page-load-speed'), /over threshold: page weight/);

  assert.equal(judgePageLoad({ ttfbMs: 900, bytes: 10, ttfbLimit: 800, bytesLimit: 100 }).status, 'fail');
  const ok = judgePageLoad({ ttfbMs: 12, bytes: 10, ttfbLimit: 800, bytesLimit: 100 });
  assert.equal(ok.status, 'pass');
  assert.match(ok.evidence.join(' '), /12 ms.*10 bytes/);
});

test('check 11, secrets: every shape is found, reported by file and line, and never printed', () => {
  const r = runFixture(BROKEN);
  assert.equal(statuses(r)['secrets-off-the-frontend'], 'fail');
  const evidence = evidenceFor(r, 'secrets-off-the-frontend');
  assert.match(evidence, /app\.js:8: credential assigned to a name/);
  assert.match(evidence, /demo\.\.\. \(33 chars, rest withheld\)/);
  assert.ok(!evidence.includes('demo_placeholder_not_a_credential'), 'the value itself is never in the report');

  // Needles are built from fragments so this file is not itself a credential
  // to the repository's secret scan. Each is a shape, not a key.
  const shapes = [
    ['anthropic', 'sk-' + 'ant-' + 'a'.repeat(30)],
    ['openrouter', 'sk-' + 'or-' + 'v1' + '-' + 'b'.repeat(30)],
    ['github', 'ghp' + '_' + 'c'.repeat(36)],
    ['aws', 'AKI' + 'A' + 'D'.repeat(16)],
    ['stripe', 'sk' + '_live_' + 'e'.repeat(24)],
    ['pem', '-----BEGIN ' + 'RSA ' + 'PRIVATE KEY-----'],
    ['assigned', 'const TOKEN = "' + 'f'.repeat(28) + '"'],
  ];
  for (const [kind, needle] of shapes) {
    const hits = scanSecrets(`const x = 1;\n${needle}\n`, 'bundle.js');
    assert.ok(hits.some((h) => h.kind === kind), `${kind} was not detected`);
    assert.ok(hits.every((h) => h.line === 2), `${kind} reported the wrong line`);
    for (const hit of hits) assert.ok(!hit.masked.includes(needle), `${kind} leaked the value`);
  }
  assert.deepEqual(scanSecrets('const version = "1.2.3";\nconst token = "short";\n', 'a.js'), []);
  assert.match(maskSecret('abcdefghij'), /^abcd\.\.\. \(10 chars, rest withheld\)$/);
  assert.match(maskSecret('ab'), /^\*\* \(2 chars\)$/);
});

test('check 12, colour contrast: a pair under 4.5:1 fails; an unresolvable one is never guessed', () => {
  const r = runFixture(BROKEN);
  assert.equal(statuses(r)['colour-contrast'], 'fail');
  const evidence = evidenceFor(r, 'colour-contrast');
  assert.match(evidence, /\.notice \}: #a4a4a4 on #ffffff = 2\.49:1/);
  assert.match(evidence, /unresolved: .*\.page \}: colour #1c1c1c is declared but the background is inherited/);

  // Ratios against the WCAG reference values.
  assert.equal(Math.round(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }) * 100) / 100, 21);
  assert.equal(Math.round(contrastRatio({ r: 255, g: 255, b: 255 }, { r: 255, g: 255, b: 255 }) * 100) / 100, 1);

  assert.deepEqual(parseColour('#fff'), { r: 255, g: 255, b: 255 });
  assert.deepEqual(parseColour('#102030'), { r: 16, g: 32, b: 48 });
  assert.deepEqual(parseColour('rgb(1, 2, 3)'), { r: 1, g: 2, b: 3 });
  assert.deepEqual(parseColour('rgba(1, 2, 3, 1)'), { r: 1, g: 2, b: 3 });
  assert.deepEqual(parseColour('white'), { r: 255, g: 255, b: 255 });
  assert.equal(parseColour('var(--ink)'), null, 'a variable is not a colour this script knows');
  assert.equal(parseColour('currentColor'), null);
  assert.equal(parseColour('rgba(0, 0, 0, 0.4)'), null, 'translucent over an unknown backdrop is unresolvable');
  assert.equal(parseColour('#00000080'), null);
  assert.equal(parseColour('rebeccapurple'), null, 'not in the small literal table, so not guessed');

  const { pairs, unresolved } = contrastFindings(
    cssRules('.a{color:var(--ink);background:#fff}.b{color:#000;background:linear-gradient(#fff,#eee)}.c{color:#000;background:#fff}'),
    'inline',
  );
  assert.equal(pairs.length, 1);
  assert.equal(unresolved.length, 2);
  assert.ok(unresolved.every((u) => /cannot resolve/.test(u.reason)));
});

test('check 12: at-rule wrappers are stepped over and the rules inside them are still read', () => {
  const rules = cssRules('@media (min-width: 40rem) { .x { color: #000; background: #fff } }');
  assert.deepEqual(rules.map((r) => r.selector), ['.x']);
  assert.equal(contrastFindings(rules, 'inline').pairs.length, 1);
  assert.deepEqual(declarations('color:#000;background:#fff;'), { color: '#000', background: '#fff' });
});

test('check 13, mixed content: an http asset on an https page fails', () => {
  const assets = [{ page: 'https://example.com/', url: 'http://cdn.example.com/a.css', tag: 'link', attribute: 'href' }];
  const bad = judgeMixedContent({ baseIsHttps: true, assets });
  assert.equal(bad.status, 'fail');
  assert.match(bad.evidence.join(' '), /http:\/\/cdn\.example\.com\/a\.css/);
  assert.equal(judgeMixedContent({ baseIsHttps: true, assets: [] }).status, 'pass');

  // Over plain http the verdict is n/a, but the references are still collected
  // and printed, so turning TLS on does not require a second pass to find them.
  const r = runFixture(BROKEN);
  assert.equal(statuses(r)['mixed-content'], 'na');
  assert.match(evidenceFor(r, 'mixed-content'), /1 http:\/\/ asset reference found/);
  assert.match(evidenceFor(r, 'mixed-content'), /static\.clover-lane\.example\/print\.css/);
});

test('check 14, security headers: report only, and the value is printed whether present or absent', () => {
  const absent = judgeSecurityHeaders({});
  assert.equal(absent.status, 'pass');
  assert.deepEqual(absent.evidence.slice(0, 3), ['0 of 2 reported headers present', 'Content-Security-Policy: absent', 'X-Content-Type-Options: absent']);
  const present = judgeSecurityHeaders({ 'content-security-policy': "default-src 'self'", 'x-content-type-options': 'nosniff' });
  assert.equal(present.status, 'pass');
  assert.match(present.evidence.join(' '), /default-src 'self'.*nosniff/);
  assert.match(present.evidence.join(' '), /the checklist does not require either header/);
});

test('all fourteen checks have a failing case somewhere in this file', () => {
  const endToEnd = new Set();
  for (const r of [runFixture(BROKEN), runFixture(PASS, ['--max-bytes', '200'])]) {
    for (const item of report(r).results) if (item.status === 'fail') endToEnd.add(item.item);
  }
  assert.deepEqual(
    [...endToEnd].sort(),
    [
      'alt-text', 'broken-links', 'colour-contrast', 'custom-404', 'favicon',
      'image-compression', 'meta-title-description', 'mobile-friendly',
      'page-load-speed', 'robots-sitemap', 'secrets-off-the-frontend', 'social-preview',
    ],
    'twelve of the fifteen rows fail against a fixture',
  );
  // The remaining three, and why they are not in that list.
  assert.equal(judgeHttpsRedirect({ baseIsHttps: true, host: 'h', status: 200 }).status, 'fail');
  assert.equal(judgeMixedContent({ baseIsHttps: true, assets: [{ page: 'p', url: 'http://x/y', tag: 'img', attribute: 'src' }] }).status, 'fail');
  assert.equal(judgeSecurityHeaders({}).status, 'pass', 'report-only: it has no failing case by design');
  assert.equal(ITEMS.length, 15);
});

// ---------------------------------------------------------------------------
// Exit codes. 2 is never 0, and could-not-check is never a pass.
// ---------------------------------------------------------------------------

test('a closed port exits 2 and says so in the report', async () => {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const r = runScript(['--url', `http://127.0.0.1:${port}`]);
  assert.equal(r.status, 2, r.stderr || r.stdout);
  const rep = report(r);
  assert.equal(rep.unreachable, true);
  assert.equal(rep.exitCode, 2);
  assert.match(readFileSync(path.join(r.out, 'report.md'), 'utf8'), /could not be reached/);
  assert.match(r.stdout, /Nothing was checked; this is not a pass/);
});

test('could-not-check is not a pass: it exits 1 with no failures at all', () => {
  const site = tempSite(PASS, {
    'assets/site.css': '.bar{color:#f4ece0;background-color:#3d2a1f}.brand{color:#fff;background-color:#3d2a1f}.page{color:var(--ink);background-color:#fffaf3}.note{color:#5a3e2b;background-color:#fffaf3}\n',
  });
  const r = runFixture(site);
  const rep = report(r);
  assert.equal(rep.counts.fail, 0, 'nothing failed');
  assert.equal(rep.counts['could-not-check'], 1);
  assert.equal(r.status, 1, 'and it still is not a 0');
  assert.match(evidenceFor(r, 'colour-contrast'), /variables, inheritance or values this script will not guess at/);
});

test('exit codes 0, 1 and 2 are distinct on inputs that differ only in the site', async () => {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const codes = [runFixture(PASS).status, runFixture(BROKEN).status, runScript(['--url', `http://127.0.0.1:${port}`]).status];
  assert.deepEqual(codes, [0, 1, 2]);
  assert.equal(exitCodeFor([{ status: 'pass' }, { status: 'na' }]), 0);
  assert.equal(exitCodeFor([{ status: 'pass' }, { status: 'could-not-check' }]), 1);
  assert.equal(exitCodeFor([{ status: 'could-not-check' }, { status: 'fail' }]), 1);
});

test('bad arguments exit 2, never 0', () => {
  assert.equal(runScript([]).status, 2);
  assert.equal(runScript(['--url', 'not a url']).status, 2);
  assert.equal(runScript(['--fixture', '/does/not/exist']).status, 2);
  assert.equal(runScript(['--url', 'http://127.0.0.1:1', '--max-pages', 'lots']).status, 2);
  assert.match(runScript(['--url', 'http://127.0.0.1:1', '--max-pages', 'lots']).stderr, /positive integer/);
  const spawned = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(spawned.status, 0);
  assert.match(spawned.stdout, /2 is never a pass/);
});

// ---------------------------------------------------------------------------
// Parsing units
// ---------------------------------------------------------------------------

test('the crawl stops at --max-pages and says that it did', () => {
  const r = runFixture(PASS, ['--max-pages', '2']);
  assert.equal(report(r).pages.length, 2);
  assert.match(evidenceFor(r, 'broken-links'), /stopped at --max-pages 2/);
});

test('attributes survive quoting, casing, and a bare attribute with no value', () => {
  assert.deepEqual(parseAttributes(' SRC="/a.png" alt=\'two\' width=24 hidden'), { src: '/a.png', alt: 'two', width: '24', hidden: '' });
});

test('parsePage reads the head, the images and the inline scripts, and drops comments', () => {
  const page = parsePage(`<!doctype html><html><head>
    <title>A &amp; B</title>
    <meta name="description" content="d">
    <meta name="viewport" content="width=device-width">
    <meta property="og:image" content="/o.png">
    <meta name="twitter:card" content="summary">
    <link rel="icon" href="/f.ico"><link rel="stylesheet" href="/s.css">
    </head><body>
    <!-- <img src="/ignored.png"> -->
    <img src="/a.png" alt="a"><a href="/next">next</a>
    <script src="/x.js"></script><script>var t = 1;</script>
    <p style="color:#000;background:#fff">hi</p>
    </body></html>`);
  assert.equal(page.title, 'A & B');
  assert.equal(page.description, 'd');
  assert.equal(page.viewport, 'width=device-width');
  assert.equal(page.og.image, '/o.png');
  assert.equal(page.twitterCard, 'summary');
  assert.deepEqual(page.images.map((i) => i.src), ['/a.png'], 'a commented-out image is not on the page');
  assert.deepEqual(page.anchors.map((a) => a.href), ['/next']);
  assert.deepEqual(page.scripts.map((s) => s.src), ['/x.js']);
  assert.deepEqual(page.inlineScripts, ['var t = 1;']);
  assert.deepEqual(page.styleAttributes, ['color:#000;background:#fff']);
});

test('image dimensions are read from the bytes, and unreadable bytes read as unreadable', () => {
  assert.deepEqual(imageSize(encodePng(7, 11, () => [0, 0, 0])), { type: 'png', width: 7, height: 11 });
  assert.equal(imageSize(Buffer.from('<svg viewBox="0 0 1200 630"></svg>')), null, 'an SVG carries no raster dimensions here');
  assert.equal(imageSize(Buffer.alloc(0)), null);
  assert.equal(imageSize(Buffer.from([0xff, 0xd8, 0xff])), null, 'a truncated JPEG is unreadable, not assumed');
});

// ---------------------------------------------------------------------------
// The human half
// ---------------------------------------------------------------------------

test('the six human items are listed in the report and never answered by the script', () => {
  const rep = report(runFixture(PASS));
  assert.deepEqual(rep.humanItems.map((h) => h.id), [
    'privacy-policy', 'terms', 'call-to-action', 'spam-protection', 'form-validation', 'analytics',
  ]);
  for (const h of rep.humanItems) {
    assert.ok(h.question.trim().endsWith('?') || /valid answer\.$/.test(h.question), `${h.id} is not phrased as a question`);
    assert.ok(!('status' in h), `${h.id} carries a status the script has no business setting`);
  }
  assert.match(readFileSync(path.join(runFixture(PASS).out, 'report.md'), 'utf8'), /The six a script cannot answer/);
  assert.equal(HUMAN_ITEMS.length, 6);
  assert.equal(ITEMS.length + HUMAN_ITEMS.length, 21);
});

// ---------------------------------------------------------------------------
// Offline
// ---------------------------------------------------------------------------

test('no fixture references a cross-origin asset the script would fetch', () => {
  for (const site of [PASS, BROKEN]) {
    for (const file of execFileSync('git', ['ls-files', '-z', path.relative(REPO, site)], { cwd: REPO, encoding: 'utf8' }).split('\0').filter((f) => f.endsWith('.html'))) {
      const page = parsePage(readFileSync(path.join(REPO, file), 'utf8'));
      for (const img of page.images) {
        assert.ok(!/^https?:\/\//i.test(img.src ?? ''), `${file} has an absolute <img src>, which the image check would fetch over the network`);
      }
      for (const script of page.scripts) {
        assert.ok(!/^https?:\/\//i.test(script.src ?? ''), `${file} has an absolute <script src>`);
      }
      if (page.og.image) assert.match(page.og.image, /^\{\{ORIGIN\}\}/, `${file} og:image must resolve to the fixture server`);
    }
  }
});

// ---------------------------------------------------------------------------
// HYGIENE — the same grep blind-review runs, over the same tree.
// ---------------------------------------------------------------------------

test('hygiene: no personal data, private paths, or key shapes in tracked files', () => {
  // Patterns are assembled from pieces so this file does not match itself.
  // The public GitHub handle (first name + surname + "007", no space) is the
  // one allowed occurrence; the lookarounds carve it out.
  const first = 'Ya' + 'sh';
  const last = 'She' + 'lar';
  const forbidden = [
    { name: 'owner first name', re: new RegExp(`${first}(?!${last}007)`) },
    { name: 'owner surname', re: new RegExp(`(?<!${first})${last}(?!007)`) },
    { name: 'private database ref', re: new RegExp('pwhnenl' + 'yeqentvhpgisu') },
    { name: 'private repo path', re: new RegExp('\\bcar' + 'eer/') },
    { name: 'private repo path', re: new RegExp('\\bjour' + 'nal/') },
    { name: 'OpenRouter key prefix', re: new RegExp('sk-' + 'or-') },
    { name: 'Anthropic key prefix', re: new RegExp('sk-' + 'ant-') },
  ];
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' }).split('\0').filter(Boolean);
  assert.ok(files.length > 5, 'git ls-files returned the tree');
  const hits = [];
  for (const f of files) {
    const text = readFileSync(path.join(REPO, f), 'utf8');
    text.split('\n').forEach((line, i) => {
      for (const { name, re } of forbidden) {
        if (re.test(line)) hits.push(`${f}:${i + 1}: ${name}: ${line.trim().slice(0, 80)}`);
      }
    });
  }
  assert.deepEqual(hits, [], `forbidden content in tracked files:\n${hits.join('\n')}`);
});

test('hygiene: the planted fixture key carries no real provider prefix', () => {
  const app = readFileSync(path.join(BROKEN, 'assets', 'app.js'), 'utf8');
  // The shapes the repository's own secret scan refuses, rebuilt from pieces.
  const scanned = [
    new RegExp('sk' + '-or-' + '[A-Za-z0-9-]{20,}'),
    new RegExp('sk' + '-ant-' + '[A-Za-z0-9_-]{10,}'),
    new RegExp('ghp' + '[_]' + '[A-Za-z0-9]{20,}'),
    new RegExp('AKI' + 'A' + '[0-9A-Z]{16}'),
    new RegExp('-----BEGIN ' + '[A-Z ]*' + 'PRIVATE KEY-----'),
  ];
  for (const re of scanned) assert.equal(re.test(app), false, `the fixture key matches ${re}, which CI refuses`);
  assert.match(app, /const api_key = "demo_placeholder_not_a_credential"/, 'and it is still long enough to be found');
});

test('hygiene: the fixtures are a made-up bakery', () => {
  assert.match(readFileSync(path.join(PASS, 'index.html'), 'utf8'), /Maple and Rye Bakery/);
  assert.match(readFileSync(path.join(BROKEN, 'index.html'), 'utf8'), /Clover Lane Bakery/);
});
