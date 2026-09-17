// Tests for blind-review. Fixtures only; every end-to-end case spawns the real
// script with --dry-run and recorded responses. Nothing here touches the
// network or needs a key.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evidenceShape,
  parseFindings,
  matchFindings,
  validateConfig,
  buildReviewerRequest,
  buildAdjudicatorRequest,
  extractJson,
  jaccard,
  normaliseClaim,
  makeTransport,
  isExampleConfig,
  REVIEWER_SYSTEM_PROMPT,
} from './blind-review.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, 'blind-review.mjs');
const PLUGIN = path.resolve(here, '..');
const REPO = path.resolve(PLUGIN, '..', '..');
const FIX = path.join(PLUGIN, 'fixtures');
const DIFF = path.join(FIX, 'diff.patch');
const BRIEF = path.join(FIX, 'brief.md');
const CONFIG = path.join(FIX, 'config', 'three-families.json');
const RESPONSES = (name) => path.join(FIX, 'responses', name);

function runScript(args, { withKey = false } = {}) {
  const env = { ...process.env };
  delete env.OPENROUTER_API_KEY;
  if (withKey) env.OPENROUTER_API_KEY = 'fixture-key-not-a-real-credential';
  const out = mkdtempSync(path.join(tmpdir(), 'blind-review-test-'));
  const r = spawnSync(process.execPath, [SCRIPT, '--out', out, ...args], { env, encoding: 'utf8' });
  return { ...r, out };
}

function dryRun(scenario, extra = []) {
  return runScript(['--diff', DIFF, '--brief', BRIEF, '--config', CONFIG, '--dry-run', '--responses', RESPONSES(scenario), ...extra]);
}

function report(r) {
  return JSON.parse(readFileSync(path.join(r.out, 'report.json'), 'utf8'));
}

// ---------------------------------------------------------------------------
// Schema parse and evidence filter
// ---------------------------------------------------------------------------

test('evidenceShape accepts exactly the three shapes', () => {
  assert.equal(evidenceShape('src/cache.js:13'), 'path-line');
  assert.equal(evidenceShape('see src/cache.js:13 for the comparison'), 'path-line');
  assert.equal(evidenceShape('lib/deep/Makefile:4'), 'path-line');
  assert.equal(evidenceShape('test: get returns undefined after ttl'), 'test-name');
  assert.equal(evidenceShape("it('expires after ttl')"), 'test-name');
  assert.equal(evidenceShape('$ node -e "import(\'./src/cache.js\')"\nundefined'), 'command-output');
  assert.equal(evidenceShape('`npm test` -> 1 failing'), 'command-output');
  assert.equal(evidenceShape(''), null);
  assert.equal(evidenceShape('   '), null);
  assert.equal(evidenceShape('general knowledge'), null);
  assert.equal(evidenceShape('this is obviously wrong'), null);
  assert.equal(evidenceShape(null), null);
  assert.equal(evidenceShape(42), null);
});

test('extractJson tolerates prose and code fences', () => {
  assert.deepEqual(extractJson('{"findings":[]}'), { findings: [] });
  assert.deepEqual(extractJson('Sure!\n```json\n{"findings":[]}\n```\nHope this helps.'), { findings: [] });
  assert.deepEqual(extractJson('Findings below: {"findings":[{"a":1}]} end'), { findings: [{ a: 1 }] });
  assert.equal(extractJson('no json here'), null);
  assert.equal(extractJson(null), null);
});

test('parseFindings drops evidence-less findings and counts them', () => {
  const text = readFileSync(path.join(RESPONSES('agreed'), 'b.json'), 'utf8');
  const content = JSON.parse(text).choices[0].message.content;
  const { findings, dropped, unparseable } = parseFindings(content, 'b');
  assert.equal(unparseable, false);
  assert.equal(findings.length, 1, 'one finding survives');
  assert.equal(findings[0].evidenceShape, 'command-output');
  assert.equal(dropped.length, 2, 'two evidence-less findings dropped');
  assert.ok(dropped.every((d) => d.reason === 'no-evidence'));
  assert.ok(dropped.every((d) => d.source === 'b'));
});

