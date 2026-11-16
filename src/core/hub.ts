// A hub is a brain whose brain.yaml lists other brains under `connects`. It adds one thing a brain
// never holds: priorities.md, the owner's strict ranking of tasks across every connected brain.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb, type Db } from './sqlite.js';
import { type Brain, openBrain, locateBrain, expandHome } from './brain.js';
import { openFresh } from './ops.js';

export const OPEN = ['active', 'blocked'];

export interface HubItem {
  key: string;
  brain: string;
  id: string;
  type: string;
  title: string;
  status: string;
  created: string;
  due: string | null;
  assignee: string | null;
  tags: string[];
  file: string;
}

export interface Ranked extends HubItem {
  rank: number;
}

// ---- finding the hub ----

function savedHubFile(): string {
  return path.join(os.homedir(), '.config', 'reinstall-brain', 'hub');
}

/** --hub flag, then REINSTALL_HUB, then the saved hub (`reinstall-hub use`), then the brain here if it is a hub. */
export function locateHub(flag?: string): Brain {
  const candidates = [flag, process.env.REINSTALL_HUB, existsSync(savedHubFile()) ? readFileSync(savedHubFile(), 'utf8').trim() : undefined];
  for (const c of candidates) {
    if (!c) continue;
    const root = locateBrain(expandHome(c));
    if (!root) throw new Error(`no brain at ${c}`);
    const brain = openBrain(root);
    if (!brain.config.connects.length) throw new Error(`${c} is a brain but not a hub: add connects: to its brain.yaml`);
    return brain;
  }
  const here = locateBrain();
  if (here) {
    const brain = openBrain(here);
    if (brain.config.connects.length) return brain;
  }
  throw new Error('no hub found: pass --hub <path>, set REINSTALL_HUB, or run `reinstall-hub use <path>` once');
}

export function saveHub(p: string): string {
  const root = locateBrain(expandHome(p));
  if (!root) throw new Error(`no brain at ${p}`);
  const brain = openBrain(root);
  if (!brain.config.connects.length) throw new Error(`${p} has no connects: in brain.yaml, so it is not a hub`);
  mkdirSync(path.dirname(savedHubFile()), { recursive: true });
  writeFileSync(savedHubFile(), `${brain.root}\n`);
  return brain.root;
}

// ---- the hub index ----

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  key TEXT PRIMARY KEY, brain TEXT NOT NULL, ord INTEGER NOT NULL, id TEXT NOT NULL, type TEXT, title TEXT,
  status TEXT, created TEXT, due TEXT, assignee TEXT, tags TEXT, file TEXT
);
CREATE TABLE IF NOT EXISTS brains (name TEXT PRIMARY KEY, ord INTEGER, root TEXT, records INTEGER, error TEXT);
`;

export interface HubIndexResult {
  brains: { name: string; root: string | null; records: number; error?: string }[];
}

export async function openHubDb(hub: Brain): Promise<Db> {
  mkdirSync(path.join(hub.dir, '.local'), { recursive: true });
  const db = await openDb(path.join(hub.dir, '.local', 'hub.db'));
  db.exec(SCHEMA);
  return db;
}

/** Refresh every connected brain's own index, then copy its records into the hub's index. The hub's own brain counts too. */
export async function indexHub(hub: Brain, db: Db): Promise<HubIndexResult> {
  const result: HubIndexResult = { brains: [] };
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM items; DELETE FROM brains;');
    const ins = db.prepare('INSERT OR REPLACE INTO items VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    const insB = db.prepare('INSERT OR REPLACE INTO brains VALUES (?,?,?,?,?)');
    const sources = [{ name: hub.config.name, path: hub.root }, ...hub.config.connects];
    for (const [ord, c] of sources.entries()) {
      const root = c.path ? locateBrain(expandHome(c.path)) : undefined;
      if (!root || !existsSync(path.join(root, 'brain', 'brain.yaml'))) {
        const error = c.path ? `no brain at ${c.path}` : 'no local path (remote-only brains are not indexed yet)';
        result.brains.push({ name: c.name, root: null, records: 0, error });
        insB.run(c.name, ord, null, 0, error);
        continue;
      }
      const opened = await openFresh(openBrain(root));
      const rows = opened.db.prepare('SELECT id, type, title, status, created, due, assignee, tags, path FROM records').all();
      opened.db.close();
      for (const r of rows) {
        ins.run(`${c.name}/${r.id}`, c.name, ord, String(r.id), r.type, r.title, r.status, r.created, r.due ?? null, r.assignee ?? null, r.tags ?? '[]', path.join(root, String(r.path)));
      }
      result.brains.push({ name: c.name, root, records: rows.length });
      insB.run(c.name, ord, root, rows.length, null);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return result;
}

function toItem(r: Record<string, unknown>): HubItem {
  return {
    key: String(r.key), brain: String(r.brain), id: String(r.id), type: String(r.type), title: String(r.title),
    status: String(r.status), created: String(r.created), due: (r.due as string) ?? null, assignee: (r.assignee as string) ?? null,
    tags: JSON.parse(String(r.tags ?? '[]')), file: String(r.file),
  };
}

// ---- priorities.md ----

export function prioritiesPath(hub: Brain): string {
  return path.join(hub.dir, 'priorities.md');
}

const LINE = /^\s*(?:\d+[.)]|[-*])\s+([a-z0-9-]+\/[^\s]+)/;

export function readPriorities(hub: Brain): string[] {
  const file = prioritiesPath(hub);
  if (!existsSync(file)) return [];
  const keys: string[] = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (m && !keys.includes(m[1])) keys.push(m[1]);
  }
  return keys;
}

export function writePriorities(hub: Brain, keys: string[], titles: Map<string, string>): void {
  const lines = keys.map((k, i) => `${i + 1}. ${k}  ${titles.get(k) ?? ''}`.trimEnd());
  writeFileSync(
    prioritiesPath(hub),
    `# Priorities\n\nLine order is the rank: no two items are equal. Edit by moving lines, or with \`reinstall-hub place\`.\n\n${lines.join('\n')}${lines.length ? '\n' : ''}`,
  );
}

