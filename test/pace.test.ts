import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { initBrain, openFresh, createRecord, updateRecord } from '../src/core/ops.js';
import { openBrain } from '../src/core/brain.js';
import { lintBrain } from '../src/core/indexer.js';
import { locateHub, openHubDb, indexHub, pace, appendPace } from '../src/core/hub.js';

describe('pace', () => {
  it('appends to the Pace section, or adds one', () => {
    expect(appendPace('Why.\n\n## Pace\n- 2026-01-01: 0\n\n## Notes\nx\n', '2026-01-02: 1')).toBe('Why.\n\n## Pace\n- 2026-01-01: 0\n- 2026-01-02: 1\n\n## Notes\nx\n');
    expect(appendPace('Why.\n', '2026-01-02: 1')).toBe('Why.\n\n## Pace\n- 2026-01-02: 1\n');
  });

  it('runs measure_cmd only with run, and logs the reading as a Pace line', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'rb-pace-'));
    const hubRoot = path.join(base, 'the-hub');
    execFileSync('git', ['init', '-q', hubRoot]);
    initBrain(hubRoot, 'the-hub');
    writeFileSync(path.join(hubRoot, 'brain', 'brain.yaml'), 'format: 1\nname: the-hub\nhub: true\nconnects: []\n');
    let o = await openFresh(openBrain(hubRoot));
    const g = createRecord(o, { type: 'goal', title: 'Ten signups', extra: { done_when: '10', measure: 'signups', measure_cmd: 'echo 7 signups' } });
    const g2 = createRecord(o, { type: 'goal', title: 'By hand', extra: { done_when: 'x', measure: 'ask' } });
    o.db.close();
    const hub = locateHub(hubRoot);
    const db = await openHubDb(hub);
    await indexHub(hub, db);
    let rows = await pace(hub, db);
    expect(rows.find((r) => r.key === `the-hub/${g.id}`)).toMatchObject({ measure_cmd: 'echo 7 signups', last: null });
    expect(rows.find((r) => r.key === `the-hub/${g2.id}`)!.measure_cmd).toBeNull();

    rows = await pace(hub, db, { run: true, author: 'tester' });
    expect(rows.find((r) => r.key === `the-hub/${g.id}`)!.reading).toBe('7 signups');
    const file = rows.find((r) => r.key === `the-hub/${g.id}`)!.file;
    expect(readFileSync(file, 'utf8')).toMatch(/## Pace\n- \d{4}-\d{2}-\d{2}: 7 signups \(measure_cmd, tester\)/);
    await indexHub(hub, db);
    expect((await pace(hub, db)).find((r) => r.key === `the-hub/${g.id}`)!.last).toMatch(/7 signups/);
    db.close();
  });
});

describe('work under dropped work', () => {
  it('warns about open tasks whose parent or goal was dropped', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'rb-dropped-'));
    execFileSync('git', ['init', '-q', dir]);
    initBrain(dir, 'acme');
    const brain = openBrain(dir);
    const o = await openFresh(brain);
    const old = createRecord(o, { type: 'task', title: 'Old direction' });
    const goal = createRecord(o, { type: 'goal', title: 'Old goal', extra: { done_when: 'x' } });
    createRecord(o, { type: 'task', title: 'Child', parent: old.id });
    createRecord(o, { type: 'task', title: 'Serving', extra: { serves: goal.id } });
    expect(lintBrain(brain, o.db).filter((i) => /is dropped/.test(i.message))).toHaveLength(0);
    updateRecord(o, old.id, { status: 'dropped' });
    updateRecord(o, goal.id, { status: 'dropped' });
    const msgs = lintBrain(brain, o.db).filter((i) => /is dropped/.test(i.message)).map((i) => i.message);
    expect(msgs).toHaveLength(2);
    expect(msgs.some((m) => /parent/.test(m)) && msgs.some((m) => /goal/.test(m))).toBe(true);
    o.db.close();
  });
});

describe('pace placeholder', () => {
  it('replaces the template placeholder with the first reading', () => {
    expect(appendPace("Why.\n\n## Pace\n- YYYY-MM-DD: <the measure's reading now>\n", '2026-01-02: 1')).toBe('Why.\n\n## Pace\n- 2026-01-02: 1\n');
  });
});
