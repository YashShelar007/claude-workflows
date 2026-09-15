#!/usr/bin/env node
// blind-review: two reviewers from different model families read the same diff
// and brief, in parallel, with byte-identical requests. Agreement is recorded.
// Disagreement goes to a third family, once, in a fresh context. Findings that
// cite nothing are dropped before anyone reads them.
//
// Node builtins only. The API key is read from the environment and is never
// written anywhere: not to the report, not to the request files, not to logs.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SEVERITIES = ['high', 'medium', 'low'];
const OPENROUTER = 'https://openrouter.ai/api/v1';
const ROLES = ['a', 'b', 'adjudicator'];

// ---------------------------------------------------------------------------
// Prompts. The reviewer prompt is the finding schema and the rules, nothing
// else. Both reviewers receive exactly this string.
// ---------------------------------------------------------------------------

export const REVIEWER_SYSTEM_PROMPT = `You are one of two independent code reviewers. You receive a brief (what the change was meant to do) and a unified diff (what it does). You have not seen and will not see the other reviewer's output.

Report only findings you can back with evidence. Return JSON and nothing else, in exactly this shape:

{"findings":[{"path":"src/file.js","line":42,"severity":"high","claim":"one sentence: what is wrong and why it matters","evidence":"src/file.js:42"}]}

Rules:
- "severity" is "high" (wrong behaviour, data loss, security), "medium" (likely bug or broken contract), or "low" (correctness risk, missing test, misleading name that will cause a bug).
- "line" is the line number in the new version of the file (the + side of the diff), as an integer.
- "evidence" must take exactly one of three shapes:
  1. a file:line reference into the diff, for example "src/cache.js:18"
  2. a test name prefixed with "test:", for example "test: get returns undefined after ttl"
  3. a command and its output on the next line, for example "$ node -e \\"import('./src/x.js')\\"\\nTypeError: x is not a function"
  A finding whose evidence is anything else is discarded unread.
- Do not report style, formatting or naming preferences unless they cause a bug.
- Do not restate the brief. Do not summarise the diff. Do not praise.
- If you find nothing, return {"findings":[]}.`;

export const ADJUDICATOR_SYSTEM_PROMPT = `You are the adjudicator. Two reviewers independently examined the same brief and diff. Below are only the findings they disagreed on: either one reviewer raised a finding the other did not, or both raised it at different severities.

For each disputed finding decide "upheld" (the evidence supports the claim and it is a real problem) or "dismissed" (the evidence does not support the claim, or the behaviour is correct as written). When upholding a finding both reviewers raised at different severities, choose the severity.

Return JSON and nothing else, in exactly this shape:

{"verdicts":[{"id":"d1","verdict":"upheld","severity":"medium","reason":"one or two sentences"}]}

Rule on every id listed. Do not add findings of your own.`;

export function buildReviewerUserMessage(brief, diff) {
  return `# Brief\n\n${brief.trim()}\n\n# Diff\n\n\`\`\`diff\n${diff.trimEnd()}\n\`\`\`\n`;
}

// One function builds every reviewer request so the two bodies can only differ
// in the model field. The test asserts this at the byte level.
export function buildReviewerRequest(model, brief, diff) {
  return JSON.stringify({
    model,
    messages: [
      { role: 'system', content: REVIEWER_SYSTEM_PROMPT },
      { role: 'user', content: buildReviewerUserMessage(brief, diff) },
    ],
    temperature: 0,
  });
}

export function buildAdjudicatorRequest(model, brief, diff, disputed) {
  const lines = [];
  lines.push('# Brief', '', brief.trim(), '', '# Diff', '', '```diff', diff.trimEnd(), '```', '', '# Disputed findings', '');
  for (const d of disputed) {
    lines.push(`## ${d.disputeId}`);
    lines.push(`Raised by: ${d.a && d.b ? 'both reviewers, at different severities' : d.a ? 'reviewer A only' : 'reviewer B only'}`);
    for (const side of ['a', 'b']) {
      const f = d[side];
      if (!f) continue;
      lines.push(`- Reviewer ${side.toUpperCase()}: [${f.severity}] ${f.path}:${f.line}`);
      lines.push(`  claim: ${f.claim}`);
      lines.push(`  evidence: ${f.evidence.replace(/\n/g, '\n            ')}`);
    }
    lines.push('');
  }
  return JSON.stringify({
    model,
    messages: [
      { role: 'system', content: ADJUDICATOR_SYSTEM_PROMPT },
      { role: 'user', content: lines.join('\n') },
    ],
    temperature: 0,
  });
}

