#!/usr/bin/env node
// adversarial: a thin check in front of /codex:adversarial-review from
// openai/codex-plugin-cc. It looks for that plugin and the Codex CLI it needs.
// Exit 0 with the command to run when both are present; exit 2 with a plain
// message when they are not. It never runs a review itself and it never
// modifies anything.

import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const CODEX_MARKETPLACE = 'openai-codex';
const CODEX_PLUGIN = 'codex';

async function exists(p) {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// Claude Code records marketplace plugins under ~/.claude/plugins. The exact
// layout has moved between releases, so several signals are checked and any
// one is enough. Setting CODEX_PLUGIN_INSTALLED=1 overrides the check for
// hosts that store plugins elsewhere.
export async function detectCodexPlugin(home = os.homedir(), env = process.env) {
  if (env.CODEX_PLUGIN_INSTALLED === '1') return { installed: true, via: 'CODEX_PLUGIN_INSTALLED=1' };
  const root = path.join(home, '.claude', 'plugins');
  const candidates = [
    path.join(root, 'marketplaces', CODEX_MARKETPLACE),
    path.join(root, 'cache', CODEX_MARKETPLACE, CODEX_PLUGIN),
    path.join(root, 'repos', 'openai', 'codex-plugin-cc'),
  ];
  for (const c of candidates) {
    if (await exists(c)) return { installed: true, via: c };
  }
  for (const file of ['installed_plugins.json', 'known_marketplaces.json']) {
    const p = path.join(root, file);
    if (!(await exists(p))) continue;
    try {
      const text = await readFile(p, 'utf8');
      if (text.includes(`${CODEX_PLUGIN}@${CODEX_MARKETPLACE}`) || text.includes('codex-plugin-cc')) {
        return { installed: true, via: p };
      }
    } catch {
      // unreadable; keep looking
    }
  }
  return { installed: false, via: null };
}

export function detectCodexCli() {
  const which = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(which, ['codex'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim().split('\n')[0] : null;
}

export async function main(argv) {
  const plugin = await detectCodexPlugin();
  const cli = detectCodexCli();
  const args = argv.join(' ').trim();

  if (!plugin.installed) {
    process.stdout.write(
      [
        'The adversarial skill wraps /codex:adversarial-review from openai/codex-plugin-cc, and that plugin is not installed here.',
        'Install it, then run this skill again:',
        '',
        '  /plugin marketplace add openai/codex-plugin-cc',
        '  /plugin install codex@openai-codex',
        '',
        cli ? `The Codex CLI is present at ${cli}.` : 'The Codex CLI (`codex`) is also not on PATH; the plugin needs it. See https://github.com/openai/codex-plugin-cc.',
        '',
        'The blind half of the pipeline (/blind-review:blind-review) does not depend on this and still runs.',
      ].join('\n') + '\n',
    );
    return 2;
  }

  process.stdout.write(
    [
      `Codex plugin detected (${plugin.via}).`,
      cli ? `Codex CLI: ${cli}` : 'Warning: the Codex CLI (`codex`) is not on PATH; the plugin will fail without it.',
      '',
      'Run the review with:',
      '',
      `  /codex:adversarial-review ${args}`.trimEnd(),
      '',
      'It is review-only. Return its output verbatim; do not act on it.',
    ].join('\n') + '\n',
  );
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
