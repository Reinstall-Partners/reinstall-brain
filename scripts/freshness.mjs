// Is the reinstall-brain this machine runs the one in its clone, built from the clone's current
// source, and level with GitHub? One answer for every caller: the build stamps it (stamp-build.mjs),
// the session hook says what is stale, and `reinstall-brain doctor` / `version` report it.
//
//   node scripts/freshness.mjs [--json] [--fetch]
//
//   - built:   dist/ was built from the source on disk (a hash of src/, templates/ and the build inputs,
//              so a pull that touches only docs never reads as stale, and a pull that was not rebuilt
//              always does);
//   - behind:  commits on the clone's upstream not pulled yet, from the last fetch (--fetch, or the
//              session hook at most once a day, in the background);
//   - copies:  every `reinstall-brain` on PATH that runs a different copy than this clone.
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INPUTS = ['src', 'templates', 'package.json', 'package-lock.json', 'tsconfig.json', 'scripts/gen-templates.mjs'];
const STAMP = path.join(PKG, 'dist', '.build-stamp.json');
const FETCH_EVERY_MS = 20 * 3600e3;

function files(rel) {
  const abs = path.join(PKG, rel);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return [rel];
  return fs.readdirSync(abs).sort().flatMap((n) => (n === 'templates.gen.ts' ? [] : files(path.join(rel, n))));
}

/** A hash of everything the build reads. Line endings are normalized, so a Windows checkout agrees. */
export function sourceHash() {
  const h = createHash('sha256');
  for (const f of INPUTS.flatMap(files)) {
    h.update(f.split(path.sep).join('/'));
    h.update('\0');
    h.update(fs.readFileSync(path.join(PKG, f), 'utf8').replace(/\r\n/g, '\n'));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: PKG, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
  } catch {
    return '';
  }
}

export function writeStamp() {
  fs.mkdirSync(path.dirname(STAMP), { recursive: true });
  fs.writeFileSync(STAMP, `${JSON.stringify({ src: sourceHash(), head: git(['rev-parse', 'HEAD']), at: new Date().toISOString() })}\n`);
}

export function readStamp() {
  try {
    return JSON.parse(fs.readFileSync(STAMP, 'utf8'));
  } catch {
    return null;
  }
}

/** Fetch the upstream now (--fetch), or in the background when the last fetch is older than a day. */
export function fetchUpstream({ wait = false } = {}) {
  if (!fs.existsSync(path.join(PKG, '.git'))) return;
  if (wait) return void git(['fetch', '--quiet']);
  const fh = git(['rev-parse', '--git-path', 'FETCH_HEAD']);
  let age = Infinity;
  try {
    age = Date.now() - fs.statSync(path.resolve(PKG, fh)).mtimeMs;
  } catch {}
  if (age < FETCH_EVERY_MS) return;
  try {
    spawn('git', ['fetch', '--quiet'], { cwd: PKG, detached: true, stdio: 'ignore' }).unref();
  } catch {}
}

/** Other `reinstall-brain` commands on PATH that do not run this clone. */
function otherCopies() {
  const out = [];
  const seen = new Set();
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const name of process.platform === 'win32' ? ['reinstall-brain.cmd', 'reinstall-brain.ps1'] : ['reinstall-brain']) {
      const p = path.join(dir, name);
      if (seen.has(p) || !fs.existsSync(p)) continue;
      seen.add(p);
      let target = p;
      try {
        target = fs.realpathSync(p);
      } catch {}
      let text = '';
      try {
        text = fs.readFileSync(target, 'utf8').slice(0, 4000);
      } catch {}
      const pkgReal = fs.realpathSync(PKG);
      const ours = target.startsWith(pkgReal + path.sep) || text.includes(pkgReal) || text.includes('.reinstall-brain');
      if (!ours) out.push(target);
    }
  }
  return out;
}

export function freshness() {
  const stamp = readStamp();
  const src = sourceHash();
  const isGit = fs.existsSync(path.join(PKG, '.git'));
  const upstream = isGit ? git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']) : '';
  const behind = upstream ? Number(git(['rev-list', '--count', 'HEAD..@{u}']) || 0) : null;
  return {
    pkg: PKG,
    head: isGit ? git(['rev-parse', '--short', 'HEAD']) : null,
    built: !!stamp && stamp.src === src,
    builtFrom: stamp ? (stamp.head || '').slice(0, 7) : null,
    upstream: upstream || null,
    behind,
    copies: otherCopies(),
  };
}

/** One line per problem, for people: empty when all is well. */
export function staleLines(f = freshness()) {
  const out = [];
  if (!f.built) out.push('Reinstall Brain\'s source changed since it was built (a pull without a rebuild): run `reinstall-brain update`.');
  if (f.behind) out.push(`Reinstall Brain is ${f.behind} commit${f.behind === 1 ? '' : 's'} behind ${f.upstream}: run \`reinstall-brain update\`.`);
  for (const c of f.copies) out.push(`Another reinstall-brain on PATH runs a different copy (${c}): remove it, or re-run setup.mjs in the clone you use.`);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--stamp')) {
    writeStamp();
  } else {
    if (process.argv.includes('--fetch')) fetchUpstream({ wait: true });
    const f = freshness();
    if (process.argv.includes('--json')) console.log(JSON.stringify({ ...f, problems: staleLines(f) }));
    else console.log(staleLines(f).join('\n') || `current: built from ${f.builtFrom}, level with ${f.upstream || 'its clone'}`);
  }
}
