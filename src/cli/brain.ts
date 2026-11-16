#!/usr/bin/env node
import path from 'node:path';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { wire, formatWire, packageRoot } from '../core/wire.js';
import { openDb } from '../core/sqlite.js';
import { doctor } from '../core/doctor.js';
import { VERSION } from '../core/version.js';
import { locateBrain, requireBrain } from '../core/brain.js';
import { lintBrain, refresh } from '../core/indexer.js';
import {
  openFresh, findRecord, listRecords, searchRecords, runSql, createRecord, updateRecord, supersede,
  initBrain, defaultBrainName, goalsReport, type RecordRow,
} from '../core/ops.js';
import { parseArgs } from './args.js';
import { migrateBrain } from '../core/migrate.js';

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
  update                             git pull this install, rebuild, and re-wire every hub
  index [--rebuild]                  refresh the index (every command does this first)
  migrate [--from cowork/brain/BRAIN.db] [--dry-run] [--move-docs]
                                     convert a TB Claude Kit brain into records (one-time)
  lint                               check every record; exit 1 on errors
  where                              print the brain this folder uses
  kitdb <name> "<sql>" [--json]      read/write SQL on a kit's own live-state database, brain/.local/<name>.db
  doctor                             check this machine can run the brain
  version
`;

/** Parse field=value pairs. Dotted keys (meta.plan_id=002) set nested values; list fields split on commas; "" removes. */
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
      : ['tags', 'blocked_by', 'docs', 'covers'].includes(key) ? raw.split(',').map((x) => x.trim()).filter(Boolean)
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
  const json = a.flag('json');
  const out = (value: unknown, human: () => void) => (json ? console.log(JSON.stringify(value, null, 2)) : human());

  switch (cmd) {
    case 'doctor': {
      const r = await doctor();
      out(r, () => {
        console.log(`${r.ok ? 'ok' : 'FAIL'}  reinstall-brain ${r.version} on ${r.runtime}, ${r.platform}`);
        console.log(`    sqlite ${r.sqlite}, fts5 ${r.fts5 ? 'yes' : 'no'}, frontmatter ${r.frontmatter ? 'yes' : 'no'}`);
        for (const p of r.problems) console.log(`    problem: ${p}`);
      });
      return r.ok ? 0 : 1;
    }
    case 'version':
    case '--version':
      console.log(VERSION);
      return 0;
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
      case 'migrate': {
        const from = path.resolve(a.value('from') ?? path.join(brain.root, 'cowork', 'brain', 'BRAIN.db'));
        const r = await migrateBrain(brain, { from, dryRun: a.flag('dry-run'), moveDocs: a.flag('move-docs') });
        if (r.written) refresh(brain, opened.db);
        const issues = r.written ? lintBrain(brain, opened.db) : [];
        const errors = issues.filter((i) => i.level === 'error');
        out({ ...r, lintErrors: errors }, () => {
          console.log(`${r.written ? 'migrated' : 'dry run:'} ${r.records} records from ${r.source}`);
          const keys = [...new Set([...Object.keys(r.sourceCounts), ...Object.keys(r.migratedCounts)])].sort();
          for (const k of keys) {
            const s = r.sourceCounts[k] ?? 0;
            const m = r.migratedCounts[k] ?? 0;
            console.log(`  ${k.padEnd(22)} ${String(s).padStart(5)} -> ${String(m).padStart(5)}${s === m ? '' : '   MISMATCH'}`);
          }
          if (r.skipped.length) console.log(`  skipped ${r.skipped.length}: ${[...new Set(r.skipped.map((x) => x.reason))].join('; ')}`);
          console.log(`  unresolved links ${r.unresolvedLinks.length}, path rewrites ${r.pathRewrites}, ranking rows ${r.rankingExported}`);
          if (r.updated.length) console.log(`  caught up ${r.updated.length} records whose old row changed since the last run`);
          for (const c of r.conflicts) console.log(`  CONFLICT legacy #${c.legacy_id} -> ${c.path}: changed in both the old brain and the record; left alone`);
          for (const [t, n] of Object.entries(r.swarmRowsExported)) console.log(`  swarm table ${t}: ${n} rows exported to brain/.local/legacy-swarm.json`);
          for (const d of r.docsMoved) console.log(`  moved ${d}`);
          if (r.written) console.log(`  lint: ${errors.length} errors, ${issues.length - errors.length} warnings`);
          for (const e of errors.slice(0, 20)) console.log(`    ${e.path}: ${e.message}`);
        });
        return (r.written && errors.length) || r.conflicts.length ? 1 : 0;
      }
      case 'lint': {
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