test('parseFindings drops malformed entries separately and flags unparseable output', () => {
  const { findings, dropped } = parseFindings(
    JSON.stringify({
      findings: [
        { path: 'a.js', line: 1, severity: 'critical', claim: 'bad severity', evidence: 'a.js:1' },
        { line: 1, severity: 'high', claim: 'no path', evidence: 'a.js:1' },
        'not an object',
        { path: 'a.js', line: '7', severity: 'LOW', claim: 'string line and upper severity are fine', evidence: 'a.js:7' },
      ],
    }),
    'a',
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 7);
  assert.equal(findings[0].severity, 'low');
  assert.equal(dropped.length, 3);
  assert.ok(dropped.every((d) => d.reason === 'malformed'));
  assert.equal(parseFindings('I refuse to answer.', 'a').unparseable, true);
});

// ---------------------------------------------------------------------------
// Matcher
// ---------------------------------------------------------------------------

test('matcher: same path within 3 lines and same severity is agreed', () => {
  const a = [{ path: 'src/cache.js', line: 13, severity: 'high', claim: 'seconds vs milliseconds', evidence: 'src/cache.js:13' }];
  const b = [{ path: 'a/src/cache.js', line: 16, severity: 'high', claim: 'completely different words here', evidence: 'src/cache.js:16' }];
  const { agreed, disputed } = matchFindings(a, b);
  assert.equal(agreed.length, 1);
  assert.equal(disputed.length, 0);
});

test('matcher: same location but different severity is disputed, with both sides kept', () => {
  const a = [{ path: 'src/cache.js', line: 13, severity: 'high', claim: 'x', evidence: 'src/cache.js:13' }];
  const b = [{ path: 'src/cache.js', line: 13, severity: 'low', claim: 'x', evidence: 'src/cache.js:13' }];
  const { agreed, disputed } = matchFindings(a, b);
  assert.equal(agreed.length, 0);
  assert.equal(disputed.length, 1);
  assert.ok(disputed[0].a && disputed[0].b);
  assert.equal(disputed[0].disputeId, 'd1');
});

test('matcher: 4 lines apart is not the same location', () => {
  const a = [{ path: 'src/cache.js', line: 13, severity: 'high', claim: 'alpha beta gamma', evidence: 'src/cache.js:13' }];
  const b = [{ path: 'src/cache.js', line: 17, severity: 'high', claim: 'delta epsilon zeta', evidence: 'src/cache.js:17' }];
  const { agreed, disputed } = matchFindings(a, b);
  assert.equal(agreed.length, 0);
  assert.equal(disputed.length, 2);
});

test('matcher: Jaccard >= 0.6 on normalised claim text matches across locations', () => {
  const claimA = 'ttl is in seconds but compared against milliseconds';
  const claimB = 'TTL is in seconds, but compared against milliseconds!';
  assert.ok(jaccard(normaliseClaim(claimA), normaliseClaim(claimB)) >= 0.6);
  const a = [{ path: 'src/cache.js', line: 13, severity: 'high', claim: claimA, evidence: 'src/cache.js:13' }];
  const b = [{ path: 'src/other.js', line: 90, severity: 'high', claim: claimB, evidence: 'src/other.js:90' }];
  const { agreed, disputed } = matchFindings(a, b);
  assert.equal(agreed.length, 1);
  assert.equal(disputed.length, 0);
});

test('matcher: findings present in one reviewer only are disputed', () => {
  const a = [{ path: 'x.js', line: 1, severity: 'high', claim: 'one thing', evidence: 'x.js:1' }];
  const b = [
    { path: 'x.js', line: 1, severity: 'high', claim: 'one thing', evidence: 'x.js:1' },
    { path: 'y.js', line: 50, severity: 'low', claim: 'a totally separate matter', evidence: 'y.js:50' },
  ];
  const { agreed, disputed } = matchFindings(a, b);
  assert.equal(agreed.length, 1);
  assert.equal(disputed.length, 1);
  assert.equal(disputed[0].a, null);
  assert.equal(disputed[0].b.path, 'y.js');
});

