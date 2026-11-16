import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, lstatSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { initBrain, openFresh, createRecord } from '../src/core/ops.js';
import { openBrain } from '../src/core/brain.js';
import {
  initHub, connectRepo, disconnectRepo, syncHub, locateHub, listHubs, saveHub, openHubDb, indexHub, inbox,
} from '../src/core/hub.js';
import { wire, packageRoot } from '../src/core/wire.js';

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
    expect(second.every((l) => l.kind === 'ok')).toBe(true);
    // One hook, not two.
    const again = JSON.parse(readFileSync(path.join(r, '.claude', 'settings.json'), 'utf8'));
    expect(JSON.stringify(again).match(/session-start\.mjs/g)!.length).toBe(1);
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
