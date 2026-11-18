// Wiring: what makes a repo (or a hub) usable by an agent straight away. Brain and Hub ship their
// own skills and agent guidance from this package; wiring links them into the folder and keeps them
// current:
//
//   - .claude/skills/brain (every brain) and .claude/skills/hub (hubs only): links into this
//     package's skills/ folder, through the machine pointer ~/.reinstall-brain when it points here,
//     so a `git pull` in the clone updates every wired folder at once. Windows gets junctions.
//   - .claude/settings.json: a SessionStart hook that loads the brain's (or hub's) context.
//   - CLAUDE.md and AGENTS.md: a short managed block telling any agent where the guide is.
//   - .gitignore: the links hold this machine's paths, so they are ignored (managed block).
//   - hubs only: brain/HUB.md, the hub guide, refreshed from the package on every wiring.
//
// Wiring is idempotent: run it again (reinstall-hub sync) and only what drifted changes. It never
// replaces a real file or folder: those are reported as occupied.

import {
  existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync, symlinkSync, unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HUB_TEMPLATES, TEMPLATES } from './templates.gen.js';

const IS_WIN = process.platform === 'win32';

export const POINTER = path.join(os.homedir(), '.reinstall-brain');
export const POINTER_SHOWN = '~/.reinstall-brain';

const BLOCK_BEGIN = '<!-- >>> reinstall-brain (managed by reinstall-brain; edit outside this block) >>> -->';
const BLOCK_END = '<!-- <<< reinstall-brain <<< -->';
const IGNORE_BEGIN = '# >>> reinstall-brain (managed by reinstall-brain; edit outside this block) >>>';
const IGNORE_END = '# <<< reinstall-brain <<<';
const HOOK_MARK = 'reinstall-brain/hooks/session-start.mjs';
const HOOK_MARK_RE = /reinstall-brain[\\/]+hooks[\\/]+session-start\.mjs/;
const HOOK_SKILL_RE = /reinstall-brain[\\/]+skills[\\/]+(brain|hub)$/;

export type Role = 'brain' | 'hub';

export interface WireLine {
  kind: 'ok' | 'link' | 'relink' | 'write' | 'remove' | 'occupied' | 'skip';
  what: string;
  note?: string;
}

/** This package's root (the clone, or wherever npm put it): the folder holding skills/ and hooks/. */
export function packageRoot(): string {
  // dist/core/wire.js or src/core/wire.ts -> two levels up.
  return realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
}

/** Where wiring points: the machine pointer when it resolves to this package, else the package itself. */
export function sourceRoot(): { abs: string; shown: string; viaPointer: boolean } {
  const pkg = packageRoot();
  try {
    if (realpathSync(POINTER) === pkg) return { abs: POINTER, shown: POINTER_SHOWN, viaPointer: true };
  } catch {
    /* no pointer */
  }
  return { abs: pkg, shown: pkg, viaPointer: false };
}

export function skillsFor(role: Role): string[] {
  return role === 'hub' ? ['brain', 'hub'] : ['brain'];
}

function lstat(p: string) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

function norm(p: string): string {
  let s = String(p).replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '');
  if (IS_WIN) s = s.replace(/\//g, '\\').toLowerCase();
  return s;
}

/** Windows junctions can report their target in another form (a \\?\ prefix, 8.3 names): compare what both resolve to. */
function sameRealPath(a: string, b: string): boolean {
  try {
    return norm(realpathSync.native(a)) === norm(realpathSync.native(b));
  } catch {
    return false;
  }
}

function removeLink(p: string): void {
  try {
    unlinkSync(p);
  } catch (e) {
    if (IS_WIN) rmdirSync(p);
    else throw e;
  }
}

function linkDir(target: string, at: string, dryRun: boolean): WireLine['kind'] {
  const rel = at;
  const st = lstat(at);
  if (st && st.isSymbolicLink()) {
    let cur = '';
    try {
      cur = readlinkSync(at);
    } catch {}
    if (norm(cur) === norm(target) || sameRealPath(at, target)) return 'ok';
    if (!dryRun) {
      removeLink(at);
      mkdirSync(path.dirname(at), { recursive: true });
      symlinkSync(target, at, IS_WIN ? 'junction' : 'dir');
    }
    return 'relink';
  }
  if (st) return 'occupied';
  if (!dryRun) {
    mkdirSync(path.dirname(rel), { recursive: true });
    symlinkSync(target, at, IS_WIN ? 'junction' : 'dir');
  }
  return 'link';
}