test('matcher on the planted fixtures: bug agreed, false positive and missing test disputed', () => {
  const content = (scenario, role) => JSON.parse(readFileSync(path.join(RESPONSES(scenario), `${role}.json`), 'utf8')).choices[0].message.content;
  const a = parseFindings(content('disputed', 'a'), 'a').findings;
  const b = parseFindings(content('disputed', 'b'), 'b').findings;
  const { agreed, disputed } = matchFindings(a, b);
  assert.equal(agreed.length, 1);
  assert.equal(agreed[0].a.line, 13);
  assert.equal(disputed.length, 2);
  assert.equal(disputed[0].disputeId, 'd1');
  assert.equal(disputed[0].a.line, 19, 'd1 is the planted false positive from A');
  assert.equal(disputed[1].disputeId, 'd2');
  assert.equal(disputed[1].b.path, 'test/cache.test.mjs', 'd2 is the missing-test finding from B');
});

// ---------------------------------------------------------------------------
// Family refusal
// ---------------------------------------------------------------------------

test('validateConfig refuses two roles from one family', () => {
  assert.equal(validateConfig(JSON.parse(readFileSync(CONFIG, 'utf8'))), null);
  const same = JSON.parse(readFileSync(path.join(FIX, 'config', 'same-family.json'), 'utf8'));
  assert.match(validateConfig(same), /refusing to run/);
  assert.match(validateConfig({ a: { model: 'm', family: 'x' }, b: { model: 'm', family: 'y' }, adjudicator: { model: 'm', family: 'X' } }), /refusing to run/, 'family comparison is case-insensitive');
  assert.match(validateConfig({ a: { model: 'm', family: 'x' } }), /missing "b"/);
});

test('same-family config exits 2 before any call is made', () => {
  const r = runScript(['--diff', DIFF, '--brief', BRIEF, '--config', path.join(FIX, 'config', 'same-family.json'), '--dry-run', '--responses', RESPONSES('agreed')]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /refusing to run/);
  assert.equal(existsSync(path.join(r.out, 'request-a.json')), false, 'no request was built');
});

// ---------------------------------------------------------------------------
// Adjudicator trigger
// ---------------------------------------------------------------------------

test('fully agreeing run makes zero adjudicator calls', () => {
  const r = dryRun('agreed');
  const rep = report(r);
  assert.deepEqual(rep.calls, { a: 1, b: 1, adjudicator: 0 });
  assert.equal(existsSync(path.join(r.out, 'request-adjudicator.json')), false);
  assert.equal(rep.counts.disputed, 0);
});

