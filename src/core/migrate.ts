// Migrate a TB Claude Kit brain (cowork/brain/BRAIN.db, table `logs`) to Reinstall Brain records.
// One-time tool: reads the old database, never writes to it.

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, renameSync, rmdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { openDb } from './sqlite.js';
import { type Brain } from './brain.js';
import { CORE_TYPES, newId, normalizeTags, slugify, formatRecord, type Fields } from './record.js';

export interface MigrateOptions {
  /** Path to the old BRAIN.db. */
  from: string;
  /** Write nothing; return the report. */
  dryRun?: boolean;
  /** git mv cowork/plans -> brain/plans and cowork/research -> brain/research. */
  moveDocs?: boolean;
}

export interface MigrateReport {
  source: string;
  sourceCounts: Record<string, number>;
  migratedCounts: Record<string, number>;
  records: number;
  skipped: { legacy_id: string; reason: string }[];
  unresolvedLinks: { legacy_id: string; field: string; target: string }[];
  /** Catch-up runs: records refreshed because the old row changed after the last migration. */
  updated: string[];
  /** Old row and record both changed since the last migration: left alone, needs a person. */
  conflicts: { legacy_id: string; id: string; path: string }[];
  rankingExported: number;
  swarmRowsExported: Record<string, number>;
  docsMoved: string[];
  pathRewrites: number;
  written: boolean;
}

const OLD_TO_NEW_PATHS: [RegExp, string][] = [
  [/cowork\/plans\//g, 'brain/plans/'],
  [/cowork\/research\//g, 'brain/research/'],
];

function rewritePaths(text: string): { text: string; n: number } {
  let n = 0;
  let out = text;
  for (const [re, to] of OLD_TO_NEW_PATHS) out = out.replace(re, () => (n++, to));
  return { text: out, n };
}

/**
 * Old timestamps come in three shapes. "YYYY-MM-DD HH:MM:SS" is SQLite's datetime('now'): UTC.
 * "YYYY-MM-DDTHH:MM:SS" with no zone was written with strftime(..., 'localtime'): local time.
 * Anything carrying Z or an offset is already exact.
 */
export function convertTimestamp(raw: unknown): string | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  const s = String(raw).trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) return s.replace(' ', 'T');
  const m = /^(\d{4}-\d{2}-\d{2})(?:([ T])(\d{2}:\d{2}(?::\d{2})?))?/.exec(s);
  if (!m) return s;
  const [, date, sep, time] = m;
  if (!time) return date;
  const t = time.length === 5 ? `${time}:00` : time;
  if (sep === ' ') return `${date}T${t}Z`;
  const local = new Date(`${date}T${t}`);
  const off = -local.getTimezoneOffset();
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return `${date}T${t}${off >= 0 ? '+' : '-'}${pad(off / 60)}:${pad(off % 60)}`;
}

const DOC_KEYS = ['plan_path', 'summary', 'folder', 'breakout_plan_path', 'also_plan_path', 'also_plan_path_2'];

