import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Windows runners are slow at git init and links.
vi.setConfig({ testTimeout: 30000 });
import { mkdtempSync, readFileSync, writeFileSync, lstatSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { initBrain, openFresh, createRecord } from '../src/core/ops.js';
import { openBrain } from '../src/core/brain.js';
import {
  initHub, connectRepo, disconnectRepo, syncHub, locateHub, listHubs, saveHub, openHubDb, indexHub, inbox,
} from '../src/core/hub.js';
import { wire, unwire, packageRoot } from '../src/core/wire.js';

let saved: Record<string, string | undefined>;
let base: string;

beforeEach(() => {
  saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, REINSTALL_HUB: process.env.REINSTALL_HUB };
  base = mkdtempSync(path.join(os.tmpdir(), 'rb-wire-'));
  const home = path.join(base, 'home');
  mkdirSync(home);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.REINSTALL_HUB;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function repo(name: string): string {
  const dir = path.join(base, name);
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}

describe('wiring', () => {
  it('links the brain skill, adds the session hook and guide blocks, and is idempotent', () => {
    const r = repo('alpha');
    initBrain(r, 'alpha');
    writeFileSync(path.join(r, 'CLAUDE.md'), '# Alpha\n\nOwn notes.\n');
    const first = wire(r, 'brain');
    expect(first.some((l) => l.kind === 'link' && l.what === '.claude/skills/brain')).toBe(true);
    expect(lstatSync(path.join(r, '.claude', 'skills', 'brain')).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(r, '.claude', 'skills', 'brain', 'SKILL.md'))).toBe(true);
    expect(existsSync(path.join(r, '.claude', 'skills', 'hub'))).toBe(false);
    const settings = JSON.parse(readFileSync(path.join(r, '.claude', 'settings.json'), 'utf8'));
    expect(JSON.stringify(settings.hooks.SessionStart)).toMatch(/reinstall-brain[\\/]+hooks[\\/]+session-start\.mjs/);
    const claude = readFileSync(path.join(r, 'CLAUDE.md'), 'utf8');
    expect(claude).toContain('Own notes.');
    expect(claude).toContain('brain/README.md');
    expect(readFileSync(path.join(r, 'AGENTS.md'), 'utf8')).toContain('brain/README.md');
    expect(readFileSync(path.join(r, '.gitignore'), 'utf8')).toContain('/.claude/skills/brain');

    const second = wire(r, 'brain');
    expect(second.filter((l) => l.kind !== 'ok')).toEqual([]);
    // One hook, not two.
    const again = JSON.parse(readFileSync(path.join(r, '.claude', 'settings.json'), 'utf8'));
    expect(JSON.stringify(again).match(/session-start\.mjs/g)!.length).toBe(1);
  });

  it('unwire removes only what wire added, and keeps brain/ and the owner\'s own lines', () => {
    const r = repo('delta');
    initBrain(r, 'delta');
    writeFileSync(path.join(r, 'CLAUDE.md'), '# Delta\n\nOwn notes.\n');
    mkdirSync(path.join(r, '.claude'), { recursive: true });
    writeFileSync(path.join(r, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }));
    wire(r, 'brain');
    const dry = unwire(r, { dryRun: true });
    expect(dry.length).toBeGreaterThan(3);
    expect(existsSync(path.join(r, '.claude', 'skills', 'brain'))).toBe(true);
    unwire(r);
    expect(existsSync(path.join(r, '.claude', 'skills', 'brain'))).toBe(false);
    expect(readFileSync(path.join(r, 'CLAUDE.md'), 'utf8')).toBe('# Delta\n\nOwn notes.\n');
    expect(existsSync(path.join(r, 'AGENTS.md'))).toBe(false);
    const settings = JSON.parse(readFileSync(path.join(r, '.claude', 'settings.json'), 'utf8'));
    expect(settings).toEqual({ permissions: { allow: ['Bash(ls)'] } });
    const gi = path.join(r, '.gitignore');
    if (existsSync(gi)) expect(readFileSync(gi, 'utf8')).not.toContain('reinstall-brain');
    expect(existsSync(path.join(r, 'brain', 'brain.yaml'))).toBe(true);
    expect(unwire(r)).toEqual([]);
  });

  it('repoints a link to an older skill, and leaves a real folder alone', () => {
    const r = repo('beta');
    initBrain(r, 'beta');
    const old = path.join(base, 'old-kit', 'skills', 'brain');
    mkdirSync(old, { recursive: true });
    mkdirSync(path.join(r, '.claude', 'skills'), { recursive: true });
    symlinkSync(old, path.join(r, '.claude', 'skills', 'brain'), process.platform === 'win32' ? 'junction' : 'dir');
    const lines = wire(r, 'hub');
    expect(lines.find((l) => l.what === '.claude/skills/brain')!.kind).toBe('relink');

    const r2 = repo('gamma');
    initBrain(r2, 'gamma');
    mkdirSync(path.join(r2, '.claude', 'skills', 'brain'), { recursive: true });
    expect(wire(r2, 'brain').find((l) => l.what === '.claude/skills/brain')!.kind).toBe('occupied');
  });
});