test('disputed run makes exactly one adjudicator call, batched over all disputes', () => {
  const r = dryRun('disputed');
  const rep = report(r);
  assert.deepEqual(rep.calls, { a: 1, b: 1, adjudicator: 1 });
  assert.equal(rep.counts.disputed, 2);
  const adjBody = JSON.parse(readFileSync(path.join(r.out, 'request-adjudicator.json'), 'utf8'));
  const userMsg = adjBody.messages.find((m) => m.role === 'user').content;
  assert.match(userMsg, /## d1/);
  assert.match(userMsg, /## d2/);
  assert.equal(rep.counts.adjudicatedDismissed, 1);
  assert.equal(rep.counts.adjudicatedUpheld, 1);
  const dismissed = rep.findings.find((f) => f.status === 'adjudicated-dismissed');
  assert.equal(dismissed.line, 19, 'the planted false positive was dismissed');
  const upheld = rep.findings.find((f) => f.status === 'adjudicated-upheld');
  assert.equal(upheld.path, 'test/cache.test.mjs');
});

test('clean run makes zero adjudicator calls', () => {
  const rep = report(dryRun('clean'));
  assert.deepEqual(rep.calls, { a: 1, b: 1, adjudicator: 0 });
});

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

test('clean fixture exits 0', () => {
  const r = dryRun('clean');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(report(r).findings.length, 0);
});

test('planted bug agreed exits 1 and the dropped count is 2', () => {
  const r = dryRun('agreed');
  assert.equal(r.status, 1, r.stderr);
  const rep = report(r);
  assert.equal(rep.counts.agreed, 1);
  assert.equal(rep.counts.droppedNoEvidence, 2);
  assert.equal(rep.findings.filter((f) => f.status === 'dropped-no-evidence').length, 2);
  assert.equal(rep.findings.find((f) => f.status === 'agreed').line, 13);
});

test('disputed fixture exits 1 because the agreed bug stands', () => {
  assert.equal(dryRun('disputed').status, 1);
});

test('missing key without --dry-run exits 2 with a clear message and no request written', () => {
  const r = runScript(['--diff', DIFF, '--brief', BRIEF, '--config', CONFIG]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /OPENROUTER_API_KEY is not set/);
  assert.equal(existsSync(path.join(r.out, 'request-a.json')), false);
});

test('--dry-run without --responses exits 2', () => {
  const r = runScript(['--diff', DIFF, '--brief', BRIEF, '--config', CONFIG, '--dry-run']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--responses/);
});

test('missing recorded adjudicator response on a disputed run exits 2, not 0', () => {
  // The "agreed" directory has no adjudicator.json. Force a dispute by using
  // A from "disputed" and B from "agreed" via a temp responses dir.
  const dir = mkdtempSync(path.join(tmpdir(), 'blind-review-mixed-'));
  execFileSync('cp', [path.join(RESPONSES('disputed'), 'a.json'), path.join(dir, 'a.json')]);
  execFileSync('cp', [path.join(RESPONSES('agreed'), 'b.json'), path.join(dir, 'b.json')]);
  const r = runScript(['--diff', DIFF, '--brief', BRIEF, '--config', CONFIG, '--dry-run', '--responses', dir]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /adjudicator call failed/);
});

test('exit codes 0, 1 and 2 are distinct on the same inputs', () => {
  const codes = new Set([dryRun('clean').status, dryRun('agreed').status, runScript(['--diff', DIFF, '--brief', BRIEF, '--config', CONFIG]).status]);
  assert.deepEqual([...codes].sort(), [0, 1, 2]);
});

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

test('cost: unknown is printed as unknown, never as $0', () => {
  const r = dryRun('clean');
  assert.match(r.stdout, /total: cost unknown/);
  assert.doesNotMatch(r.stdout, /\$0\.0000/);
  const rep = report(r);
  assert.equal(rep.cost.total, null);
  assert.equal(rep.cost.a, null);
  assert.equal(rep.cost.unpricedCalls, 2);
});

test('cost: partial pricing reports the known portion and a null total', () => {
  const r = dryRun('disputed');
  const rep = report(r);
  assert.equal(rep.cost.a, 0.0021);
  assert.equal(rep.cost.b, 0.0017);
  assert.equal(rep.cost.adjudicator, null);
  assert.equal(rep.cost.total, null, 'one unpriced call means the total is unknown');
  assert.equal(rep.cost.unpricedCalls, 1);
  assert.ok(Math.abs(rep.cost.knownPortion - 0.0038) < 1e-9);
  assert.match(r.stdout, /1 of 3 calls unpriced/);
});

// ---------------------------------------------------------------------------
// TIMEOUT
// ---------------------------------------------------------------------------

test('timeout: a hanging fetch is aborted and the role is recorded as timed_out', async () => {
  const neverResolves = () => new Promise(() => {});
  const transport = makeTransport({ dryRun: false, apiKey: 'fixture-key-not-a-real-credential', timeoutMs: 50, fetchImpl: neverResolves });
  await assert.rejects(transport.complete('a', '{}'), (err) => {
    assert.equal(err.code, 'ETIMEDOUT');
    assert.match(err.message, /role "a" timed out after/);
    return true;
  });
});

test('timeout: a slow-but-successful fetch under the limit is not aborted', async () => {
  const slowOk = () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, json: async () => ({ choices: [{ message: { content: '{"findings":[]}' } }] }) }), 10));
  const transport = makeTransport({ dryRun: false, apiKey: 'fixture-key-not-a-real-credential', timeoutMs: 1000, fetchImpl: slowOk });
  const res = await transport.complete('a', '{}');
  assert.deepEqual(JSON.parse(res.choices[0].message.content), { findings: [] });
});

test('--timeout is accepted and does not interfere with a normal dry run', () => {
  // Dry run never touches the network, so this only proves the flag parses
  // and is threaded through; the abort behaviour itself is proven above at
  // the makeTransport level with a fetch double that never resolves.
  const r = dryRun('agreed', ['--timeout', '5']);
  assert.equal(r.status, 1, r.stderr);
});

