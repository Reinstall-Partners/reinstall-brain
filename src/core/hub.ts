// A hub is a brain whose brain.yaml lists other brains under `connects`. It adds one thing a brain
// never holds: priorities.md, the owner's strict ranking of tasks across every connected brain.

import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseDocument, type Document } from 'yaml';
import path from 'node:path';
import os from 'node:os';
import { openDb, type Db } from './sqlite.js';
import { type Brain, openBrain, locateBrain, expandHome } from './brain.js';
import { openFresh, initBrain, defaultBrainName, findRecord, updateRecord } from './ops.js';
import { wire, type WireLine } from './wire.js';

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
  /** The goal this task serves: a project goal (by serves:) or else a hub goal that covers it. */
  goal: string | null;
  goal_title: string | null;
  /** The hub goal this task rolls up to, directly or through its project goal. */
  hub_goal: string | null;
  hub_goal_title: string | null;
}

export interface GoalItem extends HubItem {
  level: 'hub' | 'project';
  measure: string | null;
  done_when: string | null;
  covers: string[];
  open_tasks: number;
}

export interface Ranked extends HubItem {
  rank: number;
}

// ---- the machine's hubs (D20: many hubs on one machine) ----
//
// ~/.config/reinstall-brain/hubs.json: { "default": "<path>", "hubs": [{ "name", "path" }] }.
// `reinstall-hub init` registers a hub; `reinstall-hub use` sets the default.

export interface HubEntry {
  name: string;
  path: string;
}

interface Registry {
  default?: string;
  hubs: HubEntry[];
}

function configDir(): string {
  return path.join(os.homedir(), '.config', 'reinstall-brain');
}

function registryFile(): string {
  return path.join(configDir(), 'hubs.json');
}

/** The old single-hub file, read once and folded into the registry. */
function legacyHubFile(): string {
  return path.join(configDir(), 'hub');
}

function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export function readRegistry(): Registry {
  let reg: Registry = { hubs: [] };
  try {
    const raw = JSON.parse(readFileSync(registryFile(), 'utf8'));
    reg = { default: raw.default ? String(raw.default) : undefined, hubs: Array.isArray(raw.hubs) ? raw.hubs.map((h: any) => ({ name: String(h.name), path: String(h.path) })) : [] };
  } catch {
    /* none yet */
  }
  if (existsSync(legacyHubFile())) {
    const p = readFileSync(legacyHubFile(), 'utf8').trim();
    if (p && !reg.hubs.some((h) => realOr(expandHome(h.path)) === realOr(expandHome(p)))) {
      try {
        reg.hubs.push({ name: openBrain(p).config.name, path: p });
      } catch {
        /* the old hub is gone */
      }
    }
    reg.default ??= p;
  }
  return reg;
}

function writeRegistry(reg: Registry): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(registryFile(), `${JSON.stringify(reg, null, 2)}\n`);
  if (existsSync(legacyHubFile())) rmSync(legacyHubFile());
}

export function tildePath(p: string): string {
  const home = os.homedir();
  const abs = path.resolve(p);
  return abs === home ? '~' : abs.startsWith(home + path.sep) ? `~/${path.relative(home, abs).split(path.sep).join('/')}` : abs;
}

export function registerHub(hub: Brain, opts: { makeDefault?: boolean } = {}): Registry {
  const reg = readRegistry();
  const at = realOr(hub.root);
  const existing = reg.hubs.find((h) => realOr(expandHome(h.path)) === at);
  if (existing) existing.name = hub.config.name;
  else reg.hubs.push({ name: hub.config.name, path: tildePath(hub.root) });
  if (opts.makeDefault || !reg.default) reg.default = tildePath(hub.root);
  writeRegistry(reg);
  return reg;
}

export function listHubs(): (HubEntry & { default: boolean; ok: boolean })[] {
  const reg = readRegistry();
  const def = reg.default ? realOr(expandHome(reg.default)) : undefined;
  return reg.hubs.map((h) => {
    const root = realOr(expandHome(h.path));
    return { ...h, default: root === def, ok: existsSync(path.join(root, 'brain', 'brain.yaml')) };
  });
}

function openHub(root: string, said: string): Brain {
  const brain = openBrain(root);
  if (!brain.config.hub) throw new Error(`${said} is a brain but not a hub (run reinstall-hub init there to make it one)`);
  return brain;
}

/**
 * Which hub a command acts on: --hub (a registered hub's name, or a path), then the hub folder you are
 * in, then REINSTALL_HUB, then the default hub, then the only registered hub.
 */
