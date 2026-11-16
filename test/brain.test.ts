import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { initBrain, openFresh, createRecord, updateRecord, supersede, findRecord, listRecords, searchRecords, runSql } from '../src/core/ops.js';
import { locateBrain, openBrain } from '../src/core/brain.js';
import { lintBrain, refresh } from '../src/core/indexer.js';
import { parseRecord, formatRecord, newId, slugify } from '../src/core/record.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

function tempRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rb-test-'));
  git(dir, 'init', '-q', '-b', 'main');
  return dir;
}

describe('records', () => {
  it('keeps ids, dates and padded numbers as strings', () => {
    const { fields } = parseRecord('---\nid: 12e4\nparent: 0042\ncreated: 2026-11-16T10:00:00-06:00\nimportance: 7\n---\nbody');
    expect(fields.id).toBe('12e4');
    expect(fields.parent).toBe('0042');
    expect(fields.created).toBe('2026-11-16T10:00:00-06:00');
    expect(fields.importance).toBe(7);
  });

  it('writes fields in the canonical order with flow lists', () => {
    const text = formatRecord({ updated: 'u', tags: ['b', 'A'], id: 'ab12', status: 'active', type: 'task', title: 't', created: 'c', assignee: 'x' }, 'b');
    const keys = text.split('\n').slice(1, 9).map((l) => l.split(':')[0]);
    expect(keys).toEqual(['id', 'type', 'title', 'status', 'created', 'tags', 'assignee', 'updated']);
    expect(text).toContain('tags: [a, b]');
  });

  it('never generates an id YAML would read as a number', () => {
    for (let i = 0; i < 2000; i++) {
      const id = newId(() => false, 0);
      expect(id).toMatch(/^[0-9a-z]{4}$/);
      expect(/^[0-9]+$/.test(id) || /^[0-9]*e[0-9]+$/.test(id)).toBe(false);
    }
  });

  it('slugs titles', () => {
    expect(slugify('Build the Import Screen!! (v2)')).toBe('build-the-import-screen-v2');
    expect(slugify('Café déjà vu')).toBe('cafe-deja-vu');
  });
});