function writeIfChanged(p: string, next: string, dryRun: boolean): boolean {
  let cur: string | null = null;
  try {
    cur = readFileSync(p, 'utf8');
  } catch {}
  if (cur === next) return false;
  if (!dryRun) {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, next);
  }
  return true;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function upsertBlock(text: string, begin: string, end: string, body: string): string {
  const block = `${begin}\n${body}\n${end}`;
  const re = new RegExp(`${escapeRe(begin)}[\\s\\S]*?${escapeRe(end)}`);
  if (re.test(text)) return text.replace(re, block);
  if (!text) return `${block}\n`;
  return `${text.endsWith('\n') ? text : `${text}\n`}\n${block}\n`;
}

function guideBlock(role: Role): string {
  const lines = [
    'This repository keeps its project memory in `brain/` (Reinstall Brain): decisions, tasks, questions, insights',
    'and notes, one markdown file per record. Read `brain/README.md` before reading or writing records. With the',
    '`reinstall-brain` CLI, prefer it (`reinstall-brain list|search|show|new|set|done`); without it, edit the files',
    'as the guide says. In messages to a person, name a record by a link to its file, never by its bare id.',
  ];
  if (role === 'hub') {
    lines.push(
      '',
      'This folder is a **hub**: `brain/brain.yaml` lists the project brains it connects, in the owner\'s project order,',
      "and `brain/priorities.md` ranks goals (and pins a few tasks); every open task across them takes its place from",
      'those. Read `brain/HUB.md` before working with it. The `/hub` skill sets the hub up, connects repos, and helps',
      'the owner prioritize.',
    );
  }
  return lines.join('\n');
}

function settingsHook(root: string, src: { abs: string; shown: string; viaPointer: boolean }, dryRun: boolean): WireLine {
  const p = path.join(root, '.claude', 'settings.json');
  let cfg: any = {};
  if (existsSync(p)) {
    try {
      cfg = JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      return { kind: 'occupied', what: '.claude/settings.json', note: 'is not valid JSON; add the SessionStart hook by hand' };
    }
  }
  const script = src.viaPointer ? `${src.shown}/hooks/session-start.mjs` : `"${path.join(src.abs, 'hooks', 'session-start.mjs')}"`;
  const command = `node ${script}`;
  cfg.hooks ??= {};
  const groups: any[] = Array.isArray(cfg.hooks.SessionStart) ? cfg.hooks.SessionStart : [];
  let found = false;
  let changed = false;
  for (const g of groups) {
    if (!Array.isArray(g.hooks)) continue;
    for (const h of g.hooks) {
      if (typeof h.command === 'string' && HOOK_MARK_RE.test(h.command)) {
        if (found) continue;
        found = true;
        if (h.command !== command) {
          h.command = command;
          changed = true;
        }
      }
    }
  }
  // Drop duplicates of our hook beyond the first.
  let seen = false;
  for (const g of groups) {
    if (!Array.isArray(g.hooks)) continue;
    const before = g.hooks.length;
    g.hooks = g.hooks.filter((h: any) => {
      if (typeof h.command === 'string' && HOOK_MARK_RE.test(h.command)) {
        if (seen) return false;
        seen = true;
      }
      return true;
    });
    if (g.hooks.length !== before) changed = true;
  }
  const kept = groups.filter((g) => !Array.isArray(g.hooks) || g.hooks.length);
  if (kept.length !== groups.length) changed = true;
  if (!found) {
    kept.push({ hooks: [{ type: 'command', command }] });
    changed = true;
  }
  cfg.hooks.SessionStart = kept;
  if (!changed) return { kind: 'ok', what: '.claude/settings.json SessionStart hook' };
  writeIfChanged(p, `${JSON.stringify(cfg, null, 2)}\n`, dryRun);
  return { kind: found ? 'write' : 'write', what: '.claude/settings.json SessionStart hook', note: command };
}