// ---------------------------------------------------------------------------
// Parsing. Models are asked for JSON; they do not always comply. Be lenient
// about wrapping (prose, code fences) and strict about content.
// ---------------------------------------------------------------------------

export function extractJson(text) {
  if (typeof text !== 'string') return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch {
    // fall through
  }
  const start = t.search(/[{[]/);
  if (start < 0) return null;
  for (let end = t.length; end > start; end--) {
    const ch = t[end - 1];
    if (ch !== '}' && ch !== ']') continue;
    try {
      return JSON.parse(t.slice(start, end));
    } catch {
      // keep shrinking
    }
  }
  return null;
}

const PATH_LINE = /(?:^|[\s(`'"[])(?:(?:[\w.@-]+\/)*[\w.@-]+\.[A-Za-z0-9]+|(?:[\w.@-]+\/)+[\w.@-]+):\d+\b/;
const TEST_NAME = /^\s*test\s*:\s*\S|\b(?:test|it|describe)\s*\(\s*['"`]|\b[\w-]+[._]test\.[a-z]+\b|\b[\w-]+\.spec\.[a-z]+\b/i;
const COMMAND_OUTPUT = /(?:^|\n)\s*\$\s+\S[^\n]*\n\s*\S|`[^`\n]{2,}`\s*(?:→|->|=>|:|\n)\s*\S/;

// Returns which of the three accepted shapes the evidence takes, or null.
export function evidenceShape(evidence) {
  if (typeof evidence !== 'string') return null;
  const ev = evidence.trim();
  if (!ev) return null;
  if (PATH_LINE.test(ev)) return 'path-line';
  if (TEST_NAME.test(ev)) return 'test-name';
  if (COMMAND_OUTPUT.test(ev)) return 'command-output';
  return null;
}

export function normalisePath(p) {
  return String(p).replace(/^\.\//, '').replace(/^[ab]\//, '');
}

// Turn one reviewer's raw text into {findings, dropped}. Every dropped item
// carries a reason so the report can show a reviewer that cites nothing as
// the noise it is.
export function parseFindings(text, source) {
  const findings = [];
  const dropped = [];
  const parsed = extractJson(text);
  let list;
  if (Array.isArray(parsed)) list = parsed;
  else if (parsed && Array.isArray(parsed.findings)) list = parsed.findings;
  else return { findings, dropped, unparseable: true };

  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || typeof raw.path !== 'string' || typeof raw.claim !== 'string' || !raw.claim.trim()) {
      dropped.push({ source, reason: 'malformed', raw });
      continue;
    }
    const severity = typeof raw.severity === 'string' ? raw.severity.toLowerCase().trim() : '';
    if (!SEVERITIES.includes(severity)) {
      dropped.push({ source, reason: 'malformed', raw });
      continue;
    }
    const line = Number.isInteger(raw.line) ? raw.line : Number.isInteger(Number(raw.line)) && raw.line !== '' && raw.line !== null ? Number(raw.line) : null;
    const shape = evidenceShape(raw.evidence);
    if (!shape) {
      dropped.push({ source, reason: 'no-evidence', raw });
      continue;
    }
    findings.push({
      source,
      path: normalisePath(raw.path),
      line,
      severity,
      claim: raw.claim.trim(),
      evidence: String(raw.evidence).trim(),
      evidenceShape: shape,
    });
  }
  return { findings, dropped, unparseable: false };
}

// ---------------------------------------------------------------------------
// Matching. Two findings are the same finding when they point at the same
// place (path equal, line within 3) or say the same thing (Jaccard >= 0.6 on
// normalised claim tokens). Same finding + same severity = agreed. Anything
// else is disputed.
// ---------------------------------------------------------------------------

export function normaliseClaim(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export function sameLocation(x, y) {
  return (
    normalisePath(x.path) === normalisePath(y.path) &&
    Number.isInteger(x.line) &&
    Number.isInteger(y.line) &&
    Math.abs(x.line - y.line) <= 3
  );
}

export function sameClaim(x, y) {
  return jaccard(normaliseClaim(x.claim), normaliseClaim(y.claim)) >= 0.6;
}

export function matchFindings(aFindings, bFindings) {
  const usedB = new Set();
  const pairs = [];
  // Location matches first, then text matches, so a finding is paired with its
  // strongest counterpart rather than the first one that clears the bar.
  for (const pass of [sameLocation, sameClaim]) {
    for (const a of aFindings) {
      if (pairs.some((p) => p.a === a)) continue;
      const idx = bFindings.findIndex((b, i) => !usedB.has(i) && pass(a, b));
      if (idx >= 0) {
        usedB.add(idx);
        pairs.push({ a, b: bFindings[idx] });
      }
    }
  }
  const agreed = [];
  const disputed = [];
  for (const a of aFindings) {
    const pair = pairs.find((p) => p.a === a);
    if (!pair) disputed.push({ a, b: null });
    else if (pair.a.severity === pair.b.severity) agreed.push(pair);
    else disputed.push(pair);
  }
  bFindings.forEach((b, i) => {
    if (!usedB.has(i)) disputed.push({ a: null, b });
  });
  disputed.forEach((d, i) => {
    d.disputeId = `d${i + 1}`;
  });
  return { agreed, disputed };
}

export function parseVerdicts(text) {
  const parsed = extractJson(text);
  const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.verdicts) ? parsed.verdicts : null;
  if (!list) return null;
  const out = new Map();
  for (const v of list) {
    if (!v || typeof v.id !== 'string') continue;
    const verdict = typeof v.verdict === 'string' ? v.verdict.toLowerCase().trim() : '';
    if (verdict !== 'upheld' && verdict !== 'dismissed') continue;
    const severity = typeof v.severity === 'string' && SEVERITIES.includes(v.severity.toLowerCase()) ? v.severity.toLowerCase() : null;
    out.set(v.id, { verdict, severity, reason: typeof v.reason === 'string' ? v.reason.trim() : '' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Config.
// ---------------------------------------------------------------------------

export function validateConfig(config) {
  if (!config || typeof config !== 'object') return 'config is not an object';
  for (const role of ROLES) {
    const r = config[role];
    if (!r || typeof r !== 'object') return `config is missing "${role}"`;
    if (typeof r.model !== 'string' || !r.model) return `config "${role}" needs a "model" string`;
    if (typeof r.family !== 'string' || !r.family) return `config "${role}" needs a "family" string`;
  }
  const fam = (role) => config[role].family.toLowerCase().trim();
  for (let i = 0; i < ROLES.length; i++) {
    for (let j = i + 1; j < ROLES.length; j++) {
      if (fam(ROLES[i]) === fam(ROLES[j])) {
        return `refusing to run: "${ROLES[i]}" and "${ROLES[j]}" are both family "${config[ROLES[i]].family}". Two reviewers from one family agree with each other; pick three families.`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Transport. Real: OpenRouter over fetch. Dry run: recorded responses from a
// directory, one file per role. Both count calls per role so the report and
// the tests can see exactly who was consulted.
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function makeTransport({ dryRun, responsesDir, apiKey }) {
  const calls = { a: 0, b: 0, adjudicator: 0 };

  async function complete(role, bodyString) {
    calls[role] += 1;
    if (dryRun) {
      const file = path.join(responsesDir, `${role}.json`);
      let text;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        throw new Error(`dry run: no recorded response for role "${role}" at ${file}`);
      }
      return JSON.parse(text);
    }
    const res = await fetch(`${OPENROUTER}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'blind-review',
      },
      body: bodyString,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 500);
      throw new Error(`OpenRouter ${res.status} for role "${role}": ${detail}`);
    }
    return res.json();
  }

  // Cost comes from OpenRouter's generation endpoint. It can lag the completion
  // by a moment, so retry briefly. Anything short of a number is null, which
  // the report prints as "unknown" and never as zero.
  async function cost(role, generationId) {
    if (dryRun) {
      try {
        const g = JSON.parse(await readFile(path.join(responsesDir, `generation-${role}.json`), 'utf8'));
        const c = g?.data?.total_cost;
        return typeof c === 'number' && Number.isFinite(c) ? c : null;
      } catch {
        return null;
      }
    }
    if (!generationId) return null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(`${OPENROUTER}/generation?id=${encodeURIComponent(generationId)}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (res.ok) {
          const g = await res.json();
          const c = g?.data?.total_cost;
          return typeof c === 'number' && Number.isFinite(c) ? c : null;
        }
        if (res.status !== 404) return null;
      } catch {
        return null;
      }
      await sleep(750 * (attempt + 1));
    }
    return null;
  }

  return { complete, cost, calls };
}

export function messageContent(response) {
  const c = response?.choices?.[0]?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
  return null;
}

function tokensOf(response) {
  const u = response?.usage;
  if (!u || typeof u !== 'object') return { prompt: null, completion: null };
  return {
    prompt: Number.isFinite(u.prompt_tokens) ? u.prompt_tokens : null,
    completion: Number.isFinite(u.completion_tokens) ? u.completion_tokens : null,
  };
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------

export function formatCost(c) {
  return typeof c === 'number' ? `$${c.toFixed(4)}` : 'cost unknown';
}

export function renderMarkdown(report) {
  const L = [];
  L.push('# Blind review');
  L.push('');
  L.push('| Role | Model | Family | Calls | Tokens in / out | Cost |');
  L.push('|---|---|---|---|---|---|');
  for (const role of ROLES) {
    const m = report.models[role];
    const t = report.tokens[role];
    L.push(`| ${role} | \`${m.model}\` | ${m.family} | ${report.calls[role]} | ${t.prompt ?? '?'} / ${t.completion ?? '?'} | ${formatCost(report.cost[role])} |`);
  }
  L.push('');
  const c = report.counts;
  L.push(`**${c.agreed} agreed**, **${c.adjudicatedUpheld} upheld** and **${c.adjudicatedDismissed} dismissed** by the adjudicator (${c.disputed} disputed in total), **${c.droppedNoEvidence} dropped for citing nothing**, ${c.droppedMalformed} dropped as malformed.`);
  L.push('');
  L.push(`Total: ${report.cost.total === null ? `cost unknown (${report.cost.unpricedCalls} of ${report.calls.a + report.calls.b + report.calls.adjudicator} calls unpriced${report.cost.knownPortion !== null ? `; known portion ${formatCost(report.cost.knownPortion)}` : ''})` : formatCost(report.cost.total)}`);
  L.push('');

  const section = (title, status) => {
    const items = report.findings.filter((f) => f.status === status);
    if (!items.length) return;
    L.push(`## ${title} (${items.length})`);
    L.push('');
    for (const f of items) {
      L.push(`- **[${f.severity}]** \`${f.path}${f.line !== null ? `:${f.line}` : ''}\` ${f.claim}`);
      L.push(`  - evidence: ${f.evidence.split('\n').join('\n    ')}`);
      L.push(`  - raised by: ${f.raisedBy.join(', ')}`);
      if (f.adjudication) L.push(`  - adjudicator: ${f.adjudication.verdict}. ${f.adjudication.reason}`);
    }
    L.push('');
  };
  section('Agreed', 'agreed');
  section('Upheld by the adjudicator', 'adjudicated-upheld');
  section('Dismissed by the adjudicator', 'adjudicated-dismissed');
  section('Dropped: no evidence', 'dropped-no-evidence');
  section('Dropped: malformed', 'dropped-malformed');

  if (!report.findings.some((f) => f.status === 'agreed' || f.status === 'adjudicated-upheld')) {
    L.push('No agreed or upheld findings.');
    L.push('');
  }
  L.push(`Exit code: ${report.exitCode}. This report is advisory; it merges nothing and comments nowhere on its own.`);
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[++i];
    };
    switch (arg) {
      case '--diff':
        out.diff = next();
        break;
      case '--brief':
        out.brief = next();
        break;
      case '--config':
        out.config = next();
        break;
      case '--out':
        out.out = next();
        break;
      case '--responses':
        out.responses = next();
        break;
      case '--dry-run':
        out.dryRun = true;
        break;
      case '-h':
      case '--help':
        out.help = true;
        break;
      default:
        throw new Error(`unknown argument ${arg}`);
    }
  }
  return out;
}

