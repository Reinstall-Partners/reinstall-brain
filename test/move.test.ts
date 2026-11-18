import { describe, it, expect, vi } from 'vitest';

// Windows runners are slow at git init and file work.
vi.setConfig({ testTimeout: 30000 });
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { initBrain, openFresh, createRecord, findRecord } from '../src/core/ops.js';
import { openBrain } from '../src/core/brain.js';
import { locateHub, openHubDb, indexHub, place, cover, moveRecord, readPriorities, inboxByPlan } from '../src/core/hub.js';

function repo(name: string, base: string): string {
  const dir = path.join(base, name);
  execFileSync('git', ['init', '-q', dir]);
  initBrain(dir, name);
  return dir;
}

describe('move', () => {
  it('moves a record between brains and repoints the hub', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'rb-move-'));
    const acme = repo('acme', base);
    const widgets = repo('widgets', base);
    const hubRoot = repo('the-hub', base);
    writeFileSync(path.join(hubRoot, 'brain', 'brain.yaml'), `format: 1\nname: the-hub\nhub: true\nconnects:\n  - name: acme\n    path: ${acme}\n  - name: widgets\n    path: ${widgets}\n`);
    let o = await openFresh(openBrain(acme));
    const umbrella = createRecord(o, { type: 'task', title: 'Umbrella' });
    const meta = { meta: { plan_path: 'brain/plans/001_2026-01-01_rollout.md' } };
    const t = createRecord(o, { type: 'task', title: 'Plan 001 Phase 2: Widgets side', parent: umbrella.id, extra: meta });
    createRecord(o, { type: 'task', title: 'Plan 001 Phase 1: Acme side', extra: meta });
    o.db.close();
    o = await openFresh(openBrain(hubRoot));
    const goal = createRecord(o, { type: 'goal', title: 'Roll out', extra: { done_when: 'live' } });
    o.db.close();

    const hub = locateHub(hubRoot);
    const db = await openHubDb(hub);
    await indexHub(hub, db);
    const key = `acme/${t.id}`;
    await cover(hub, db, `the-hub/${goal.id}`, key);
    place(hub, db, key, { top: true });
    await indexHub(hub, db);

    const r = await moveRecord(hub, db, key, 'widgets', { author: 'tester' });
    expect(r).toMatchObject({ from: key, to: `widgets/${t.id}`, covers: [`the-hub/${goal.id}`], pinned: true });
    const moved = readFileSync(r.file, 'utf8');
    expect(moved).toMatch(/Moved from acme on \d{4}-\d{2}-\d{2}\. Its parent there is acme\//);
    expect(moved).toMatch(/plan_brain: acme/);
    expect(moved).not.toMatch(/^parent:/m);
    expect(moved).toMatch(/- \d{4}-\d{2}-\d{2} tester: moved here from acme\//);

    o = await openFresh(openBrain(acme));
    expect(findRecord(o, t.id)!.status).toBe('dropped');
    o.db.close();
    await indexHub(hub, db);
    expect(readPriorities(hub)).toEqual([`widgets/${t.id}`]);
    o = await openFresh(openBrain(hubRoot));
    expect(findRecord(o, goal.id)!.fields.covers).toEqual([`widgets/${t.id}`]);
    o.db.close();
    // The moved phase still groups with its plan, which lives in acme.
    place(hub, db, `widgets/${t.id}`, { bottom: true });
    const plans = inboxByPlan(hub, db).filter((x) => x.kind === 'plan');
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ key: 'acme/plan:brain/plans/001_2026-01-01_rollout.md' });

    await expect(moveRecord(hub, db, `the-hub/${goal.id}`, 'acme')).rejects.toThrow(/goals are not moved/);
    await expect(moveRecord(hub, db, `widgets/${t.id}`, 'widgets')).rejects.toThrow(/already in/);
    db.close();
  });
});
