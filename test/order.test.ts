import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { initBrain, openFresh, createRecord, updateRecord } from '../src/core/ops.js';
import { openBrain } from '../src/core/brain.js';
import {
  locateHub, openHubDb, indexHub, priorities, inbox, place, placeGoal, placeProject, projects, phaseNumber, cover,
  inboxByPlan, unrank, readPriorities,
} from '../src/core/hub.js';

function repo(name: string, base: string): string {
  const dir = path.join(base, name);
  execFileSync('git', ['init', '-q', dir]);
  initBrain(dir, name);
  return dir;
}

const day = (n: number) => `2026-01-${String(n).padStart(2, '0')}T09:00:00Z`;

async function setup() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'rb-order-'));
  const acme = repo('acme', base);
  const widgets = repo('widgets', base);
  const hubRoot = repo('the-hub', base);
  writeFileSync(path.join(hubRoot, 'brain', 'brain.yaml'), `format: 1\nname: the-hub\nhub: true\nconnects:\n  - name: acme\n    path: ${acme}\n  - name: widgets\n    path: ${widgets}\n`);

  let o = await openFresh(openBrain(acme));
  const plan = { meta: { plan_path: 'brain/plans/001_2026-01-01_importer.md' } };
  // Created out of phase order on purpose: the phase number decides inside a plan.
  const p2 = createRecord(o, { type: 'task', title: 'Plan 001 Phase 2: Wire the UI', extra: { ...plan, created: day(1) } });
  const p1 = createRecord(o, { type: 'task', title: 'Plan 001 Phase 1: Parse files', extra: { ...plan, created: day(2) } });
  const loose = createRecord(o, { type: 'task', title: 'Loose acme task', extra: { created: day(3) } });
  const urgent = createRecord(o, { type: 'task', title: 'Urgent acme task', extra: { created: day(9), due: '2026-02-01' } });
  o.db.close();

  o = await openFresh(openBrain(widgets));
  const w1 = createRecord(o, { type: 'task', title: 'Widgets task', extra: { created: day(1) } });
  const wg = createRecord(o, { type: 'task', title: 'Widgets task for the goal', extra: { created: day(5) } });
  o.db.close();

  o = await openFresh(openBrain(hubRoot));
  const goal = createRecord(o, { type: 'goal', title: 'Ship widgets', extra: { done_when: 'shipped' } });
  o.db.close();

  const hub = locateHub(hubRoot);
  const db = await openHubDb(hub);
  await indexHub(hub, db);
  const k = (b: string, id: string) => `${b}/${id}`;
  return {
    hub, db, hubRoot,
    keys: { p1: k('acme', p1.id), p2: k('acme', p2.id), loose: k('acme', loose.id), urgent: k('acme', urgent.id), w1: k('widgets', w1.id), wg: k('widgets', wg.id), goal: k('the-hub', goal.id) },
  };
}

