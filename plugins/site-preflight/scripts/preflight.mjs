#!/usr/bin/env node
// site-preflight: ask a live site the mechanical half of a launch checklist and
// write down what it answered. Every item carries the number or the status code
// it was judged on, on a pass as well as a failure, because a green tick with
// no measurement behind it is the thing this script exists to replace.
//
// Node builtins only. Nothing here logs, stores, or transmits a credential: the
// secret scan reports a file and a line and the first four characters of what
// it found, never the value.
//
// What it cannot judge, it says it cannot judge. `could-not-check` is a real
// answer and it is never rounded up to a pass.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const STATUSES = ['pass', 'fail', 'na', 'could-not-check'];

// The mechanical rows of the checklist, in the checklist's own words. Fourteen
// checks; `alt-text` and `image-compression` are two rows off one crawl.
export const ITEMS = [
  { id: 'force-https', label: 'Force HTTPS' },
  { id: 'robots-sitemap', label: 'Sitemap and robots.txt' },
  { id: 'meta-title-description', label: 'Meta title and description' },
  { id: 'social-preview', label: 'Social preview image' },
  { id: 'favicon', label: 'Favicon' },
  { id: 'mobile-friendly', label: 'Mobile friendly' },
  { id: 'custom-404', label: 'Custom 404 page' },
  { id: 'broken-links', label: 'No broken links' },
  { id: 'alt-text', label: 'Alt text on images' },
  { id: 'image-compression', label: 'Image compression' },
  { id: 'page-load-speed', label: 'Page load speed' },
  { id: 'secrets-off-the-frontend', label: 'Secrets off the frontend' },
  { id: 'colour-contrast', label: 'Colour contrast' },
  { id: 'mixed-content', label: 'No mixed content' },
  { id: 'security-headers', label: 'Security headers (report only)' },
];

// The six rows no script can answer. The skill asks these one at a time, in
// these words, and records the answer. The script never fills them in.
export const HUMAN_ITEMS = [
  { id: 'privacy-policy', label: 'Privacy policy page', question: 'Is there a privacy policy page, and is it linked from the site?' },
  { id: 'terms', label: 'Terms and conditions page', question: 'Is there a terms and conditions page, and is it linked from the site?' },
  { id: 'call-to-action', label: 'One clear call to action', question: 'Does the page have one clear call to action, and can you say in a sentence what it is?' },
  { id: 'spam-protection', label: 'Spam protection on forms', question: 'Do the forms have spam protection, and which kind?' },
  { id: 'form-validation', label: 'Form validation', question: 'Do the forms validate input and show the visitor what went wrong?' },
  { id: 'analytics', label: 'Analytics set up', question: 'Is analytics set up, and which? "None, on purpose" is a valid answer.' },
];

export const DEFAULTS = {
  maxPages: 20,
  ttfbMs: 800,
  totalBytes: 2 * 1024 * 1024,
  imageBytes: 300 * 1024,
  titleMin: 10,
  titleMax: 70,
  descriptionMin: 50,
  descriptionMax: 160,
  ogImageWidth: 1200,
  ogImageHeight: 630,
  contrastMin: 4.5,
  maxLinkChecks: 200,
};

const USER_AGENT = 'site-preflight (+https://github.com/YashShelar007/claude-workflows)';

// ---------------------------------------------------------------------------
// HTML. A tolerant tag scanner, not a parser. It is enough for the attributes
// a launch checklist asks about, and it is honest about the one case it gets
// wrong: an attribute value containing an unescaped ">".
// ---------------------------------------------------------------------------

export function stripComments(html) {
  return String(html).replace(/<!--[\s\S]*?-->/g, '');
}

export function parseAttributes(chunk) {
  const attrs = {};
  const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(chunk))) {
    const name = m[1].toLowerCase();
    if (name in attrs) continue;
    attrs[name] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return attrs;
}

export function findTags(html, tagName) {
  const out = [];
  const re = new RegExp(`<${tagName}\\b([^>]*)>`, 'gi');
  let m;
  while ((m = re.exec(html))) out.push({ raw: m[0], attrs: parseAttributes(m[1]) });
  return out;
}

export function parsePage(rawHtml) {
  const html = stripComments(rawHtml);
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const metas = findTags(html, 'meta').map((t) => t.attrs);
  const meta = (name) => {
    const hit = metas.find((a) => (a.name || '').toLowerCase() === name.toLowerCase());
    return hit ? (hit.content ?? '') : null;
  };
  const property = (prop) => {
    const hit = metas.find((a) => ((a.property || a.name) || '').toLowerCase() === prop.toLowerCase());
    return hit ? (hit.content ?? '') : null;
  };
  const inlineScripts = [];
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let s;
  while ((s = scriptRe.exec(html))) {
    const attrs = parseAttributes(s[1]);
    if (!attrs.src && s[2].trim()) inlineScripts.push(s[2]);
  }
  const inlineStyles = [];
  const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let y;
  while ((y = styleRe.exec(html))) inlineStyles.push(y[1]);

  return {
    title: titleMatch ? decodeEntities(titleMatch[1]).trim() : null,
    description: meta('description'),
    viewport: meta('viewport'),
    og: {
      title: property('og:title'),
      description: property('og:description'),
      image: property('og:image'),
    },
    twitterCard: property('twitter:card'),
    links: findTags(html, 'link').map((t) => t.attrs),
    scripts: findTags(html, 'script').map((t) => t.attrs).filter((a) => a.src),
    images: findTags(html, 'img').map((t) => t.attrs),
    anchors: findTags(html, 'a').map((t) => t.attrs).filter((a) => typeof a.href === 'string'),
    styleAttributes: findTags(html, '[a-z][a-z0-9]*')
      .map((t) => t.attrs.style)
      .filter(Boolean),
    inlineScripts,
    inlineStyles,
    text: html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
  };
}

export function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------------------
// Colour. Hex, rgb()/rgba() and the basic named colours resolve to numbers.
// Everything else — var(), currentColor, gradients, a colour that is inherited
// rather than declared — resolves to null, which the contrast check reports as
// could-not-check. It never substitutes a plausible value.
// ---------------------------------------------------------------------------

