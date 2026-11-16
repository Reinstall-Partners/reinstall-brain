import { statSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openDb, type Db } from './sqlite.js';
import type { Brain } from './brain.js';
import { listMarkdown, readRecordFile, lintFields, type Fields } from './record.js';

export const INDEX_VERSION = 1;

const COLUMNS = [
  'id', 'type', 'title', 'status', 'created', 'scope', 'assignee', 'author', 'delegate', 'updated',
  'parent', 'supersedes', 'superseded_by', 'due', 'completed', 'legacy_id',
] as const;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  mtime REAL NOT NULL,
  size INTEGER NOT NULL,
  record_id TEXT,
  error TEXT
);
CREATE TABLE IF NOT EXISTS records (
  rowid INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  ${COLUMNS.map((c) => `${c} TEXT`).join(',\n  ')},
  importance INTEGER,
  tags TEXT,
  blocked_by TEXT,
  docs TEXT,
  meta TEXT,
  fields TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS records_id ON records(id);
CREATE INDEX IF NOT EXISTS records_type_status ON records(type, status);
CREATE INDEX IF NOT EXISTS records_legacy ON records(legacy_id);
CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(title, body, tags, content='records', content_rowid='rowid');
CREATE TABLE IF NOT EXISTS info (key TEXT PRIMARY KEY, value TEXT);
`;

export interface RefreshResult {
  scanned: number;
  added: number;
  updated: number;
  removed: number;
  errors: { path: string; error: string }[];
}

export function indexPath(brain: Brain): string {
  return path.join(brain.dir, '.local', 'index.db');
}

function ensureLocal(brain: Brain): void {
  const local = path.join(brain.dir, '.local');
  mkdirSync(local, { recursive: true });
  const gi = path.join(brain.dir, '.gitignore');
  if (!existsSync(gi)) writeFileSync(gi, '.local/\n');
}

export async function openIndex(brain: Brain, opts: { rebuild?: boolean } = {}): Promise<Db> {
  ensureLocal(brain);
  const file = indexPath(brain);
  if (opts.rebuild && existsSync(file)) rmSync(file);
  let db = await openDb(file);
  const v = (() => {
    try {
      return db.prepare("SELECT value FROM info WHERE key='index_version'").get()?.value;
    } catch {
      return undefined;
    }
  })();
  if (v !== undefined && String(v) !== String(INDEX_VERSION)) {
    db.close();
    rmSync(file);
    db = await openDb(file);
  }
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec(SCHEMA);
  db.prepare("INSERT OR REPLACE INTO info(key, value) VALUES ('index_version', ?)").run(String(INDEX_VERSION));
  return db;
}

/** Every file that may hold a record, mapped to the type folder it sits in. */
export function recordFiles(brain: Brain): { file: string; typeFromFolder: string; named: boolean }[] {
  const out: { file: string; typeFromFolder: string; named: boolean }[] = [];
  const seen = new Set<string>();
  for (const [type, dir] of brain.typeDirs) {
    const underRecords = dir.startsWith(path.join(brain.dir, 'records') + path.sep);
    for (const file of listMarkdown(dir)) {
      if (seen.has(file)) continue;
      seen.add(file);
      out.push({ file, typeFromFolder: type, named: underRecords });
    }
  }
  return out;
}

function rel(brain: Brain, file: string): string {
  return path.relative(brain.dir, file).split(path.sep).join('/');
}

function toRow(fields: Fields) {
  const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
  return {
    cols: COLUMNS.map((c) => (fields[c] === undefined ? null : String(fields[c]))),
    importance: typeof fields.importance === 'number' ? fields.importance : null,
    tags: json(fields.tags),
    blocked_by: json(fields.blocked_by),
    docs: json(fields.docs),
    meta: json(fields.meta),
  };
}

/** Bring the index up to date with the files: re-read changed files, add new ones, drop deleted ones. */
export function refresh(brain: Brain, db: Db): RefreshResult {
  const result: RefreshResult = { scanned: 0, added: 0, updated: 0, removed: 0, errors: [] };
  const known = new Map<string, { mtime: number; size: number }>();
  for (const r of db.prepare('SELECT path, mtime, size FROM files').all()) {
    known.set(String(r.path), { mtime: Number(r.mtime), size: Number(r.size) });
  }
  const insertRec = db.prepare(
    `INSERT INTO records (path, ${COLUMNS.join(', ')}, importance, tags, blocked_by, docs, meta, fields, body)
     VALUES (?, ${COLUMNS.map(() => '?').join(', ')}, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const deleteRec = db.prepare('DELETE FROM records WHERE path = ?');
  const rowidOf = db.prepare('SELECT rowid, title, body, tags FROM records WHERE path = ?');
  const ftsDelete = db.prepare("INSERT INTO records_fts(records_fts, rowid, title, body, tags) VALUES ('delete', ?, ?, ?, ?)");
  const ftsInsert = db.prepare('INSERT INTO records_fts(rowid, title, body, tags) VALUES (?, ?, ?, ?)');
  const upsertFile = db.prepare('INSERT OR REPLACE INTO files(path, mtime, size, record_id, error) VALUES (?, ?, ?, ?, ?)');
  const deleteFile = db.prepare('DELETE FROM files WHERE path = ?');

  const dropRecord = (p: string) => {
    const old = rowidOf.get(p);
    if (old) {
      ftsDelete.run(old.rowid, old.title ?? '', old.body ?? '', old.tags ?? '');
      deleteRec.run(p);
    }
  };

  db.exec('BEGIN');
  try {
    const present = new Set<string>();
    for (const { file, typeFromFolder } of recordFiles(brain)) {
      result.scanned++;
      const p = rel(brain, file);
      present.add(p);
      const st = statSync(file);
      const prev = known.get(p);
      if (prev && prev.mtime === st.mtimeMs && prev.size === st.size) continue;
      dropRecord(p);
      try {
        const rec = readRecordFile(file);
        const fields = { ...rec.fields };
        if (fields.type === undefined) fields.type = typeFromFolder;
        const row = toRow(fields);
        insertRec.run(p, ...row.cols, row.importance, row.tags, row.blocked_by, row.docs, row.meta, JSON.stringify(fields), rec.body);
        const now = rowidOf.get(p)!;
        ftsInsert.run(now.rowid, now.title ?? '', now.body ?? '', now.tags ?? '');
        upsertFile.run(p, st.mtimeMs, st.size, fields.id === undefined ? null : String(fields.id), null);
      } catch (e) {
        const error = (e as Error).message;
        result.errors.push({ path: p, error });
        upsertFile.run(p, st.mtimeMs, st.size, null, error);
      }
      if (prev) result.updated++;
      else result.added++;
    }
    for (const p of known.keys()) {
      if (!present.has(p)) {
        dropRecord(p);
        deleteFile.run(p);
        result.removed++;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  for (const r of db.prepare('SELECT path, error FROM files WHERE error IS NOT NULL').all()) {
    if (!result.errors.some((x) => x.path === r.path)) result.errors.push({ path: String(r.path), error: String(r.error) });
  }
  return result;
}

export interface LintIssue {
  path: string;
  level: 'error' | 'warning';
  message: string;
}

/** Check every record, plus what only shows across records: duplicate ids and broken links. */
export function lintBrain(brain: Brain, db: Db): LintIssue[] {
  const issues: LintIssue[] = [];
  const types = new Set(brain.typeDirs.keys());
  for (const r of db.prepare('SELECT path, error FROM files WHERE error IS NOT NULL').all()) {
    issues.push({ path: String(r.path), level: 'error', message: String(r.error) });
  }
  const rows = db.prepare('SELECT path, fields FROM records').all();
  const ids = new Set<string>();
  for (const r of rows) {
    const fields = JSON.parse(String(r.fields)) as Fields;
    const p = String(r.path);
    const named = p.startsWith('records/');
    const { errors, warnings } = lintFields(fields, named ? path.posix.basename(p) : undefined, types);
    for (const m of errors) issues.push({ path: p, level: 'error', message: m });
    for (const m of warnings) issues.push({ path: p, level: 'warning', message: m });
    if (fields.id !== undefined) ids.add(String(fields.id));
  }
  for (const d of db.prepare('SELECT id, group_concat(path, \', \') AS paths, count(*) AS n FROM records GROUP BY id HAVING n > 1').all()) {
    issues.push({ path: String(d.paths), level: 'error', message: `id "${d.id}" is used by ${d.n} records` });
  }
  for (const r of rows) {
    const fields = JSON.parse(String(r.fields)) as Fields;
    for (const f of ['parent', 'supersedes', 'superseded_by']) {
      if (fields[f] !== undefined && !ids.has(String(fields[f]))) {
        issues.push({ path: String(r.path), level: 'warning', message: `${f} "${fields[f]}" does not match any record` });
      }
    }
    for (const b of (fields.blocked_by as string[] | undefined) ?? []) {
      if (!ids.has(String(b))) issues.push({ path: String(r.path), level: 'warning', message: `blocked_by "${b}" does not match any record` });
    }
  }
  return issues;
}