describe('hubs', () => {
  it('creates a hub, connects repos (making a brain where needed), and indexes them', async () => {
    const hubDir = path.join(base, 'my-hub');
    const r = initHub(hubDir);
    expect(r.hub.config.hub).toBe(true);
    expect(existsSync(path.join(hubDir, 'brain', 'HUB.md'))).toBe(true);
    expect(existsSync(path.join(hubDir, 'brain', 'priorities.md'))).toBe(true);
    expect(existsSync(path.join(hubDir, '.claude', 'skills', 'hub', 'SKILL.md'))).toBe(true);
    expect(existsSync(path.join(hubDir, '.claude', 'skills', 'brain', 'SKILL.md'))).toBe(true);

    const a = repo('alpha');
    initBrain(a, 'alpha');
    const o = await openFresh(openBrain(a));
    createRecord(o, { type: 'task', title: 'Alpha task' });
    o.db.close();
    const b = repo('beta'); // no brain yet

    let hub = locateHub(undefined, hubDir);
    const ca = connectRepo(hub, a);
    expect(ca.name).toBe('alpha');
    hub = openBrain(hub.root);
    const cb = connectRepo(hub, b);
    expect(cb.createdBrain).toBe(true);
    expect(existsSync(path.join(b, '.claude', 'skills', 'brain', 'SKILL.md'))).toBe(true);
    expect(existsSync(path.join(b, '.claude', 'skills', 'hub'))).toBe(false);

    hub = openBrain(hub.root);
    expect(hub.config.connects.map((c) => c.name)).toEqual(['alpha', 'beta']);
    expect(connectRepo(hub, a).already).toBe(true);

    const db = await openHubDb(hub);
    await indexHub(hub, db);
    expect(inbox(hub, db).map((i) => i.title)).toContain('Alpha task');
    // A hub item's file is the record's real path, so agents can link to it.
    for (const i of inbox(hub, db)) expect(existsSync(i.file)).toBe(true);
    db.close();

    expect(disconnectRepo(hub, 'beta')).toBe(true);
    expect(openBrain(hub.root).config.connects.map((c) => c.name)).toEqual(['alpha']);
    expect(syncHub(openBrain(hub.root)).lines.every((l) => !l.error)).toBe(true);
  });

  it('resolves a relative connects path from the hub folder', async () => {
    const hubDir = path.join(base, 'demo', 'acme-hub');
    initHub(hubDir);
    const w = path.join(base, 'demo', 'widgets');
    execFileSync('git', ['init', '-q', w]);
    initBrain(w, 'widgets');
    const o = await openFresh(openBrain(w));
    createRecord(o, { type: 'task', title: 'Widget task' });
    o.db.close();
    const yml = path.join(hubDir, 'brain', 'brain.yaml');
    writeFileSync(yml, readFileSync(yml, 'utf8').replace(/^connects:.*$/m, 'connects:\n  - name: widgets\n    path: ../widgets'));
    expect(openBrain(hubDir).config.connects.map((c) => c.path)).toEqual(['../widgets']);
    const db = await openHubDb(openBrain(hubDir));
    await indexHub(openBrain(hubDir), db);
    expect(inbox(openBrain(hubDir), db).map((i) => i.title)).toContain('Widget task');
    db.close();
  });

  it('supports many hubs on one machine, resolving by flag, folder, then default', () => {
    const one = initHub(path.join(base, 'hub-one')).hub;
    const two = initHub(path.join(base, 'hub-two')).hub;
    const hubs = listHubs();
    expect(hubs.map((h) => h.name).sort()).toEqual(['hub-one', 'hub-two']);
    expect(hubs.find((h) => h.default)!.name).toBe('hub-one');

    const shared = repo('shared');
    connectRepo(one, shared);
    connectRepo(two, shared); // a repo can belong to two hubs

    const elsewhere = repo('elsewhere');
    expect(locateHub(undefined, elsewhere).config.name).toBe('hub-one');
    expect(locateHub('hub-two', elsewhere).config.name).toBe('hub-two');
    expect(locateHub(undefined, two.root).config.name).toBe('hub-two');
    process.env.REINSTALL_HUB = 'hub-two';
    expect(locateHub(undefined, elsewhere).config.name).toBe('hub-two');
    delete process.env.REINSTALL_HUB;
    saveHub('hub-two');
    expect(locateHub(undefined, elsewhere).config.name).toBe('hub-two');
  });

  it('adopts an existing brain with connects as a hub', () => {
    const dir = repo('old-hub');
    initBrain(dir, 'old-hub');
    const a = repo('alpha');
    initBrain(a, 'alpha');
    writeFileSync(path.join(dir, 'brain', 'brain.yaml'), `format: 1\nname: old-hub\n# my note\nconnects:\n  - name: alpha\n    path: ${a}\n`);
    const r = initHub(dir);
    expect(r.adopted).toBe(true);
    const yaml = readFileSync(path.join(dir, 'brain', 'brain.yaml'), 'utf8');
    expect(yaml).toContain('# my note');
    expect(yaml).toMatch(/^hub: true$/m);
    expect(r.hub.config.connects.map((c) => c.name)).toEqual(['alpha']);
  });

  it('ships the skills it wires', () => {
    for (const s of ['brain', 'hub']) expect(existsSync(path.join(packageRoot(), 'skills', s, 'SKILL.md'))).toBe(true);
  });
});

