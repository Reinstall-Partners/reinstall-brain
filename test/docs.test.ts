// The docs can't drift from the code: every command they name exists, every command exists in the docs,
// the spec lists the types and fields the code knows, relative links resolve, and the demo's order is the
// one docs/hub.md prints. See docs/MAP.md for where each idea is explained.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync, cpSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CORE_TYPES, FIELD_ORDER } from '../src/core/record.js';
import { openBrain } from '../src/core/brain.js';
import { openHubDb, indexHub, priorities } from '../src/core/hub.js';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

function walk(rel: string, out: string[] = []): string[] {
  const abs = path.join(ROOT, rel);
  if (!existsSync(abs)) return out;
  if (statSync(abs).isFile()) return rel.endsWith('.md') ? [...out, rel] : out;
  for (const e of readdirSync(abs)) {
    if (e === 'node_modules' || e === '.local' || e === 'records' || e === 'templates') continue;
    walk(path.join(rel, e), out);
  }
  return out;
}

/** Command names in a CLI's help text: the first word of each two-space-indented line. */
function helpCommands(src: string): Set<string> {
  const help = /const HELP = `([\s\S]*?)`;/.exec(read(src))![1];
  const out = new Set<string>();
  for (const line of help.split('\n')) {
    const m = /^ {2}([a-z][a-z-]*)\b/.exec(line);
    if (m) out.add(m[1]);
  }
  return out;
}

const DOCS = ['README.md', ...walk('docs'), ...walk('guide'), ...walk('skills'), 'templates/hub/HUB.md', 'templates/brain/README.md', 'examples/demo/README.md'];
const brainCmds = helpCommands('src/cli/brain.ts');
const hubCmds = helpCommands('src/cli/hub.ts');

describe('docs match the code', () => {
  it('every command the docs name exists', () => {
    const bad: string[] = [];
    for (const f of DOCS) {
      const text = read(f);
      for (const [, tool, cmd] of text.matchAll(/\breinstall-(brain|hub) ([a-z][a-z-]+)\b/g)) {
        const known = tool === 'brain' ? brainCmds : hubCmds;
        if (!known.has(cmd) && !['help'].includes(cmd)) bad.push(`${f}: reinstall-${tool} ${cmd}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('every command is documented somewhere besides --help', () => {
    const all = DOCS.map(read).join('\n');
    const missing = [
      ...[...brainCmds].filter((c) => !new RegExp(`reinstall-brain ${c}\\b`).test(all)).map((c) => `reinstall-brain ${c}`),
      ...[...hubCmds].filter((c) => !new RegExp(`reinstall-hub ${c}\\b`).test(all)).map((c) => `reinstall-hub ${c}`),
    ].filter((c) => !/ (version|index|kitdb|where)$/.test(c));
    expect(missing).toEqual([]);
  });

  it('package.json and the CLI report the same version', async () => {
    const { VERSION } = await import('../src/core/version.js');
    expect(JSON.parse(read('package.json')).version).toBe(VERSION);
  });

  it('the spec lists every core type and field, in the code\'s field order', () => {
    const spec = read('docs/brain-spec.md');
    for (const [type, folder] of Object.entries(CORE_TYPES)) {
      expect(spec).toContain(`| \`${type}\` | \`${folder}/\` |`);
      expect(spec).toContain(`│   ├── ${folder}/`.replace('├', spec.includes(`│   └── ${folder}/`) ? '└' : '├'));
    }
    for (const f of FIELD_ORDER) expect(spec).toContain(`| \`${f}\` |`);
    const order = /\*\*Field order\.\*\*[^\n]*\n\n([\s\S]*?)\.\n/.exec(spec)![1].match(/`([a-z_]+)`/g)!.map((x) => x.slice(1, -1));
    expect(order).toEqual([...FIELD_ORDER]);
  });

  it('the type lists in the guides name every core type', () => {
    for (const f of ['docs/brain-spec.md', 'templates/brain/README.md', 'skills/brain/SKILL.md']) {
      const first = read(f).split('\n').slice(0, 12).join(' ');
      for (const type of Object.keys(CORE_TYPES)) {
        const plural = CORE_TYPES[type];
        expect(first.includes(type) || first.includes(plural), `${f} names ${type}`).toBe(true);
      }
    }
  });

  it('relative links resolve', () => {
    const bad: string[] = [];
    for (const f of DOCS) {
      for (const [, target] of read(f).matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^(https?:|mailto:|#|\/)/.test(target)) continue;
        const file = target.split('#')[0];
        if (!existsSync(path.join(ROOT, path.dirname(f), file))) bad.push(`${f}: ${target}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('the demo hub ranks the way docs/hub.md says', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'rb-demo-'));
    cpSync(path.join(ROOT, 'examples', 'demo'), tmp, { recursive: true });
    const hub = openBrain(path.join(tmp, 'acme-hub'));
    const db = await openHubDb(hub);
    await indexHub(hub, db);
    const got = priorities(hub, db).ranked.map((r) => String(r.key));
    db.close();
    const block = /reinstall-hub priorities --hub examples\/demo\/acme-hub\n```\n\n```\n([\s\S]*?)```/.exec(read('docs/hub.md'))![1];
    const documented = [...block.matchAll(/^\s+\d+\.\s+(\S+)/gm)].map((m) => m[1]);
    expect(got).toEqual(documented);
  });
});