function gitignoreBlock(root: string, rels: string[], dryRun: boolean): WireLine {
  const p = path.join(root, '.gitignore');
  let text = '';
  try {
    text = readFileSync(p, 'utf8');
  } catch {}
  const body = rels.map((r) => `/${r}`).join('\n');
  const block = `${IGNORE_BEGIN}\n${body}\n${IGNORE_END}`;
  const re = new RegExp(`${escapeRe(IGNORE_BEGIN)}[\\s\\S]*?${escapeRe(IGNORE_END)}`);
  const next = re.test(text) ? text.replace(re, block) : `${text && !text.endsWith('\n') ? `${text}\n` : text}${text ? '\n' : ''}${block}\n`;
  return writeIfChanged(p, next, dryRun) ? { kind: 'write', what: '.gitignore block' } : { kind: 'ok', what: '.gitignore block' };
}

/**
 * Wire one folder that holds a brain. `role: 'hub'` adds the hub skill and the hub guide.
 * Returns what it did, line by line; nothing it reports as occupied was touched.
 */
export function wire(root: string, role: Role, opts: { dryRun?: boolean } = {}): WireLine[] {
  const dryRun = !!opts.dryRun;
  const src = sourceRoot();
  const out: WireLine[] = [];
  if (!existsSync(path.join(root, 'brain', 'brain.yaml'))) throw new Error(`no brain at ${root} (run reinstall-brain init there first)`);

  // Skills.
  const links: string[] = [];
  for (const name of skillsFor(role)) {
    const target = path.join(src.abs, 'skills', name);
    if (!existsSync(path.join(packageRoot(), 'skills', name, 'SKILL.md'))) {
      out.push({ kind: 'skip', what: `.claude/skills/${name}`, note: 'this reinstall-brain install has no skills/ folder (install from a git clone to get them)' });
      continue;
    }
    const rel = `.claude/skills/${name}`;
    const kind = linkDir(target, path.join(root, rel), dryRun);
    out.push({ kind, what: rel, note: kind === 'occupied' ? 'a real folder is there; remove it to let the shared skill in' : undefined });
    if (kind !== 'occupied') links.push(rel);
  }
  if (links.length) out.push(gitignoreBlock(root, links, dryRun));

  // Session hook.
  out.push(settingsHook(root, src, dryRun));

  // Guide lines for any agent.
  for (const f of ['CLAUDE.md', 'AGENTS.md']) {
    const p = path.join(root, f);
    let text = '';
    try {
      text = readFileSync(p, 'utf8');
    } catch {}
    const next = upsertBlock(text, BLOCK_BEGIN, BLOCK_END, guideBlock(role));
    out.push(writeIfChanged(p, next, dryRun) ? { kind: 'write', what: `${f} guide block` } : { kind: 'ok', what: `${f} guide block` });
  }

  // Record templates a newer version added (a goal template for brains made before goals, say).
  for (const [rel, text] of Object.entries(TEMPLATES)) {
    if (!rel.startsWith('templates/')) continue;
    const p = path.join(root, 'brain', rel);
    if (!existsSync(p)) {
      writeIfChanged(p, text, dryRun);
      out.push({ kind: 'write', what: `brain/${rel}` });
    }
  }

  // Hub guide.
  if (role === 'hub') {
    const p = path.join(root, 'brain', 'HUB.md');
    out.push(writeIfChanged(p, HUB_TEMPLATES['HUB.md'], dryRun) ? { kind: 'write', what: 'brain/HUB.md' } : { kind: 'ok', what: 'brain/HUB.md' });
    const pr = path.join(root, 'brain', 'priorities.md');
    if (!existsSync(pr)) {
      writeIfChanged(pr, HUB_TEMPLATES['priorities.md'], dryRun);
      out.push({ kind: 'write', what: 'brain/priorities.md' });
    }
  }
  return out;
}

/**
 * Undo `wire`: remove the skill links that point at this package, the managed blocks in CLAUDE.md,
 * AGENTS.md and .gitignore, and the session hook. Never touches `brain/` (the records are the
 * project's) or anything it did not write. A file left empty by removing a block is deleted.
 */