describe('derived order', () => {
  it('reads phase numbers from titles', () => {
    expect(phaseNumber('Plan 004 Phase 3: Build')).toBe(3);
    expect(phaseNumber('Plan 004 Phase 3b: Build')).toBeCloseTo(3.2);
    expect(phaseNumber('Not a phase')).toBeNull();
  });

  it('orders by project, then goal, then plan (phases together, in order), then due date and age', async () => {
    const { hub, db, keys } = await setup();
    const order = () => priorities(hub, db).ranked.map((i) => i.key);
    // acme before widgets; in acme the due task leads, then the plan (phase 1, 2), then the loose task.
    expect(order()).toEqual([keys.urgent, keys.p1, keys.p2, keys.loose, keys.w1, keys.wg]);
    expect(priorities(hub, db).ranked.every((i) => !i.pinned)).toBe(true);
    expect(priorities(hub, db).ranked.find((i) => i.key === keys.p1)!.plan).toBe('acme:brain/plans/001_2026-01-01_importer.md');

    // A ranked goal lifts the tasks it covers within their project, not above a higher project.
    await cover(hub, db, keys.goal, keys.wg);
    await indexHub(hub, db);
    placeGoal(hub, db, keys.goal, { top: true });
    expect(order()).toEqual([keys.urgent, keys.p1, keys.p2, keys.loose, keys.wg, keys.w1]);

    // Reordering projects reorders every task.
    const r = placeProject(hub, db, 'widgets', { top: true });
    expect(r).toEqual({ rank: 1, pins: [] });
    expect(projects(hub, db).map((p) => p.name)).toEqual(['widgets', 'acme']);
    expect(order()).toEqual([keys.wg, keys.w1, keys.urgent, keys.p1, keys.p2, keys.loose]);
    db.close();
  });

  it('puts pins first, keeps them through a project reorder, and reports them', async () => {
    const { hub, db, keys, hubRoot } = await setup();
    place(hub, db, keys.loose, { top: true });
    let r = priorities(hub, db);
    expect(r.ranked[0]).toMatchObject({ key: keys.loose, pinned: true, rank: 1 });
    expect(inbox(hub, db).map((i) => i.key)).not.toContain(keys.loose);
    expect(inbox(hub, db)[0].key).toBe(keys.urgent);

    const moved = placeProject(hub, db, 'acme', { bottom: true });
    expect(moved.pins).toEqual([keys.loose]);
    r = priorities(hub, db);
    expect(r.ranked.map((i) => i.key)).toEqual([keys.loose, keys.w1, keys.wg, keys.urgent, keys.p1, keys.p2]);
    expect(projects(hub, db).find((p) => p.name === 'acme')!.pins).toBe(1);
    // connects: was rewritten in place, keeping each entry's path.
    const yaml = readFileSync(path.join(hubRoot, 'brain', 'brain.yaml'), 'utf8');
    expect(yaml.indexOf('name: widgets')).toBeLessThan(yaml.indexOf('name: acme'));
    expect(yaml).toMatch(/name: acme\n\s+path: .*acme/);
    expect(() => placeProject(hub, db, 'nope', { top: true })).toThrow(/no project/);
    db.close();
  });
});

describe('the hub\'s own tasks', () => {
  it('rank as the project they are for, by project: or by plan folder, and the rest come last', async () => {
    const { hub, db, keys, hubRoot } = await setup();
    let o = await openFresh(openBrain(hubRoot));
    const forWidgets = createRecord(o, { type: 'task', title: 'Hub task for widgets', extra: { project: 'widgets', created: day(1) } });
    const planned = createRecord(o, { type: 'task', title: 'Plan 000 Phase 1: Move acme', extra: { meta: { plan_path: 'brain/plans/acme/000_2026-01-01_move.md' }, created: day(1) } });
    const loose = createRecord(o, { type: 'task', title: 'Hub task for nothing', extra: { created: day(1) } });
    o.db.close();
    await indexHub(hub, db);
    const k = (id: string) => `the-hub/${id}`;
    const order = () => priorities(hub, db).ranked.map((i) => i.key);
    // The hub's plan task sits in acme's block, its widgets task in widgets' block, and the loose one last.
    expect(order()).toEqual([keys.urgent, keys.p1, keys.p2, k(planned.id), keys.loose, k(forWidgets.id), keys.w1, keys.wg, k(loose.id)]);
    placeProject(hub, db, 'widgets', { top: true });
    expect(order()).toEqual([k(forWidgets.id), keys.w1, keys.wg, keys.urgent, keys.p1, keys.p2, k(planned.id), keys.loose, k(loose.id)]);
    db.close();
  });
});

