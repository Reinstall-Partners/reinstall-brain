# Brain format, version 1

A **brain** is a folder of plain markdown files in a git repository that records what happens over a
project's life: decisions, tasks, questions, insights, notes and milestones. Humans and agents read
and write it with ordinary tools. The `reinstall-brain` CLI is optional: it makes the brain faster
and safer to use, but a brain must stay fully usable with only a text editor.

A **hub** is a brain that also connects other brains (see [Hub](#hub)).

## Principles

1. **The files are the truth.** Every record is one markdown file, committed to git. Nothing else
   holds data that the files don't.
2. **The index is disposable.** `brain/.local/index.db` (SQLite) is built from the files, in one
   direction only. Delete it at any time; the next command rebuilds it.
3. **Merge-friendly by construction.** One record per file, random IDs, append-only logs, and no
   shared index file. Two people or agents editing different records never conflict, including
   through GitHub's merge button, which ignores custom merge drivers.
4. **No ranking in the brain.** A brain records facts: what, status, who, when. The order of what
   matters most belongs to a hub, per person.
5. **Primitives, not workflows.** The core defines records and how to find them. Workflows such as
   planning, research or agent swarms are built on top by kits, using the extension points below.

## Layout

```
<repo>/
└── brain/
    ├── README.md        the agent guide: how to use this brain with or without the CLI
    ├── brain.yaml       this brain's identity and settings
    ├── templates/       one blank record per type
    ├── records/         the records, one folder per type
    │   ├── decisions/
    │   ├── insights/
    │   ├── milestones/
    │   ├── notes/
    │   ├── questions/
    │   └── tasks/
    ├── <kit folders>/   optional folders owned by kits (for example plans/, research/)
    ├── .gitignore       contains `.local/`
    └── .local/          NOT committed: index.db and any kit's live state
```

The folder is named `brain/`, not `.brain/`. Search tools such as ripgrep skip hidden folders by
default, and a brain agents cannot find is no use to them.

**One brain per repository**, at its root. In a monorepo, records carry a `scope` field naming the
sub-project they belong to (see below), rather than each package having its own brain.

**Git worktrees share one brain.** From any worktree of a repository, tools read and write the brain
of the primary checkout (found through git's common directory). Records written in a worktree would
otherwise sit on that branch, invisible to everyone else until it merges.

## Records

A record is a file at `brain/records/<type folder>/<id>-<slug>.md`:

```markdown
---
id: 7f3a
type: task
title: Build the import screen
status: active
created: 2026-11-16T14:02:00-06:00
scope: apps/web
tags: [import, ui]
assignee: sam
author: sam
updated: 2026-11-16T14:02:00-06:00
parent: 2b10
due: 2026-12-01
---

What to build, why, and when it counts as done. Any markdown, any length.

## Log
- 2026-11-16 sam: created
- 2026-11-17 claude-code (for sam): first pass done, tests pending
```

### File name

`<id>-<slug>.md`. The **id** is the stable part: find a record by globbing `*/<id>-*.md`. The
**slug** is the title at creation, lowercased, non-alphanumerics replaced by `-`, at most 60
characters. It is never changed afterwards, so renaming a title never renames the file.

### IDs

Random, lowercase base36 (`0-9a-z`), 4 characters by default. A tool creating a record checks that
the id is not already used in this brain and draws again if it is. When a brain passes 10,000
records, new ids use 5 characters; past 300,000, 6. Random ids mean two branches can create records
at the same time without ever colliding. Never reuse the id of a deleted record.

At the hub layer, a record is named `<brain name>/<id>`, for example `web-app/7f3a`.

### Fields

| Field | Required | Type | Meaning |
|---|---|---|---|
| `id` | yes | string | Matches the file name |
| `type` | yes | string | A core or registered type (below) |
| `title` | yes | string | One line |
| `status` | yes | string | `active`, `blocked`, `done`, `dropped` or `superseded` |
| `created` | yes | ISO 8601 date-time | When the record was created |
| `updated` | no | ISO 8601 date-time | Last meaningful change |
| `author` | no | string | Who created it: a person, or `<agent> (for <person>)` |
| `tags` | no | list of strings | Lowercase, sorted, no duplicates |
| `scope` | no | string | Monorepo sub-project path, for example `packages/billing` |
| `assignee` | no | string | The person who owns it (tasks) |
| `delegate` | no | string | The agent doing it on the assignee's behalf (tasks) |
| `parent` | no | id | The record this came out of |
| `supersedes` | no | id | The record this one replaces |
| `superseded_by` | no | id | Set on the old record when it is replaced |
| `serves` | no | id | The goal this record works toward (tasks; a goal can serve a larger goal). One goal |
| `blocked_by` | no | list of ids | Records that must be done first (tasks) |
| `due` | no | ISO 8601 date | When it is due (tasks, milestones) |
| `completed` | no | ISO 8601 date-time | When `status` became `done` |
| `importance` | no | integer 0–10 | How much it matters, for notes and insights. Not a rank |
| `done_when` | no | string | When a goal counts as reached (goals) |
| `measure` | no | string | How to read a goal's progress: a command, a query or a count (goals) |
| `measure_cmd` | no | string | A shell command whose output is the goal's current reading; `reinstall-hub pace --run` runs it and appends a Pace line (goals) |
| `ranking` | no | `off` | Keeps a goal out of a hub's ranking on purpose (goals) |
| `managed_by` | no | string | The tool that creates, re-dates and closes this record; people and hubs leave its status to that tool (tasks) |
| `project` | no | string | In a hub's own brain: the connected project a task is for, so it ranks with that project (tasks) |
| `covers` | no | list of `<brain>/<id>` | Project goals and tasks a hub goal counts (hub goals) |
| `docs` | no | list of paths | Long documents this record points to, relative to `brain/` |
| `legacy_id` | no | string | The record's id in a system it was migrated from |
| `meta` | no | mapping | Anything else a tool needs to keep, under its own key |

Unknown top-level fields are allowed and preserved by every tool, but `lint` warns about them:
put tool-specific data under `meta.<tool>`.

**Field order.** Tools write fields in this order, and keep unknown fields after them:

`id`, `type`, `title`, `status`, `created`, `scope`, `tags`, `assignee`, `author`, `delegate`,
`updated`, `parent`, `supersedes`, `superseded_by`, `blocked_by`, `due`, `completed`, `importance`,
`docs`, `legacy_id`, `meta`.

The fields that change most (`status`, `scope`, `assignee`) are separated by fields that rarely
change. Git treats changes on neighbouring lines as one block, so two branches changing two
neighbouring fields would conflict; keeping them apart lets those merges succeed.

### The body

Free markdown. By convention, a record that collects updates over time ends with a `## Log`
section where each update is one new line appended at the end. Appending, never editing, keeps
concurrent updates mergeable.

### Changing records

- **Edit in place** for status changes, corrections and log lines. Tools do not stamp `updated`
  automatically: a field that changes on every edit makes any two concurrent edits to the same
  record conflict, and git already records when a file changed. Set it by hand only when it means
  something to a reader.
- **Decisions are permanent.** When a decision changes, create a new decision with
  `supersedes: <old id>`, and set the old one's `status: superseded` and `superseded_by: <new id>`.
  The same pattern works for any type whose history matters.
- **Do not delete records.** Set `status: dropped`. Deleting loses history and breaks links.

### Core types

| Type | Folder | Use |
|---|---|---|
| `note` | `notes/` | Context, observations, meeting notes, summaries |
| `decision` | `decisions/` | A choice made, with the reasoning in the body |
| `question` | `questions/` | Something unresolved that needs an answer |
| `insight` | `insights/` | Something learned that should change future work |
| `task` | `tasks/` | Work to do |
| `milestone` | `milestones/` | A notable point reached, or a dated target |
| `goal` | `goals/` | An outcome the work is for, with `done_when`, `measure` and a `## Pace` log; `done` when reached |

## brain.yaml

```yaml
format: 1                 # this spec's version
name: web-app             # how hubs name this brain; lowercase, a-z 0-9 and -
title: Web App            # optional display name
scopes:                   # optional: monorepo sub-projects records may name
  - apps/web
  - packages/billing
types:                    # optional: extra record types (see Extending)
  - name: memory
    folder: memories        # records in brain/records/memories/
    kit: example-kit
  - name: swarm-run
    path: swarm             # records anywhere under brain/swarm/ (a kit-owned folder)
    kit: example-kit
hub: true                 # hubs only (see Hub)
connects: []              # hubs only (see Hub)
```

## Extending a brain

Kits build workflows on a brain without changing the core:

- **Register a record type** in `brain.yaml` under `types`. Its records live in
  `brain/records/<folder>/`, or, with `path` instead of `folder`, anywhere under a kit-owned folder
  `brain/<path>/`. They use the same file format and core fields, and are indexed and searched like
  core records. A record under a `path` folder may be named freely (for example
  `brain/swarm/<run-id>/run.md`); its `id` field is what identifies it.
- **Own a folder** at `brain/<folder>/` for long documents or structured output, such as
  `brain/plans/` or `brain/research/`. The index ignores kit folders unless a registered type points
  at them. Records link to these documents with `docs`.
- **Keep live state in `brain/.local/<kit>.db`** or similar. Anything under `.local/` is local to the
  machine, never committed, and never treated as truth by other tools.

- **Index another tool's files** with `schema: loose` on a registered type, for example Claude Code's
  memory files (`- name: memory` / `path: memory` / `schema: loose`). Loose files are indexed and
  searchable but never linted: their id is `<type>:<file name>`, the title comes from `title`,
  `name`, the first heading or the file name, and files without frontmatter are indexed whole.

A kit must not write fields with core meanings for other purposes, and must not store data only in
`.local/` that other people need to see.

## The index

`brain/.local/index.db` is a SQLite database built from the files:

- one row per record with every field (lists as JSON), the file path, its modification time and a
  content hash;
- an FTS5 full-text table over title, body and tags.

Before every query, tools re-read files whose modification time or size changed since the last
build, add new files and drop rows whose file is gone. `index --rebuild` starts from scratch.
Agents may query the index with any SQLite client, but must never write to it: a write there is
lost on the next refresh.

## Hub

A hub is a brain whose `brain.yaml` says `hub: true` and lists other brains under `connects`, in
the owner's project order (a non-empty `connects` alone also makes a brain a hub):

```yaml
format: 1
name: sams-hub
hub: true
connects:
  - name: web-app
    path: ~/dev/web-app          # local clone
    remote: github.com/acme/web-app
  - name: billing
    path: ~/dev/billing
```

The hub keeps its own records like any brain (cross-project decisions, daily plans as notes) and
adds `priorities.md`: the owner's personal ranking of tasks across every connected brain, and,
under an optional `## Goals` heading, a ranking of goals. Goals live at both levels: a project's
goals in its own brain, and goals that span projects in the hub's brain. A task `serves` one goal in
its own brain; a hub goal reaches project work one way, by listing keys in `covers` (a brain never
knows its hubs).

```markdown
# Priorities

1. web-app/7f3a  Build the import screen
2. billing/91c2  Fix the proration bug
3. web-app/c41e  Write the onboarding email
```

Line order is the rank: no two items are equal. Only the owner (or tools acting for them) edits
this file. Tasks in connected brains that are not yet listed are the **inbox**; tasks whose status
is no longer `active` or `blocked` drop off. A brain never knows which hubs read it, and holds no
hub settings: a brain can belong to many hubs, and a machine can hold many hubs. A hub also carries
`brain/HUB.md`, the agent guide for working it, refreshed by the tools.

### Wiring

Tools set up the folders that use a brain or a hub so an agent can work in them straight away
(`reinstall-brain init|wire`, `reinstall-hub init|connect|sync`): the `brain` skill (and the `hub`
skill in a hub) linked into `.claude/skills/`, a session hook that loads the brain's context, and a
managed block in `CLAUDE.md` and `AGENTS.md` pointing at the guide. The links are git-ignored, since
they hold one machine's paths; everything else is committed.

## Versioning

`format` in `brain.yaml` is this spec's major version. Tools refuse to write to a brain with a newer
format than they know, and may read it.