export function unwire(root: string, opts: { dryRun?: boolean } = {}): WireLine[] {
  const dryRun = !!opts.dryRun;
  const out: WireLine[] = [];
  for (const name of skillsFor('hub')) {
    const rel = `.claude/skills/${name}`;
    const at = path.join(root, rel);
    const st = lstat(at);
    if (!st) continue;
    let cur = '';
    try {
      cur = readlinkSync(at);
    } catch {}
    const ours = st.isSymbolicLink() && (HOOK_SKILL_RE.test(cur) || sameRealPath(at, path.join(packageRoot(), 'skills', name)));
    if (!ours) {
      out.push({ kind: 'occupied', what: rel, note: 'not a link to reinstall-brain; left alone' });
      continue;
    }
    if (!dryRun) removeLink(at);
    out.push({ kind: 'remove', what: rel, note: dryRun ? 'would remove the link' : 'link removed' });
  }
  const strip = (rel: string, begin: string, end: string) => {
    const p = path.join(root, rel);
    let text: string;
    try {
      text = readFileSync(p, 'utf8');
    } catch {
      return;
    }
    const re = new RegExp(`\\n?${escapeRe(begin)}[\\s\\S]*?${escapeRe(end)}\\n?`);
    if (!re.test(text)) return;
    const next = text.replace(re, '\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n');
    if (!dryRun) {
      if (next.trim()) writeFileSync(p, `${next.trimEnd()}\n`);
      else unlinkSync(p);
    }
    out.push({ kind: 'remove', what: `${rel} block`, note: `${dryRun ? 'would remove' : 'removed'}${next.trim() ? '' : '; the file held only the block, so it goes too'}` });
  };
  strip('CLAUDE.md', BLOCK_BEGIN, BLOCK_END);
  strip('AGENTS.md', BLOCK_BEGIN, BLOCK_END);
  strip('.gitignore', IGNORE_BEGIN, IGNORE_END);
  const sp = path.join(root, '.claude', 'settings.json');
  if (existsSync(sp)) {
    try {
      const cfg = JSON.parse(readFileSync(sp, 'utf8'));
      const groups: any[] = Array.isArray(cfg?.hooks?.SessionStart) ? cfg.hooks.SessionStart : [];
      let removed = false;
      for (const g of groups) {
        if (!Array.isArray(g.hooks)) continue;
        const before = g.hooks.length;
        g.hooks = g.hooks.filter((h: any) => !(typeof h.command === 'string' && HOOK_MARK_RE.test(h.command)));
        if (g.hooks.length !== before) removed = true;
      }
      if (removed) {
        cfg.hooks.SessionStart = groups.filter((g) => !Array.isArray(g.hooks) || g.hooks.length);
        if (!cfg.hooks.SessionStart.length) delete cfg.hooks.SessionStart;
        if (!Object.keys(cfg.hooks).length) delete cfg.hooks;
        if (!dryRun) {
          if (Object.keys(cfg).length) writeFileSync(sp, `${JSON.stringify(cfg, null, 2)}\n`);
          else unlinkSync(sp);
        }
        out.push({ kind: 'remove', what: '.claude/settings.json SessionStart hook', note: dryRun ? 'would remove' : 'removed' });
      }
    } catch {
      out.push({ kind: 'occupied', what: '.claude/settings.json', note: 'is not valid JSON; remove the reinstall-brain hook by hand' });
    }
  }
  return out;
}

/** What a wired folder is missing (for the session hook's drift check). */
export function wiringGaps(root: string, role: Role): string[] {
  const gaps: string[] = [];
  for (const name of skillsFor(role)) {
    const st = lstat(path.join(root, '.claude', 'skills', name));
    if (!st) gaps.push(`.claude/skills/${name}`);
  }
  return gaps;
}

export function formatWire(lines: WireLine[], indent = '  '): string {
  return lines
    .filter((l) => l.kind !== 'ok')
    .map((l) => `${indent}[${l.kind}] ${l.what}${l.note ? ` (${l.note})` : ''}`)
    .join('\n');
}

export const HOOK_COMMAND_MARK = HOOK_MARK;
