#!/usr/bin/env node
import { VERSION } from '../core/version.js';
import { parseArgs } from './args.js';
import {
  locateHub, saveHub, openHubDb, indexHub, priorities, inbox, place, unrank, seedFromLegacy, type Position,
  initHub, connectRepo, disconnectRepo, syncHub, listHubs, readRegistry, goals, placeGoal, unrankGoal, cover,
} from '../core/hub.js';
import { formatWire } from '../core/wire.js';
import { expandHome, locateBrain, openBrain } from '../core/brain.js';

const HELP = `reinstall-hub ${VERSION}: the layer that connects every project's brain.

A hub is a brain whose brain.yaml lists other brains under connects:. Its priorities.md is your
strict ranking of tasks across all of them (line order is the rank).

A machine can have many hubs. A command acts on --hub <name|path>, else the hub folder you are in,
else REINSTALL_HUB, else the default hub (reinstall-hub use).

Usage: reinstall-hub <command> [--hub NAME|PATH] [--json]

Set up
  init [folder] [--name NAME] [--default]   create a hub (or adopt a folder), register it, wire its skills
  connect <repo> [--name NAME]     connect a project repo (sets up its brain if it has none) and wire it
  disconnect <name>                remove a brain from this hub (its own wiring stays)
  sync [--all]                     re-wire this hub (or every hub) and its connected repos
  list                             the hubs on this machine
  use <name|path>                  make a hub the default

Work
  index                            refresh every connected brain and the hub's combined index
  goals                            ranked goals, then unranked open goals, with open tasks serving each
  place-goal <brain/id> --top|--bottom|--at N|--above KEY|--below KEY
  unrank-goal <brain/id>
  cover <hub goal key> <brain/id>  a hub goal covers a project goal or task (uncover to remove)
  priorities [--all]               your ranked tasks (finished ones drop off the file)
  inbox [--brain NAME] [--unserved] [--limit N]   open tasks not ranked yet (--unserved: serving no goal)
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
    if (!pos[0]) throw new Error('usage: reinstall-hub use <name or path>');
    const root = saveHub(pos[0]);
    console.log(`default hub: ${root}`);
    return 0;
  }
  if (cmd === 'list') {
    const hubs = listHubs();
    out(hubs, () => {
      for (const h of hubs) console.log(`${h.default ? '*' : ' '} ${h.name.padEnd(24)} ${h.path}${h.ok ? '' : '   (missing)'}`);
      if (!hubs.length) console.log('(no hubs yet: reinstall-hub init <folder>)');
    });
    return 0;
  }
  if (cmd === 'init') {
    const r = initHub(pos[0] ?? '.', { name: a.value('name'), makeDefault: a.flag('default'), dryRun: a.flag('dry-run') });
    out({ hub: r.hub.config.name, root: r.hub.root, adopted: r.adopted, created: r.created, wired: r.wired }, () => {
      console.log(`${r.adopted ? 'adopted' : 'created'} hub ${r.hub.config.name} at ${r.hub.root}`);
      for (const c of r.created) console.log(`  [create] ${c}`);
      const w = formatWire(r.wired);
      if (w) console.log(w);
      console.log(`\nNext: reinstall-hub connect <repo> for each project, or open this folder with your agent and run /hub.`);
    });
    return 0;
  }
  if (cmd === 'sync' && a.flag('all')) {
    const reg = readRegistry();
    const results: any[] = [];
    for (const h of reg.hubs) {
      const root = locateBrain(expandHome(h.path));
      if (!root) {
        results.push({ hub: h.name, error: `missing (${h.path})` });
        continue;
      }
      results.push(syncHub(openBrain(root)));
    }
    out(results, () => printSync(results));
    return 0;
  }

  const hub = locateHub(a.value('hub'));
  if (cmd === 'connect') {
    if (!pos[0]) throw new Error('usage: reinstall-hub connect <repo folder> [--name NAME]');
    const r = connectRepo(hub, pos[0], { name: a.value('name') });
    out(r, () => {
      console.log(`${r.already ? 'already connected' : 'connected'}: ${r.name} (${r.root})${r.createdBrain ? ', with a new brain' : ''}`);
      const w = formatWire(r.wired);
      if (w) console.log(w);
    });
    return 0;
  }
  if (cmd === 'disconnect') {
    const ok = disconnectRepo(hub, pos[0] ?? '');
    out({ removed: ok }, () => console.log(ok ? `disconnected ${pos[0]} (its own wiring stays; it may belong to another hub)` : `${pos[0]} is not connected to ${hub.config.name}`));
    return ok ? 0 : 1;
  }
  if (cmd === 'sync') {
    const r = syncHub(hub);
    out([r], () => printSync([r]));
    return 0;
  }
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
          for (const i of r.ranked) console.log(`${String(i.rank).padStart(3)}. ${i.key.padEnd(30)} ${i.status === 'blocked' ? '[blocked] ' : ''}${i.title}${i.due ? `  (due ${i.due})` : ''}${i.goal_title ? `  -> ${i.goal_title}` : ''}`);
          if (!r.ranked.length) console.log('(nothing ranked yet: see reinstall-hub inbox, then place)');
          if (r.dropped.length) console.log(`\ndropped ${r.dropped.length} finished task(s) from priorities.md`);
          for (const u of r.unknown) console.log(`warning: ${u} is in priorities.md but not in any connected brain`);
        });
        return 0;
      }
      case 'inbox': {
        let items = inbox(hub, db, { brain: a.value('brain') });
        if (a.flag('unserved')) items = items.filter((i) => !i.goal);
        if (a.value('limit')) items = items.slice(0, Number(a.value('limit')));
        out(items, () => {
          for (const i of items) console.log(`${i.key.padEnd(30)} ${i.status === 'blocked' ? '[blocked] ' : ''}${i.title}${i.goal_title ? `  -> ${i.goal_title}` : ''}`);
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
      case 'goals': {
        const r = goals(hub, db, { prune: true });
        out(r, () => {
          const show = (g: any, lead: string) => console.log(`${lead} ${g.key.padEnd(30)} ${g.title}${g.due ? `  (due ${g.due})` : ''}  [${g.level}, ${g.open_tasks} open task(s)]`);
          for (const g of r.ranked) show(g, `${String(g.rank).padStart(3)}.`);
          if (r.unranked.length) console.log(r.ranked.length ? '\nnot ranked yet:' : 'not ranked yet:');
          for (const g of r.unranked) show(g, '    ');
          if (!r.ranked.length && !r.unranked.length) console.log('(no goals yet: reinstall-brain new goal "<the outcome>" in the hub or a project)');
        });
        return 0;
      }
      case 'place-goal': {
        const key = pos[0];
        if (!key) throw new Error('usage: reinstall-hub place-goal <brain/id> --top|--bottom|--at N|--above KEY|--below KEY');
        const p: Position = a.flag('top') ? { top: true }
          : a.value('at') ? { at: Number(a.value('at')) }
          : a.value('above') ? { above: a.value('above')! }
          : a.value('below') ? { below: a.value('below')! }
          : { bottom: true };
        const rank = placeGoal(hub, db, key, p);
        out({ key, rank }, () => console.log(`${key} is goal #${rank}`));
        return 0;
      }
      case 'unrank-goal': {
        const ok = unrankGoal(hub, db, pos[0] ?? '');
        out({ removed: ok }, () => console.log(ok ? `removed ${pos[0]}` : `${pos[0]} was not ranked`));
        return 0;
      }
      case 'cover':
      case 'uncover': {
        if (pos.length < 2) throw new Error(`usage: reinstall-hub ${cmd} <hub goal key> <brain/id>`);
        const next = await cover(hub, db, pos[0], pos[1], cmd === 'uncover');
        out({ goal: pos[0], covers: next }, () => console.log(`${pos[0]} covers ${next.length ? next.join(', ') : 'nothing'}`));
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

function printSync(results: any[]): void {
  for (const r of results) {
    if (r.error) {
      console.log(`${r.hub}: ${r.error}`);
      continue;
    }
    console.log(`${r.hub}:`);
    for (const l of r.lines) {
      const w = formatWire(l.wired, '    ');
      console.log(`  ${l.where}: ${l.error ?? (w ? 'updated' : 'ok')}`);
      if (w) console.log(w);
    }
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