const NAMED_COLOURS = {
  black: [0, 0, 0], silver: [192, 192, 192], gray: [128, 128, 128], grey: [128, 128, 128],
  white: [255, 255, 255], maroon: [128, 0, 0], red: [255, 0, 0], purple: [128, 0, 128],
  fuchsia: [255, 0, 255], magenta: [255, 0, 255], green: [0, 128, 0], lime: [0, 255, 0],
  olive: [128, 128, 0], yellow: [255, 255, 0], navy: [0, 0, 128], blue: [0, 0, 255],
  teal: [0, 128, 128], aqua: [0, 255, 255], cyan: [0, 255, 255],
};

export function parseColour(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (NAMED_COLOURS[v]) {
    const [r, g, b] = NAMED_COLOURS[v];
    return { r, g, b };
  }
  const hex = v.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    const h = hex[1];
    if (h.length === 3 || h.length === 4) {
      if (h.length === 4 && h[3] !== 'f') return null; // translucent: not resolvable
      return { r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16), b: parseInt(h[2] + h[2], 16) };
    }
    if (h.length === 6 || h.length === 8) {
      if (h.length === 8 && h.slice(6) !== 'ff') return null;
      return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
    }
    return null;
  }
  const rgb = v.match(/^rgba?\(\s*([0-9.]+%?)[\s,]+([0-9.]+%?)[\s,]+([0-9.]+%?)\s*(?:[,/]\s*([0-9.]+%?)\s*)?\)$/);
  if (rgb) {
    if (rgb[4] !== undefined) {
      const alpha = rgb[4].endsWith('%') ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]);
      if (!(alpha >= 1)) return null; // translucent over an unknown backdrop
    }
    const channel = (t) => {
      const n = t.endsWith('%') ? (parseFloat(t) / 100) * 255 : parseFloat(t);
      return Math.max(0, Math.min(255, Math.round(n)));
    };
    return { r: channel(rgb[1]), g: channel(rgb[2]), b: channel(rgb[3]) };
  }
  return null;
}

export function relativeLuminance({ r, g, b }) {
  const channel = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// ---------------------------------------------------------------------------
// CSS. Flat rule extraction: the pattern below cannot match a block that
// contains a block, so at-rule wrappers are skipped and the rules inside them
// are found on their own. Good enough to decide whether both sides of a
// text/background pair were written down as literals.
// ---------------------------------------------------------------------------

export function cssRules(css) {
  const clean = String(css).replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean))) {
    const selector = m[1].trim().replace(/\s+/g, ' ');
    if (selector.startsWith('@')) continue; // @font-face and friends declare no text
    rules.push({ selector, declarations: declarations(m[2]) });
  }
  return rules;
}

export function declarations(block) {
  const out = {};
  for (const part of String(block).split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const name = part.slice(0, i).trim().toLowerCase();
    if (!name || /\s/.test(name)) continue;
    out[name] = part.slice(i + 1).trim();
  }
  return out;
}