export async function migrateBrain(brain: Brain, opts: MigrateOptions): Promise<MigrateReport> {
  const report: MigrateReport = {
    source: opts.from,
    sourceCounts: {},
    migratedCounts: {},
    records: 0,
    skipped: [],
    unresolvedLinks: [],
    updated: [],
    conflicts: [],
    rankingExported: 0,
    swarmRowsExported: {},
    docsMoved: [],
    pathRewrites: 0,
    written: false,
  };
  if (!existsSync(opts.from)) throw new Error(`no old brain at ${opts.from}`);
  const src = await openDb(opts.from);
  const rows = src.prepare('SELECT * FROM logs ORDER BY id').all();

  // Existing records. Re-runs are catch-ups: rows already migrated are refreshed only when the old row
  // changed and the record file did not (both hashes are kept in brain/.local/migration.json).
  const statePath = path.join(brain.dir, '.local', 'migration.json');
  const state: Record<string, { id: string; row: string; file: string; path: string }> = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, 'utf8'))
    : {};
  const existingLegacy = new Map<string, string>();
  const existingPath = new Map<string, string>();
  const takenIds = new Set<string>();
  for (const dir of brain.typeDirs.values()) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const m = /^([0-9a-z]+)-/.exec(f);
      if (m) takenIds.add(m[1]);
      const lm = /^legacy_id: ['"]?([^'"\n]+)['"]?$/m.exec(readFileSync(path.join(dir, f), 'utf8').slice(0, 2000));
      if (lm && m) {
        existingLegacy.set(lm[1], m[1]);
        existingPath.set(lm[1], path.join(dir, f));
      }
    }
  }
  const sha = (t: string) => createHash('sha256').update(t).digest('hex').slice(0, 16);

  // Pass 1: give every row a new id.
  const idMap = new Map<string, string>(existingLegacy);
  for (const r of rows) {
    const legacy = String(r.id);
    if (idMap.has(legacy)) continue;
    const id = newId((x) => takenIds.has(x), rows.length + takenIds.size);
    takenIds.add(id);
    idMap.set(legacy, id);
  }

  const ranking: { id: string; legacy_id: string; type: string; status: string; title: string; focus: number; priority: number | null; pillar: string | null }[] = [];
  const files: { file: string; text: string; legacy: string; id: string; row: string; replaces?: string }[] = [];

  // Pass 2: build records.
  for (const r of rows) {
    const legacy = String(r.id);
    const type = String(r.type);
    const status = String(r.status ?? 'active');
    report.sourceCounts[`${type}/${status}`] = (report.sourceCounts[`${type}/${status}`] ?? 0) + 1;
    const rowHash = sha(JSON.stringify(r));
    let replaces: string | undefined;
    if (existingLegacy.has(legacy)) {
      const prev = state[legacy];
      const current = existingPath.get(legacy)!;
      if (!prev || prev.row === rowHash) {
        report.skipped.push({ legacy_id: legacy, reason: 'already migrated' });
        continue;
      }
      if (sha(readFileSync(current, 'utf8')) !== prev.file) {
        report.conflicts.push({ legacy_id: legacy, id: existingLegacy.get(legacy)!, path: path.relative(brain.root, current) });
        continue;
      }
      replaces = current;
    }
    if (!CORE_TYPES[type]) {
      report.skipped.push({ legacy_id: legacy, reason: `unknown type "${type}"` });
      continue;
    }
    const id = idMap.get(legacy)!;
    const link = (field: string, v: unknown) => {
      if (v === null || v === undefined || v === '') return undefined;
      const target = idMap.get(String(v));
      if (!target) report.unresolvedLinks.push({ legacy_id: legacy, field, target: String(v) });
      return target ?? undefined;
    };

    let meta: Record<string, unknown> = {};
    if (r.meta && String(r.meta).trim() && String(r.meta).trim() !== '{}') {
      try {
        meta = JSON.parse(String(r.meta));
      } catch {
        meta = { raw: String(r.meta) };
      }
    }
    const docs: string[] = [];
    for (const k of DOC_KEYS) {
      if (typeof meta[k] === 'string') {
        const p = rewritePaths(String(meta[k])).text.replace(/^brain\//, '');
        if (!docs.includes(p) && !(k === 'folder' && docs.some((d) => d.startsWith(p)))) docs.push(p);
      }
    }
    for (const k of Object.keys(meta)) {
      if (typeof meta[k] === 'string') {
        const rw = rewritePaths(String(meta[k]));
        report.pathRewrites += rw.n;
        meta[k] = rw.text;
      }
    }
    let blockedBy: string[] | undefined;
    if (Array.isArray(meta.depends_on)) {
      blockedBy = meta.depends_on.map((d) => link('depends_on', d)).filter((x): x is string => !!x);
      delete meta.depends_on;
    }

    const tags = normalizeTags([...(r.tags ? String(r.tags).split(',') : []), ...(r.pillar ? [String(r.pillar)] : [])]);
    const importance = r.importance === null || r.importance === undefined ? undefined : Number(r.importance);
    const fields: Fields = {
      id,
      type,
      title: String(r.title ?? '').trim() || '(untitled)',
      status: ['active', 'blocked', 'done', 'dropped', 'superseded'].includes(status) ? status : 'active',
      created: convertTimestamp(r.created_at) ?? convertTimestamp(r.updated_at),
      tags: tags.length ? tags : undefined,
      parent: link('parent', r.parent_id),
      supersedes: link('supersedes', r.supersedes),
      superseded_by: link('superseded_by', r.superseded_by),
      blocked_by: blockedBy?.length ? blockedBy : undefined,
      completed: convertTimestamp(r.completed_at),
      importance: importance !== undefined && importance !== 5 ? importance : undefined,
      docs: docs.length ? docs : undefined,
      legacy_id: legacy,
      meta: Object.keys(meta).length ? meta : undefined,
    };
    if (!['active', 'blocked', 'done', 'dropped', 'superseded'].includes(status)) {
      fields.meta = { ...(fields.meta as object), legacy_status: status };
    }
    if (Number(r.focus) === 1 || (r.priority !== null && r.priority !== undefined)) {
      ranking.push({
        id, legacy_id: legacy, type, status, title: String(fields.title),
        focus: Number(r.focus) || 0,
        priority: r.priority === null || r.priority === undefined ? null : Number(r.priority),
        pillar: r.pillar ? String(r.pillar) : null,
      });
    }
    const rw = rewritePaths(String(r.body ?? ''));
    report.pathRewrites += rw.n;
    const dir = brain.typeDirs.get(type)!;
    files.push({
      file: replaces ?? path.join(dir, `${id}-${slugify(String(fields.title))}.md`),
      text: formatRecord(fields, rw.text),
      legacy, id, row: rowHash, replaces,
    });
    if (replaces) report.updated.push(id);
    report.migratedCounts[`${type}/${fields.status}`] = (report.migratedCounts[`${type}/${fields.status}`] ?? 0) + 1;
    report.records++;
  }
  report.rankingExported = ranking.length;

  // Live swarm state is not knowledge: export it for the kit to pick up, never into records.
  const swarmTables = src.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'swarm_%'").all().map((t) => String(t.name));
  const swarm: Record<string, unknown[]> = {};
  for (const t of swarmTables) {
    swarm[t] = src.prepare(`SELECT * FROM "${t}"`).all();
    report.swarmRowsExported[t] = swarm[t].length;
  }
  src.close();

  if (opts.dryRun) return report;

  for (const f of files) {
    mkdirSync(path.dirname(f.file), { recursive: true });
    writeFileSync(f.file, f.text);
    state[f.legacy] = { id: f.id, row: f.row, file: sha(f.text), path: path.relative(brain.dir, f.file).split(path.sep).join('/') };
  }
  const local = path.join(brain.dir, '.local');
  mkdirSync(local, { recursive: true });
  writeFileSync(statePath, JSON.stringify(state));
  writeFileSync(path.join(local, 'legacy-ranking.json'), JSON.stringify(ranking, null, 2));
  if (swarmTables.length) writeFileSync(path.join(local, 'legacy-swarm.json'), JSON.stringify(swarm, null, 2));
  if (opts.moveDocs) report.docsMoved = moveDocs(brain);
  report.written = true;
  return report;
}

