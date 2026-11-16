#!/usr/bin/env node
// Reinstall Brain's SessionStart hook: loads what a new agent session needs about this folder's brain,
// as additionalContext. Wired into .claude/settings.json by `reinstall-brain init|wire` and
// `reinstall-hub init|connect|sync`.
//
//   - a project brain: active and blocked tasks, open questions, recent decisions (each with its file
//     path, so the agent can link to it), and the conventions for working with the brain.
//   - a hub: the same for the hub's own brain, plus its projects and goals in rank order and the top
//     of the task order.
//   - upkeep notices: wiring that drifted, or an install that was pulled but not rebuilt.
//
// Node standard library only. It never fails the session: any error becomes a one-line notice.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRAIN_CLI = path.join(PKG, 'dist', 'cli', 'brain.js');
const HUB_CLI = path.join(PKG, 'dist', 'cli', 'hub.js');
const LIMITS = { tasks: 40, questions: 20, decisions: 8, ranked: 10 };

const notices = [];
const sections = [];
const notice = (s) => s && notices.push(s);
const guard = (label, fn) => {
  try {
    return fn();
  } catch (e) {
    notice(`⚠️ reinstall-brain session-start (${label}) failed: ${String((e && e.message) || e).split('\n')[0]}`);
    return undefined;
  }
};

let input = {};
try {
  if (!process.stdin.isTTY) input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
} catch {}
const cwd = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();

