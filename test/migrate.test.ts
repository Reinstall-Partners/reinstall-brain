import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { convertTimestamp, migrateBrain } from '../src/core/migrate.js';
import { initBrain, openFresh, findRecord } from '../src/core/ops.js';
import { openBrain } from '../src/core/brain.js';
import { lintBrain } from '../src/core/indexer.js';

describe('convertTimestamp', () => {
  it('treats SQLite datetime() output as UTC', () => {
    expect(convertTimestamp('2026-11-16 16:00:30')).toBe('2026-11-16T16:00:30Z');
  });
  it('keeps explicit zones', () => {
    expect(convertTimestamp('2026-11-16T10:00:00-06:00')).toBe('2026-11-16T10:00:00-06:00');
    expect(convertTimestamp('2026-11-16T10:00:00Z')).toBe('2026-11-16T10:00:00Z');
  });
  it('gives zone-less T timestamps the local offset', () => {
    expect(convertTimestamp('2026-11-16T10:00:00')).toMatch(/^2026-11-16T10:00:00[+-]\d{2}:\d{2}$/);
  });
});

describe('migrateBrain', () => {
  it('converts rows, links, paths and side data with exact parity', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'rb-mig-'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    mkdirSync(path.join(root, 'cowork', 'brain'), { recursive: true });
    mkdirSync(path.join(root, 'cowork', 'plans'), { recursive: true });
    writeFileSync(path.join(root, 'cowork', 'plans', '001_x.md'), 'see cowork/research/000_y/SUMMARY.md\n');
    const db = new DatabaseSync(path.join(root, 'cowork', 'brain', 'BRAIN.db'));
    db.exec(`CREATE TABLE logs (id INTEGER PRIMARY KEY, created_at TEXT, type TEXT, title TEXT, body TEXT, tags TEXT,
      status TEXT, parent_id INTEGER, meta TEXT, priority INTEGER, pillar TEXT, focus INTEGER, importance INTEGER,
      tier TEXT, completed_at TEXT, supersedes INTEGER, superseded_by INTEGER);
      CREATE TABLE swarm_runs (id INTEGER PRIMARY KEY, plan_id TEXT);
      INSERT INTO swarm_runs VALUES (1, '001');`);
    const ins = db.prepare('INSERT INTO logs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    ins.run(1, '2026-07-01 12:00:00', 'note', 'Brainstorm', 'Plan at cowork/plans/001_x.md', 'brainstorm', 'active', null, '{"plan_id":"001","plan_path":"cowork/plans/001_x.md"}', null, '', 0, 6, 'warm', null, null, null);
    ins.run(2, '2026-07-02T09:00:00', 'decision', 'Old way', '', 'Arch, arch', 'superseded', 1, '{}', null, 'eng', 0, 5, 'archived', null, null, 3);
    ins.run(3, '2026-07-03 09:00:00', 'decision', 'New way', '', '', 'active', 1, null, null, null, 0, 5, 'warm', null, 2, null);
    ins.run(4, '2026-07-04 09:00:00', 'task', 'Do it', '', '', 'active', 3, '{"depends_on":[2]}', 1, 'eng', 1, 5, 'hot', null, null, null);
    db.close();
    initBrain(root, 'mig');
    const brain = openBrain(root);
    const dry = await migrateBrain(brain, { from: path.join(root, 'cowork/brain/BRAIN.db'), dryRun: true });
    expect(dry.written).toBe(false);
    expect(dry.records).toBe(4);
    const r = await migrateBrain(brain, { from: path.join(root, 'cowork/brain/BRAIN.db'), moveDocs: true });
    expect(r.sourceCounts).toEqual(r.migratedCounts);
    expect(r.unresolvedLinks).toEqual([]);
    expect(r.rankingExported).toBe(1);
    expect(r.swarmRowsExported.swarm_runs).toBe(1);
    expect(existsSync(path.join(root, 'brain', 'plans', '001_x.md'))).toBe(true);
    expect(readFileSync(path.join(root, 'brain', 'plans', '001_x.md'), 'utf8')).toContain('brain/research/000_y');
    const o = await openFresh(brain);
    const note = findRecord(o, '1')!;
    expect(note.fields.docs).toEqual(['plans/001_x.md']);
    expect(note.fields.importance).toBe(6);
    expect(note.body).toContain('brain/plans/001_x.md');
    const old = findRecord(o, '2')!;
    const neu = findRecord(o, '3')!;
    expect(old.fields.superseded_by).toBe(neu.id);
    expect(neu.fields.supersedes).toBe(old.id);
    expect(old.fields.tags).toEqual(['arch', 'eng']);
    const task = findRecord(o, '4')!;
    expect(task.fields.blocked_by).toEqual([old.id]);
    expect(task.fields.parent).toBe(neu.id);
    expect(lintBrain(brain, o.db).filter((i) => i.level === 'error')).toEqual([]);
    o.db.close();
    const again = await migrateBrain(brain, { from: path.join(root, 'cowork/brain/BRAIN.db') });
    expect(again.records).toBe(0);
    expect(again.skipped.length).toBe(4);

    // Live work after the first run: a session on the old kit adds a row and changes two others.
    const live = new DatabaseSync(path.join(root, 'cowork', 'brain', 'BRAIN.db'));
    live.prepare('INSERT INTO logs (id, created_at, type, title, status) VALUES (5, ?, ?, ?, ?)').run('2026-07-05 09:00:00', 'task', 'Written late', 'active');
    live.exec("UPDATE logs SET status='done', completed_at='2026-07-06 09:00:00' WHERE id=4");
    live.exec("UPDATE logs SET body='changed in the old brain' WHERE id=3");
    live.close();
    // ...while someone also edited record 3 by hand in the new brain.
    const o2 = await openFresh(brain);
    const rec3 = path.join(root, findRecord(o2, '3')!.path);
    o2.db.close();
    writeFileSync(rec3, readFileSync(rec3, 'utf8') + '\nEdited in the new brain.\n');
    const catchUp = await migrateBrain(brain, { from: path.join(root, 'cowork/brain/BRAIN.db') });
    expect(catchUp.updated.length).toBe(1);
    expect(catchUp.conflicts.map((c) => c.legacy_id)).toEqual(['3']);
    const o3 = await openFresh(brain);
    expect(findRecord(o3, '5')?.title).toBe('Written late');
    expect(findRecord(o3, '4')?.status).toBe('done');
    expect(findRecord(o3, '4')?.id).toBe(task.id);
    expect(findRecord(o3, '3')?.body).toContain('Edited in the new brain.');
    o3.db.close();
  });
});
