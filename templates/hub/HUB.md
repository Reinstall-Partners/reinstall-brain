<!-- Managed by reinstall-brain: `reinstall-hub sync` rewrites this file. Put your own notes elsewhere. -->
# This hub

This folder is a **hub**: a brain that connects other brains. `brain/brain.yaml` lists the project
brains it connects under `connects:`, in **project order**: the first is the most important project.
The hub holds what no project brain does: the owner's ranking. The owner ranks **projects** (the order
of `connects:`) and **goals** (`brain/priorities.md`); every open task then takes its place from those:

1. its project's rank (the hub's own brain first),
2. the rank of the goal it serves (ranked goals first, then unranked goals, then none),
3. its plan: a plan's open phases stay together, in phase order,
4. its due date, then its age.

A task the owner wants ahead of that order is **pinned**: a line under `## Tasks` in `priorities.md`.
Pins go first, in file order. Pins are exceptions; most hubs need few or none.

A machine can have many hubs, and a project can be connected to more than one. Each hub's ranking is
its own.

## Keys

Every task in a hub is named `<brain>/<id>`: the brain's name from `connects:` and the record's id
(`acme-web/k3x9`). `priorities.md` holds one key per line, numbered, with the title after it as a
reminder (goals under `## Goals`, pinned tasks under `## Tasks`):

```
1. acme-web/k3x9  Ship the importer
2. ops/7f3a  Renew the TLS certificate
```

## Goals

Goals are the outcomes the work is for, and the strongest signal for ranking.

- **Hub goals** live in this hub's own brain (`brain/records/goals/`) and span projects ("first paying
  client by March"). **Project goals** live in each project's brain.
- A task names the one goal it serves, in its own brain: `serves: <goal id>`.
- A hub goal counts project work by listing keys in `covers:` (`acme-web/k3x9`, a project goal or a
  task). Links run one way: a project brain never names a hub.
- `priorities.md` ranks goals under a `## Goals` heading, above the pinned tasks under `## Tasks`.
- Every task in the hub resolves to a **goal** (its project goal, or a hub goal covering it) and a
  **hub goal** (where it rolls up). A task with neither serves no goal: ask whether it should exist.

## With the CLI (preferred)

| To | Run |
|---|---|
| see the projects in order | `reinstall-hub projects --json` (open and pinned tasks per project) |
| rank a project | `reinstall-hub place-project <name> --top`, `--at N`, `--above <name>`, `--below <name>`, `--bottom` |
| see every open task in order | `reinstall-hub priorities --json` (`pinned: true` on pins; `--pins`, `--limit N`) |
| see what is not pinned | `reinstall-hub inbox --json` (`--brain NAME`, `--limit N`), in the same order: each plan is one row (`kind: plan`, its `next` phase, `open_phases`); `--flat` lists every task |
| pin a task | `reinstall-hub place <brain>/<id> --top`, `--at N`, `--above <key>`, `--below <key>`, `--bottom` |
| pin a whole plan | `reinstall-hub place <brain>/plan:<plan id or path> --top` (its open phases, in order) |
| unpin a task | `reinstall-hub unrank <brain>/<id>` |
| see goals | `reinstall-hub goals --json` (ranked, then unranked, each with `open_tasks`, `measure`, `file`) |
| rank a goal | `reinstall-hub place-goal <brain>/<id> --at N` (same positions as `place`) |
| tie a hub goal to project work | `reinstall-hub cover <hub goal key> <brain>/<id>` (`uncover` removes) |
| move a record to another brain | `reinstall-hub move <brain>/<id> <to-brain> --author "<who>"` (keeps the id; the source is dropped with a pointer; covers and pins follow) |
| add a goal | in the hub or a project: `reinstall-brain new goal "<outcome>" --set done_when="..." --set measure="..."` |
| tasks serving no goal | `reinstall-hub inbox --unserved --json` |
| connect a repo | `reinstall-hub connect <path> [--name NAME]` (sets up its brain if it has none) |
| check every brain | `reinstall-hub status` |
| re-wire skills and guides | `reinstall-hub sync` (this hub), `reinstall-hub sync --all` (every hub on the machine) |

Run them from inside this folder and they act on this hub. Elsewhere, add `--hub <name or path>`.
`--json` output gives each task's `file`, the absolute path of its record: link to it when you name a
task to the owner.

## Without the CLI

Everything above is plain files, so an agent with only file tools can do the same work:

1. **Connected brains:** read `brain/brain.yaml`. Each `connects:` entry has a `name` and a `path`
   (`~` is the home folder).
2. **Open tasks:** in each connected repo, the files under `brain/records/tasks/`. A task is open when
   its frontmatter has `status: active` or `status: blocked`. Its id is the `id:` field, and its key
   is `<name>/<id>`.
3. **The ranking:** projects in the order of `connects:` (move entries to re-rank them); goals and
   pinned tasks as the numbered lines of `brain/priorities.md`. A pinned key whose task is no longer
   open should be removed. Every other open task is ordered as described at the top of this file.
4. **Re-ranking goals or pins:** rewrite the numbered list in the new order, renumbering from 1. Keep
   the header lines. Goals go under the `## Goals` heading, pins under `## Tasks`.
5. **Goals:** files under `brain/records/goals/` in the hub and in each project. A task's goal is its
   `serves:` id in its own brain; a hub goal's `covers:` lists `<brain>/<id>` keys it counts.

## Rules for an agent helping the owner prioritize

- **The order is the owner's.** Propose, then place only what the owner agreed to.
- **Ask in small rounds.** Put a few tasks to the owner at a time, with a recommendation first and the
  reason in a few words, and offer a short set of choices. Use your question tool when you have one.
  Never hand the owner a wall of text to read.
- **Name tasks by link,** `[Ship the importer](/abs/path/to/record.md)`, never by a bare key or id.
- **Rank projects and goals, not tasks.** The task order follows from them. Pin a task only when the
  owner wants it ahead of its place (people waiting on them, a hard date, work that unblocks others).
- **Old untouched tasks may be dead:** offer to drop them, a cluster at a time (a project, a plan, a
  theme), not one by one. In a project that has goals, a task serving none is a candidate to drop; in
  client or delivery projects without goals, it is normal.
- **Never express priority inside a project brain.** Ranking lives only in `priorities.md`. Changing a
  task itself (dropping it, adding a due date) is a write to that project's brain: do it there, only
  when the owner says so.
- **A plan for the day** is a note in this hub's own brain, tagged `daily-plan`:
  `reinstall-brain new note "Plan for YYYY-MM-DD" --tag daily-plan --body-file -`.
