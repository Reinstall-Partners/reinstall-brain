// A hub is a brain whose brain.yaml lists other brains under `connects`. It adds one thing a brain
// never holds: the owner's ranking. Projects are ranked by the order of connects:, goals and pinned
// tasks by priorities.md; every other open task takes its place from those (see priorities()).

import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseDocument, type Document } from 'yaml';
import path from 'node:path';
import os from 'node:os';
import { openDb, type Db } from './sqlite.js';
import { type Brain, openBrain, locateBrain, expandHome } from './brain.js';
import { openFresh, initBrain, defaultBrainName, findRecord, updateRecord } from './ops.js';
import { readRecordFile, writeRecordFile, slugify, type Fields } from './record.js';
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
  /** A module that owns this task (e.g. a finance tool): place it, but never drop or finish it from the hub. */
  managed_by: string | null;
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
  /** A hand-placed task (a line in priorities.md): it goes ahead of the derived order. */
  pinned: boolean;
  /** The plan this task is a phase of (`<brain>:<plan path>`), when it has one. */
  plan: string | null;
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
  /** The dev folder: the one folder this machine keeps its project repos in (see devFolder). */
  dev?: string;
  hubs: HubEntry[];
}

/** Where this machine's list of hubs lives; REINSTALL_BRAIN_CONFIG_DIR moves it (tests, throwaway runs). */
function configDir(): string {
  return process.env.REINSTALL_BRAIN_CONFIG_DIR || path.join(os.homedir(), '.config', 'reinstall-brain');
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
    // .native also expands Windows 8.3 short names (RUNNER~1), so two spellings of a folder compare equal.
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

export function readRegistry(): Registry {
  let reg: Registry = { hubs: [] };
  try {
    const raw = JSON.parse(readFileSync(registryFile(), 'utf8'));
    reg = { default: raw.default ? String(raw.default) : undefined, dev: raw.dev ? String(raw.dev) : undefined, hubs: Array.isArray(raw.hubs) ? raw.hubs.map((h: any) => ({ name: String(h.name), path: String(h.path) })) : [] };
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

/** Take a hub off this machine's list (its folder is not touched). Returns the entry removed, if any. */
export function forgetHub(nameOrPath: string): { name: string; path: string } | undefined {
  const reg = readRegistry();
  const target = realOr(expandHome(nameOrPath));
  const i = reg.hubs.findIndex((h) => h.name === nameOrPath || realOr(expandHome(h.path)) === target);
  if (i < 0) return undefined;
  const [gone] = reg.hubs.splice(i, 1);
  if (reg.default && (reg.default === gone.path || realOr(expandHome(reg.default)) === realOr(expandHome(gone.path)))) reg.default = undefined;
  writeRegistry(reg);
  return gone;
}

/** Registered hubs whose connects: list this folder (so their next sync would wire it again). */
export function hubsConnecting(root: string): string[] {
  const out: string[] = [];
  const me = realOr(root);
  for (const h of readRegistry().hubs) {
    const hr = locateBrain(expandHome(h.path));
    if (!hr) continue;
    try {
      const hub = openBrain(hr);
      if (hub.config.connects.some((c) => c.path && realOr(connectPath(hub, c.path)) === me)) out.push(h.name);
    } catch {}
  }
  return out;
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

/**
 * The dev folder: the one folder this machine keeps its project repos in, side by side. REINSTALL_DEV,
 * else the one saved with `reinstall-hub dev <folder>`, else ~/dev. `set` says whether it was chosen.
 */
export function devFolder(): { path: string; set: boolean; exists: boolean } {
  const chosen = process.env.REINSTALL_DEV || readRegistry().dev;
  const p = path.resolve(expandHome(chosen || '~/dev'));
  return { path: p, set: !!chosen, exists: existsSync(p) };
}

/** Save the dev folder for this machine. It must exist. */
export function setDevFolder(dir: string): string {
  const abs = path.resolve(expandHome(dir));
  if (!existsSync(abs)) throw new Error(`no folder at ${dir}`);
  const reg = readRegistry();
  reg.dev = tildePath(abs);
  writeRegistry(reg);
  return abs;
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
  /** When the hub names a kit (`kit:` in its brain.yaml) and this repo does not have it yet: the command to install it. */
  kit: { install: string } | null;
}

/**
 * A hub may name a toolkit its projects use, in brain.yaml:
 *   kit:
 *     install: node ~/path/to/kit/install.mjs   # run inside a project
 *     marker: .claude/kit-installed.json         # a file that exists once it is installed
 * connect then reports a repo that lacks it, so the owner can install it there.
 */
function kitFor(hub: Brain, root: string): { install: string } | null {
  try {
    const doc = parseDocument(readFileSync(path.join(hub.dir, 'brain.yaml'), 'utf8')).toJS() as { kit?: { install?: string; marker?: string } };
    const k = doc?.kit;
    if (!k?.install) return null;
    if (k.marker && existsSync(path.join(root, k.marker))) return null;
    return { install: String(k.install) };
  } catch {
    return null;
  }
}

/** Connect a project repo to a hub: set up its brain if it has none, list it in connects:, and wire it. */
export function connectRepo(hub: Brain, repo: string, opts: { name?: string } = {}): ConnectResult {
  let abs = path.resolve(expandHome(repo));
  // A bare name that is not a folder here is a repo in the dev folder: `connect web-app`.
  if (!existsSync(abs) && !/[\\/]/.test(repo) && existsSync(path.join(devFolder().path, repo))) abs = path.join(devFolder().path, repo);
  if (!existsSync(abs)) throw new Error(`no folder at ${repo}`);
  const root = locateBrain(abs) ?? abs;
  let createdBrain = false;
  if (!existsSync(path.join(root, 'brain', 'brain.yaml'))) {
    initBrain(root, defaultBrainName(root));
    createdBrain = true;
  }
  const brain = openBrain(root);
  if (realOr(root) === realOr(hub.root)) throw new Error('a hub cannot connect itself: its own brain is always included');
  const existing = hub.config.connects.find((c) => c.path && realOr(connectPath(hub, c.path)) === realOr(root));
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
  return { name, root, createdBrain, already: !!existing, wired, kit: kitFor(hub, root) };
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
    const root = c.path ? locateBrain(connectPath(hub, c.path)) : undefined;
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
  measure TEXT, done_when TEXT, plan TEXT, plan_id TEXT, plan_brain TEXT, managed_by TEXT, ranking TEXT, project TEXT
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
/** A connected brain's folder: `~` is the home folder, and a relative path is relative to the hub's folder. */
export function connectPath(hub: Brain, p: string): string {
  return path.resolve(hub.root, expandHome(p));
}

export async function indexHub(hub: Brain, db: Db): Promise<HubIndexResult> {
  const result: HubIndexResult = { brains: [] };
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM items; DELETE FROM brains;');
    const ins = db.prepare('INSERT OR REPLACE INTO items VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const insB = db.prepare('INSERT OR REPLACE INTO brains VALUES (?,?,?,?,?)');
    const sources = [{ name: hub.config.name, path: hub.root }, ...hub.config.connects];
    for (const [ord, c] of sources.entries()) {
      const root = c.path ? locateBrain(connectPath(hub, c.path)) : undefined;
      if (!root || !existsSync(path.join(root, 'brain', 'brain.yaml'))) {
        const error = c.path ? `no brain at ${c.path}` : 'no local path (remote-only brains are not indexed yet)';
        result.brains.push({ name: c.name, root: null, records: 0, error });
        insB.run(c.name, ord, null, 0, error);
        continue;
      }
      const opened = await openFresh(openBrain(root));
      const rows = opened.db.prepare("SELECT id, type, title, status, created, due, assignee, tags, path, json_extract(fields, '$.serves') AS serves, json_extract(fields, '$.covers') AS covers, json_extract(fields, '$.measure') AS measure, json_extract(fields, '$.done_when') AS done_when, json_extract(meta, '$.plan_path') AS plan, json_extract(meta, '$.plan_id') AS plan_id, json_extract(meta, '$.plan_brain') AS plan_brain, json_extract(fields, '$.managed_by') AS managed_by, json_extract(fields, '$.ranking') AS ranking, json_extract(fields, '$.project') AS project FROM records").all();
      opened.db.close();
      for (const r of rows) {
        ins.run(`${c.name}/${r.id}`, c.name, ord, String(r.id), r.type, r.title, r.status, r.created, r.due ?? null, r.assignee ?? null, r.tags ?? '[]', path.join(root, 'brain', String(r.path)), r.serves ?? null, r.covers ?? null, r.measure ?? null, r.done_when ?? null, r.plan ?? null, r.plan_id == null ? null : String(r.plan_id), r.plan_brain ?? null, r.managed_by ?? null, r.ranking == null ? null : String(r.ranking), r.project ?? null);
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
    managed_by: (r.managed_by as string) ?? null,
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
export function goals(hub: Brain, db: Db, opts: { prune?: boolean } = {}): { ranked: (GoalItem & { rank: number })[]; unranked: GoalItem[]; not_ranked: GoalItem[]; dropped: string[] } {
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
  const open = all.filter((r) => OPEN.includes(String(r.status)) && !rankedKeys.has(String(r.key)));
  // `ranking: off` on a goal: the owner keeps it out of the hub's ranking on purpose (a personal goal,
  // say), so it is not listed as waiting to be ranked.
  const off = (r: Record<string, unknown>) => ['off', 'false', 'no'].includes(String(r.ranking ?? '').toLowerCase());
  const unranked = open.filter((r) => !off(r)).map(toGoal);
  const not_ranked = open.filter(off).map(toGoal);
  return { ranked, unranked, not_ranked, dropped };
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
const HEADER = '# Priorities\n\nGoals are ranked here (line order is the rank). Tasks under `## Tasks` are pinned ahead of the derived\norder (project, goal, plan, due date). Edit by moving lines, or with `reinstall-hub place-goal` and\n`reinstall-hub place`. Projects are ranked by the order of `connects:` in brain.yaml.\n';

/**
 * priorities.md holds an optional `## Goals` section (ranked goals) and the pinned tasks (under
 * `## Tasks`, or before any heading). Any other `##` section is the owner's own: it is not read as
 * a ranking, and it is kept as written when the file is rewritten.
 */
export function readPrioritiesFile(hub: Brain): { goals: string[]; tasks: string[]; extra: string } {
  const file = prioritiesPath(hub);
  const out = { goals: [] as string[], tasks: [] as string[], extra: '' };
  if (!existsSync(file)) return out;
  let section: 'goals' | 'tasks' | 'other' = 'tasks';
  const extra: string[] = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      section = /^goals$/i.test(h[1]) ? 'goals' : /^(tasks|pinned( tasks)?)$/i.test(h[1]) ? 'tasks' : 'other';
      if (section === 'other') extra.push(line);
      continue;
    }
    if (section === 'other') { extra.push(line); continue; }
    const m = LINE.exec(line);
    if (m && !out[section].includes(m[1])) out[section].push(m[1]);
  }
  out.extra = extra.join('\n').replace(/\s+$/, '');
  return out;
}

export function writePrioritiesFile(hub: Brain, lists: { goals: string[]; tasks: string[]; extra?: string }, titles: Map<string, string>): void {
  const fmt = (keys: string[]) => keys.map((k, i) => `${i + 1}. ${k}  ${titles.get(k) ?? ''}`.trimEnd()).join('\n');
  const extra = lists.extra ?? readPrioritiesFile(hub).extra;
  let text = HEADER;
  if (lists.goals.length) text += `\n## Goals\n\n${fmt(lists.goals)}\n\n## Tasks\n`;
  text += lists.tasks.length ? `\n${fmt(lists.tasks)}\n` : '';
  if (extra) text += `\n${extra}\n`;
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

/**
 * The order of every open task (D1 of the hub's design): pinned tasks first, in the order of
 * priorities.md; then everything else, derived, by
 *   1. project order (`connects:` in file order). A task in the hub's own brain ranks as the project it
 *      is for: its `project:` field, else the plan folder it belongs to when that names a project
 *      (`brain/plans/<project>/…`); one for no project comes after every project,
 *   2. the rank of the goal the task rolls up to (ranked goals first, then unranked goals, then none),
 *   3. its plan: a plan's open phases stay together, in phase order, placed by the plan's earliest
 *      due date and then its first open phase's age; a task outside any plan is a group of one,
 *   4. due date, then age.
 * Finished pins are dropped from the file with `prune`.
 */
export function priorities(hub: Brain, db: Db, opts: { prune?: boolean } = {}): { ranked: Ranked[]; dropped: string[]; unknown: string[] } {
  const keys = readPriorities(hub);
  const get = db.prepare('SELECT * FROM items WHERE key = ?');
  const gm = goalMap(hub, db);
  const dropped: string[] = [];
  const unknown: string[] = [];
  const pins: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const k of keys) {
    const pk = parsePlanKey(k);
    if (pk) {
      // A pinned plan brings its open phases, in phase order.
      const phases = planTasks(db, pk.brain, pk.path);
      if (!phases.length) dropped.push(k);
      for (const r of phases) if (!seen.has(String(r.key))) { seen.add(String(r.key)); pins.push(r); }
      continue;
    }
    const r = get.get(k);
    if (!r) unknown.push(k);
    else if (r.type !== 'task' || !OPEN.includes(String(r.status))) dropped.push(k);
    else if (!seen.has(k)) { seen.add(k); pins.push(r); }
  }
  if (opts.prune && dropped.length) {
    const keep = keys.filter((k) => !dropped.includes(k));
    writePriorities(hub, keep, titleMap(db, keep));
  }
  const pinned = new Set(pins.map((r) => String(r.key)));
  const rest = derivedOrder(hub, db, gm).filter((r) => !pinned.has(String(r.key)));
  const ranked = [...pins.map((r) => ({ r, pinned: true })), ...rest.map((r) => ({ r, pinned: false }))].map(({ r, pinned: p }, i) => ({
    ...toItem(r, gm), rank: i + 1, pinned: p, plan: planKey(r),
  }));
  return { ranked, dropped, unknown };
}

/** `<brain>:<plan path>`, where brain holds the plan file: meta.plan_brain when a task lives in another
 * brain than its plan (a plan in one repo with work in others), else the task's own brain. */
function planKey(r: Record<string, unknown>): string | null {
  return r.plan ? `${r.plan_brain ?? r.brain}:${r.plan}` : null;
}

// ---- plans as one item: `<brain>/plan:<plan path>` in priorities.md pins a whole plan ----

export function parsePlanKey(k: string): { brain: string; path: string } | null {
  const m = /^([a-z0-9-]+)\/plan:(.+)$/.exec(k);
  return m ? { brain: m[1], path: m[2] } : null;
}

/** A plan's open tasks, in phase order. */
function planTasks(db: Db, brain: string, planPath: string): Record<string, unknown>[] {
  const rows = db.prepare("SELECT * FROM items WHERE type = 'task' AND status IN ('active','blocked') AND plan = ? AND coalesce(plan_brain, brain) = ?").all(planPath, brain);
  const NONE = Number.MAX_SAFE_INTEGER;
  return rows.sort((a, b) => (phaseNumber(String(a.title)) ?? NONE) - (phaseNumber(String(b.title)) ?? NONE) || String(a.created).localeCompare(String(b.created)));
}

/** `<brain>/plan:<id or path>` -> `<brain>/plan:<path>`, the form priorities.md keeps; throws when no open task has that plan. */
export function resolvePlanKey(db: Db, k: string): string {
  const pk = parsePlanKey(k);
  if (!pk) throw new Error(`${k} is not a plan key (use <brain>/plan:<plan id or path>)`);
  const row = db.prepare("SELECT plan FROM items WHERE coalesce(plan_brain, brain) = ? AND plan IS NOT NULL AND (plan = ? OR plan_id = ?) AND type = 'task' AND status IN ('active','blocked') LIMIT 1").get(pk.brain, pk.path, pk.path);
  if (!row) throw new Error(`no open task in ${pk.brain} belongs to plan "${pk.path}"`);
  return `${pk.brain}/plan:${row.plan}`;
}

function planTitle(db: Db, brain: string, planPath: string): { title: string; file: string | null } {
  const b = db.prepare('SELECT root FROM brains WHERE name = ?').get(brain);
  const file = b?.root ? path.join(String(b.root), planPath) : null;
  if (file && existsSync(file)) {
    const h = /^#\s+(?:Plan:\s*)?(.+)$/m.exec(readFileSync(file, 'utf8'));
    if (h) return { title: h[1].trim(), file };
  }
  return { title: path.basename(planPath, '.md'), file };
}

export interface PlanRow {
  kind: 'plan';
  key: string;
  brain: string;
  plan: string;
  title: string;
  file: string | null;
  open_phases: number;
  /** The plan's first open phase: the actionable task. */
  next: HubItem;
  goal: string | null;
  goal_title: string | null;
  hub_goal: string | null;
  hub_goal_title: string | null;
}
export type InboxRow = PlanRow | (HubItem & { kind: 'task' });

/** The inbox with each plan folded into one row (its next open phase, and how many are open). */
export function inboxByPlan(hub: Brain, db: Db, opts: { brain?: string } = {}): InboxRow[] {
  const items = inbox(hub, db, opts);
  const rows = db.prepare("SELECT key, brain, plan, plan_brain FROM items WHERE plan IS NOT NULL AND type = 'task'").all();
  const planOf = new Map(rows.map((r) => [String(r.key), { key: planKey(r)!, brain: String(r.plan_brain ?? r.brain), path: String(r.plan) }]));
  const out: InboxRow[] = [];
  const done = new Set<string>();
  for (const i of items) {
    const p = planOf.get(i.key);
    if (!p) { out.push({ ...i, kind: 'task' }); continue; }
    const key = `${p.brain}/plan:${p.path}`;
    if (done.has(key)) continue;
    done.add(key);
    const t = planTitle(db, p.brain, p.path);
    out.push({
      kind: 'plan', key, brain: p.brain, plan: p.path, title: t.title, file: t.file,
      open_phases: items.filter((x) => planOf.get(x.key)?.key === p.key).length, next: i,
      goal: i.goal, goal_title: i.goal_title, hub_goal: i.hub_goal, hub_goal_title: i.hub_goal_title,
    });
  }
  return out;
}

/** "Plan 004 Phase 3: …" -> 3 (also 3b -> 3.5); null when the title names no phase. */
export function phaseNumber(title: string): number | null {
  const m = /\bphase\s+(\d+)([a-z])?\b/i.exec(title);
  if (!m) return null;
  return Number(m[1]) + (m[2] ? (m[2].toLowerCase().charCodeAt(0) - 96) / 10 : 0);
}

/** Every open task in the derived order (no pins): see priorities(). */
function derivedOrder(hub: Brain, db: Db, gm: GoalMap): Record<string, unknown>[] {
  const rows = db.prepare("SELECT * FROM items WHERE type = 'task' AND status IN ('active','blocked')").all();
  const goalRank = new Map(readPrioritiesFile(hub).goals.map((k, i) => [k, i]));
  const NONE = Number.MAX_SAFE_INTEGER;
  // Project rank from the live connects: list (the index may predate a reorder).
  const projectRank = new Map<string, number>(hub.config.connects.map((c, i) => [c.name, i] as [string, number]));
  const rankOfProject = (r: Record<string, unknown>): number => {
    if (r.brain !== hub.config.name) return projectRank.get(String(r.brain)) ?? NONE;
    // The hub's own tasks rank as the project they are for, so reordering projects moves them too.
    const scope = typeof r.plan === 'string' ? /^brain\/plans\/([^/]+)\//.exec(r.plan)?.[1] : undefined;
    const p = [r.project as string | undefined, scope].find((n) => n && projectRank.has(n));
    return p ? projectRank.get(p)! : hub.config.connects.length;
  };
  const rankOf = (r: Record<string, unknown>): number => {
    const g = gm.resolve(String(r.key), String(r.brain), (r.serves as string) ?? null);
    const ranked = [g.hub_goal, g.goal].map((k) => (k ? goalRank.get(k) : undefined)).find((x) => x !== undefined);
    if (ranked !== undefined) return ranked;
    return g.goal || g.hub_goal ? NONE - 1 : NONE;
  };
  // A plan's phases form one group, placed by the group's earliest due date, then its oldest phase.
  const groups = new Map<string, { due: string; created: string }>();
  const groupOf = (r: Record<string, unknown>) => planKey(r) ?? `task:${r.key}`;
  for (const r of rows) {
    const g = groupOf(r);
    const due = (r.due as string) || '9999';
    const cur = groups.get(g);
    groups.set(g, { due: cur && cur.due < due ? cur.due : due, created: cur && cur.created < String(r.created) ? cur.created : String(r.created) });
  }
  const keyed = rows.map((r) => {
    const g = groupOf(r);
    const gi = groups.get(g)!;
    return { r, k: [rankOfProject(r), rankOf(r), gi.due, gi.created, g, phaseNumber(String(r.title)) ?? NONE, (r.due as string) || '9999', String(r.created)] as (number | string)[] };
  });
  keyed.sort((a, b) => {
    for (let i = 0; i < a.k.length; i++) if (a.k[i] !== b.k[i]) return a.k[i] < b.k[i] ? -1 : 1;
    return 0;
  });
  return keyed.map((x) => x.r);
}

// ---- pace: a goal's measure_cmd, run and logged ----

export interface PaceRow {
  key: string;
  title: string;
  file: string;
  measure: string | null;
  measure_cmd: string | null;
  /** The last line of the goal's ## Pace section. */
  last: string | null;
  /** With run: what measure_cmd printed (one line), or the error. */
  reading?: string;
  error?: string;
}

/** The goal template's example line, which the first real reading replaces. */
const PACE_PLACEHOLDER = /^\s*-\s*YYYY-MM-DD\b/;

/** Append `- <line>` at the end of a body's `## Pace` section (adding the section when missing). */
export function appendPace(body: string, line: string): string {
  const lines = body.replace(/\s+$/, '').split('\n').filter((l) => !PACE_PLACEHOLDER.test(l));
  const at = lines.findIndex((l) => /^##\s+Pace\s*$/.test(l));
  if (at < 0) return `${lines.join('\n')}\n\n## Pace\n- ${line}\n`;
  let end = at + 1;
  while (end < lines.length && !/^##\s/.test(lines[end])) end++;
  while (end > at + 1 && lines[end - 1].trim() === '') end--;
  lines.splice(end, 0, `- ${line}`);
  return `${lines.join('\n')}\n`;
}

function lastPace(body: string): string | null {
  const m = /^##\s+Pace\s*$([\s\S]*?)(?=^##\s|$(?![\s\S]))/m.exec(body);
  const items = (m?.[1] ?? '').split('\n').filter((l) => /^\s*-\s/.test(l) && !PACE_PLACEHOLDER.test(l));
  return items.length ? items[items.length - 1].replace(/^\s*-\s*/, '') : null;
}

/**
 * Every open goal (ranked first) with its measure, measure_cmd and latest Pace line. With run, each
 * measure_cmd runs in its brain's repo (it is the owner's own command, from the owner's own brains),
 * and its output is appended to the goal's ## Pace as today's reading.
 */
export async function pace(hub: Brain, db: Db, opts: { run?: boolean; author?: string } = {}): Promise<PaceRow[]> {
  const g = goals(hub, db);
  const all = [...g.ranked, ...g.unranked];
  const rows: PaceRow[] = [];
  const today = new Date().toISOString().slice(0, 10);
  for (const goal of all) {
    const rec = readRecordFile(goal.file);
    const cmd = rec.fields.measure_cmd ? String(rec.fields.measure_cmd) : null;
    const row: PaceRow = { key: goal.key, title: goal.title, file: goal.file, measure: goal.measure, measure_cmd: cmd, last: lastPace(rec.body) };
    if (opts.run && cmd) {
      const root = db.prepare('SELECT root FROM brains WHERE name = ?').get(goal.brain)?.root as string | undefined;
      try {
        const outp = execFileSync(process.platform === 'win32' ? 'cmd' : 'sh', process.platform === 'win32' ? ['/c', cmd] : ['-c', cmd], { cwd: root ?? hub.root, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
        const reading = outp.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join('; ').slice(0, 300);
        row.reading = reading || '(no output)';
        const b = openBrain(root ?? hub.root);
        const o = await openFresh(b);
        try {
          updateRecord(o, goal.id, {}, undefined, appendPace(rec.body, `${today}: ${row.reading} (measure_cmd${opts.author ? `, ${opts.author}` : ''})`));
        } finally {
          o.db.close();
        }
      } catch (e) {
        row.error = String((e as { stderr?: string }).stderr || (e as Error).message).trim().split('\n')[0].slice(0, 200);
      }
    }
    rows.push(row);
  }
  return rows;
}

// ---- moving a record between brains ----

export interface MoveResult {
  from: string;
  to: string;
  file: string;
  covers: string[];
  pinned: boolean;
}

/**
 * Move a record to another connected brain, keeping its id: write it there, mark the source
 * dropped with a pointer, and repoint the hub (goal covers:, pins). Links that cannot resolve in
 * the target become notes in the body: a parent, a goal it serves. A plan link stays resolvable
 * through meta.plan_brain. Goals are not moved (their tasks would lose them).
 */
export async function moveRecord(hub: Brain, db: Db, key: string, toBrain: string, opts: { author?: string } = {}): Promise<MoveResult> {
  const item = db.prepare('SELECT * FROM items WHERE key = ?').get(key);
  if (!item) throw new Error(`no item "${key}" in the hub index (use <brain>/<id>)`);
  const from = String(item.brain);
  const id = String(item.id);
  if (from === toBrain) throw new Error(`${key} is already in ${toBrain}`);
  if (item.type === 'goal') throw new Error(`${key} is a goal; goals are not moved (the tasks serving it would lose it)`);
  const target = db.prepare('SELECT root FROM brains WHERE name = ?').get(toBrain);
  if (!target?.root) throw new Error(`no readable brain "${toBrain}" in this hub (see reinstall-hub status)`);
  const source = db.prepare('SELECT root FROM brains WHERE name = ?').get(from);
  if (!source?.root) throw new Error(`the brain "${from}" is not readable here`);
  const to = openBrain(String(target.root));
  const dir = to.typeDirs.get(String(item.type));
  if (!dir) throw new Error(`${toBrain} has no "${item.type}" type`);
  if (db.prepare('SELECT 1 FROM items WHERE brain = ? AND id = ?').get(toBrain, id)) throw new Error(`${toBrain} already has a record with id ${id}`);

  const who = opts.author ?? 'reinstall-hub move';
  const today = new Date().toISOString().slice(0, 10);
  const rec = readRecordFile(String(item.file));
  const fields: Fields = { ...rec.fields };
  const notes: string[] = [`Moved from ${from} on ${today}.`];
  if (fields.parent !== undefined) {
    notes.push(`Its parent there is ${from}/${fields.parent}.`);
    delete fields.parent;
  }
  if (fields.serves !== undefined) {
    notes.push(`It served the goal ${from}/${fields.serves} there.`);
    delete fields.serves;
  }
  const meta = (fields.meta && typeof fields.meta === 'object' ? { ...(fields.meta as Fields) } : undefined);
  if (meta && meta.plan_path !== undefined && meta.plan_brain === undefined) meta.plan_brain = from;
  if (meta) fields.meta = meta;
  let body = rec.body.replace(/^\n*/, '');
  body = `\n${notes.join(' ')}\n\n${body}`;
  const logLine = `- ${today} ${who}: moved here from ${key}`;
  body = /^## Log\s*$/m.test(body) ? `${body.replace(/\s*$/, '')}\n${logLine}\n` : `${body.replace(/\s*$/, '')}\n\n## Log\n${logLine}\n`;
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}-${slugify(String(fields.title))}.md`);
  writeRecordFile(file, fields, body);

  const src = await openFresh(openBrain(String(source.root)));
  try {
    updateRecord(src, id, { status: 'dropped' }, `${who}: moved to ${toBrain}/${id}`);
  } finally {
    src.db.close();
  }

  // Repoint the hub: goal covers: lists and pins.
  const newKey = `${toBrain}/${id}`;
  const covers: string[] = [];
  const goalsHere = db.prepare("SELECT id, key, covers FROM items WHERE brain = ? AND type = 'goal'").all(hub.config.name)
    .filter((g) => (JSON.parse(String(g.covers ?? '[]')) as string[]).includes(key));
  if (goalsHere.length) {
    const h = await openFresh(hub);
    try {
      for (const g of goalsHere) {
        const next = (JSON.parse(String(g.covers)) as string[]).map((k) => (k === key ? newKey : k));
        updateRecord(h, String(g.id), { covers: next });
        covers.push(String(g.key));
      }
    } finally {
      h.db.close();
    }
  }
  const file0 = readPrioritiesFile(hub);
  const pinned = file0.tasks.includes(key);
  if (pinned) {
    const tasks = file0.tasks.map((k) => (k === key ? newKey : k));
    const titles = titleMap(db, [...file0.goals, ...tasks]);
    titles.set(newKey, String(fields.title));
    writePrioritiesFile(hub, { goals: file0.goals, tasks }, titles);
  }
  return { from: key, to: newKey, file, covers, pinned };
}

// ---- projects: the order of connects: is the project ranking ----

export interface ProjectItem {
  name: string;
  rank: number;
  path: string | null;
  open_tasks: number;
  pins: number;
  error: string | null;
}

/** The projects in rank order (the hub's own brain is not one of them), with their open and pinned task counts. */
export function projects(hub: Brain, db: Db): ProjectItem[] {
  const pins = new Set(readPriorities(hub));
  const count = db.prepare("SELECT key FROM items WHERE brain = ? AND type = 'task' AND status IN ('active','blocked')");
  const err = db.prepare('SELECT error FROM brains WHERE name = ?');
  return hub.config.connects.map((c, i) => {
    const keys = count.all(c.name).map((r) => String(r.key));
    return { name: c.name, rank: i + 1, path: c.path ?? null, open_tasks: keys.length, pins: keys.filter((k) => pins.has(k)).length, error: (err.get(c.name)?.error as string) ?? null };
  });
}

/** Move a project in connects: (its rank). Returns its new rank and the pins that still go ahead of the derived order. */
export function placeProject(hub: Brain, db: Db, name: string, pos: Position): { rank: number; pins: string[] } {
  const names = hub.config.connects.map((c) => c.name);
  if (!names.includes(name)) throw new Error(`no project "${name}" in this hub (see reinstall-hub projects)`);
  const others = names.filter((n) => n !== name);
  const i = positionIndex(others, pos);
  others.splice(i, 0, name);
  editYaml(hub, (doc) => {
    const seq = doc.get('connects') as any;
    const items = [...seq.items];
    const byName = new Map(items.map((n: any) => [n.get('name'), n]));
    seq.items = others.map((n) => byName.get(n));
  });
  hub.config.connects = others.map((n) => hub.config.connects.find((c) => c.name === n)!);
  return { rank: i + 1, pins: readPriorities(hub) };
}

function titleMap(db: Db, keys: string[]): Map<string, string> {
  const get = db.prepare('SELECT title FROM items WHERE key = ?');
  return new Map(keys.map((k) => {
    const pk = parsePlanKey(k);
    return [k, pk ? `(plan) ${planTitle(db, pk.brain, pk.path).title}` : String(get.get(k)?.title ?? '')];
  }));
}

/** Open tasks that are not pinned, in the derived order (see priorities()). */
export function inbox(hub: Brain, db: Db, opts: { brain?: string; limit?: number } = {}): HubItem[] {
  const keys = readPriorities(hub);
  const pinned = new Set(keys);
  const pinnedPlans = new Set(keys.map(parsePlanKey).filter(Boolean).map((p) => `${p!.brain}:${p!.path}`));
  const gm = goalMap(hub, db);
  const out = derivedOrder(hub, db, gm)
    .filter((r) => !pinned.has(String(r.key)) && !pinnedPlans.has(planKey(r) ?? '') && (!opts.brain || r.brain === opts.brain))
    .map((r) => toItem(r, gm));
  return opts.limit ? out.slice(0, opts.limit) : out;
}

export type Position = { at: number } | { above: string } | { below: string } | { top: true } | { bottom: true };

/** Put one task at a position in priorities.md (moving it if it is already ranked). */
export function place(hub: Brain, db: Db, key: string, pos: Position): number {
  if (parsePlanKey(key)) {
    const canonical = resolvePlanKey(db, key);
    const keys = readPriorities(hub).filter((k) => k !== canonical);
    const i = positionIndex(keys, pos);
    keys.splice(i, 0, canonical);
    writePriorities(hub, keys, titleMap(db, keys));
    return i + 1;
  }
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
  if (parsePlanKey(key) && !keys.includes(key)) {
    try { key = resolvePlanKey(db, key); } catch { /* finished plan: match by the key as given */ }
  }
  if (!keys.includes(key)) return false;
  const keep = keys.filter((k) => k !== key);
  writePriorities(hub, keep, titleMap(db, keep));
  return true;
}

