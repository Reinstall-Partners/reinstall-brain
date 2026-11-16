#!/usr/bin/env node
// Reinstall Brain: set up this machine from a git clone. Run once per machine, and again after
// moving the clone.
//
//   git clone https://github.com/Reinstall-Partners/reinstall-brain ~/dev/reinstall-brain
//   node ~/dev/reinstall-brain/setup.mjs [--hub <folder>] [--dry-run]
//
// It:
//   1. checks Node is 22.13 or newer (the built-in SQLite needs it; nothing native is compiled).
//   2. installs dependencies and builds the CLI (npm install runs the build).
//   3. points ~/.reinstall-brain at this clone (a symlink; a junction on Windows). Every wired folder
//      links its skills through that pointer, so a `git pull` here updates all of them at once.
//   4. puts `reinstall-brain` and `reinstall-hub` on your PATH with `npm link`.
//   5. with --hub <folder>: creates (or adopts) a hub there and wires its skills.
//
// Then: open the hub folder with your agent and run /hub, or `reinstall-hub connect <repo>`.
// Later: `reinstall-brain update` pulls, rebuilds and re-wires every hub.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const IS_WIN = process.platform === 'win32';
const HERE = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)));
const POINTER = path.join(os.homedir(), '.reinstall-brain');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const hubAt = (() => {
  const i = args.findIndex((a) => a === '--hub' || a.startsWith('--hub='));
  if (i < 0) return null;
  return args[i].includes('=') ? args[i].split('=')[1] : args[i + 1];
})();
if (args.includes('--help') || args.includes('-h')) {
  const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  console.log(src.slice(1).filter((l) => l.startsWith('//')).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

const say = (s) => console.log(s);
const run = (cmd, a, opts = {}) => {
  say(`  $ ${cmd} ${a.join(' ')}`);
  if (dryRun) return '';
  return execFileSync(cmd, a, { cwd: HERE, stdio: 'inherit', shell: IS_WIN, ...opts });
};

say(`Reinstall Brain setup${dryRun ? ' (dry run: nothing will be changed)' : ''}\n`);

// 1. Node.
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 13)) {
  console.error(`Node ${process.versions.node} is too old: Reinstall Brain needs Node 22.13 or newer (for its built-in SQLite).`);
  process.exit(1);
}
say(`[ok] Node ${process.versions.node}`);

// 2. Build.
say('[build] installing dependencies and building the CLI');
// Scripts are skipped on install and the build is run by name: newer npm versions hold back
// lifecycle scripts (prepare) until they are approved.
run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund']);
run('npm', ['run', 'build']);

// 3. Pointer.
let st = null;
try {
  st = fs.lstatSync(POINTER);
} catch {}
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};
if (!st) {
  if (!dryRun) fs.symlinkSync(HERE, POINTER, IS_WIN ? 'junction' : 'dir');
  say(`[link] ~/.reinstall-brain -> ${HERE}`);
} else if (!st.isSymbolicLink()) {
  console.error(`~/.reinstall-brain is a real folder, not a link. Move it aside, then re-run.`);
  process.exit(1);
} else if (real(POINTER) === HERE) {
  say(`[ok] ~/.reinstall-brain -> ${HERE}`);
} else {
  if (!dryRun) {
    try {
      fs.unlinkSync(POINTER);
    } catch {
      fs.rmdirSync(POINTER);
    }
    fs.symlinkSync(HERE, POINTER, IS_WIN ? 'junction' : 'dir');
  }
  say(`[relink] ~/.reinstall-brain -> ${HERE} (every wired folder follows)`);
}

// 4. PATH.
run('npm', ['link', '--ignore-scripts', '--no-audit', '--no-fund']);
let onPath = false;
try {
  execFileSync(IS_WIN ? 'where' : 'which', ['reinstall-brain'], { stdio: 'ignore' });
  onPath = true;
} catch {}
say(onPath ? '[ok] reinstall-brain and reinstall-hub are on your PATH' : `[note] reinstall-brain is not on this shell's PATH yet. Open a new terminal, or run it as: node ${path.join(HERE, 'dist', 'cli', 'brain.js')}`);

// 5. A hub.
if (hubAt) {
  say(`\n[hub] ${hubAt}`);
  run(process.execPath, [path.join(HERE, 'dist', 'cli', 'hub.js'), 'init', hubAt, '--default']);
}

say(`
Done. Next:
  - a hub (one place to see and rank work across your repos):  reinstall-hub init <folder>
    then open that folder with your agent and run /hub
  - or just one repo:  cd <repo> && reinstall-brain init, then use /brain
Update later with: reinstall-brain update`);