export function locateHub(flag?: string, cwd: string = process.cwd()): Brain {
  const reg = readRegistry();
  const byName = (n: string) => reg.hubs.find((h) => h.name === n);
  if (flag) {
    const p = byName(flag)?.path ?? flag;
    const root = locateBrain(expandHome(p));
    if (!root) throw new Error(`no hub named or at ${flag} (see reinstall-hub list)`);
    return openHub(root, flag);
  }
  const here = locateBrain(cwd);
  if (here) {
    const brain = openBrain(here);
    if (brain.config.hub) return brain;
  }
  for (const c of [process.env.REINSTALL_HUB, reg.default, reg.hubs.length === 1 ? reg.hubs[0].path : undefined]) {
    if (!c) continue;
    const p = byName(c)?.path ?? c;
    const root = locateBrain(expandHome(p));
    if (!root) throw new Error(`no hub at ${c} (see reinstall-hub list)`);
    return openHub(root, c);
  }
  throw new Error(reg.hubs.length ? 'more than one hub on this machine: run this inside a hub, pass --hub <name>, or set a default with reinstall-hub use <name>' : 'no hub yet: reinstall-hub init <folder> creates one');
}

/** Make a registered hub (by name or path) the default. */
export function saveHub(p: string): string {
  const reg = readRegistry();
  const target = reg.hubs.find((h) => h.name === p)?.path ?? p;
  const root = locateBrain(expandHome(target));
  if (!root) throw new Error(`no hub named or at ${p}`);
  const hub = openHub(root, p);
  registerHub(hub, { makeDefault: true });
  return hub.root;
}

// ---- creating a hub and connecting repos ----

function editYaml(brain: Brain, fn: (doc: Document) => void): void {
  const file = path.join(brain.dir, 'brain.yaml');
  const doc = parseDocument(readFileSync(file, 'utf8'));
  fn(doc);
  writeFileSync(file, String(doc));
}