/** The ranked list, with items no longer open dropped from the file. */
export function priorities(hub: Brain, db: Db, opts: { prune?: boolean } = {}): { ranked: Ranked[]; dropped: string[]; unknown: string[] } {
  const keys = readPriorities(hub);
  const get = db.prepare('SELECT * FROM items WHERE key = ?');
  const ranked: Ranked[] = [];
  const dropped: string[] = [];
  const unknown: string[] = [];
  for (const k of keys) {
    const r = get.get(k);
    if (!r) unknown.push(k);
    else if (!OPEN.includes(String(r.status))) dropped.push(k);
    else ranked.push({ ...toItem(r), rank: ranked.length + 1 });
  }
  if (opts.prune && dropped.length) {
    const keep = keys.filter((k) => !dropped.includes(k));
    writePriorities(hub, keep, titleMap(db, keep));
  }
  return { ranked, dropped, unknown };
}

function titleMap(db: Db, keys: string[]): Map<string, string> {
  const get = db.prepare('SELECT title FROM items WHERE key = ?');
  return new Map(keys.map((k) => [k, String(get.get(k)?.title ?? '')]));
}

/** Open tasks in any connected brain that are not ranked yet, in project order, then oldest first. */
export function inbox(hub: Brain, db: Db, opts: { brain?: string; limit?: number } = {}): HubItem[] {
  const ranked = new Set(readPriorities(hub));
  const rows = db
    .prepare(
      `SELECT * FROM items WHERE type = 'task' AND status IN ('active','blocked') ${opts.brain ? 'AND brain = ?' : ''} ORDER BY ord, created`,
    )
    .all(...(opts.brain ? [opts.brain] : []));
  const out = rows.map(toItem).filter((i) => !ranked.has(i.key));
  return opts.limit ? out.slice(0, opts.limit) : out;
}

export type Position = { at: number } | { above: string } | { below: string } | { top: true } | { bottom: true };

/** Put one task at a position in priorities.md (moving it if it is already ranked). */
export function place(hub: Brain, db: Db, key: string, pos: Position): number {
  const item = db.prepare('SELECT * FROM items WHERE key = ?').get(key);
  if (!item) throw new Error(`no item "${key}" in the hub index (run reinstall-hub index, and use <brain>/<id>)`);
  if (item.type !== 'task') throw new Error(`${key} is a ${item.type}; only tasks are ranked`);
  const keys = readPriorities(hub).filter((k) => k !== key);
  let i: number;
  if ('top' in pos) i = 0;
  else if ('bottom' in pos) i = keys.length;
  else if ('at' in pos) i = Math.max(0, Math.min(keys.length, pos.at - 1));
  else {
    const ref = 'above' in pos ? pos.above : pos.below;
    const j = keys.indexOf(ref);
    if (j < 0) throw new Error(`${ref} is not ranked`);
    i = 'above' in pos ? j : j + 1;
  }
  keys.splice(i, 0, key);
  writePriorities(hub, keys, titleMap(db, keys));
  return i + 1;
}

export function unrank(hub: Brain, db: Db, key: string): boolean {
  const keys = readPriorities(hub);
  if (!keys.includes(key)) return false;
  const keep = keys.filter((k) => k !== key);
  writePriorities(hub, keep, titleMap(db, keep));
  return true;
}

/**
 * Seed priorities.md from rankings exported by `reinstall-brain migrate` (brain/.local/legacy-ranking.json):
 * focus items first, then lower priority numbers, then project order. Only open tasks; never reorders what is
 * already ranked, only appends.
 */
export function seedFromLegacy(hub: Brain, db: Db): string[] {
  const existing = readPriorities(hub);
  const candidates: { key: string; focus: number; priority: number; ord: number }[] = [];
  for (const b of db.prepare('SELECT name, ord, root FROM brains WHERE root IS NOT NULL').all()) {
    const f = path.join(String(b.root), 'brain', '.local', 'legacy-ranking.json');
    if (!existsSync(f)) continue;
    for (const r of JSON.parse(readFileSync(f, 'utf8')) as { id: string; focus: number; priority: number | null }[]) {
      const key = `${b.name}/${r.id}`;
      const item = db.prepare('SELECT type, status FROM items WHERE key = ?').get(key);
      if (!item || item.type !== 'task' || !OPEN.includes(String(item.status)) || existing.includes(key)) continue;
      candidates.push({ key, focus: r.focus, priority: r.priority ?? 999, ord: Number(b.ord) });
    }
  }
  candidates.sort((a, b) => b.focus - a.focus || a.priority - b.priority || a.ord - b.ord);
  const added = candidates.map((c) => c.key);
  const keys = [...existing, ...added];
  writePriorities(hub, keys, titleMap(db, keys));
  return added;
}