describe('goals', () => {
  it('ties tasks to project goals and hub goals, ranks goals, and finds unserved tasks', async () => {
    const { goalsReport } = await import('../src/core/ops.js');
    const { goals, placeGoal, cover, place, priorities, readPrioritiesFile } = await import('../src/core/hub.js');
    const hubDir = path.join(base, 'goal-hub');
    let hub = initHub(hubDir).hub;
    const a = repo('alpha');
    initBrain(a, 'alpha');
    let o = await openFresh(openBrain(a));
    const pg = createRecord(o, { type: 'goal', title: 'Importer live', extra: { done_when: 'three customers import', measure: 'count imports' } });
    const t1 = createRecord(o, { type: 'task', title: 'Build importer', extra: { serves: pg.id } });
    const t2 = createRecord(o, { type: 'task', title: 'Loose end' });
    expect(goalsReport(o).goals[0].open_tasks).toBe(1);
    expect(goalsReport(o).unserved.map((t) => t.title)).toEqual(['Loose end']);
    o.db.close();
    connectRepo(hub, a);
    hub = openBrain(hub.root);
    o = await openFresh(hub);
    const hg = createRecord(o, { type: 'goal', title: 'First paying client', extra: { done_when: 'invoice paid' } });
    o.db.close();

    let db = await openHubDb(hub);
    await indexHub(hub, db);
    await cover(hub, db, `goal-hub/${hg.id}`, `alpha/${pg.id}`);
    await indexHub(hub, db);
    const items = inbox(hub, db);
    const built = items.find((i) => i.title === 'Build importer')!;
    expect(built.goal).toBe(`alpha/${pg.id}`);
    expect(built.hub_goal).toBe(`goal-hub/${hg.id}`);
    expect(built.hub_goal_title).toBe('First paying client');
    expect(items.find((i) => i.title === 'Loose end')!.goal).toBeNull();

    placeGoal(hub, db, `goal-hub/${hg.id}`, { top: true });
    place(hub, db, `alpha/${t1.id}`, { top: true });
    const file = readPrioritiesFile(hub);
    expect(file.goals).toEqual([`goal-hub/${hg.id}`]);
    expect(file.tasks).toEqual([`alpha/${t1.id}`]);
    const g = goals(hub, db);
    expect(g.ranked[0].open_tasks).toBe(1); // the hub goal, through its project goal
    expect(g.unranked.map((x) => x.title)).toEqual(['Importer live']);
    expect(priorities(hub, db).ranked[0].goal_title).toBe('Importer live');
    db.close();
    void t2;
  });

  it('lints serves and covers', async () => {
    const { lintBrain } = await import('../src/core/indexer.js');
    const r = repo('lint-goals');
    initBrain(r, 'lint-goals');
    const o = await openFresh(openBrain(r));
    const note = createRecord(o, { type: 'note', title: 'Not a goal' });
    createRecord(o, { type: 'task', title: 'Bad serves', extra: { serves: note.id } });
    createRecord(o, { type: 'goal', title: 'Bad covers', extra: { covers: ['not a key'] } });
    const issues = lintBrain(o.brain, o.db).map((i) => i.message);
    o.db.close();
    expect(issues.some((m) => /serves ".*" is a note, not a goal/.test(m))).toBe(true);
    expect(issues.some((m) => /covers entry "not a key"/.test(m))).toBe(true);
    expect(issues.some((m) => /done_when/.test(m))).toBe(true);
  });
});