function isGitRepo(dir: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export interface HubInitResult {
  hub: Brain;
  created: string[];
  wired: WireLine[];
  adopted: boolean;
}

/** Create a hub in `dir` (a new folder, or an existing repo or brain), register it, and wire it. */
export function initHub(dir: string, opts: { name?: string; makeDefault?: boolean; dryRun?: boolean } = {}): HubInitResult {
  const root = path.resolve(expandHome(dir));
  mkdirSync(root, { recursive: true });
  if (!isGitRepo(root)) execFileSync('git', ['init', '-q', root]);
  const adopted = existsSync(path.join(root, 'brain', 'brain.yaml'));
  const { created } = initBrain(root, opts.name ?? defaultBrainName(root));
  let hub = openBrain(root);
  if (!hub.config.hub || !/^hub:\s*true\s*$/m.test(readFileSync(path.join(hub.dir, 'brain.yaml'), 'utf8'))) {
    editYaml(hub, (doc) => {
      doc.set('hub', true);
      if (!doc.has('connects')) doc.set('connects', doc.createNode([]));
    });
    hub = openBrain(root);
  }
  const wired = wire(root, 'hub', { dryRun: opts.dryRun });
  registerHub(hub, { makeDefault: opts.makeDefault });
  return { hub, created, wired, adopted };
}

export interface ConnectResult {
  name: string;
  root: string;
  createdBrain: boolean;
  already: boolean;
  wired: WireLine[];
}

/** Connect a project repo to a hub: set up its brain if it has none, list it in connects:, and wire it. */
export function connectRepo(hub: Brain, repo: string, opts: { name?: string } = {}): ConnectResult {
  const abs = path.resolve(expandHome(repo));
  if (!existsSync(abs)) throw new Error(`no folder at ${repo}`);
  const root = locateBrain(abs) ?? abs;
  let createdBrain = false;
  if (!existsSync(path.join(root, 'brain', 'brain.yaml'))) {
    initBrain(root, defaultBrainName(root));
    createdBrain = true;
  }
  const brain = openBrain(root);
  if (realOr(root) === realOr(hub.root)) throw new Error('a hub cannot connect itself: its own brain is always included');
  const existing = hub.config.connects.find((c) => c.path && realOr(expandHome(c.path)) === realOr(root));
  let name = existing?.name ?? opts.name ?? brain.config.name;
  if (!existing) {
    const taken = new Set(hub.config.connects.map((c) => c.name).concat(hub.config.name));
    if (taken.has(name)) {
      if (opts.name) throw new Error(`${name} is already a name in this hub: pass a different --name`);
      let i = 2;
      while (taken.has(`${name}-${i}`)) i++;
      name = `${name}-${i}`;
    }
    editYaml(hub, (doc) => {
      if (!doc.has('connects')) doc.set('connects', doc.createNode([]));
      const seq = doc.get('connects') as any;
      seq.add(doc.createNode({ name, path: tildePath(root) }));
    });
  }
  const wired = wire(root, 'brain');
  return { name, root, createdBrain, already: !!existing, wired };
}

/** Remove a brain from the hub's connects:. Its own wiring stays: it may belong to another hub. */
export function disconnectRepo(hub: Brain, name: string): boolean {
  if (!hub.config.connects.some((c) => c.name === name)) return false;
  editYaml(hub, (doc) => {
    const seq = doc.get('connects') as any;
    const i = seq.items.findIndex((it: any) => it.get && it.get('name') === name);
    if (i >= 0) seq.delete(i);
  });
  return true;
}

export interface SyncResult {
  hub: string;
  lines: { where: string; wired: WireLine[]; error?: string }[];
}

/** Re-wire a hub and every connected repo that is on this machine. */
export function syncHub(hub: Brain): SyncResult {
  const lines: SyncResult['lines'] = [{ where: hub.config.name, wired: wire(hub.root, 'hub') }];
  for (const c of hub.config.connects) {
    const root = c.path ? locateBrain(expandHome(c.path)) : undefined;
    if (!root) {
      lines.push({ where: c.name, wired: [], error: c.path ? `not on this machine (${c.path})` : 'no local path' });
      continue;
    }
    try {
      lines.push({ where: c.name, wired: wire(root, 'brain') });
    } catch (e) {
      lines.push({ where: c.name, wired: [], error: (e as Error).message });
    }
  }
  return { hub: hub.config.name, lines };
}

// ---- the hub index ----

const SCHEMA = `
DROP TABLE IF EXISTS items;
CREATE TABLE items (
  key TEXT PRIMARY KEY, brain TEXT NOT NULL, ord INTEGER NOT NULL, id TEXT NOT NULL, type TEXT, title TEXT,
  status TEXT, created TEXT, due TEXT, assignee TEXT, tags TEXT, file TEXT, serves TEXT, covers TEXT,
  measure TEXT, done_when TEXT
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
    const ins = db.prepare('INSERT OR REPLACE INTO items VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
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
      const rows = opened.db.prepare("SELECT id, type, title, status, created, due, assignee, tags, path, json_extract(fields, '$.serves') AS serves, json_extract(fields, '$.covers') AS covers, json_extract(fields, '$.measure') AS measure, json_extract(fields, '$.done_when') AS done_when FROM records").all();
      opened.db.close();
      for (const r of rows) {
        ins.run(`${c.name}/${r.id}`, c.name, ord, String(r.id), r.type, r.title, r.status, r.created, r.due ?? null, r.assignee ?? null, r.tags ?? '[]', path.join(root, 'brain', String(r.path)), r.serves ?? null, r.covers ?? null, r.measure ?? null, r.done_when ?? null);
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

function toItem(r: Record<string, unknown>, goals?: GoalMap): HubItem {
  const item: HubItem = {
    key: String(r.key), brain: String(r.brain), id: String(r.id), type: String(r.type), title: String(r.title),
    status: String(r.status), created: String(r.created), due: (r.due as string) ?? null, assignee: (r.assignee as string) ?? null,
    tags: JSON.parse(String(r.tags ?? '[]')), file: String(r.file), goal: null, goal_title: null, hub_goal: null, hub_goal_title: null,
  };
  if (goals) {
    const g = goals.resolve(item.key, item.brain, (r.serves as string) ?? null);
    Object.assign(item, g);
  }
  return item;
}

// ---- goals (D21-D23): a task serves one goal in its own brain; a hub goal covers project work by key ----

interface GoalMap {
  resolve(key: string, brain: string, serves: string | null): Pick<HubItem, 'goal' | 'goal_title' | 'hub_goal' | 'hub_goal_title'>;
}

function goalMap(hub: Brain, db: Db): GoalMap {
  const titles = new Map<string, string>();
  for (const g of db.prepare("SELECT key, title FROM items WHERE type = 'goal'").all()) titles.set(String(g.key), String(g.title));
  const coveredBy = new Map<string, string>();
  for (const g of db.prepare("SELECT key, covers FROM items WHERE type = 'goal' AND brain = ? AND status IN ('active','blocked') ORDER BY created").all(hub.config.name)) {
    for (const k of JSON.parse(String(g.covers ?? '[]')) as string[]) if (!coveredBy.has(k)) coveredBy.set(k, String(g.key));
  }
  return {
    resolve(key, brain, serves) {
      const projectGoal = serves ? `${brain}/${serves}` : null;
      let hubGoal = coveredBy.get(key) ?? (projectGoal ? coveredBy.get(projectGoal) : undefined) ?? null;
      if (!hubGoal && projectGoal && brain === hub.config.name) hubGoal = projectGoal; // a task in the hub serving a hub goal
      const goal = projectGoal ?? hubGoal;
      return {
        goal,
        goal_title: goal ? titles.get(goal) ?? null : null,
        hub_goal: hubGoal,
        hub_goal_title: hubGoal ? titles.get(hubGoal) ?? null : null,
      };
    },
  };
}

/** Every open goal (the hub's own and each connected brain's), ranked ones first, with how many open tasks serve each. */
export function goals(hub: Brain, db: Db, opts: { prune?: boolean } = {}): { ranked: (GoalItem & { rank: number })[]; unranked: GoalItem[]; dropped: string[] } {
  const gm = goalMap(hub, db);
  const tasks = db.prepare("SELECT * FROM items WHERE type = 'task' AND status IN ('active','blocked')").all().map((r) => toItem(r, gm));
  const toGoal = (r: Record<string, unknown>): GoalItem => {
    const base = toItem(r);
    const key = base.key;
    return {
      ...base,
      level: base.brain === hub.config.name ? 'hub' : 'project',
      measure: (r.measure as string) ?? null,
      done_when: (r.done_when as string) ?? null,
      covers: JSON.parse(String(r.covers ?? '[]')),
      open_tasks: tasks.filter((t) => t.goal === key || t.hub_goal === key).length,
    };
  };
  const all = db.prepare("SELECT * FROM items WHERE type = 'goal' ORDER BY ord, created").all();
  const byKey = new Map(all.map((r) => [String(r.key), r]));
  const file = readPrioritiesFile(hub);
  const ranked: (GoalItem & { rank: number })[] = [];
  const dropped: string[] = [];
  for (const k of file.goals) {
    const r = byKey.get(k);
    if (!r || !OPEN.includes(String(r.status))) dropped.push(k);
    else ranked.push({ ...toGoal(r), rank: ranked.length + 1 });
  }
  if (opts.prune && dropped.length) writePrioritiesFile(hub, { goals: file.goals.filter((k) => !dropped.includes(k)), tasks: file.tasks }, titleMap(db, [...file.goals, ...file.tasks]));
  const rankedKeys = new Set(file.goals);
  const unranked = all.filter((r) => OPEN.includes(String(r.status)) && !rankedKeys.has(String(r.key))).map(toGoal);
  return { ranked, unranked, dropped };
}

/** Put a goal at a position in the Goals section of priorities.md. */
export function placeGoal(hub: Brain, db: Db, key: string, pos: Position): number {
  const item = db.prepare('SELECT * FROM items WHERE key = ?').get(key);
  if (!item) throw new Error(`no item "${key}" in the hub index (use <brain>/<id>)`);
  if (item.type !== 'goal') throw new Error(`${key} is a ${item.type}, not a goal: use reinstall-hub place for tasks`);
  const file = readPrioritiesFile(hub);
  const keys = file.goals.filter((k) => k !== key);
  const i = positionIndex(keys, pos);
  keys.splice(i, 0, key);
  writePrioritiesFile(hub, { goals: keys, tasks: file.tasks }, titleMap(db, [...keys, ...file.tasks]));
  return i + 1;
}

export function unrankGoal(hub: Brain, db: Db, key: string): boolean {
  const file = readPrioritiesFile(hub);
  if (!file.goals.includes(key)) return false;
  const keep = file.goals.filter((k) => k !== key);
  writePrioritiesFile(hub, { goals: keep, tasks: file.tasks }, titleMap(db, [...keep, ...file.tasks]));
  return true;
}

/** Link a hub goal to project work (a project goal or a task) by key. The project's brain is not touched. */
export async function cover(hub: Brain, db: Db, goalKey: string, target: string, remove = false): Promise<string[]> {
  const g = db.prepare('SELECT * FROM items WHERE key = ?').get(goalKey);
  if (!g || g.type !== 'goal' || g.brain !== hub.config.name) throw new Error(`${goalKey} is not a goal in this hub's own brain (hub goals live in the hub; see reinstall-hub goals)`);
  if (!remove && !db.prepare('SELECT 1 FROM items WHERE key = ?').get(target)) throw new Error(`no item "${target}" in the hub index (use <brain>/<id>)`);
  const opened = await openFresh(hub);
  try {
    const rec = findRecord(opened, String(g.id));
    const cur = ((rec?.fields.covers as string[] | undefined) ?? []).filter((k) => k !== target);
    const next = remove ? cur : [...cur, target];
    updateRecord(opened, String(g.id), { covers: next.length ? next : undefined });
    return next;
  } finally {
    opened.db.close();
  }
}