const USAGE = `usage: blind-review.mjs --diff <file> --brief <file> --config <models.json> --out <dir> [--dry-run --responses <dir>]

  --diff       unified diff to review (e.g. from \`gh pr diff N\`)
  --brief      what the change was meant to do
  --config     {"a":{model,family},"b":{...},"adjudicator":{...}}; three families
  --out        directory for report.json, report.md and the request/response bodies
  --dry-run    use recorded responses from --responses <dir> instead of the network
  --responses  directory holding a.json, b.json, optionally adjudicator.json and generation-<role>.json

  OPENROUTER_API_KEY is read from the environment. It is never written anywhere.
  exit 0: no findings · 1: at least one agreed or upheld finding · 2: could not run
`;

class RunError extends Error {}

export async function run(argv, env, io = { stdout: process.stdout, stderr: process.stderr }) {
  const say = (s) => io.stdout.write(s + '\n');
  const fail = (msg) => {
    throw new RunError(msg);
  };

  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    fail(`${e.message}\n\n${USAGE}`);
  }
  if (args.help) {
    say(USAGE);
    return 0;
  }
  for (const k of ['diff', 'brief', 'config', 'out']) {
    if (!args[k]) fail(`--${k} is required\n\n${USAGE}`);
  }
  if (args.dryRun && !args.responses) fail('--dry-run needs --responses <dir> with recorded responses');

  const apiKey = env.OPENROUTER_API_KEY;
  if (!args.dryRun && !apiKey) {
    fail('OPENROUTER_API_KEY is not set. Export it in this shell; it is read from the environment only and never stored. Use --dry-run with --responses to run without a key.');
  }

  let config;
  try {
    config = JSON.parse(await readFile(args.config, 'utf8'));
  } catch (e) {
    fail(`could not read config ${args.config}: ${e.message}`);
  }
  const configError = validateConfig(config);
  if (configError) fail(configError);

  let diff;
  let brief;
  try {
    diff = await readFile(args.diff, 'utf8');
  } catch (e) {
    fail(`could not read diff ${args.diff}: ${e.message}`);
  }
  try {
    brief = await readFile(args.brief, 'utf8');
  } catch (e) {
    fail(`could not read brief ${args.brief}: ${e.message}`);
  }
  if (!diff.trim()) fail('the diff is empty; nothing to review');

  await mkdir(args.out, { recursive: true });
  const write = (name, content) => writeFile(path.join(args.out, name), content);

  const transport = makeTransport({ dryRun: args.dryRun, responsesDir: args.responses, apiKey });

  // Both reviewer bodies are built by the same function from the same inputs
  // before either call starts. Nothing from A can reach B: B's body exists
  // before A has answered.
  const bodyA = buildReviewerRequest(config.a.model, brief, diff);
  const bodyB = buildReviewerRequest(config.b.model, brief, diff);
  await Promise.all([write('request-a.json', bodyA), write('request-b.json', bodyB)]);

  let responseA;
  let responseB;
  try {
    [responseA, responseB] = await Promise.all([transport.complete('a', bodyA), transport.complete('b', bodyB)]);
  } catch (e) {
    fail(`reviewer call failed: ${e.message}`);
  }
  await Promise.all([
    write('response-a.json', JSON.stringify(responseA, null, 2)),
    write('response-b.json', JSON.stringify(responseB, null, 2)),
  ]);

  const parsedA = parseFindings(messageContent(responseA), 'a');
  const parsedB = parseFindings(messageContent(responseB), 'b');
  if (parsedA.unparseable) fail('reviewer A returned nothing parseable as findings; see response-a.json');
  if (parsedB.unparseable) fail('reviewer B returned nothing parseable as findings; see response-b.json');

  const { agreed, disputed } = matchFindings(parsedA.findings, parsedB.findings);

  // The adjudicator is consulted once, for the disputed set, and only when
  // there is one. A fully agreeing run makes zero adjudicator calls.
  let verdicts = new Map();
  let responseAdj = null;
  if (disputed.length > 0) {
    const bodyAdj = buildAdjudicatorRequest(config.adjudicator.model, brief, diff, disputed);
    await write('request-adjudicator.json', bodyAdj);
    try {
      responseAdj = await transport.complete('adjudicator', bodyAdj);
    } catch (e) {
      fail(`adjudicator call failed: ${e.message}`);
    }
    await write('response-adjudicator.json', JSON.stringify(responseAdj, null, 2));
    const parsed = parseVerdicts(messageContent(responseAdj));
    if (!parsed) fail('adjudicator returned nothing parseable as verdicts; see response-adjudicator.json');
    verdicts = parsed;
  }

  // Assemble findings.
  const findings = [];
  let n = 0;
  const id = () => `f${++n}`;
  for (const p of agreed) {
    findings.push({
      id: id(),
      status: 'agreed',
      severity: p.a.severity,
      path: p.a.path,
      line: p.a.line,
      claim: p.a.claim,
      evidence: p.a.evidence,
      raisedBy: ['a', 'b'],
      sides: { a: p.a, b: p.b },
      adjudication: null,
    });
  }
  const unresolved = [];
  for (const d of disputed) {
    const primary = d.a ?? d.b;
    const v = verdicts.get(d.disputeId);
    if (!v) {
      unresolved.push(d.disputeId);
      continue;
    }
    findings.push({
      id: id(),
      disputeId: d.disputeId,
      status: v.verdict === 'upheld' ? 'adjudicated-upheld' : 'adjudicated-dismissed',
      severity: v.severity ?? primary.severity,
      path: primary.path,
      line: primary.line,
      claim: primary.claim,
      evidence: primary.evidence,
      raisedBy: [d.a && 'a', d.b && 'b'].filter(Boolean),
      sides: { a: d.a, b: d.b },
      adjudication: { verdict: v.verdict, reason: v.reason },
    });
  }
  for (const drop of [...parsedA.dropped, ...parsedB.dropped]) {
    const raw = drop.raw && typeof drop.raw === 'object' ? drop.raw : {};
    findings.push({
      id: id(),
      status: drop.reason === 'no-evidence' ? 'dropped-no-evidence' : 'dropped-malformed',
      severity: SEVERITIES.includes(String(raw.severity).toLowerCase()) ? String(raw.severity).toLowerCase() : 'unknown',
      path: typeof raw.path === 'string' ? normalisePath(raw.path) : '?',
      line: Number.isInteger(raw.line) ? raw.line : null,
      claim: typeof raw.claim === 'string' ? raw.claim : JSON.stringify(raw),
      evidence: typeof raw.evidence === 'string' && raw.evidence.trim() ? raw.evidence : '(none)',
      raisedBy: [drop.source],
      sides: null,
      adjudication: null,
    });
  }

  const counts = {
    agreed: agreed.length,
    disputed: disputed.length,
    adjudicatedUpheld: findings.filter((f) => f.status === 'adjudicated-upheld').length,
    adjudicatedDismissed: findings.filter((f) => f.status === 'adjudicated-dismissed').length,
    droppedNoEvidence: findings.filter((f) => f.status === 'dropped-no-evidence').length,
    droppedMalformed: findings.filter((f) => f.status === 'dropped-malformed').length,
    unresolved: unresolved.length,
  };

  // Cost, per call, from generation metadata. Unknown is unknown.
  const costs = { a: null, b: null, adjudicator: null };
  const [costA, costB, costAdj] = await Promise.all([
    transport.cost('a', responseA?.id),
    transport.cost('b', responseB?.id),
    responseAdj ? transport.cost('adjudicator', responseAdj?.id) : Promise.resolve(null),
  ]);
  costs.a = costA;
  costs.b = costB;
  costs.adjudicator = costAdj;
  const madeCalls = ROLES.filter((r) => transport.calls[r] > 0);
  const unpricedCalls = madeCalls.filter((r) => costs[r] === null).length;
  const known = madeCalls.filter((r) => costs[r] !== null).reduce((s, r) => s + costs[r], 0);
  const cost = {
    ...costs,
    total: unpricedCalls === 0 ? known : null,
    knownPortion: unpricedCalls > 0 && unpricedCalls < madeCalls.length ? known : null,
    unpricedCalls,
    source: args.dryRun ? 'recorded' : 'openrouter generation endpoint',
  };

  const hasFindings = counts.agreed + counts.adjudicatedUpheld > 0;
  const exitCode = unresolved.length > 0 ? 2 : hasFindings ? 1 : 0;

  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    dryRun: args.dryRun,
    models: {
      a: { model: config.a.model, family: config.a.family },
      b: { model: config.b.model, family: config.b.family },
      adjudicator: { model: config.adjudicator.model, family: config.adjudicator.family },
    },
    calls: { ...transport.calls },
    tokens: { a: tokensOf(responseA), b: tokensOf(responseB), adjudicator: tokensOf(responseAdj) },
    cost,
    counts,
    unresolved,
    findings,
    exitCode,
  };

  await write('report.json', JSON.stringify(report, null, 2) + '\n');
  const md = renderMarkdown(report);
  await write('report.md', md);

  say(md);
  say(`Wrote ${path.join(args.out, 'report.json')} and ${path.join(args.out, 'report.md')}`);
  for (const role of ROLES) {
    if (transport.calls[role] > 0) say(`${role}: ${formatCost(costs[role])}`);
  }
  say(`total: ${cost.total === null ? 'cost unknown' : formatCost(cost.total)}`);

  if (unresolved.length > 0) {
    fail(`adjudicator did not rule on ${unresolved.length} disputed finding(s): ${unresolved.join(', ')}. Report written; treating as could-not-run.`);
  }
  return exitCode;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  run(process.argv.slice(2), process.env)
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`blind-review: ${e instanceof RunError ? e.message : e.stack || e.message}\n`);
      process.exit(2);
    });
}