function cli(script, args) {
  const out = execFileSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 });
  return JSON.parse(out);
}
function git(args, dir) {
  try {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

if (!fs.existsSync(BRAIN_CLI)) {
  emit(`⚠️ Reinstall Brain is wired here but not built at ${PKG}. Tell the user, in one line: run \`node ${path.join(PKG, 'setup.mjs')}\`.`);
  process.exit(0);
}

const where = guard('where', () => {
  try {
    return cli(BRAIN_CLI, ['where', '--json']);
  } catch {
    return null; // no brain here: say nothing
  }
});
if (!where) {
  emit('');
  process.exit(0);
}
const root = where.root;
const yaml = fs.readFileSync(path.join(root, 'brain', 'brain.yaml'), 'utf8');
const isHub = /^hub:\s*true\s*$/m.test(yaml) || /^connects:\s*\n\s+-/m.test(yaml);

// ---- upkeep ----
guard('build', () => {
  const head = git(['rev-parse', 'HEAD'], PKG);
  const stampFile = path.join(PKG, 'dist', '.build-head');
  const built = fs.existsSync(stampFile) ? fs.readFileSync(stampFile, 'utf8').trim() : '';
  if (head && built && head !== built) notice('🔄 Reinstall Brain was updated but not rebuilt. Tell the user, in one line: run `reinstall-brain update`.');
});
guard('wiring', () => {
  const want = isHub ? ['brain', 'hub'] : ['brain'];
  const missing = want.filter((n) => !fs.existsSync(path.join(root, '.claude', 'skills', n, 'SKILL.md')));
  if (missing.length) notice(`🔌 This ${isHub ? 'hub' : 'repo'} is missing Reinstall Brain's ${missing.map((m) => `/${m}`).join(' and ')} skill. Fix it with \`${isHub ? 'reinstall-hub sync' : 'reinstall-brain wire'}\` (offer to run it).`);
});

// ---- the brain ----
guard('brain', () => {
  const active = cli(BRAIN_CLI, ['list', '--status', 'active', '--json']);
  const blocked = cli(BRAIN_CLI, ['list', '--status', 'blocked', '--json']);
  const line = (r, extra = '') => {
    const f = r.fields || {};
    const who = f.assignee ? ` @${f.assignee}` : '';
    const legacy = f.legacy_id ? ` (#${f.legacy_id})` : '';
    return `- ${r.id}${legacy} ${r.title}${who}${extra} · ${r.path}`;
  };
  const capped = (rows, n, more, fmt = (r) => line(r)) => {
    const out = rows.slice(0, n).map(fmt);
    if (rows.length > n) out.push(`- … ${rows.length - n} more: ${more}`);
    return out.join('\n');
  };
  const tasks = active.filter((r) => r.type === 'task');
  const blockedTasks = blocked.filter((r) => r.type === 'task');
  const questions = active.filter((r) => r.type === 'question');
  const decisions = active.filter((r) => r.type === 'decision');
  const goals = active.filter((r) => r.type === 'goal');
  let s = `## ${isHub ? 'Hub' : 'Brain'}: ${where.name} (auto-loaded at session start)\n\nRecords are in brain/, one markdown file each.`;
  const owner = git(['config', 'user.name'], root);
  if (owner) s += ` Write as \`--author "claude (for ${owner})"\`.`;
  if (goals.length) {
    s += `\n\n### Goals\n${goals.map((g) => {
      const f = g.fields || {};
      return `- ${g.id} ${g.title}${f.due ? ` (due ${f.due})` : ''}${f.measure ? `; measure: ${f.measure}` : ''} · ${g.path}`;
    }).join('\n')}\nA task names the goal it serves with \`serves: <goal id>\`.`;
  }
  s += `\n\n### Active tasks\n${tasks.length ? capped(tasks, LIMITS.tasks, 'reinstall-brain list --type task --status active') : 'None.'}`;
  if (blockedTasks.length) {
    s += `\n\n### Blocked tasks\n${capped(blockedTasks, LIMITS.tasks, 'reinstall-brain list --type task --status blocked', (r) => {
      const by = (r.fields && r.fields.blocked_by) || [];
      return line(r, by.length ? ` (waits on ${by.join(', ')})` : '');
    })}`;
  }
  if (questions.length) s += `\n\n### Open questions\n${capped(questions, LIMITS.questions, 'reinstall-brain list --type question --status active')}`;
  if (decisions.length) s += `\n\n### Recent decisions\n${capped(decisions, LIMITS.decisions, 'reinstall-brain list --type decision --status active')}`;
  sections.push(s);
});

// ---- the hub ----
if (isHub) {
  guard('hub', () => {
    const pr = cli(HUB_CLI, ['priorities', '--json', '--hub', root]);
    const projects = cli(HUB_CLI, ['projects', '--json', '--hub', root]) || [];
    const status = cli(HUB_CLI, ['status', '--json', '--hub', root]);
    const goals = cli(HUB_CLI, ['goals', '--json', '--hub', root]);
    const brains = (status.brains || []).filter((b) => b.name !== where.name);
    const missing = brains.filter((b) => b.error);
    const pins = pr.ranked.filter((i) => i.pinned).length;
    let s = `## This folder is a hub\n\nIt connects ${brains.length} brain(s).`;
    if (missing.length) s += ` Not readable on this machine: ${missing.map((b) => `${b.name} (${b.error})`).join('; ')}.`;
    s += ` Open tasks: ${pr.ranked.length}, ordered by project rank, then goal rank, then plan; ${pins} pinned ahead of that. Read \`brain/HUB.md\` before changing the ranking; the \`/hub\` skill runs setup and prioritizing.`;
    const unserved = pr.ranked.filter((i) => !i.goal).length;
    s += ` Open goals: ${goals.ranked.length} ranked, ${goals.unranked.length} not ranked. Open tasks serving no goal: ${unserved}.`;
    if (projects.length) s += `\n\n### Projects, ranked\n${projects.map((p) => `${p.rank}. ${p.name} (${p.open_tasks} open${p.pins ? `, ${p.pins} pinned` : ''})`).join('\n')}`;
    if (goals.ranked.length) {
      s += `\n\n### Goals, ranked\n${goals.ranked.map((g) => `${g.rank}. ${g.key} ${g.title} (${g.level}, ${g.open_tasks} open task(s)${g.measure ? `; measure: ${g.measure}` : ''}) · ${g.file}`).join('\n')}`;
    }
    if (pr.ranked.length) {
      s += `\n\n### Top of the order\n${pr.ranked.slice(0, LIMITS.ranked).map((i) => `${i.rank}.${i.pinned ? ' (pinned)' : ''} ${i.key} ${i.title}${i.goal_title ? ` (for: ${i.goal_title})` : ''} · ${i.file}`).join('\n')}`;
      if (pr.ranked.length > LIMITS.ranked) s += `\n- … ${pr.ranked.length - LIMITS.ranked} more: reinstall-hub priorities`;
    }
    sections.push(s);
  });
}

const guide = guard('guide', () => fs.readFileSync(path.join(PKG, 'guide', 'session.md'), 'utf8').trim());
if (guide) sections.push(guide);
emit([notices.join('\n\n'), ...sections].filter(Boolean).join('\n\n'));

function emit(ctx) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } }) + '\n');
}
