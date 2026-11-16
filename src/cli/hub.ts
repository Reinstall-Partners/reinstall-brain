#!/usr/bin/env node
import { VERSION } from '../core/version.js';
import { parseArgs } from './args.js';
import {
  locateHub, saveHub, openHubDb, indexHub, priorities, inbox, place, unrank, seedFromLegacy, type Position,
} from '../core/hub.js';

const HELP = `reinstall-hub ${VERSION}: the layer that connects every project's brain.

A hub is a brain whose brain.yaml lists other brains under connects:. Its priorities.md is your
strict ranking of tasks across all of them (line order is the rank).

Usage: reinstall-hub <command> [--hub PATH] [--json]

  use <path>                       remember which hub to use (else --hub, REINSTALL_HUB, or the brain here)
  index                            refresh every connected brain and the hub's combined index
  priorities [--all]               your ranked tasks (finished ones drop off the file)
  inbox [--brain NAME] [--limit N] open tasks not ranked yet, in project order
  place <brain/id> --top|--bottom|--at N|--above KEY|--below KEY
  unrank <brain/id>
  seed                             append tasks ranked in migrated brains (legacy focus/priority)
  status                           each connected brain: records and problems
  version
`;

async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv);
  const [cmd, ...pos] = a.positional;
  const json = a.flag('json');
  const out = (value: unknown, human: () => void) => (json ? console.log(JSON.stringify(value, null, 2)) : human());

  if (cmd === undefined || cmd === 'help' || cmd === '--help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (cmd === 'version' || cmd === '--version') {
    console.log(VERSION);
    return 0;
  }
  if (cmd === 'use') {
    if (!pos[0]) throw new Error('usage: reinstall-hub use <path to the hub repo>');
    const root = saveHub(pos[0]);
    console.log(`hub: ${root}`);
    return 0;
  }

  const hub = locateHub(a.value('hub'));
  const db = await openHubDb(hub);
  try {
    // Every command reads fresh data: brains are small and indexing is incremental.
    const indexed = await indexHub(hub, db);
    switch (cmd) {
      case 'index':
      case 'status': {
        out(indexed, () => {
          for (const b of indexed.brains) console.log(`${b.name.padEnd(24)} ${String(b.records).padStart(5)} records${b.error ? `   ${b.error}` : ''}`);
        });
        return indexed.brains.some((b) => b.error) && cmd === 'status' ? 1 : 0;
      }
      case 'priorities': {
        const r = priorities(hub, db, { prune: true });
        out(r, () => {
          for (const i of r.ranked) console.log(`${String(i.rank).padStart(3)}. ${i.key.padEnd(30)} ${i.status === 'blocked' ? '[blocked] ' : ''}${i.title}${i.due ? `  (due ${i.due})` : ''}`);
          if (!r.ranked.length) console.log('(nothing ranked yet: see reinstall-hub inbox, then place)');
          if (r.dropped.length) console.log(`\ndropped ${r.dropped.length} finished task(s) from priorities.md`);
          for (const u of r.unknown) console.log(`warning: ${u} is in priorities.md but not in any connected brain`);
        });
        return 0;
      }
      case 'inbox': {
        const items = inbox(hub, db, { brain: a.value('brain'), limit: a.value('limit') ? Number(a.value('limit')) : undefined });
        out(items, () => {
          for (const i of items) console.log(`${i.key.padEnd(30)} ${i.status === 'blocked' ? '[blocked] ' : ''}${i.title}`);
          console.log(`${items.length} unranked open task(s)`);
        });
        return 0;
      }
      case 'place': {
        const key = pos[0];
        if (!key) throw new Error('usage: reinstall-hub place <brain/id> --top|--bottom|--at N|--above KEY|--below KEY');
        const p: Position = a.flag('top') ? { top: true }
          : a.value('at') ? { at: Number(a.value('at')) }
          : a.value('above') ? { above: a.value('above')! }
          : a.value('below') ? { below: a.value('below')! }
          : { bottom: true };
        const rank = place(hub, db, key, p);
        out({ key, rank }, () => console.log(`${key} is #${rank}`));
        return 0;
      }
      case 'unrank': {
        const ok = unrank(hub, db, pos[0] ?? '');
        out({ removed: ok }, () => console.log(ok ? `removed ${pos[0]}` : `${pos[0]} was not ranked`));
        return 0;
      }
      case 'seed': {
        const added = seedFromLegacy(hub, db);
        out({ added }, () => console.log(`appended ${added.length} task(s) to priorities.md`));
        return 0;
      }
      default:
        process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
        return 2;
    }
  } finally {
    db.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`reinstall-hub: ${(e as Error).message}\n`);
    process.exitCode = 1;
  },
);
