import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { initBrain, openFresh, createRecord, updateRecord } from '../src/core/ops.js';
import { openBrain } from '../src/core/brain.js';
import { locateHub, openHubDb, indexHub, priorities, inbox, place, readPriorities } from '../src/core/hub.js';

function repo(name: string, base: string): string {
  const dir = path.join(base, name);
  execFileSync('git', ['init', '-q', dir]);
  initBrain(dir, name);
  return dir;
}

describe('hub', () => {
  it('indexes connected brains, ranks tasks strictly and drops finished ones', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'rb-hub-'));
    const a = repo('alpha', base);
    const b = repo('beta', base);
    const hubRoot = repo('my-hub', base);
    writeFileSync(path.join(hubRoot, 'brain', 'brain.yaml'), `format: 1\nname: my-hub\nconnects:\n  - name: alpha\n    path: ${a}\n  - name: beta\n    path: ${b}\n  - name: gone\n    path: ${path.join(base, 'missing')}\n`);
    let o = await openFresh(openBrain(a));
    const t1 = createRecord(o, { type: 'task', title: 'Alpha one' });
    createRecord(o, { type: 'decision', title: 'Not a task' });
    o.db.close();
    o = await openFresh(openBrain(b));
    const t2 = createRecord(o, { type: 'task', title: 'Beta one' });
    o.db.close();

    const hub = locateHub(hubRoot);
    const db = await openHubDb(hub);
    const res = await indexHub(hub, db);
    expect(res.brains.find((x) => x.name === 'gone')?.error).toMatch(/no brain/);
    expect(inbox(hub, db).map((i) => i.key)).toEqual([`alpha/${t1.id}`, `beta/${t2.id}`]);

    place(hub, db, `beta/${t2.id}`, { top: true });
    place(hub, db, `alpha/${t1.id}`, { above: `beta/${t2.id}` });
    expect(readPriorities(hub)).toEqual([`alpha/${t1.id}`, `beta/${t2.id}`]);
    expect(readFileSync(path.join(hubRoot, 'brain', 'priorities.md'), 'utf8')).toContain(`1. alpha/${t1.id}  Alpha one`);
    expect(inbox(hub, db)).toEqual([]);
    expect(() => place(hub, db, 'alpha/nope', { top: true })).toThrow(/no item/);

    o = await openFresh(openBrain(a));
    updateRecord(o, t1.id, { status: 'done' });
    o.db.close();
    await indexHub(hub, db);
    const r = priorities(hub, db, { prune: true });
    expect(r.ranked.map((i) => i.key)).toEqual([`beta/${t2.id}`]);
    expect(r.dropped).toEqual([`alpha/${t1.id}`]);
    expect(readPriorities(hub)).toEqual([`beta/${t2.id}`]);
    db.close();
  });
});