// The background shorthand may carry a colour among other components. Take a
// literal colour token out of it when one is there; otherwise give up.
export function backgroundColour(decls) {
  if (decls['background-color']) return { raw: decls['background-color'], colour: parseColour(decls['background-color']) };
  if (!decls.background) return null;
  const raw = decls.background;
  if (/gradient\(|url\(/i.test(raw)) return { raw, colour: null };
  for (const token of raw.split(/\s+/)) {
    const c = parseColour(token);
    if (c) return { raw, colour: c };
  }
  return { raw, colour: null };
}

// Returns every text/background pair that could be resolved, and a reason for
// every rule that declared one side and not the other, or a value the script
// cannot read. Nothing is guessed in either direction.
export function contrastFindings(rules, source, minimum = DEFAULTS.contrastMin) {
  const pairs = [];
  const unresolved = [];
  for (const rule of rules) {
    const fgRaw = rule.declarations.color;
    const bg = backgroundColour(rule.declarations);
    if (!fgRaw && !bg) continue;
    if (!fgRaw) {
      unresolved.push({ source, selector: rule.selector, reason: `background ${bg.raw} is declared but the text colour is inherited` });
      continue;
    }
    if (!bg) {
      unresolved.push({ source, selector: rule.selector, reason: `colour ${fgRaw} is declared but the background is inherited` });
      continue;
    }
    const fg = parseColour(fgRaw);
    if (!fg || !bg.colour) {
      unresolved.push({ source, selector: rule.selector, reason: `cannot resolve ${!fg ? `colour ${fgRaw}` : `background ${bg.raw}`} to a literal value` });
      continue;
    }
    const ratio = contrastRatio(fg, bg.colour);
    pairs.push({
      source,
      selector: rule.selector,
      colour: fgRaw.trim(),
      background: bg.raw.trim(),
      ratio: Math.round(ratio * 100) / 100,
      passes: ratio >= minimum,
    });
  }
  return { pairs, unresolved };
}

// ---------------------------------------------------------------------------
// Image dimensions, read from the bytes. PNG's IHDR and JPEG's SOF markers
// only; anything else returns null and the check says the dimensions were not
// readable rather than assuming they are fine.
// ---------------------------------------------------------------------------

export function imageSize(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const marker = buf[i + 1];
      if (marker === 0xff) { i += 1; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const length = buf.readUInt16BE(i + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { type: 'jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      if (length < 2) return null;
      i += 2 + length;
    }
  }
  if (buf.length > 8 && buf.slice(0, 4).toString('latin1') === 'GIF8') {
    return { type: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Secrets. The patterns are assembled from fragments so this file does not
// itself read as a credential to the repository's own secret scan, and so the
// hygiene test that greps the tree stays meaningful.
// ---------------------------------------------------------------------------

const QUOTED_VALUE = /["']([A-Za-z0-9_-]{24,})["']/;

export const SECRET_PATTERNS = [
  { id: 'anthropic', label: 'Anthropic API key', re: new RegExp('sk-' + 'ant-' + '[A-Za-z0-9_-]{20,}', 'g') },
  { id: 'openrouter', label: 'OpenRouter API key', re: new RegExp('sk-' + 'or-' + '[A-Za-z0-9-]{20,}', 'g') },
  { id: 'github', label: 'GitHub personal access token', re: new RegExp('ghp' + '_' + '[A-Za-z0-9]{30,}', 'g') },
  { id: 'aws', label: 'AWS access key id', re: new RegExp('AKI' + 'A' + '[0-9A-Z]{16}', 'g') },
  { id: 'stripe', label: 'Stripe live secret key', re: new RegExp('sk' + '_live_' + '[A-Za-z0-9]{20,}', 'g') },
  { id: 'pem', label: 'private key block', re: new RegExp('-----BEGIN ' + '[A-Z ]*' + 'PRIVATE KEY-----', 'g') },
  {
    id: 'assigned',
    label: 'credential assigned to a name',
    re: /(api[_-]?key|secret|token)\s*[:=]\s*["'][A-Za-z0-9_-]{24,}["']/gi,
    value: (match) => (match.match(QUOTED_VALUE) || [null, match])[1],
  },
];

// Never the value. Four characters is enough to recognise a key you already
// know and not enough to use one you do not.
export function maskSecret(value) {
  const v = String(value ?? '');
  if (v.length <= 4) return `${'*'.repeat(v.length)} (${v.length} chars)`;
  return `${v.slice(0, 4)}... (${v.length} chars, rest withheld)`;
}

export function scanSecrets(text, file) {
  const hits = [];
  String(text ?? '')
    .split('\n')
    .forEach((line, index) => {
      for (const pattern of SECRET_PATTERNS) {
        pattern.re.lastIndex = 0;
        let m;
        while ((m = pattern.re.exec(line))) {
          const value = pattern.value ? pattern.value(m[0]) : m[0];
          hits.push({ file, line: index + 1, kind: pattern.id, label: pattern.label, masked: maskSecret(value) });
          if (m[0].length === 0) break;
        }
      }
    });
  return hits;
}

// ---------------------------------------------------------------------------
// Pure judgements. Collection and verdict are separate so the verdicts can be
// tested on inputs a local fixture cannot produce — a site served over TLS,
// most of all.
// ---------------------------------------------------------------------------

export function judgeHttpsRedirect({ baseIsHttps, host, status, location, error }) {
  if (!baseIsHttps) {
    return { status: 'na', evidence: [`the origin under test is http://${host}; this check applies to a site served over https`] };
  }
  if (error) return { status: 'could-not-check', evidence: [`http://${host}/ could not be reached: ${error}`] };
  if (status !== 301 && status !== 308) {
    return { status: 'fail', evidence: [`GET http://${host}/ returned ${status}${location ? ` to ${location}` : ''}; expected 301 or 308`] };
  }
  if (!location) return { status: 'fail', evidence: [`GET http://${host}/ returned ${status} with no Location header`] };
  let target;
  try {
    target = new URL(location, `http://${host}/`);
  } catch {
    return { status: 'fail', evidence: [`GET http://${host}/ returned ${status} to an unparseable Location: ${location}`] };
  }
  if (target.protocol !== 'https:') {
    return { status: 'fail', evidence: [`GET http://${host}/ returned ${status} to ${target.href}, which is not https`] };
  }
  if (target.host !== host) {
    return { status: 'fail', evidence: [`GET http://${host}/ returned ${status} to ${target.href}, a different host`] };
  }
  return { status: 'pass', evidence: [`GET http://${host}/ returned ${status} to ${target.href}`] };
}

export function judgeMixedContent({ baseIsHttps, assets }) {
  const listed = assets.map((a) => `${a.page} references ${a.url} (${a.attribute} on <${a.tag}>)`);
  if (!baseIsHttps) {
    return {
      status: 'na',
      evidence: [
        'the origin under test is not https, so nothing on it can be mixed content',
        `${assets.length} http:// asset reference${assets.length === 1 ? '' : 's'} found and recorded for when it is`,
        ...listed,
      ],
    };
  }
  if (assets.length === 0) return { status: 'pass', evidence: ['0 http:// asset references on https pages'] };
  return { status: 'fail', evidence: [`${assets.length} http:// asset reference${assets.length === 1 ? '' : 's'} on an https page`, ...listed] };
}

// Report only. The checklist does not ask for these, so the verdict is always
// a pass and the value is always printed.
export function judgeSecurityHeaders(headers) {
  const csp = headers['content-security-policy'] ?? null;
  const nosniff = headers['x-content-type-options'] ?? null;
  const present = [csp, nosniff].filter((v) => v !== null).length;
  return {
    status: 'pass',
    evidence: [
      `${present} of 2 reported headers present`,
      `Content-Security-Policy: ${csp === null ? 'absent' : csp}`,
      `X-Content-Type-Options: ${nosniff === null ? 'absent' : nosniff}`,
      'reported only; the checklist does not require either header',
    ],
  };
}

export function judgePageLoad({ ttfbMs, bytes, ttfbLimit, bytesLimit }) {
  const evidence = [
    `time to first byte ${ttfbMs} ms (threshold ${ttfbLimit} ms)`,
    `${bytes} bytes transferred for the landing page (threshold ${bytesLimit} bytes)`,
  ];
  const over = [];
  if (ttfbMs > ttfbLimit) over.push('time to first byte');
  if (bytes > bytesLimit) over.push('page weight');
  if (over.length) return { status: 'fail', evidence: [...evidence, `over threshold: ${over.join(' and ')}`] };
  return { status: 'pass', evidence };
}

export function judgeMetaLengths(pages, limits = DEFAULTS) {
  const problems = [];
  const evidence = [];
  for (const page of pages) {
    const title = page.parsed.title;
    const description = page.parsed.description;
    if (!title) problems.push(`${page.url}: no <title>`);
    else if (title.length < limits.titleMin || title.length > limits.titleMax) {
      problems.push(`${page.url}: title is ${title.length} chars, outside ${limits.titleMin}-${limits.titleMax}`);
    }
    if (description === null) problems.push(`${page.url}: no <meta name="description">`);
    else if (description.length < limits.descriptionMin || description.length > limits.descriptionMax) {
      problems.push(`${page.url}: description is ${description.length} chars, outside ${limits.descriptionMin}-${limits.descriptionMax}`);
    }
    evidence.push(`${page.url}: title ${title === null ? 'absent' : `${title.length} chars`}, description ${description === null ? 'absent' : `${description.length} chars`}`);
  }
  if (!pages.length) return { status: 'could-not-check', evidence: ['no HTML pages were crawled'] };
  return problems.length ? { status: 'fail', evidence: [...problems, ...evidence] } : { status: 'pass', evidence };
}

// A 404 body that is only the server's own words is not a custom 404. The
// heuristic: the body must carry the site's title, or a link back into the
// site. Both are things a hand-written page has and a default does not.
export function looksCustom(body, { siteTitle }) {
  const text = String(body ?? '');
  if (text.length < 40) return false;
  if (siteTitle && text.toLowerCase().includes(siteTitle.toLowerCase())) return true;
  return /<a\b[^>]*href=/i.test(text);
}

// ---------------------------------------------------------------------------
// Fetching.
// ---------------------------------------------------------------------------

function headersToObject(headers) {
  const out = {};
  for (const [k, v] of headers) out[k.toLowerCase()] = v;
  return out;
}

export function makeFetcher({ timeoutMs = 15000 } = {}) {
  const cache = new Map();

  async function raw(url, { method = 'GET', redirect = 'follow' } = {}) {
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method, redirect, headers: { 'user-agent': USER_AGENT }, signal: controller.signal });
      const ttfbMs = Math.round(performance.now() - started);
      const body = method === 'HEAD' ? Buffer.alloc(0) : Buffer.from(await res.arrayBuffer());
      const headers = headersToObject(res.headers);
      return {
        ok: true,
        url,
        finalUrl: res.url || url,
        status: res.status,
        headers,
        contentType: headers['content-type'] ?? '',
        body,
        bytes: body.length,
        ttfbMs,
      };
    } catch (e) {
      return { ok: false, url, status: null, error: e.name === 'AbortError' ? `timed out after ${timeoutMs} ms` : e.message };
    } finally {
      clearTimeout(timer);
    }
  }

  async function get(url, options = {}) {
    const key = `${options.method ?? 'GET'} ${options.redirect ?? 'follow'} ${url}`;
    if (!cache.has(key)) cache.set(key, raw(url, options));
    return cache.get(key);
  }

  return { get, raw, cache };
}

// ---------------------------------------------------------------------------
// The fixture server. Serves a directory over http for the test suite, with
// two conventions real static hosts have: a `404.html` served with status 404,
// and a `200.html` served with status 200 for unknown paths — the soft 404 the
// custom-404 check exists to catch. `{{ORIGIN}}` in text files is replaced
// with the real origin so sitemaps and absolute og:image URLs work on a port
// nobody knew in advance.
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function isText(mime) {
  return /^text\/|charset=utf-8|xml|json/.test(mime);
}

export async function serveFixture(dir) {
  const root = path.resolve(dir);
  if (!existsSync(root)) throw new Error(`fixture directory not found: ${root}`);

  const resolveFile = (pathname) => {
    const decoded = decodeURIComponent(pathname.split('?')[0]);
    const rel = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
    const base = path.join(root, rel);
    if (!base.startsWith(root)) return null;
    const candidates = decoded.endsWith('/') ? [path.join(base, 'index.html')] : [base, `${base}.html`, path.join(base, 'index.html')];
    for (const c of candidates) {
      if (existsSync(c) && statSync(c).isFile()) return c;
    }
    return null;
  };

  const server = createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const file = resolveFile(req.url);
    const send = async (status, filePath, fallbackBody) => {
      let mime = 'text/html; charset=utf-8';
      let body;
      if (filePath) {
        mime = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
        body = await readFile(filePath);
        if (isText(mime)) body = Buffer.from(body.toString('utf8').replaceAll('{{ORIGIN}}', origin), 'utf8');
      } else {
        body = Buffer.from(fallbackBody, 'utf8');
      }
      res.writeHead(status, { 'content-type': mime, 'content-length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
    };

    if (file) return send(200, file);
    // A static host with an SPA rewrite answers unknown *page* paths with one
    // document and status 200 — the soft 404 — while still 404ing a missing
    // asset. The broken fixture leans on exactly that shape.
    const soft = path.join(root, '200.html');
    if (existsSync(soft) && path.extname(decodeURIComponent(req.url.split('?')[0])) === '') return send(200, soft);
    const custom = path.join(root, '404.html');
    if (existsSync(custom)) return send(404, custom);
    return send(404, null, 'Not Found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

function sameOrigin(url, origin) {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

const ASSET_EXTENSION = /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|json|xml|txt|pdf|zip|woff2?|ttf|otf|mp4|webm|webmanifest)$/i;

export function resolveUrl(href, base) {
  try {
    const u = new URL(href, base);
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

function crawlable(href) {
  return !/^(mailto:|tel:|javascript:|data:|sms:)/i.test(href.trim());
}

export async function collect(origin, options) {
  const fetcher = options.fetcher ?? makeFetcher();
  const pages = [];
  const queue = [`${origin}/`];
  const seen = new Set(queue);
  const anchors = []; // every same-origin <a href>, page-shaped or not
  const httpAssets = [];

  let home = null;
  while (queue.length && pages.length < options.maxPages) {
    const url = queue.shift();
    const res = await fetcher.get(url);
    if (!home) home = res;
    if (!res.ok) continue;
    if (res.status >= 400 || !/text\/html/i.test(res.contentType)) continue;
    const parsed = parsePage(res.body.toString('utf8'));
    pages.push({ url, status: res.status, bytes: res.bytes, ttfbMs: res.ttfbMs, headers: res.headers, parsed, html: res.body.toString('utf8') });

    for (const a of parsed.anchors) {
      if (!crawlable(a.href)) continue;
      const target = resolveUrl(a.href, url);
      if (!target || !sameOrigin(target, origin)) continue;
      anchors.push({ from: url, url: target });
      if (ASSET_EXTENSION.test(new URL(target).pathname)) continue;
      if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }

    const assetRefs = [
      ...parsed.images.map((a) => ({ tag: 'img', attribute: 'src', href: a.src })),
      ...parsed.scripts.map((a) => ({ tag: 'script', attribute: 'src', href: a.src })),
      ...parsed.links.map((a) => ({ tag: 'link', attribute: 'href', href: a.href })),
    ];
    for (const ref of assetRefs) {
      if (typeof ref.href !== 'string') continue;
      if (/^http:\/\//i.test(ref.href.trim())) httpAssets.push({ page: url, url: ref.href.trim(), tag: ref.tag, attribute: ref.attribute });
    }
  }

  return { fetcher, pages, anchors, httpAssets, home, truncated: queue.length > 0 };
}

export async function runChecks(origin, options) {
  const limits = { ...DEFAULTS, ...options };
  const results = [];
  const record = (id, status, evidence) => {
    const item = ITEMS.find((i) => i.id === id);
    results.push({ item: id, label: item.label, status, evidence: Array.isArray(evidence) ? evidence : [evidence] });
  };

  const base = new URL(origin);
  const baseIsHttps = base.protocol === 'https:';
  const { fetcher, pages, anchors, httpAssets, home, truncated } = await collect(base.origin, limits);

  if (!home || !home.ok) {
    return { unreachable: true, error: home?.error ?? 'no response', results, pages: [] };
  }

  // 1. http -> https
  {
    let observed = { baseIsHttps, host: base.host };
    if (baseIsHttps) {
      const plain = await fetcher.raw(`http://${base.host}/`, { redirect: 'manual' });
      observed = {
        ...observed,
        status: plain.status,
        location: plain.ok ? plain.headers.location ?? null : null,
        error: plain.ok ? null : plain.error,
      };
    }
    const verdict = judgeHttpsRedirect(observed);
    record('force-https', verdict.status, verdict.evidence);
  }

  // 2. robots.txt and sitemap.xml
  {
    const robots = await fetcher.get(`${base.origin}/robots.txt`);
    const sitemap = await fetcher.get(`${base.origin}/sitemap.xml`);
    const evidence = [];
    const problems = [];
    if (!robots.ok) problems.push(`/robots.txt could not be fetched: ${robots.error}`);
    else {
      evidence.push(`/robots.txt returned ${robots.status}, ${robots.bytes} bytes`);
      if (robots.status !== 200) problems.push(`/robots.txt returned ${robots.status}`);
      else {
        const text = robots.body.toString('utf8');
        const directives = text.split('\n').filter((l) => /^\s*(user-agent|allow|disallow|sitemap|crawl-delay)\s*:/i.test(l));
        evidence.push(`/robots.txt parsed: ${directives.length} directive line(s)`);
        if (directives.length === 0) problems.push('/robots.txt has no parseable directive lines');
      }
    }
    if (!sitemap.ok) problems.push(`/sitemap.xml could not be fetched: ${sitemap.error}`);
    else {
      evidence.push(`/sitemap.xml returned ${sitemap.status}, ${sitemap.bytes} bytes`);
      if (sitemap.status !== 200) problems.push(`/sitemap.xml returned ${sitemap.status}`);
      else {
        const locs = [...sitemap.body.toString('utf8').matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => decodeEntities(m[1]));
        evidence.push(`/sitemap.xml lists ${locs.length} URL(s)`);
        if (locs.length === 0) problems.push('/sitemap.xml lists no <loc> entries');
        for (const loc of locs.slice(0, limits.maxLinkChecks)) {
          const res = await fetcher.get(loc);
          if (!res.ok) { problems.push(`sitemap URL ${loc} could not be fetched: ${res.error}`); continue; }
          evidence.push(`sitemap URL ${loc} returned ${res.status}`);
          if (res.status !== 200) problems.push(`sitemap URL ${loc} returned ${res.status}`);
        }
      }
    }
    record('robots-sitemap', problems.length ? 'fail' : 'pass', problems.length ? [...problems, ...evidence] : evidence);
  }

  // 3. title and description
  {
    const verdict = judgeMetaLengths(pages, limits);
    record('meta-title-description', verdict.status, verdict.evidence);
  }

  // 4. social preview
  {
    const page = pages[0];
    if (!page) record('social-preview', 'could-not-check', ['no HTML page was crawled']);
    else {
      const { og, twitterCard } = page.parsed;
      const evidence = [
        `og:title: ${og.title === null ? 'absent' : `${og.title.length} chars`}`,
        `og:description: ${og.description === null ? 'absent' : `${og.description.length} chars`}`,
        `og:image: ${og.image === null ? 'absent' : og.image}`,
        `twitter:card: ${twitterCard === null ? 'absent' : twitterCard}`,
      ];
      const problems = [];
      if (og.title === null || !og.title.trim()) problems.push('og:title is absent');
      if (og.description === null || !og.description.trim()) problems.push('og:description is absent');
      if (twitterCard === null || !twitterCard.trim()) problems.push('twitter:card is absent');
      if (og.image === null || !og.image.trim()) problems.push('og:image is absent');
      else {
        const url = resolveUrl(og.image, page.url);
        const res = url ? await fetcher.get(url) : null;
        if (!res || !res.ok) problems.push(`og:image ${og.image} could not be fetched${res ? `: ${res.error}` : ''}`);
        else {
          evidence.push(`og:image fetched: ${res.status}, ${res.bytes} bytes, content-type ${res.contentType || 'absent'}`);
          if (res.status !== 200) problems.push(`og:image returned ${res.status}`);
          else if (!/^image\//i.test(res.contentType)) problems.push(`og:image content-type is ${res.contentType || 'absent'}, not an image`);
          else {
            const size = imageSize(res.body);
            if (!size) evidence.push('og:image dimensions are not readable from the bytes; not judged');
            else {
              evidence.push(`og:image is ${size.width}x${size.height} (${size.type})`);
              if (size.width < limits.ogImageWidth || size.height < limits.ogImageHeight) {
                problems.push(`og:image is ${size.width}x${size.height}, under ${limits.ogImageWidth}x${limits.ogImageHeight}`);
              }
            }
          }
        }
      }
      record('social-preview', problems.length ? 'fail' : 'pass', problems.length ? [...problems, ...evidence] : evidence);
    }
  }

  // 5. favicon
  {
    const page = pages[0];
    const declared = page
      ? page.parsed.links.find((l) => String(l.rel ?? '').toLowerCase().split(/\s+/).includes('icon'))
      : null;
    const evidence = [];
    let status = 'fail';
    if (declared && declared.href) {
      const url = resolveUrl(declared.href, page.url);
      const res = url ? await fetcher.get(url) : null;
      evidence.push(`<link rel="${declared.rel}" href="${declared.href}"> resolved to ${url}`);
      if (res && res.ok) {
        evidence.push(`returned ${res.status}, ${res.bytes} bytes, content-type ${res.contentType || 'absent'}`);
        status = res.status === 200 ? 'pass' : 'fail';
      } else evidence.push(`could not be fetched: ${res ? res.error : 'unresolvable href'}`);
    } else {
      evidence.push('no <link rel="icon"> on the landing page');
      const res = await fetcher.get(`${base.origin}/favicon.ico`);
      if (res.ok) {
        evidence.push(`/favicon.ico returned ${res.status}, ${res.bytes} bytes`);
        status = res.status === 200 ? 'pass' : 'fail';
      } else evidence.push(`/favicon.ico could not be fetched: ${res.error}`);
    }
    record('favicon', status, evidence);
  }

  // 6. viewport on every page
  {
    if (!pages.length) record('mobile-friendly', 'could-not-check', ['no HTML pages were crawled']);
    else {
      const missing = pages.filter((p) => p.parsed.viewport === null || !p.parsed.viewport.trim());
      const evidence = pages.map((p) => `${p.url}: viewport ${p.parsed.viewport === null ? 'absent' : `"${p.parsed.viewport}"`}`);
      record('mobile-friendly', missing.length ? 'fail' : 'pass', missing.length ? [`${missing.length} of ${pages.length} page(s) have no <meta name="viewport">`, ...evidence] : evidence);
    }
  }

  // 7. custom 404
  {
    const probe = `${base.origin}/site-preflight-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const res = await fetcher.get(probe);
    const evidence = [];
    let status;
    if (!res.ok) {
      status = 'could-not-check';
      evidence.push(`${probe} could not be fetched: ${res.error}`);
    } else {
      evidence.push(`GET ${probe} returned ${res.status}, ${res.bytes} bytes`);
      const custom = looksCustom(res.body.toString('utf8'), { siteTitle: pages[0]?.parsed.title ?? null });
      evidence.push(`body ${custom ? 'carries the site title or an internal link' : 'looks like a bare server default: no site title and no link back into the site'}`);
      if (res.status === 200) { status = 'fail'; evidence.push('status 200 for a path that does not exist is a soft 404'); }
      else if (res.status !== 404) { status = 'fail'; evidence.push(`expected 404, got ${res.status}`); }
      else status = custom ? 'pass' : 'fail';
    }
    record('custom-404', status, evidence);
  }

  // 8. internal links
  {
    const unique = [...new Set(anchors.map((a) => a.url))].slice(0, limits.maxLinkChecks);
    const evidence = [`crawled ${pages.length} page(s)${truncated ? ` (stopped at --max-pages ${limits.maxPages})` : ''}, found ${unique.length} unique same-origin link target(s)`];
    const problems = [];
    for (const url of unique) {
      const res = await fetcher.get(url);
      const from = anchors.filter((a) => a.url === url).map((a) => a.from);
      if (!res.ok) { problems.push(`${url} could not be fetched (${res.error}); linked from ${from[0]}`); continue; }
      evidence.push(`${url}: ${res.status}`);
      if (res.status >= 400) problems.push(`${url} returned ${res.status}; linked from ${from.join(', ')}`);
    }
    record('broken-links', problems.length ? 'fail' : 'pass', problems.length ? [...problems, ...evidence] : evidence);
  }

  // 9a. alt text  /  9b. image weight
  {
    const images = [];
    for (const page of pages) {
      for (const img of page.parsed.images) {
        images.push({ page: page.url, src: img.src ?? null, alt: 'alt' in img ? img.alt : null, role: img.role ?? null });
      }
    }
    if (!images.length) {
      record('alt-text', 'na', [`no <img> elements on the ${pages.length} page(s) crawled`]);
      record('image-compression', 'na', [`no <img> elements on the ${pages.length} page(s) crawled`]);
    } else {
      // `alt=""` is the marking for a decorative image, and it is sufficient on
      // its own: `role="presentation"` adds nothing an assistive technology
      // acts on. So the only failure here is an <img> with no `alt` attribute
      // at all, which leaves a screen reader to read out the file name.
      //
      // Whether an image was *rightly* called decorative is not a thing bytes
      // can answer, so the count is reported for a human to weigh: twenty-three
      // decorative images on a page is either a row of technology logos or a
      // gallery nobody can see, and only a person can say which.
      const altProblems = [];
      const altEvidence = [];
      let described = 0;
      let decorative = 0;
      for (const img of images) {
        const hasAlt = typeof img.alt === 'string';
        const hasText = hasAlt && img.alt.trim().length > 0;
        if (hasText) described += 1;
        else if (hasAlt) decorative += 1;
        else altProblems.push(`${img.page} <img src="${img.src}"> has no alt attribute`);
        altEvidence.push(`${img.page} <img src="${img.src}">: alt ${hasAlt ? `"${img.alt}"` : 'absent'}${img.role ? `, role="${img.role}"` : ''}`);
      }
      const altSummary = [
        `${images.length} image(s): ${described} described, ${decorative} marked decorative with alt="", ${altProblems.length} with no alt attribute`,
      ];
      if (decorative > 0) {
        altSummary.push(`${decorative} image(s) declare themselves decorative; whether that is right is a judgement no script makes — read the list and decide`);
      }
      record('alt-text', altProblems.length ? 'fail' : 'pass', [...altSummary, ...altProblems, ...altEvidence]);

      const weightProblems = [];
      const weightEvidence = [];
      const seenSrc = new Set();
      for (const img of images) {
        if (!img.src || seenSrc.has(img.src)) continue;
        seenSrc.add(img.src);
        const url = resolveUrl(img.src, img.page);
        const res = url ? await fetcher.get(url) : null;
        if (!res || !res.ok) { weightProblems.push(`${img.src} could not be fetched${res ? `: ${res.error}` : ''}`); continue; }
        weightEvidence.push(`${url}: ${res.status}, ${res.bytes} bytes (threshold ${limits.imageBytes})`);
        if (res.status >= 400) { weightProblems.push(`${url} returned ${res.status}`); continue; }
        if (res.bytes > limits.imageBytes) weightProblems.push(`${url} is ${res.bytes} bytes, over the ${limits.imageBytes} byte threshold`);
      }
      record('image-compression', weightProblems.length ? 'fail' : 'pass', weightProblems.length ? [...weightProblems, ...weightEvidence] : weightEvidence);
    }
  }

  // 10. page load
  {
    const landing = pages.find((p) => p.url === `${base.origin}/`) ?? pages[0];
    if (!landing) record('page-load-speed', 'could-not-check', ['the landing page was not retrieved as HTML']);
    else {
      const verdict = judgePageLoad({ ttfbMs: landing.ttfbMs, bytes: landing.bytes, ttfbLimit: limits.ttfbMs, bytesLimit: limits.totalBytes });
      record('page-load-speed', verdict.status, verdict.evidence);
    }
  }

  // 11. secrets in served JS
  {
    const hits = [];
    const evidence = [];
    const scanned = new Set();
    for (const page of pages) {
      page.parsed.inlineScripts.forEach((code, i) => {
        const name = `${page.url} inline <script> #${i + 1}`;
        evidence.push(`scanned ${name} (${Buffer.byteLength(code)} bytes)`);
        hits.push(...scanSecrets(code, name));
      });
      for (const script of page.parsed.scripts) {
        const url = resolveUrl(script.src, page.url);
        if (!url || !sameOrigin(url, base.origin) || scanned.has(url)) continue;
        scanned.add(url);
        const res = await fetcher.get(url);
        if (!res.ok) { evidence.push(`${url} could not be fetched: ${res.error}`); continue; }
        evidence.push(`scanned ${url} (${res.status}, ${res.bytes} bytes)`);
        hits.push(...scanSecrets(res.body.toString('utf8'), url));
      }
    }
    if (!evidence.length) record('secrets-off-the-frontend', 'na', [`no same-origin scripts on the ${pages.length} page(s) crawled`]);
    else {
      const found = hits.map((h) => `${h.file}:${h.line}: ${h.label}: ${h.masked}`);
      record('secrets-off-the-frontend', hits.length ? 'fail' : 'pass', hits.length
        ? [`${hits.length} credential-shaped string(s) in served JavaScript`, ...found, ...evidence]
        : [`0 credential-shaped strings across ${evidence.length} script source(s)`, ...evidence]);
    }
  }

  // 12. colour contrast
  {
    const allPairs = [];
    const allUnresolved = [];
    const stylesheets = new Set();
    for (const page of pages) {
      page.parsed.inlineStyles.forEach((css, i) => {
        const { pairs, unresolved } = contrastFindings(cssRules(css), `${page.url} inline <style> #${i + 1}`, limits.contrastMin);
        allPairs.push(...pairs);
        allUnresolved.push(...unresolved);
      });
      for (const style of page.parsed.styleAttributes) {
        const { pairs, unresolved } = contrastFindings([{ selector: 'style attribute', declarations: declarations(style) }], `${page.url} style attribute`, limits.contrastMin);
        allPairs.push(...pairs);
        allUnresolved.push(...unresolved);
      }
      for (const link of page.parsed.links) {
        const rel = String(link.rel ?? '').toLowerCase();
        if (rel !== 'stylesheet' || typeof link.href !== 'string') continue;
        const url = resolveUrl(link.href, page.url);
        if (!url || !sameOrigin(url, base.origin) || stylesheets.has(url)) continue;
        stylesheets.add(url);
        const res = await fetcher.get(url);
        if (!res.ok || res.status >= 400) { allUnresolved.push({ source: url, selector: '(whole file)', reason: `stylesheet could not be read: ${res.ok ? res.status : res.error}` }); continue; }
        const { pairs, unresolved } = contrastFindings(cssRules(res.body.toString('utf8')), url, limits.contrastMin);
        allPairs.push(...pairs);
        allUnresolved.push(...unresolved);
      }
    }
    const failing = allPairs.filter((p) => !p.passes);
    const evidence = [
      `${allPairs.length} text/background pair(s) resolved to literal colours; ${allUnresolved.length} declaration(s) could not be resolved`,
      ...allPairs.map((p) => `${p.source} { ${p.selector} }: ${p.colour} on ${p.background} = ${p.ratio.toFixed(2)}:1 (minimum ${limits.contrastMin})`),
      ...allUnresolved.map((u) => `unresolved: ${u.source} { ${u.selector} }: ${u.reason}`),
    ];
    if (failing.length) {
      record('colour-contrast', 'fail', [
        `${failing.length} pair(s) under ${limits.contrastMin}:1`,
        ...failing.map((p) => `${p.source} { ${p.selector} }: ${p.colour} on ${p.background} = ${p.ratio.toFixed(2)}:1`),
        ...evidence,
      ]);
    } else if (allUnresolved.length) {
      record('colour-contrast', 'could-not-check', [
        `${allUnresolved.length} declaration(s) use variables, inheritance or values this script will not guess at`,
        ...evidence,
      ]);
    } else if (!allPairs.length) {
      record('colour-contrast', 'could-not-check', ['no colour declarations were found to judge']);
    } else {
      record('colour-contrast', 'pass', evidence);
    }
  }

  // 13. mixed content
  {
    const verdict = judgeMixedContent({ baseIsHttps, assets: httpAssets });
    record('mixed-content', verdict.status, verdict.evidence);
  }

  // 14. security headers (report only)
  {
    const landing = pages.find((p) => p.url === `${base.origin}/`) ?? pages[0];
    const verdict = judgeSecurityHeaders(landing ? landing.headers : home.headers ?? {});
    record('security-headers', verdict.status, verdict.evidence);
  }

  return { unreachable: false, results, pages: pages.map((p) => ({ url: p.url, status: p.status, bytes: p.bytes, ttfbMs: p.ttfbMs })) };
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------

export function exitCodeFor(results) {
  if (results.some((r) => r.status === 'fail')) return 1;
  if (results.some((r) => r.status === 'could-not-check')) return 1;
  return 0;
}

const SYMBOL = { pass: 'pass', fail: 'FAIL', na: 'n/a', 'could-not-check': 'could not check' };

export function renderMarkdown(report) {
  const L = [];
  L.push('# Site preflight');
  L.push('');
  L.push(`Origin: ${report.origin}`);
  L.push(`Run at: ${report.generatedAt}`);
  L.push(`Pages crawled: ${report.pages.length} (limit ${report.limits.maxPages})`);
  L.push('');
  if (report.unreachable) {
    L.push(`**The origin could not be reached:** ${report.error}`);
    L.push('');
    L.push('Exit code: 2. Nothing was checked; this is not a pass.');
    return L.join('\n') + '\n';
  }
  const counts = report.counts;
  L.push(`${counts.pass} pass, ${counts.fail} fail, ${counts.na} n/a, ${counts['could-not-check']} could not be checked, across ${report.results.length} mechanical items.`);
  L.push('');
  L.push('| Item | Status | First line of evidence |');
  L.push('|---|---|---|');
  for (const r of report.results) {
    L.push(`| ${r.label} | ${SYMBOL[r.status]} | ${(r.evidence[0] ?? '').replace(/\|/g, '\\|')} |`);
  }
  L.push('');
  L.push('## Evidence');
  L.push('');
  for (const r of report.results) {
    L.push(`### ${r.label} — ${SYMBOL[r.status]}`);
    L.push('');
    for (const line of r.evidence) L.push(`- ${line}`);
    L.push('');
  }
  L.push('## The six a script cannot answer');
  L.push('');
  L.push('These are not judged here. `/site-preflight:preflight` asks them one at a time and appends the answers.');
  L.push('');
  for (const h of HUMAN_ITEMS) L.push(`- **${h.label}** — ${h.question}`);
  L.push('');
  L.push(`Exit code: ${report.exitCode}. 0 means every mechanical item passed or did not apply; 1 means at least one failed or could not be checked; 2 means the run did not happen. 2 is never a pass.`);
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const out = {};
  const integer = (name, raw) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} needs a positive integer, got ${raw}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[++i];
    };
    switch (arg) {
      case '--url': out.url = next(); break;
      case '--out': out.out = next(); break;
      case '--fixture': out.fixture = next(); break;
      case '--max-pages': out.maxPages = integer('--max-pages', next()); break;
      case '--ttfb-ms': out.ttfbMs = integer('--ttfb-ms', next()); break;
      case '--max-bytes': out.totalBytes = integer('--max-bytes', next()); break;
      case '--max-image-bytes': out.imageBytes = integer('--max-image-bytes', next()); break;
      case '-h':
      case '--help': out.help = true; break;
      default: throw new Error(`unknown argument ${arg}`);
    }
  }
  return out;
}

const USAGE = `usage: preflight.mjs --url <origin> --out <dir> [options]

  --url               origin to check, for example https://example.com
  --out               directory for report.json and report.md
  --fixture <dir>     serve <dir> over a local http server and check that instead;
                      --url is then the local server and is ignored
  --max-pages <n>     pages to crawl (default ${DEFAULTS.maxPages})
  --ttfb-ms <n>       time-to-first-byte threshold in ms (default ${DEFAULTS.ttfbMs})
  --max-bytes <n>     landing page weight threshold in bytes (default ${DEFAULTS.totalBytes})
  --max-image-bytes <n>  per-image threshold in bytes (default ${DEFAULTS.imageBytes})

  exit 0: every mechanical item passed or did not apply
  exit 1: at least one item failed, or could not be checked
  exit 2: the origin could not be reached, or a check threw. 2 is never a pass.
`;

class RunError extends Error {}

export async function run(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  const say = (s) => io.stdout.write(s + '\n');
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    throw new RunError(`${e.message}\n\n${USAGE}`);
  }
  if (args.help) {
    say(USAGE);
    return 0;
  }
  if (!args.out) throw new RunError(`--out is required\n\n${USAGE}`);
  if (!args.url && !args.fixture) throw new RunError(`--url is required unless --fixture is given\n\n${USAGE}`);

  let server = null;
  let origin;
  if (args.fixture) {
    server = await serveFixture(args.fixture);
    origin = server.origin;
  } else {
    try {
      origin = new URL(args.url.includes('://') ? args.url : `https://${args.url}`).origin;
    } catch {
      throw new RunError(`--url is not a URL: ${args.url}`);
    }
  }

  const limits = {
    maxPages: args.maxPages ?? DEFAULTS.maxPages,
    ttfbMs: args.ttfbMs ?? DEFAULTS.ttfbMs,
    totalBytes: args.totalBytes ?? DEFAULTS.totalBytes,
    imageBytes: args.imageBytes ?? DEFAULTS.imageBytes,
  };

  let outcome;
  try {
    outcome = await runChecks(origin, limits);
  } finally {
    if (server) await server.close();
  }

  const counts = { pass: 0, fail: 0, na: 0, 'could-not-check': 0 };
  for (const r of outcome.results) counts[r.status] += 1;
  const exitCode = outcome.unreachable ? 2 : exitCodeFor(outcome.results);

  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    origin,
    fixture: args.fixture ?? null,
    limits: { ...DEFAULTS, ...limits },
    unreachable: outcome.unreachable,
    error: outcome.error ?? null,
    pages: outcome.pages,
    counts,
    results: outcome.results,
    humanItems: HUMAN_ITEMS,
    exitCode,
  };

  await mkdir(args.out, { recursive: true });
  await writeFile(path.join(args.out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const md = renderMarkdown(report);
  await writeFile(path.join(args.out, 'report.md'), md);

  say(md);
  say(`Wrote ${path.join(args.out, 'report.json')} and ${path.join(args.out, 'report.md')}`);
  return exitCode;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`site-preflight: ${e instanceof RunError ? e.message : e.stack || e.message}\n`);
      process.exit(2);
    });
}