// ---- priorities.md ----

export function prioritiesPath(hub: Brain): string {
  return path.join(hub.dir, 'priorities.md');
}

const LINE = /^\s*(?:\d+[.)]|[-*])\s+([a-z0-9-]+\/[^\s]+)/;
const HEADER = '# Priorities\n\nLine order is the rank: no two items are equal. Edit by moving lines, or with `reinstall-hub place` (tasks) and `reinstall-hub place-goal` (goals).\n';

/** priorities.md holds an optional `## Goals` section (ranked goals) and the ranked tasks (under `## Tasks`, or anywhere else). */
export function readPrioritiesFile(hub: Brain): { goals: string[]; tasks: string[] } {
  const file = prioritiesPath(hub);
  const out = { goals: [] as string[], tasks: [] as string[] };
  if (!existsSync(file)) return out;
  let section: 'goals' | 'tasks' = 'tasks';
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      section = /^goals$/i.test(h[1]) ? 'goals' : 'tasks';
      continue;
    }
    const m = LINE.exec(line);
    if (m && !out[section].includes(m[1])) out[section].push(m[1]);
  }
  return out;
}

export function writePrioritiesFile(hub: Brain, lists: { goals: string[]; tasks: string[] }, titles: Map<string, string>): void {
  const fmt = (keys: string[]) => keys.map((k, i) => `${i + 1}. ${k}  ${titles.get(k) ?? ''}`.trimEnd()).join('\n');
  let text = HEADER;
  if (lists.goals.length) text += `\n## Goals\n\n${fmt(lists.goals)}\n\n## Tasks\n`;
  text += lists.tasks.length ? `\n${fmt(lists.tasks)}\n` : '';
  writeFileSync(prioritiesPath(hub), text);
}