/** Move plans and research under brain/ (git mv when tracked, so history follows), rewriting old paths inside them. */
export function moveDocs(brain: Brain): string[] {
  const moved: string[] = [];
  // Ignore rules move with the folders. Without this, a rule such as `cowork/research/*/raw/`
  // stops matching after the move and ignored data (raw client exports) becomes committable.
  const gi = path.join(brain.root, '.gitignore');
  if (existsSync(gi)) {
    const text = readFileSync(gi, 'utf8');
    const next = text.replace(/(^|[\s/!*])cowork\/(plans|research)(?=\/|$|\s)/gm, '$1brain/$2');
    if (next !== text) {
      writeFileSync(gi, next);
      moved.push('.gitignore rules for cowork/plans and cowork/research now name brain/');
    }
  }
  for (const [from, to] of [['cowork/plans', 'plans'], ['cowork/research', 'research']] as const) {
    const src = path.join(brain.root, from);
    const dest = path.join(brain.dir, to);
    if (!existsSync(src)) continue;
    if (existsSync(dest) && readdirSync(dest).length) throw new Error(`${path.relative(brain.root, dest)} already exists and is not empty`);
    let tracked = false;
    try {
      tracked = execFileSync('git', ['ls-files', from], { cwd: brain.root, encoding: 'utf8' }).trim().length > 0;
    } catch {
      tracked = false;
    }
    mkdirSync(path.dirname(dest), { recursive: true });
    if (existsSync(dest)) rmdirSync(dest);
    if (tracked) {
      execFileSync('git', ['mv', from, path.relative(brain.root, dest).split(path.sep).join('/')], { cwd: brain.root });
    } else {
      renameSync(src, dest);
    }
    moved.push(`${from} -> brain/${to}`);
    for (const f of walk(dest)) {
      if (!/\.(md|txt|json|ya?ml)$/.test(f)) continue;
      const text = readFileSync(f, 'utf8');
      const rw = rewritePaths(text);
      if (rw.n) writeFileSync(f, rw.text);
    }
  }
  return moved;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const full = path.join(dir, e);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