describe('a brain', () => {
  let root: string;
  beforeEach(() => {
    root = tempRepo();
    initBrain(root, 'test');
  });

  it('creates, finds, lists, searches and updates records', async () => {
    const o = await openFresh(openBrain(root));
    const t = createRecord(o, { type: 'task', title: 'Build the import screen', tags: ['UI', 'import'], author: 'sam' });
    createRecord(o, { type: 'decision', title: 'Markdown is the source of truth', body: 'Because git diffs it.' });
    expect(t.path).toMatch(new RegExp(`^brain/records/tasks/${t.id}-build-the-import-screen\\.md$`));
    expect(t.fields.tags).toEqual(['import', 'ui']);
    expect(t.body).toContain(`${String(t.fields.created).slice(0, 10)} sam: created`);
    expect(listRecords(o, { type: 'task', status: 'active' }).map((r) => r.id)).toEqual([t.id]);
    expect(listRecords(o, { tag: 'ui' }).length).toBe(1);
    expect(searchRecords(o, 'diffs')[0].type).toBe('decision');
    const done = updateRecord(o, t.id, { status: 'done' }, 'sam: shipped');
    expect(done.fields.completed).toBeDefined();
    expect(done.body).toMatch(/sam: shipped\s*$/);
    expect(runSql(o, "SELECT count(*) AS n FROM records WHERE status = 'done'")[0].n).toBe(1);
    expect(() => runSql(o, 'DELETE FROM records')).toThrow(/only read queries/);
    o.db.close();
  });

  it('supersedes a decision in both directions', async () => {
    const o = await openFresh(openBrain(root));
    const a = createRecord(o, { type: 'decision', title: 'Use SQLite as truth' });
    const b = createRecord(o, { type: 'decision', title: 'Use markdown as truth' });
    const r = supersede(o, a.id, b.id);
    expect(r.old.status).toBe('superseded');
    expect(r.old.fields.superseded_by).toBe(b.id);
    expect(r.replacement.fields.supersedes).toBe(a.id);
    o.db.close();
  });

  it('finds a record by legacy id', async () => {
    const o = await openFresh(openBrain(root));
    const r = createRecord(o, { type: 'note', title: 'Old entry', extra: { legacy_id: '512' } });
    expect(findRecord(o, '#512')?.id).toBe(r.id);
    o.db.close();
  });

  it('picks up hand edits, new files and deletions on the next refresh', async () => {
    const brain = openBrain(root);
    const o = await openFresh(brain);
    const r = createRecord(o, { type: 'note', title: 'Original title' });
    const file = path.join(root, r.path);
    writeFileSync(file, readFileSync(file, 'utf8').replace('title: Original title', 'title: Edited by hand'));
    const hand = path.join(brain.dir, 'records', 'notes', 'zz99-written-by-hand.md');
    writeFileSync(hand, '---\nid: zz99\ntype: note\ntitle: Written by hand\nstatus: active\ncreated: 2026-11-16T10:00:00-06:00\n---\n\nhello\n');
    let res = refresh(brain, o.db);
    expect(res.updated + res.added).toBeGreaterThanOrEqual(2);
    expect(findRecord(o, r.id)?.title).toBe('Edited by hand');
    expect(findRecord(o, 'zz99')?.title).toBe('Written by hand');
    rmSync(hand);
    res = refresh(brain, o.db);
    expect(res.removed).toBe(1);
    expect(findRecord(o, 'zz99')).toBeUndefined();
    o.db.close();
  });

  it('lint reports broken frontmatter, bad fields, duplicate ids and broken links', async () => {
    const brain = openBrain(root);
    const dir = path.join(brain.dir, 'records', 'notes');
    writeFileSync(path.join(dir, 'aa11-broken.md'), '---\nid: aa11\ntitle: [unclosed\n---\n');
    writeFileSync(path.join(dir, 'bb22-bad.md'), '---\nid: bb22\ntype: note\ntitle: Bad\nstatus: maybe\ncreated: yesterday\nparent: nope\ncolor: red\n---\n');
    writeFileSync(path.join(dir, 'cc33-one.md'), '---\nid: cc33\ntype: note\ntitle: One\nstatus: active\ncreated: 2026-11-16T10:00:00Z\n---\n');
    writeFileSync(path.join(dir, 'cc33-two.md'), '---\nid: cc33\ntype: note\ntitle: Two\nstatus: active\ncreated: 2026-11-16T10:00:00Z\n---\n');
    const o = await openFresh(brain);
    const msgs = lintBrain(brain, o.db).map((i) => `${i.level}: ${i.message}`);
    expect(msgs.some((m) => m.startsWith('error') && /flow|unclosed|Unexpected|Missing|YAML|map/i.test(m))).toBe(true);
    expect(msgs).toContain('error: status "maybe" is not one of active, blocked, done, dropped, superseded');
    expect(msgs).toContain('error: created "yesterday" is not a date');
    expect(msgs).toContain('warning: unknown field "color" (move it under meta:)');
    expect(msgs).toContain('warning: parent "nope" does not match any record');
    expect(msgs.some((m) => m.includes('id "cc33" is used by 2 records'))).toBe(true);
    o.db.close();
  });

  it('serves the primary checkout brain from inside a git worktree', () => {
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'brain');
    const wt = path.join(path.dirname(root), `${path.basename(root)}-wt`);
    git(root, 'worktree', 'add', '-q', wt);
    expect(path.resolve(locateBrain(wt)!)).toBe(path.resolve(locateBrain(root)!));
    git(root, 'worktree', 'remove', '--force', wt);
  });

  it('registers kit types, including kit-owned folders', async () => {
    const brain0 = openBrain(root);
    writeFileSync(
      path.join(brain0.dir, 'brain.yaml'),
      'format: 1\nname: test\ntypes:\n  - name: memory\n    folder: memories\n  - name: swarm-run\n    path: swarm\n',
    );
    const brain = openBrain(root);
    mkdirSync(path.join(brain.dir, 'swarm', 'run-1'), { recursive: true });
    writeFileSync(
      path.join(brain.dir, 'swarm', 'run-1', 'run.md'),
      '---\nid: sw01\ntype: swarm-run\ntitle: First run\nstatus: done\ncreated: 2026-11-16T10:00:00Z\n---\n',
    );
    const o = await openFresh(brain);
    const m = createRecord(o, { type: 'memory', title: 'Prefers short answers' });
    expect(m.path).toMatch(/^brain\/records\/memories\//);
    expect(findRecord(o, 'sw01')?.type).toBe('swarm-run');
    expect(lintBrain(brain, o.db).filter((i) => i.level === 'error')).toEqual([]);
    o.db.close();
  });
});

