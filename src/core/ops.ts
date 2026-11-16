import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { TEMPLATES } from './templates.gen.js';
import type { Db } from './sqlite.js';
import { type Brain, openBrain } from './brain.js';
import { openIndex, refresh } from './indexer.js';
import { newId, nowIso, slugify, normalizeTags, readRecordFile, writeRecordFile, type Fields, CORE_TYPES } from './record.js';

export interface Opened {
  brain: Brain;
  db: Db;
}

/** Open the brain's index and bring it up to date. Every read goes through this. */
export async function openFresh(brain: Brain, rebuild = false): Promise<Opened & { refreshed: ReturnType<typeof refresh> }> {
  const db = await openIndex(brain, { rebuild });
  const refreshed = refresh(brain, db);
  return { brain, db, refreshed };
}

export interface RecordRow {
  id: string;
  type: string;
  title: string;
  status: string;
  path: string;
  fields: Fields;
  body?: string;
}

function rowToRecord(r: Record<string, unknown>, withBody = false): RecordRow {
  return {
    id: String(r.id),
    type: String(r.type),
    title: String(r.title),
    status: String(r.status),
    path: `brain/${r.path}`,
    fields: JSON.parse(String(r.fields)),
    ...(withBody ? { body: String(r.body) } : {}),
  };
}

/** Find a record by id, or by its legacy id from a migrated system (e.g. `512` or `#512`). */
export function findRecord({ db }: Opened, ref: string): RecordRow | undefined {
  const key = ref.replace(/^#/, '');
  const r =
    db.prepare('SELECT * FROM records WHERE id = ?').get(key) ??
    db.prepare('SELECT * FROM records WHERE legacy_id = ?').get(key);
  return r ? rowToRecord(r, true) : undefined;
}

export interface ListFilter {
  type?: string;
  status?: string;
  tag?: string;
  scope?: string;
  limit?: number;
}

export function listRecords({ db }: Opened, f: ListFilter): RecordRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.type) { where.push('type = ?'); params.push(f.type); }
  if (f.status) { where.push('status = ?'); params.push(f.status); }
  if (f.scope) { where.push('(scope = ? OR scope LIKE ?)'); params.push(f.scope, `${f.scope}/%`); }
  if (f.tag) { where.push('EXISTS (SELECT 1 FROM json_each(records.tags) WHERE value = ?)'); params.push(f.tag.toLowerCase()); }
  const sql = `SELECT * FROM records ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created DESC${f.limit ? ` LIMIT ${Math.floor(f.limit)}` : ''}`;
  return db.prepare(sql).all(...params).map((r) => rowToRecord(r));
}

