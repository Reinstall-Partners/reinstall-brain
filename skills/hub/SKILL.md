---
name: hub
description: Work with a hub (Reinstall Brain), the one place that sees every connected project's brain and holds the owner's ranking of what matters. Sets a hub up, connects repos, and prioritizes across all projects in short rounds of choices, then plans the day. Use in a hub folder, or when the user asks to set up a hub, connect a repo, or prioritize across projects.
argument-hint: "[setup|goals|prioritize|today|connect <repo>|status|sync]"
---

## This hub
!`"$(command -v reinstall-hub || echo ~/.reinstall-brain/shim/reinstall-hub)" status 2>/dev/null || echo "Not a hub here (or the reinstall-brain CLI is not installed): see Setup"`

## Goals
!`"$(command -v reinstall-hub || echo ~/.reinstall-brain/shim/reinstall-hub)" goals 2>/dev/null || true`

## Hubs on this machine
!`"$(command -v reinstall-hub || echo ~/.reinstall-brain/shim/reinstall-hub)" list 2>/dev/null || true`

---

# Hub

A hub is a brain that connects other brains: `brain/brain.yaml` lists them under `connects:`. The owner
ranks **projects** (the order of `connects:`) and **goals** (`brain/priorities.md`); every open task
takes its place from those (project, then goal, then plan phases in order, then due date and age).
A task the owner wants ahead of that is **pinned** (`## Tasks` in `priorities.md`). `brain/HUB.md` is the full guide, including how to do all of this with plain files when the
CLI is missing. A machine can hold many hubs; commands act on the hub folder you are in, or
`--hub <name>`.

## Input

Optional argument: `$ARGUMENTS`

- (empty) in a hub: **Overview**, then offer the next step. Not in a hub: **Setup**.
- `setup`: **Setup**: create or adopt a hub and connect repos
- `goals`: **Goals**: set, rank and check the owner's goals
- `prioritize`: **Prioritize**: rank projects, clear dead work, pin what must jump the line
- `today`: **Today**: a plan for the day from the top of the ranking
- `connect <repo>`: **Connect** one repo
- `status`: **Status**: every connected brain, and what is missing
- `sync`: **Sync**: re-wire skills and guides in the hub and every connected repo

## How to talk to the owner here

This skill exists so the owner can steer many projects without reading walls of text.

- **Choices, not essays.** Every decision goes to the owner through your question tool when you have
  one (AskUserQuestion in Claude Code): up to 4 questions per call, 2 to 4 options each, the
  recommended option first and marked "(Recommended)", each option's description saying in a few
  words why. Without a question tool, ask the same thing as a short numbered list and take terse
  answers ("1a 2c 3a").