// ---------------------------------------------------------------------------
// EXAMPLE CONFIG REFUSAL
// ---------------------------------------------------------------------------

test('refuses to run against the example config by path', () => {
  const exampleConfig = path.join(PLUGIN, 'config', 'models.example.json');
  const r = runScript(['--diff', DIFF, '--brief', BRIEF, '--config', exampleConfig, '--dry-run', '--responses', RESPONSES('agreed')]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /refusing to run against the example config/);
  assert.equal(existsSync(path.join(r.out, 'request-a.json')), false, 'no request was built');
});

test('refuses to run when a config still carries the _comment marker, even renamed to models.json', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'blind-review-example-'));
  const cfg = { _comment: 'copy me first', ...JSON.parse(readFileSync(CONFIG, 'utf8')) };
  const renamed = path.join(dir, 'models.json');
  writeFileSync(renamed, JSON.stringify(cfg));
  const r = runScript(['--diff', DIFF, '--brief', BRIEF, '--config', renamed, '--dry-run', '--responses', RESPONSES('agreed')]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /refusing to run against the example config/);
});

test('isExampleConfig: neither signal alone is required, either is enough', () => {
  assert.equal(isExampleConfig('/x/models.example.json', { a: {} }), true);
  assert.equal(isExampleConfig('/x/models.json', { _comment: 'x' }), true);
  assert.equal(isExampleConfig('/x/models.json', { a: {} }), false);
});

// ---------------------------------------------------------------------------
// HEARTBEAT
// ---------------------------------------------------------------------------

test('heartbeat: one stderr line per request start and end, with role, model, elapsed seconds and tokens', () => {
  const r = dryRun('agreed');
  assert.match(r.stderr, /\[blind-review\] a \(fixture\/reviewer-alpha\): starting/);
  assert.match(r.stderr, /\[blind-review\] a \(fixture\/reviewer-alpha\): done in [\d.]+s, tokens 812 in \/ 71 out/);
  assert.match(r.stderr, /\[blind-review\] b \(fixture\/reviewer-beta\): starting/);
  assert.match(r.stderr, /\[blind-review\] b \(fixture\/reviewer-beta\): done in [\d.]+s, tokens \d+ in \/ \d+ out/);
});

test('heartbeat: --quiet suppresses every heartbeat line', () => {
  const r = dryRun('agreed', ['--quiet']);
  assert.doesNotMatch(r.stderr, /\[blind-review\]/);
});

test('heartbeat: a failed call is still reported once, not left silent', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'blind-review-mixed-'));
  execFileSync('cp', [path.join(RESPONSES('disputed'), 'a.json'), path.join(dir, 'a.json')]);
  execFileSync('cp', [path.join(RESPONSES('agreed'), 'b.json'), path.join(dir, 'b.json')]);
  const r = runScript(['--diff', DIFF, '--brief', BRIEF, '--config', CONFIG, '--dry-run', '--responses', dir]);
  assert.match(r.stderr, /\[blind-review\] adjudicator \(fixture\/adjudicator-gamma\): starting/);
  assert.match(r.stderr, /\[blind-review\] adjudicator \(fixture\/adjudicator-gamma\): failed after [\d.]+s:/);
});

// ---------------------------------------------------------------------------
// REASONING CAP
// ---------------------------------------------------------------------------

test('reasoning: reviewers default to low effort, the adjudicator to medium', () => {
  const bodyA = JSON.parse(buildReviewerRequest('m', 'b', 'd'));
  assert.deepEqual(bodyA.reasoning, { effort: 'low' });
  const bodyAdj = JSON.parse(buildAdjudicatorRequest('m', 'b', 'd', []));
  assert.deepEqual(bodyAdj.reasoning, { effort: 'medium' });
});

test('reasoning: an explicit config override is sent instead of the default', () => {
  const body = JSON.parse(buildReviewerRequest('m', 'b', 'd', { effort: 'high' }));
  assert.deepEqual(body.reasoning, { effort: 'high' });
});