describe('plans as one item', () => {
  it('folds a plan into one inbox row, advances it, and pins a whole plan', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'rb-plan-'));
    const acme = repo('acme', base);
    const hubRoot = repo('the-hub', base);
    writeFileSync(path.join(hubRoot, 'brain', 'brain.yaml'), `format: 1\nname: the-hub\nhub: true\nconnects:\n  - name: acme\n    path: ${acme}\n`);
    const planPath = 'brain/plans/004_2026-01-01_billing.md';
    mkdirSync(path.join(acme, 'brain', 'plans'), { recursive: true });
    writeFileSync(path.join(acme, planPath), '# Plan: Billing rebuild\n\nBody.\n');
    let o = await openFresh(openBrain(acme));
    const meta = { meta: { plan_path: planPath, plan_id: '004' } };
    const phases = [];
    for (let n = 9; n >= 1; n--) phases.unshift(createRecord(o, { type: 'task', title: `Plan 004 Phase ${n}: Step ${n}`, extra: { ...meta, created: day(10 - n) } }));
    const loose = createRecord(o, { type: 'task', title: 'Loose task', extra: { created: day(20) } });
    o.db.close();

    const hub = locateHub(hubRoot);
    const db = await openHubDb(hub);
    await indexHub(hub, db);
    let rows = inboxByPlan(hub, db);
    expect(rows.map((r) => r.kind)).toEqual(['plan', 'task']);
    const plan = rows[0] as any;
    expect(plan).toMatchObject({ key: `acme/plan:${planPath}`, title: 'Billing rebuild', open_phases: 9 });
    expect(plan.next.title).toBe('Plan 004 Phase 1: Step 1');

    o = await openFresh(openBrain(acme));
    updateRecord(o, phases[0].id, { status: 'done' });
    o.db.close();
    await indexHub(hub, db);
    rows = inboxByPlan(hub, db);
    expect((rows[0] as any).next.title).toBe('Plan 004 Phase 2: Step 2');
    expect((rows[0] as any).open_phases).toBe(8);

    // Pin by plan id; the file keeps the path form, and the plan's phases lead the order.
    place(hub, db, 'acme/plan:004', { top: true });
    expect(readPriorities(hub)).toEqual([`acme/plan:${planPath}`]);
    expect(readFileSync(path.join(hubRoot, 'brain', 'priorities.md'), 'utf8')).toContain('(plan) Billing rebuild');
    const ranked = priorities(hub, db).ranked;
    expect(ranked.slice(0, 8).every((i) => i.pinned && i.plan === `acme:${planPath}`)).toBe(true);
    expect(ranked[8]).toMatchObject({ key: `acme/${loose.id}`, pinned: false });
    expect(inboxByPlan(hub, db).map((r) => r.kind)).toEqual(['task']);
    expect(() => place(hub, db, 'acme/plan:999', { top: true })).toThrow(/no open task/);

    expect(unrank(hub, db, 'acme/plan:004')).toBe(true);
    expect(readPriorities(hub)).toEqual([]);
    db.close();
  });
});

describe('phase 6: managed tasks, goals kept out of ranking, kit offer, kept sections', async () => {
  const { goals, connectRepo, readPrioritiesFile } = await import('../src/core/hub.js');
  it('carries managed_by, keeps ranking:off goals out of the waiting list, offers the kit, and keeps unknown sections', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'rb-p6-'));
    const acme = repo('acme', base);
    const fresh = repo('fresh', base);
    const hubRoot = repo('the-hub', base);
    writeFileSync(path.join(hubRoot, 'brain', 'brain.yaml'), `format: 1\nname: the-hub\nhub: true\nkit:\n  install: node ~/kit/install.mjs\n  marker: .claude/kit-installed.json\nconnects:\n  - name: acme\n    path: ${acme}\n`);
    let o = await openFresh(openBrain(acme));
    const t = createRecord(o, { type: 'task', title: 'Feed is stale', extra: { managed_by: 'finance' } });
    createRecord(o, { type: 'goal', title: 'Personal goal', extra: { done_when: 'x', ranking: 'off' } });
    createRecord(o, { type: 'goal', title: 'Project goal', extra: { done_when: 'y' } });
    o.db.close();
    const hub = locateHub(hubRoot);
    const db = await openHubDb(hub);
    await indexHub(hub, db);
    expect(priorities(hub, db).ranked.find((i) => i.key === `acme/${t.id}`)!.managed_by).toBe('finance');
    const g = goals(hub, db);
    expect(g.unranked.map((x) => x.title)).toEqual(['Project goal']);
    expect(g.not_ranked.map((x) => x.title)).toEqual(['Personal goal']);

    expect(connectRepo(hub, fresh).kit).toEqual({ install: 'node ~/kit/install.mjs' });
    mkdirSync(path.join(acme, '.claude'), { recursive: true });
    writeFileSync(path.join(acme, '.claude', 'kit-installed.json'), '{}');
    expect(connectRepo(hub, acme).kit).toBeNull();

    const file = path.join(hubRoot, 'brain', 'priorities.md');
    writeFileSync(file, `# Priorities\n\n## Notes\n\nKeep this paragraph.\n- acme/zzzz is mentioned here, not pinned\n`);
    place(hub, db, `acme/${t.id}`, { top: true });
    const after = readFileSync(file, 'utf8');
    expect(after).toContain('## Notes\n\nKeep this paragraph.');
    expect(readPrioritiesFile(hub).tasks).toEqual([`acme/${t.id}`]);
    db.close();
  });
});