- **Small rounds.** After each round, one line of tally ("Placed 4: 2 at the top, 1 next, 1 later.
  38 left."), then the next round. No recaps of earlier rounds.
- **Tasks are links**: `[Ship the importer](/abs/path/to/record.md)`, with the project named in a few
  words. The `file` field of every `--json` item is that path. Never show a bare key or id.
- **The order is the owner's.** Place only what the owner chose. Never write to a project's brain
  (dropping a task, adding a due date) unless the owner picked exactly that.

## The CLI in one screen

```bash
reinstall-hub status --json                # connected brains, record counts, problems
reinstall-hub goals --json                 # ranked goals, then unranked open goals; open_tasks, measure, file
reinstall-hub place-goal <key> --at N | --top | --bottom | --above <key> | --below <key>
reinstall-hub cover <hub goal key> <key>   # a hub goal counts a project goal or task (uncover removes)
reinstall-hub move <key> <to-brain> --author "claude (for <owner>)"   # a record belongs in another brain
reinstall-hub projects --json              # projects in rank order: open and pinned tasks each
reinstall-hub place-project <name> --at N | --top | --bottom | --above <name> | --below <name> [--drop-pins]
reinstall-hub priorities --json [--limit N] # every open task in order (pins first): rank, pinned, plan, goal, file
reinstall-hub inbox --json [--brain NAME]  # what is not pinned, in order; a plan is one row (kind: plan, next, open_phases)
reinstall-hub inbox --unserved --json      # tasks not pinned that serve no goal
reinstall-hub place <key> --at N | --top | --bottom | --above <key> | --below <key>   # pin a task, or a plan: <brain>/plan:<id>
reinstall-hub unrank <key>                 # unpin it
reinstall-hub init [folder] [--name NAME] [--default]
reinstall-hub connect <repo> [--name NAME]
reinstall-hub disconnect <name>
reinstall-hub sync [--all]
reinstall-hub list                         # hubs on this machine (* = default)
```

A key is `<brain>/<id>`. If `reinstall-hub` is not on PATH but `~/.reinstall-brain` exists, run
`~/.reinstall-brain/shim/reinstall-hub` instead (setup writes it; it finds node by itself). With neither, follow "Without the CLI" in
`brain/HUB.md`.

---

## Overview

From the state above plus `reinstall-hub projects --json` and `reinstall-hub priorities --json --limit 5`,
say in four or five lines: the ranked goals (as links), the projects in rank order (with open-task
counts, and any brain not readable here), the top 3 tasks as links (say which are pinned), and any
pins. Then ask what to do next with one question: **Set goals** (recommended when there are none, and
always first on a hub's first run), **Rank projects** (recommended when the project order has not been
confirmed), **Prioritize** (recommended when old tasks pile up), **Plan today**, **Connect more repos**.

---

## Setup

1. **The CLI.** `reinstall-hub version`. If missing, give the one-step install from GitHub:
   ```bash
   git clone https://github.com/Reinstall-Partners/reinstall-brain ~/reinstall-brain
   node ~/reinstall-brain/setup.mjs
   ```
   then continue once the user says it ran.
2. **The hub folder.** If this folder is already a hub, skip ahead. Otherwise ask one question:
   make **this folder** the hub (recommended when it is empty or meant for it), or **a new folder**
   (ask where). Then:
   ```bash
   reinstall-hub init <folder> [--name <name>]
   ```
   It creates the brain (or adopts the one there), marks it a hub, writes `brain/HUB.md` and
   `brain/priorities.md`, wires the `/hub` and `/brain` skills and the session hook, and registers the
   hub on this machine. If it is the first hub, it becomes the default.
3. **Find the projects.** Ask where the projects live (options: the hub's parent folder, the home
   folder, somewhere else). List the git repos there, two levels deep, skipping dependency folders:
   ```bash
   find <folder> -maxdepth 3 -name .git -not -path '*/node_modules/*' 2>/dev/null | sed 's#/\.git$##'
   ```
   For each, note whether it has a brain (`<repo>/brain/brain.yaml`) and whether another hub already
   connects it (`reinstall-hub list`, then each hub's `brain/brain.yaml`). A repo may belong to more
   than one hub; say so when it already does.
4. **Pick repos.** Multi-select questions, 4 repos per question and up to 4 questions per call:
   repos with a brain first, then the most recently committed (`git -C <repo> log -1 --format=%cr`).
   Each option's description: has a brain or not, last commit, other hub if any.
5. **Connect** each chosen repo:
   ```bash
   reinstall-hub connect <repo>
   ```
   A repo without a brain gets one (empty, ready to use) and its own `/brain` wiring.
6. **Project order.** The order of `connects:` is the project ranking, and it orders every task.
   Propose an order (most recent activity first, or the order the owner named projects in) and ask
   one question: **Use this order**, or **Change it** (then ask which project goes first, and so on,
   in a round or two). Apply it with `reinstall-hub place-project <name> --at N`.
7. **Commit** the hub (`git add -A && git commit`) when the owner agrees, and each connected repo's
   new files (`brain/`, `CLAUDE.md`, `AGENTS.md`, `.claude/settings.json`, `.gitignore`).
8. Offer **Goals** next (then **Prioritize**).

---

## Goals

Goals are the outcomes everything else is for. Few is better: 3 to 5 hub goals.

1. **Load:** `reinstall-hub goals --json`.
2. **None yet:** draft 3 to 5 candidates from what the brains already say (recent decisions, plans'
   `## Goal` blocks, the project list, the hub's notes), each an outcome with a way to measure it.
   Put them to the owner as one multi-select question (**keep** the ones that are right), then a round
   to fix wording and `done_when` where needed. Ask about anything missing with a free-text option.
3. **Write each kept goal** in the hub's own brain (a goal that belongs to one project goes in that
   project's brain instead):
   ```bash
   reinstall-brain new goal "<the outcome>" --author "claude (for <owner>)" --set done_when="<when it counts as reached>" --set measure="<how to read progress>" [--set due=YYYY-MM-DD] --body-file - --json <<'EOF'
   <why it matters, in a line or two>

   ## Pace
   - YYYY-MM-DD: <the reading today>
   EOF
   ```
4. **Rank them:** one question, "Which goal matters most?", then the next, until all are placed:
   `reinstall-hub place-goal <key> --at N`.
5. **Tie project goals to hub goals:** for each project goal (`level: project`) not covered by a hub
   goal, one question offering the hub goals it could count toward, plus **Stands alone**:
   `reinstall-hub cover <hub goal key> <project goal key>`.
6. **Check pace** (when asked, or weekly): read each ranked goal's `measure`, append a Pace line to its
   record, and say in one line per goal whether it is on track.

---

## Prioritize

The owner ranks projects and goals; tasks follow from them. Prioritizing is mostly confirming the
project order and clearing dead work, with a pin only for the few tasks that must jump the line.

1. **Load.**
   ```bash
   reinstall-hub projects --json
   reinstall-hub goals --json
   reinstall-hub priorities --json
   ```
2. **Projects.** Show the projects in rank order with their open-task counts, and ask one question:
   **Keep this order**, or **Change it** (then which project goes first, and so on). Apply with
   `reinstall-hub place-project <name> --at N`. It reports pins that still go ahead of the new order;
   ask whether to keep them (`--drop-pins` clears them).
3. **Clear the dead, by cluster,** when a project holds many tasks with no recent activity. Find them
   by `created` and by the last dated line of each file's `## Log` (older than about six weeks). Group
   them: by project, then by plan (`plan` in the JSON) or by theme (a dropped direction, an old setup
   checklist, a finished plan whose phase tasks were never closed: check the plan file's
   `**Status:** done` lines). One question per cluster, up to 4 per call, naming the cluster, its count
   and a few titles, with **Drop all** (recommended for clearly dead work), **Mark all done** (when the
   plan or the owner says they finished), **Go one by one**, **Keep**. Dropping and finishing are
   writes to that project's brain, made only on those choices:
   ```bash
   cd <repo> && reinstall-brain set <id> status=dropped --log "claude (for <owner>): dropped while prioritizing in hub <hub>"
   cd <repo> && reinstall-brain done <id> --log "claude (for <owner>): finished (confirmed while prioritizing)"
   ```
   Offer to skip this step with one question before starting it.
4. **Goals for loose work,** when the hub has goals and a project that has goals holds tasks serving
   none (`inbox --unserved`). One question per task or cluster: "Which goal is this for?" with the
   likeliest goals and **No goal**. Record it in the hub: `reinstall-hub cover <hub goal key> <task key>`.
   Tasks in client or delivery projects without goals are fine as they are: skip them.
5. **Pins, only if wanted.** Show the top 10 of `priorities` as links, numbered, each with its project,
   goal and plan, and ask one question: **Looks right**, or **Move something**. For a move, ask which
   task and where (top / ahead of a named task), then pin it with `reinstall-hub place`. Prefer fixing
   the project or goal order when that is the real reason; a pin is for an exception.
6. After every round, the one-line tally. Every third round, one question: **Keep going** or **Stop
   here**.

---

## Today

1. `reinstall-hub priorities --json` and `reinstall-hub goals --json`; also anything due within 7 days
   anywhere in the inbox.
2. Ask one question about capacity: **About 2 hours**, **Half a day**, **A full day**.
3. Propose 3 to 6 tasks from the top of the ranking that fit, plus anything due today, each a link
   with the goal it moves and a few words on why. Prefer moving the top goal over spreading thin. Ask **Go with this** or **Swap something** (then which).
4. Write the plan as a note in the hub's own brain:
   ```bash
   reinstall-brain new note "Plan for YYYY-MM-DD" --author "claude (for <owner>)" --tag daily-plan --body-file - --json <<'EOF'
   <the tasks, each a link and one line>
   EOF
   ```
   Confirm with a link to the note.

---

## Connect

`connect <repo>`: `reinstall-hub connect <repo> [--name NAME]`. Say what happened in one line (a new
brain or an existing one, the name it has in this hub). Offer to commit the repo's new files.

## Status

`reinstall-hub status --json`, `reinstall-hub goals --json` and `reinstall-hub list`. Say which brains
are connected, their record counts, and any that are not readable on this machine (not cloned here,
or moved). Then each ranked goal in one line: its latest Pace line and how many open tasks serve it. For a moved repo,
offer to fix its `path:` in `brain/brain.yaml`.

## Sync

`reinstall-hub sync` (this hub) or `reinstall-hub sync --all` (every hub). Report only what changed.
After `reinstall-brain update` this runs by itself.

---

## Rules

- **Reads need no permission.** Overview, Status and loading the ranking run straight away.
- **Every ranking change is the owner's choice,** made through a question. Never re-rank on your own.
- **Writes to project brains** happen only on an explicit choice (drop, done), with a log line.
- **Remote-only projects** (a `connects:` entry with no local path, or a folder not on this machine)
  are not readable here: say so once, and leave their tasks alone.
- **A cloud session** sees only the repository it was opened on, so a hub's projects are readable
  only where they are checked out (normally the owner's own machine).
