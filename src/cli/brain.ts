#!/usr/bin/env node
import path from 'node:path';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { wire, unwire, formatWire, packageRoot } from '../core/wire.js';
import { hubsConnecting } from '../core/hub.js';
import { openDb } from '../core/sqlite.js';
import { doctor } from '../core/doctor.js';
import { VERSION } from '../core/version.js';
import { locateBrain, requireBrain } from '../core/brain.js';
import { lintBrain, refresh, planDrift } from '../core/indexer.js';
import {
  openFresh, findRecord, listRecords, searchRecords, runSql, createRecord, updateRecord, supersede,
  initBrain, defaultBrainName, goalsReport, type RecordRow,
} from '../core/ops.js';
import { parseArgs, preflight } from './args.js';

const HELP = `reinstall-brain ${VERSION}: a git-native record store for agents and humans.

Usage: reinstall-brain <command> [options]     (add --json to any read command for machine output)

Read
  list [--type T] [--status S] [--tag X] [--scope P] [--limit N]
  search "<words>" [--limit N]       full-text search over titles, bodies and tags
  show <id>                          one record; also accepts a legacy id such as 512 or #512
  sql "<SELECT ...>"                 read-only SQL over the index (table: records)
  goals [--all]                      goals, how many open tasks serve each, and tasks that serve none

Write
  new <type> "<title>" [--body TEXT|--body-file F] [--tag X]... [--parent ID] [--scope P] [--author WHO] [--set field=value]...
                                     a goal takes --set done_when=... --set measure=...; a task --set serves=<goal id>
  set <id> [field=value...] [--log "who: what"] [--body TEXT|--body-file F]
                                     change fields (meta.key=value for nested; "" removes), add a log line, or replace the body
  done <id> [--log "who: what happened"]
  supersede <old-id> <new-id>        the new record replaces the old one

Maintain
  init [--name NAME] [--no-wire]     create brain/ in the current repository and wire its skill and guide
  wire [--dry-run]                   re-link this repo's skills, session hook and guide lines
  unwire [--dry-run]                 remove what wire added (skill links, hook, CLAUDE.md/AGENTS.md/.gitignore
                                     blocks); brain/ stays. Warns when a hub still connects it
  update                             git pull this install, rebuild, and re-wire every hub
  index [--rebuild]                  refresh the index (every command does this first)
  lint [--fix] [--author WHO]        check every record; exit 1 on errors. --fix closes phase tasks
                                     whose plan file marks the phase done
  context [--agent NAME]             print what the session hook loads (open tasks, questions, decisions,
                                     goals; a hub's ranking), for agents with no session hook
  where                              print the brain this folder uses
  kitdb <name> "<sql>" [--json]      read/write SQL on a kit's own live-state database, brain/.local/<name>.db
  doctor [--fetch]                   check this machine can run the brain, and that it runs the clone's current
                                     build, level with GitHub (--fetch checks GitHub now), with no other copy on PATH
  version
`;

/** Parse field=value pairs. Dotted keys (meta.plan_id=002) set nested values; list fields split on commas; "" removes. */
/** A list field's value: `a,b` or a JSON array `["a","b"]`. */
function listValue(raw: string): string[] {
  const t = raw.trim();
  if (t.startsWith('[')) {
    try {
      const v = JSON.parse(t);
      if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
    } catch {}
  }
  return raw.split(',').map((x) => x.trim()).filter(Boolean);
}

function parseAssignments(pairs: string[]): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const kv of pairs) {
    const i = kv.indexOf('=');
    if (i < 1) throw new Error(`"${kv}" is not field=value`);
    const key = kv.slice(0, i);
    const raw = kv.slice(i + 1);
    if (key === 'body') throw new Error('the body is not a field: use --body TEXT or --body-file F');
    const value =
      raw === '' ? undefined
      : ['tags', 'blocked_by', 'docs', 'covers'].includes(key) ? listValue(raw)
      : key === 'importance' && /^-?\d+$/.test(raw) ? Number(raw)
      : raw;
    const parts = key.split('.');
    if (parts.length === 1) changes[key] = value;
    else {
      let node = (changes[parts[0]] ??= {}) as Record<string, unknown>;
      for (const part of parts.slice(1, -1)) node = (node[part] ??= {}) as Record<string, unknown>;
      node[parts.at(-1)!] = value;
    }
  }
  return changes;
}