test('reasoning: a full run sends the resolved reasoning effort in every request body', () => {
  const r = dryRun('disputed');
  const reqA = JSON.parse(readFileSync(path.join(r.out, 'request-a.json'), 'utf8'));
  const reqB = JSON.parse(readFileSync(path.join(r.out, 'request-b.json'), 'utf8'));
  const reqAdj = JSON.parse(readFileSync(path.join(r.out, 'request-adjudicator.json'), 'utf8'));
  assert.deepEqual(reqA.reasoning, { effort: 'low' });
  assert.deepEqual(reqB.reasoning, { effort: 'low' });
  assert.deepEqual(reqAdj.reasoning, { effort: 'medium' });
});

// ---------------------------------------------------------------------------
// INDEPENDENCE
// ---------------------------------------------------------------------------

test('independence: A and B request bodies are byte-identical except the model field', () => {
  const r = dryRun('disputed');
  const bodyA = readFileSync(path.join(r.out, 'request-a.json'), 'utf8');
  const bodyB = readFileSync(path.join(r.out, 'request-b.json'), 'utf8');
  const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
  const modelA = JSON.stringify({ model: cfg.a.model }).slice(1, -1);
  const modelB = JSON.stringify({ model: cfg.b.model }).slice(1, -1);
  assert.ok(bodyA.includes(modelA), 'A body names model A');
  assert.ok(bodyB.includes(modelB), 'B body names model B');
  assert.equal(bodyA.indexOf(modelA), bodyA.lastIndexOf(modelA), 'model A appears once');
  assert.equal(bodyA.replace(modelA, modelB), bodyB, 'swapping the model field yields B byte for byte');
  assert.equal(buildReviewerRequest('x', 'brief', 'diff'), buildReviewerRequest('x', 'brief', 'diff'), 'request building is deterministic');
});

test('independence: B request contains no 20-byte substring of A response that is not shared input', () => {
  const r = dryRun('disputed');
  const bodyB = readFileSync(path.join(r.out, 'request-b.json'), 'utf8');
  const responseA = readFileSync(path.join(r.out, 'response-a.json'), 'utf8');
  const contentA = JSON.parse(responseA).choices[0].message.content;
  // Everything a reviewer body may legitimately contain: the diff, the brief,
  // and the system prompt (whose schema example a compliant reviewer echoes).
  const sharedRaw = readFileSync(DIFF, 'utf8') + readFileSync(BRIEF, 'utf8') + REVIEWER_SYSTEM_PROMPT;
  const sharedEscaped = JSON.stringify(sharedRaw).slice(1, -1);
  const WINDOW = 20;
  let checked = 0;
  for (let i = 0; i + WINDOW <= contentA.length; i++) {
    const w = contentA.slice(i, i + WINDOW);
    const wEscaped = JSON.stringify(w).slice(1, -1);
    if (sharedRaw.includes(w) || sharedEscaped.includes(wEscaped)) continue;
    checked++;
    assert.equal(bodyB.includes(w), false, `B request contains A output: ${JSON.stringify(w)}`);
    assert.equal(bodyB.includes(wEscaped), false, `B request contains JSON-escaped A output: ${JSON.stringify(w)}`);
  }
  assert.ok(checked > 50, `test exercised ${checked} windows`);
});

test('independence: the reviewer system prompt is the schema and rules, with no mention of the other reviewer\'s output', () => {
  const body = JSON.parse(buildReviewerRequest('m', 'b', 'd'));
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[1].role, 'user');
  assert.doesNotMatch(body.messages[1].content, /reviewer [AB]|adjudicat|verdict/i);
});

// ---------------------------------------------------------------------------
// HYGIENE
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
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      for (const { name, re } of forbidden) {
        if (re.test(line)) hits.push(`${f}:${i + 1}: ${name}: ${line.trim().slice(0, 80)}`);
      }
    });
  }
  assert.deepEqual(hits, [], `forbidden content in tracked files:\n${hits.join('\n')}`);
});

test('hygiene: fixtures are a made-up project', () => {
  const brief = readFileSync(BRIEF, 'utf8');
  assert.match(brief, /MintCache/);
  const diff = readFileSync(DIFF, 'utf8');
  assert.match(diff, /src\/cache\.js/);
});