describe('git merges with no custom merge drivers', () => {
  // GitHub's merge button ignores .gitattributes merge drivers, so the format has to merge with plain git.
  async function twoBranches(onA: (o: Awaited<ReturnType<typeof openFresh>>) => void, onB: (o: Awaited<ReturnType<typeof openFresh>>) => void, seed?: (o: Awaited<ReturnType<typeof openFresh>>) => void) {
    const root = tempRepo();
    initBrain(root, 'merge');
    let o = await openFresh(openBrain(root));
    seed?.(o);
    o.db.close();
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'base');
    git(root, 'checkout', '-q', '-b', 'a');
    o = await openFresh(openBrain(root));
    onA(o);
    o.db.close();
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'a', '--allow-empty');
    git(root, 'checkout', '-q', 'main');
    o = await openFresh(openBrain(root));
    onB(o);
    o.db.close();
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'b', '--allow-empty');
    let clean = true;
    try {
      git(root, 'merge', '-q', '--no-edit', 'a');
    } catch {
      clean = false;
    }
    return { root, clean };
  }

  it('merges new records created on both branches', async () => {
    const { clean, root } = await twoBranches(
      (o) => createRecord(o, { type: 'task', title: 'From branch A' }),
      (o) => createRecord(o, { type: 'task', title: 'From branch B' }),
    );
    expect(clean).toBe(true);
    expect(readdirSync(path.join(root, 'brain', 'records', 'tasks')).length).toBe(2);
  });

  it('merges edits to different records', async () => {
    let x = '', y = '';
    const { clean } = await twoBranches(
      (o) => updateRecord(o, x, { status: 'done' }),
      (o) => updateRecord(o, y, { status: 'blocked' }),
      (o) => {
        x = createRecord(o, { type: 'task', title: 'X' }).id;
        y = createRecord(o, { type: 'task', title: 'Y' }).id;
      },
    );
    expect(clean).toBe(true);
  });

  it('merges a field change on one branch with a body change on the other, same record', async () => {
    let x = '';
    const { clean, root } = await twoBranches(
      (o) => updateRecord(o, x, { assignee: 'sam' }),
      (o) => {
        const r = findRecord(o, x)!;
        const file = path.join(o.brain.root, r.path);
        writeFileSync(file, readFileSync(file, 'utf8') + '\nMore detail added on main.\n');
      },
      (o) => {
        x = createRecord(o, { type: 'task', title: 'Shared', body: 'Original body.\n\n\n\nEnd.' }).id;
      },
    );
    expect(clean).toBe(true);
    const o = await openFresh(openBrain(root));
    const r = findRecord(o, x)!;
    expect(r.fields.assignee).toBe('sam');
    expect(r.body).toContain('More detail added on main.');
    o.db.close();
  });

  it('merges edits to two different fields of the same record when the fields are not adjacent', async () => {
    let x = '';
    const { clean, root } = await twoBranches(
      (o) => updateRecord(o, x, { status: 'blocked' }),
      (o) => updateRecord(o, x, { scope: 'apps/web' }),
      (o) => {
        x = createRecord(o, { type: 'task', title: 'Fields far apart', tags: ['a'], author: 'sam' }).id;
      },
    );
    expect(clean).toBe(true);
    const o = await openFresh(openBrain(root));
    const r = findRecord(o, x)!;
    expect(r.status).toBe('blocked');
    expect(r.fields.scope).toBe('apps/web');
    o.db.close();
  });
});
