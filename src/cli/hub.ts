#!/usr/bin/env node
import { VERSION } from '../core/version.js';
import { parseArgs } from './args.js';
import {
  locateHub, saveHub, openHubDb, indexHub, priorities, inbox, place, unrank, type Position,
  initHub, connectRepo, disconnectRepo, syncHub, listHubs, readRegistry, goals, placeGoal, unrankGoal, cover,
  projects, placeProject, inboxByPlan, moveRecord, pace,
} from '../core/hub.js';
import { formatWire } from '../core/wire.js';
import { expandHome, locateBrain, openBrain } from '../core/brain.js';

const HELP = `reinstall-hub ${VERSION}: the layer that connects every project's brain.

A hub is a brain whose brain.yaml lists other brains under connects:. You rank projects (the order
of connects:) and goals; every open task then takes its place: project, then goal, then plan
(phases together, in order), then due date and age. Pin a task (place) to put it ahead of that.

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
  pace [--run] [--author WHO]      each goal's latest Pace line; --run runs each goal's measure_cmd and
                                   appends today's reading to its Pace
  place-goal <brain/id> --top|--bottom|--at N|--above KEY|--below KEY
  unrank-goal <brain/id>
  cover <hub goal key> <brain/id>  a hub goal covers a project goal or task (uncover to remove)
  move <brain/id> <to-brain> [--author WHO]   move a record to another brain (keeps its id; the hub follows)
  projects                         your projects in rank order, with open and pinned tasks
  place-project <name> --top|--bottom|--at N|--above NAME|--below NAME [--drop-pins]
  priorities [--pins] [--limit N]  every open task in order, pins first (--pins: only the pins)
  inbox [--brain NAME] [--unserved] [--limit N] [--flat]   what is not pinned, in order: each plan is one row
                                   (its next open phase); --flat lists every task; --unserved: serving no goal
  place <brain/id> --top|--bottom|--at N|--above KEY|--below KEY   pin a task ahead of the derived order
  place <brain>/plan:<id|path> …   pin a whole plan (its open phases, in order)
  unrank <brain/id>                unpin a task
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
      if (r.kit) console.log(`[kit] this hub's kit is not installed there yet. To install it: cd ${r.root} && ${r.kit.install}`);
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
        if (a.flag('pins')) r.ranked = r.ranked.filter((i) => i.pinned);
        if (a.value('limit')) r.ranked = r.ranked.slice(0, Number(a.value('limit')));
        out(r, () => {
          for (const i of r.ranked) console.log(`${String(i.rank).padStart(3)}.${i.pinned ? '*' : ' '} ${i.key.padEnd(30)} ${i.status === 'blocked' ? '[blocked] ' : ''}${i.title}${i.due ? `  (due ${i.due})` : ''}${i.goal_title ? `  -> ${i.goal_title}` : ''}`);
          if (!r.ranked.length) console.log(a.flag('pins') ? '(nothing pinned: the order comes from projects, goals and plans)' : '(no open tasks)');
          else if (r.ranked.some((i) => i.pinned)) console.log('\n* pinned (reinstall-hub unrank <key> to unpin)');
          if (r.dropped.length) console.log(`\ndropped ${r.dropped.length} finished task(s) from priorities.md`);
          for (const u of r.unknown) console.log(`warning: ${u} is in priorities.md but not in any connected brain`);
        });
        return 0;
      }
      case 'inbox': {
        if (a.flag('flat')) {
          let items = inbox(hub, db, { brain: a.value('brain') });
          if (a.flag('unserved')) items = items.filter((i) => !i.goal);
          if (a.value('limit')) items = items.slice(0, Number(a.value('limit')));
          out(items, () => {
            for (const i of items) console.log(`${i.key.padEnd(30)} ${i.status === 'blocked' ? '[blocked] ' : ''}${i.title}${i.goal_title ? `  -> ${i.goal_title}` : ''}`);
            console.log(`${items.length} open task(s), not pinned`);
          });
          return 0;
        }
        let rows = inboxByPlan(hub, db, { brain: a.value('brain') });
        if (a.flag('unserved')) rows = rows.filter((i) => !i.goal);
        if (a.value('limit')) rows = rows.slice(0, Number(a.value('limit')));
        out(rows, () => {
          for (const i of rows) {
            if (i.kind === 'plan') console.log(`${i.key.padEnd(30)} [plan, ${i.open_phases} open] ${i.title}\n${''.padEnd(32)}next: ${i.next.key} ${i.next.title}${i.goal_title ? `  -> ${i.goal_title}` : ''}`);
            else console.log(`${i.key.padEnd(30)} ${i.status === 'blocked' ? '[blocked] ' : ''}${i.title}${i.goal_title ? `  -> ${i.goal_title}` : ''}`);
          }
          console.log(`${rows.length} item(s) not pinned: ${rows.filter((r) => r.kind === 'plan').length} plan(s), ${rows.filter((r) => r.kind === 'task').length} task(s)`);
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
      case 'projects': {
        const r = projects(hub, db);
        out(r, () => {
          for (const p of r) console.log(`${String(p.rank).padStart(3)}. ${p.name.padEnd(28)} ${String(p.open_tasks).padStart(4)} open${p.pins ? `, ${p.pins} pinned` : ''}${p.error ? `   ${p.error}` : ''}`);
        });
        return 0;
      }
      case 'place-project': {
        const name = pos[0];
        if (!name) throw new Error('usage: reinstall-hub place-project <name> --top|--bottom|--at N|--above NAME|--below NAME [--drop-pins]');
        const p: Position = a.flag('top') ? { top: true }
          : a.value('at') ? { at: Number(a.value('at')) }
          : a.value('above') ? { above: a.value('above')! }
          : a.value('below') ? { below: a.value('below')! }
          : { bottom: true };
        const r = placeProject(hub, db, name, p);
        let pins = r.pins;
        if (a.flag('drop-pins') && pins.length) {
          for (const k of pins) unrank(hub, db, k);
          pins = [];
        }
        out({ name, rank: r.rank, pins }, () => {
          console.log(`${name} is project #${r.rank}`);
          if (pins.length) console.log(`${pins.length} pinned task(s) still go ahead of the new order: ${pins.join(', ')}\n(reinstall-hub unrank <key>, or re-run with --drop-pins)`);
        });
        return 0;
      }
      case 'goals': {
        const r = goals(hub, db, { prune: true });
        out(r, () => {
          const show = (g: any, lead: string) => console.log(`${lead} ${g.key.padEnd(30)} ${g.title}${g.due ? `  (due ${g.due})` : ''}  [${g.level}, ${g.open_tasks} open task(s)]`);
          for (const g of r.ranked) show(g, `${String(g.rank).padStart(3)}.`);
          if (r.unranked.length) console.log(r.ranked.length ? '\nnot ranked yet:' : 'not ranked yet:');
          for (const g of r.unranked) show(g, '    ');
          if (r.not_ranked.length) console.log(`\nkept out of the ranking (ranking: off): ${r.not_ranked.map((g: any) => g.title).join('; ')}`);
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
      case 'pace': {
        const r = await pace(hub, db, { run: a.flag('run'), author: a.value('author') });
        out(r, () => {
          for (const p of r) {
            console.log(`${p.key.padEnd(30)} ${p.title}`);
            if (p.reading !== undefined) console.log(`${''.padEnd(32)}now: ${p.reading}  (added to its Pace)`);
            else if (p.error) console.log(`${''.padEnd(32)}measure_cmd failed: ${p.error}`);
            console.log(`${''.padEnd(32)}last: ${p.last ?? '(no Pace line yet)'}`);
            if (p.measure_cmd && !a.flag('run')) console.log(`${''.padEnd(32)}measure_cmd: ${p.measure_cmd}  (pace --run runs it)`);
            else if (!p.measure_cmd) console.log(`${''.padEnd(32)}measure: ${p.measure ?? '(none)'}  (read by hand; add measure_cmd to compute it)`);
          }
        });
        return r.some((p) => p.error) ? 1 : 0;
      }
      case 'move': {
        if (pos.length < 2) throw new Error('usage: reinstall-hub move <brain/id> <to-brain> [--author WHO]');
        const r = await moveRecord(hub, db, pos[0], pos[1], { author: a.value('author') });
        out(r, () => {
          console.log(`moved ${r.from} -> ${r.to}  (${r.file})`);
          if (r.covers.length) console.log(`  repointed in ${r.covers.join(', ')}`);
          if (r.pinned) console.log('  repointed its pin in priorities.md');
        });
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