/** Full-text search. Plain words are matched as prefixes; FTS5 syntax passes through when quoted or using operators. */
export function searchRecords({ db }: Opened, query: string, limit = 25): (RecordRow & { snippet: string })[] {
  const fts = /["*:()]|\b(AND|OR|NOT|NEAR)\b/.test(query)
    ? query
    : query.split(/\s+/).filter(Boolean).map((w) => `"${w.replace(/"/g, '""')}"*`).join(' ');
  const rows = db
    .prepare(
      `SELECT r.*, snippet(records_fts, 1, '[', ']', '…', 12) AS snip
       FROM records_fts JOIN records r ON r.rowid = records_fts.rowid
       WHERE records_fts MATCH ? ORDER BY rank LIMIT ?`,
    )
    .all(fts, limit);
  return rows.map((r) => ({ ...rowToRecord(r), snippet: String(r.snip ?? '') }));
}

/** Read-only SQL over the index. */
export function runSql({ db }: Opened, sql: string): Record<string, unknown>[] {
  if (!/^\s*(select|with|pragma\s+table_info|explain)\b/i.test(sql)) {
    throw new Error('only read queries (SELECT/WITH) are allowed: the index is rebuilt from the files, so writes would be lost. Change the record files instead.');
  }
  return db.prepare(sql).all();
}

export interface NewRecordInput {
  type: string;
  title: string;
  body?: string;
  tags?: string[];
  parent?: string;
  scope?: string;
  author?: string;
  status?: string;
  extra?: Fields;
}

export function createRecord(opened: Opened, input: NewRecordInput): RecordRow {
  const { brain, db } = opened;
  const dir = brain.typeDirs.get(input.type);
  if (!dir) throw new Error(`unknown type "${input.type}". Known: ${[...brain.typeDirs.keys()].join(', ')}`);
  const count = Number(db.prepare('SELECT count(*) AS n FROM records').get()?.n ?? 0);
  const taken = (id: string) =>
    db.prepare('SELECT 1 AS x FROM records WHERE id = ?').get(id) !== undefined ||
    (existsSync(dir) && readdirSync(dir).some((f) => f.startsWith(`${id}-`)));
  const id = newId(taken, count);
  const fields: Fields = {
    id,
    type: input.type,
    title: input.title,
    status: input.status ?? 'active',
    created: nowIso(),
    scope: input.scope,
    tags: input.tags?.length ? normalizeTags(input.tags) : undefined,
    author: input.author,
    parent: input.parent,
    ...(input.extra ?? {}),
  };
  const template = path.join(brain.dir, 'templates', `${input.type}.md`);
  let body = input.body;
  if (body === undefined && existsSync(template)) {
    // Fill the template's placeholder log line ("- YYYY-MM-DD who: created") with the real date and author.
    body = readRecordFile(template).body.replace(/YYYY-MM-DD who:/g, `${String(fields.created).slice(0, 10)} ${input.author ?? 'unknown'}:`);
  }
  const file = path.join(dir, `${id}-${slugify(input.title)}.md`);
  writeRecordFile(file, fields, body ?? '');
  refresh(brain, db);
  return findRecord(opened, id)!;
}

/** Change fields on one record, touching only its file. `undefined` removes a field. */
export function updateRecord(opened: Opened, ref: string, changes: Fields, appendLog?: string, newBody?: string): RecordRow {
  const found = findRecord(opened, ref);
  if (!found) throw new Error(`no record "${ref}"`);
  const file = path.join(opened.brain.root, found.path);
  const rec = readRecordFile(file);
  const fields = { ...rec.fields };
  for (const [k, v] of Object.entries(changes)) {
    if (v === undefined) delete fields[k];
    else if (k === 'meta' && typeof v === 'object' && !Array.isArray(v)) {
      const meta = { ...((fields.meta as Record<string, unknown>) ?? {}) };
      for (const [mk, mv] of Object.entries(v as Record<string, unknown>)) {
        if (mv === undefined) delete meta[mk];
        else meta[mk] = mv;
      }
      if (Object.keys(meta).length) fields.meta = meta;
      else delete fields.meta;
    } else fields[k] = v;
  }
  // No automatic `updated` stamp: it would change on every edit, so any two concurrent edits to the
  // same record would conflict in git. Git history already records when a file changed.
  const now = nowIso();
  if (changes.status === 'done' && fields.completed === undefined) fields.completed = now;
  let body = newBody ?? rec.body;
  if (appendLog) {
    const line = `- ${now.slice(0, 10)} ${appendLog}`;
    body = /^## Log\s*$/m.test(body) ? `${body.replace(/\s+$/, '')}\n${line}` : `${body.replace(/\s+$/, '')}\n\n## Log\n${line}`;
  }
  writeRecordFile(file, fields, body);
  refresh(opened.brain, opened.db);
  return findRecord(opened, String(fields.id))!;
}

/** Record that `newRef` replaces `oldRef`: set both sides of the link and retire the old record. */
export function supersede(opened: Opened, oldRef: string, newRef: string): { old: RecordRow; replacement: RecordRow } {
  const oldRec = findRecord(opened, oldRef);
  const newRec = findRecord(opened, newRef);
  if (!oldRec) throw new Error(`no record "${oldRef}"`);
  if (!newRec) throw new Error(`no record "${newRef}"`);
  const replacement = updateRecord(opened, newRec.id, { supersedes: oldRec.id });
  const old = updateRecord(opened, oldRec.id, { status: 'superseded', superseded_by: newRec.id });
  return { old, replacement };
}

/** Create brain/ in `root` from the shipped templates. Never overwrites existing files. */
export function initBrain(root: string, name: string): { created: string[]; brain: Brain } {
  const dir = path.join(root, 'brain');
  const created: string[] = [];
  const put = (relPath: string, content: string) => {
    const dest = path.join(dir, relPath);
    if (existsSync(dest)) return;
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, content);
    created.push(`brain/${relPath}`);
  };
  put('brain.yaml', TEMPLATES['brain.yaml'].replace('{{name}}', name));
  put('README.md', TEMPLATES['README.md']);
  put('.gitignore', TEMPLATES['gitignore']);
  for (const t of Object.keys(CORE_TYPES)) {
    put(`templates/${t}.md`, TEMPLATES[`templates/${t}.md`]);
    mkdirSync(path.join(dir, 'records', CORE_TYPES[t]), { recursive: true });
  }
  return { created, brain: openBrain(root) };
}

export function defaultBrainName(root: string): string {
  return slugify(path.basename(path.resolve(root))) || 'brain';
}

export interface GoalRow extends RecordRow {
  open_tasks: number;
  done_tasks: number;
}

/** Goals with how many tasks serve each, and the open tasks that serve no goal. */
export function goalsReport({ db }: Opened, opts: { all?: boolean } = {}): { goals: GoalRow[]; unserved: RecordRow[] } {
  const goals = db
    .prepare(`SELECT * FROM records WHERE type = 'goal' ${opts.all ? '' : "AND status IN ('active','blocked')"} ORDER BY created`)
    .all()
    .map((r) => {
      const g = rowToRecord(r) as GoalRow;
      const c = db
        .prepare("SELECT sum(status IN ('active','blocked')) AS open, sum(status = 'done') AS done FROM records WHERE type = 'task' AND json_extract(fields, '$.serves') = ?")
        .get(g.id) as Record<string, unknown>;
      g.open_tasks = Number(c?.open ?? 0);
      g.done_tasks = Number(c?.done ?? 0);
      return g;
    });
  const unserved = db
    .prepare("SELECT * FROM records WHERE type = 'task' AND status IN ('active','blocked') AND json_extract(fields, '$.serves') IS NULL ORDER BY created")
    .all()
    .map((r) => rowToRecord(r));
  return { goals, unserved };
}