export function readPriorities(hub: Brain): string[] {
  return readPrioritiesFile(hub).tasks;
}

export function writePriorities(hub: Brain, keys: string[], titles: Map<string, string>): void {
  const goalsNow = readPrioritiesFile(hub).goals;
  const all = new Map(titles);
  for (const [k, v] of goalTitlesFromFile(hub)) if (!all.has(k)) all.set(k, v);
  writePrioritiesFile(hub, { goals: goalsNow, tasks: keys }, all);
}

function goalTitlesFromFile(hub: Brain): Map<string, string> {
  const out = new Map<string, string>();
  const file = prioritiesPath(hub);
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*\d+[.)]\s+([a-z0-9-]+\/\S+)\s+(.*)$/.exec(line);
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

function positionIndex(keys: string[], pos: Position): number {
  if ('top' in pos) return 0;
  if ('bottom' in pos) return keys.length;
  if ('at' in pos) return Math.max(0, Math.min(keys.length, pos.at - 1));
  const ref = 'above' in pos ? pos.above : pos.below;
  const j = keys.indexOf(ref);
  if (j < 0) throw new Error(`${ref} is not ranked`);
  return 'above' in pos ? j : j + 1;
}

/** The ranked list, with items no longer open dropped from the file. */
export function priorities(hub: Brain, db: Db, opts: { prune?: boolean } = {}): { ranked: Ranked[]; dropped: string[]; unknown: string[] } {
  const keys = readPriorities(hub);
  const get = db.prepare('SELECT * FROM items WHERE key = ?');
  const gm = goalMap(hub, db);
  const ranked: Ranked[] = [];
  const dropped: string[] = [];
  const unknown: string[] = [];
  for (const k of keys) {
    const r = get.get(k);
    if (!r) unknown.push(k);
    else if (!OPEN.includes(String(r.status))) dropped.push(k);
    else ranked.push({ ...toItem(r, gm), rank: ranked.length + 1 });
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
  const gm = goalMap(hub, db);
  const out = rows.map((r) => toItem(r, gm)).filter((i) => !ranked.has(i.key));
  return opts.limit ? out.slice(0, opts.limit) : out;
}

export type Position = { at: number } | { above: string } | { below: string } | { top: true } | { bottom: true };

/** Put one task at a position in priorities.md (moving it if it is already ranked). */
export function place(hub: Brain, db: Db, key: string, pos: Position): number {
  const item = db.prepare('SELECT * FROM items WHERE key = ?').get(key);
  if (!item) throw new Error(`no item "${key}" in the hub index (run reinstall-hub index, and use <brain>/<id>)`);
  if (item.type !== 'task') throw new Error(`${key} is a ${item.type}; only tasks are ranked`);
  const keys = readPriorities(hub).filter((k) => k !== key);
  const i = positionIndex(keys, pos);
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
