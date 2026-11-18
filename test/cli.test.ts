// The CLIs are safe to probe: -h/--help never runs a command, an unknown flag is refused, and every
// flag a command reads is one its help names. (GitHub issues #1 and #2.)
import { describe, it, expect, vi } from 'vitest';

// Windows runners are slow at spawning processes and git init.
vi.setConfig({ testTimeout: 30000 });
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { knownFlags, commandHelp, GLOBAL_FLAGS } from '../src/cli/args.js';
import { normalizeTags } from '../src/core/record.js';

const ROOT = path.resolve(__dirname, '..');
const help = (f: string) => /const HELP = `([\s\S]*?)`;/.exec(readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n'))![1];
const run = (tool: 'brain' | 'hub', args: string[], cwd: string) =>
  // The built CLI (CI and `npm test` after `npm run build`): it is what agents probe.
  spawnSync(process.execPath, [path.join(ROOT, 'dist', 'cli', `${tool}.js`), ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, HOME: cwd, USERPROFILE: cwd, REINSTALL_BRAIN_CONFIG_DIR: path.join(cwd, '.cfg') },
  });

describe('CLI safety', () => {
  for (const f of ['src/cli/brain.ts', 'src/cli/hub.ts']) {
    it(`${f}: every flag a command reads is named in its help`, () => {
      const src = readFileSync(path.join(ROOT, f), 'utf8');
      const read = [...src.matchAll(/a\.(?:flag|value|values)\('([a-z-]+)'\)/g)].map((m) => m[1]);
      const known = knownFlags(help(f));
      expect(read.filter((k) => !known.has(k))).toEqual([]);
    });
  }

  it('finds one command\'s help', () => {
    expect(commandHelp(help('src/cli/brain.ts'), 'init')).toMatch(/^ {2}init /);
    expect(commandHelp(help('src/cli/brain.ts'), 'nope')).toBeNull();
    expect(GLOBAL_FLAGS).toContain('json');
  });

  it('--help and -h on a command that writes never run it', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'rb-help-'));
    execFileSync('git', ['init', '-q', dir]);
    for (const args of [['init', '--help'], ['init', '-h'], ['wire', '--help'], ['unwire', '-h']]) {
      const r = run('brain', args, dir);
      expect(r.status, args.join(' ')).toBe(0);
      expect(r.stdout).toMatch(/Usage: reinstall-brain/);
    }
    for (const args of [['init', '--help'], ['connect', '.', '--help']]) expect(run('hub', args, dir).status).toBe(0);
    expect(readdirSync(dir).sort()).toEqual(['.git']);
  });

  it('refuses an unknown flag instead of running without it', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'rb-flag-'));
    execFileSync('git', ['init', '-q', dir]);
    const r = run('brain', ['init', '--dryrun'], dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unknown flag --dryrun/);
    expect(readdirSync(dir).sort()).toEqual(['.git']);
  });
});

describe('feedback', () => {
  it('shows the issue and files nothing without --yes; a title may start with --', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'rb-fb-'));
    const r = run('brain', ['feedback', '--tag does not split commas', '--kind', 'nit', '--body', 'Seen while seeding.'], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/# NIT: --tag does not split commas/);
    expect(r.stdout).toMatch(/reinstall-brain \d+\.\d+\.\d+/);
    expect(r.stdout).not.toContain(dir);
  });

  it('refuses an issue that names a private word', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'rb-fb-'));
    writeFileSync(path.join(dir, 'words.txt'), '# private\nAcmeSecretClient\n');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'dist', 'cli', 'brain.js'), 'feedback', 'Broke for acmesecretclient'], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, REINSTALL_BRAIN_PRIVATE_WORDS: path.join(dir, 'words.txt') },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/private-words/);
  });
});

describe('tags', () => {
  it('splits commas, in a string or in a list', () => {
    expect(normalizeTags('research,pipeline')).toEqual(['pipeline', 'research']);
    expect(normalizeTags(['research,pipeline', 'Ops'])).toEqual(['ops', 'pipeline', 'research']);
  });
});