function printRecords(rows: RecordRow[]): void {
  for (const r of rows) console.log(`${r.id}  ${r.type.padEnd(9)} ${r.status.padEnd(10)} ${r.title}`);
  if (rows.length === 0) console.log('(none)');
}

async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv);
  const [cmd, ...pos] = a.positional;
  const stop = preflight(a, 'reinstall-brain', HELP, cmd);
  if (stop !== null) return stop;
  const json = a.flag('json');
  const out = (value: unknown, human: () => void) => (json ? console.log(JSON.stringify(value, null, 2)) : human());

  switch (cmd) {
    case 'doctor': {
      const r = await doctor();
      // Is this the clone's current build, level with GitHub, and the only copy on PATH?
      try {
        const f = JSON.parse(execFileSync(process.execPath, [path.join(packageRoot(), 'scripts', 'freshness.mjs'), '--json', ...(a.flag('fetch') ? ['--fetch'] : [])], { encoding: 'utf8', timeout: 30000 }));
        r.problems.push(...f.problems);
        if (f.problems.length) r.ok = false;
      } catch {}
      out(r, () => {
        console.log(`${r.ok ? 'ok' : 'FAIL'}  reinstall-brain ${r.version} on ${r.runtime}, ${r.platform}`);
        console.log(`    sqlite ${r.sqlite}, fts5 ${r.fts5 ? 'yes' : 'no'}, frontmatter ${r.frontmatter ? 'yes' : 'no'}`);
        for (const p of r.problems) console.log(`    problem: ${p}`);
      });
      return r.ok ? 0 : 1;
    }
    case 'version':
    case '--version': {
      // The version, and the commit dist/ was built from (scripts/freshness.mjs writes the stamp).
      let from = '';
      try {
        from = String(JSON.parse(readFileSync(path.join(packageRoot(), 'dist', '.build-stamp.json'), 'utf8')).head || '').slice(0, 7);
      } catch {}
      console.log(from ? `${VERSION} (built from ${from})` : VERSION);
      return 0;
    }
    case undefined:
    case 'help':
    case '--help':
      process.stdout.write(HELP);
      return 0;
    case 'init': {
      const root = locateBrain() ?? process.cwd();
      const { created, brain } = initBrain(root, a.value('name') ?? defaultBrainName(root));
      const wired = a.flag('no-wire') ? [] : wire(brain.root, brain.config.hub ? 'hub' : 'brain');
      out({ root: brain.root, name: brain.config.name, created, wired }, () => {
        console.log(`brain "${brain.config.name}" at ${path.join(brain.root, 'brain')}`);
        for (const c of created) console.log(`  created ${c}`);
        const w = formatWire(wired);
        if (w) console.log(w);
        if (created.length === 0 && !w) console.log('  already set up; nothing changed');
      });
      return 0;
    }
    case 'wire': {
      const brain = requireBrain();
      const wired = wire(brain.root, brain.config.hub ? 'hub' : 'brain', { dryRun: a.flag('dry-run') });
      out(wired, () => console.log(formatWire(wired) || 'wired; nothing changed'));
      return 0;
    }
    case 'context': {
      // The same text the session hook gives agents that have one (Claude Code, Codex): one code path.
      const hook = path.join(packageRoot(), 'hooks', 'session-start.mjs');
      const args = [hook, '--text', '--agent', a.value('agent') ?? 'agent'];
      process.stdout.write(execFileSync(process.execPath, args, { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '' } }));
      return 0;
    }
    case 'unwire': {
      const brain = requireBrain();
      const done = unwire(brain.root, { dryRun: a.flag('dry-run') });
      const hubs = hubsConnecting(brain.root);
      out({ removed: done, connectedTo: hubs }, () => {
        console.log(formatWire(done) || 'nothing to remove');
        if (hubs.length) console.log(`note: ${hubs.join(', ')} connect${hubs.length === 1 ? 's' : ''} this repo, and a sync there wires it again: reinstall-hub disconnect <name> --hub <hub> first`);
      });
      return 0;
    }
    case 'update': {
      const pkg = packageRoot();
      const run = (cmdName: string, args: string[]) => execFileSync(cmdName, args, { cwd: pkg, stdio: 'inherit', shell: process.platform === 'win32' });
      if (!existsSync(path.join(pkg, '.git'))) throw new Error(`${pkg} is not a git clone; update it the way you installed it`);
      run('git', ['pull', '--ff-only']);
      run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund']);
      run('npm', ['run', 'build']);
      run(process.execPath, [path.join(pkg, 'dist', 'cli', 'hub.js'), 'sync', '--all']);
      return 0;
    }
    case 'kitdb': {
      const [name, ...sqlParts] = pos;
      if (!name || !/^[a-z0-9-]+$/.test(name) || !sqlParts.length) throw new Error('usage: reinstall-brain kitdb <name> "<sql>"');
      const brain = requireBrain();
      mkdirSync(path.join(brain.dir, '.local'), { recursive: true });
      const db = await openDb(path.join(brain.dir, '.local', `${name}.db`));
      try {
        const sql = sqlParts.join(' ');
        const rows = /^\s*(select|with|pragma)\b/i.test(sql) ? db.prepare(sql).all() : (db.exec(sql), []);
        out(rows, () => { if (rows.length) console.table(rows); });
      } finally {
        db.close();
      }
      return 0;
    }
    case 'where': {
      const brain = requireBrain();
      out({ root: brain.root, dir: brain.dir, name: brain.config.name }, () => console.log(brain.dir));
      return 0;
    }
  }

  const brain = requireBrain();
  const opened = await openFresh(brain, cmd === 'index' && a.flag('rebuild'));
  try {
    switch (cmd) {
      case 'index': {
        const r = opened.refreshed;
        out(r, () => {
          console.log(`indexed ${r.scanned} files: ${r.added} added, ${r.updated} updated, ${r.removed} removed`);
          for (const e of r.errors) console.log(`  error ${e.path}: ${e.error}`);
        });
        return r.errors.length ? 1 : 0;
      }
      case 'list': {
        const rows = listRecords(opened, {
          type: a.value('type'), status: a.value('status'), tag: a.value('tag'), scope: a.value('scope'),
          limit: a.value('limit') ? Number(a.value('limit')) : undefined,
        });
        out(rows, () => printRecords(rows));
        return 0;
      }
      case 'goals': {
        const r = goalsReport(opened, { all: a.flag('all') });
        out(r, () => {
          for (const g of r.goals) {
            const f = g.fields;
            console.log(`${g.id}  ${g.status === 'active' ? '' : `[${g.status}] `}${g.title}${f.due ? `  (due ${f.due})` : ''}`);
            console.log(`      ${g.open_tasks} open task(s) serve it, ${g.done_tasks} done${f.measure ? `; measure: ${f.measure}` : ''}`);
          }
          if (!r.goals.length) console.log('(no goals yet: reinstall-brain new goal "<the outcome>" --set done_when="..." --set measure="...")');
          console.log(`${r.unserved.length} open task(s) serve no goal`);
        });
        return 0;
      }
      case 'search': {
        if (!pos.length) throw new Error('usage: reinstall-brain search "<words>"');
        const rows = searchRecords(opened, pos.join(' '), a.value('limit') ? Number(a.value('limit')) : 25);
        out(rows, () => {
          for (const r of rows) console.log(`${r.id}  ${r.type.padEnd(9)} ${r.title}\n      ${r.snippet.replace(/\s+/g, ' ')}`);
          if (!rows.length) console.log('(no matches)');
        });
        return 0;
      }
      case 'show': {
        const r = pos[0] ? findRecord(opened, pos[0]) : undefined;
        if (!r) throw new Error(`no record "${pos[0] ?? ''}"`);
        out(r, () => {
          console.log(r.path);
          console.log(JSON.stringify(r.fields, null, 2));
          console.log('');
          console.log(r.body);
        });
        return 0;
      }
      case 'sql': {
        const rows = runSql(opened, pos.join(' '));
        out(rows, () => console.table(rows));
        return 0;
      }
      case 'new': {
        const [type, ...titleParts] = pos;
        if (!type || !titleParts.length) throw new Error('usage: reinstall-brain new <type> "<title>"');
        const bodyFile = a.value('body-file');
        const r = createRecord(opened, {
          type, title: titleParts.join(' '),
          body: bodyFile ? readFileSync(bodyFile === '-' ? 0 : bodyFile, 'utf8') : a.value('body'),
          tags: a.values('tag'), parent: a.value('parent'), scope: a.value('scope'), author: a.value('author'),
          extra: parseAssignments(a.values('set')),
        });
        out(r, () => console.log(`${r.id}  ${r.path}`));
        return 0;
      }
      case 'set': {
        const [ref, ...assignments] = pos;
        const newBody = a.value('body-file') !== undefined ? readFileSync(a.value('body-file') === '-' ? 0 : a.value('body-file')!, 'utf8') : a.value('body');
        if (!ref || (!assignments.length && !a.value('log') && newBody === undefined)) {
          throw new Error('usage: reinstall-brain set <id> [field=value...] [--log "who: what"] [--body TEXT|--body-file F]');
        }
        const r = updateRecord(opened, ref, parseAssignments(assignments), a.value('log'), newBody);
        out(r, () => console.log(`${r.id}  ${r.path}`));
        return 0;
      }
      case 'done': {
        if (!pos[0]) throw new Error('usage: reinstall-brain done <id>');
        const r = updateRecord(opened, pos[0], { status: 'done' }, a.value('log'));
        out(r, () => console.log(`${r.id}  done  ${r.title}`));
        return 0;
      }
      case 'supersede': {
        if (pos.length < 2) throw new Error('usage: reinstall-brain supersede <old-id> <new-id>');
        const r = supersede(opened, pos[0], pos[1]);
        out(r, () => console.log(`${r.old.id} superseded by ${r.replacement.id}`));
        return 0;
      }
      case 'lint': {
        if (a.flag('fix')) {
          // The one fix lint makes: close phase tasks their plan file already marks done.
          for (const d of planDrift(brain, opened.db)) {
            updateRecord(opened, d.id, { status: 'done' }, `${a.value('author') ?? 'reinstall-brain lint --fix'}: closed, ${d.plan} marks phase ${d.phase} done`);
            if (!json) console.log(`closed ${d.id}  ${d.title}`);
          }
          await refresh(brain, opened.db);
        }
        const issues = lintBrain(brain, opened.db);
        const errors = issues.filter((i) => i.level === 'error').length;
        out({ errors, warnings: issues.length - errors, issues }, () => {
          for (const i of issues) console.log(`${i.level === 'error' ? 'error  ' : 'warning'} ${i.path}: ${i.message}`);
          console.log(`${opened.refreshed.scanned} files, ${errors} errors, ${issues.length - errors} warnings`);
        });
        return errors ? 1 : 0;
      }
      default:
        process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
        return 2;
    }
  } finally {
    opened.db.close();
  }
}

// Set the exit code and let Node exit on its own: process.exit() right after a large write to a
// pipe truncates stdout at the pipe buffer (64 KB).
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`reinstall-brain: ${(e as Error).message}\n`);
    process.exitCode = 1;
  },
);
