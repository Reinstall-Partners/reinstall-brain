<!-- Managed by reinstall-brain: `reinstall-hub sync` rewrites this file. Put your own notes elsewhere. -->
# This hub

This folder is a **hub**: a brain that connects other brains. `brain/brain.yaml` lists the project
brains it connects under `connects:`, in project order (the first is the most important project). The
hub holds one thing no project brain does: `brain/priorities.md`, the owner's strict ranking of tasks
across every connected brain. Line order is the rank, and no two items are equal.

A machine can have many hubs, and a project can be connected to more than one. Each hub's ranking is
its own.

## Keys

Every task in a hub is named `<brain>/<id>`: the brain's name from `connects:` and the record's id
(`acme-web/k3x9`). `priorities.md` holds one key per line, numbered, with the title after it as a
reminder:

```
1. acme-web/k3x9  Ship the importer
2. ops/7f3a  Renew the TLS certificate
```

## With the CLI (preferred)

| To | Run |
|---|---|
| see the ranking | `reinstall-hub priorities --json` (finished tasks drop off the file automatically) |
| see what is not ranked yet | `reinstall-hub inbox --json` (`--brain NAME`, `--limit N`) |
| rank a task | `reinstall-hub place <brain>/<id> --top`, `--at N`, `--above <key>`, `--below <key>`, `--bottom` |
| un-rank a task | `reinstall-hub unrank <brain>/<id>` |
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
3. **The ranking:** the numbered lines of `brain/priorities.md`. A key in the file whose task is no
   longer open should be removed. A task that is open and not in the file is in the inbox.
4. **Ranking:** rewrite the numbered list in the new order, renumbering from 1. Keep the header lines.

## Rules for an agent helping the owner prioritize

- **The order is the owner's.** Propose, then place only what the owner agreed to.
- **Ask in small rounds.** Put a few tasks to the owner at a time, with a recommendation first and the
  reason in a few words, and offer a short set of choices. Use your question tool when you have one.
  Never hand the owner a wall of text to read.
- **Name tasks by link,** `[Ship the importer](/abs/path/to/record.md)`, never by a bare key or id.
- **Signals, strongest first:** project order from `brain.yaml`, then due dates, people waiting on the
  owner, blocked work that this task unblocks, and age (an old untouched task may be dead: offer to drop
  it).
- **Never express priority inside a project brain.** Ranking lives only in `priorities.md`. Changing a
  task itself (dropping it, adding a due date) is a write to that project's brain: do it there, only
  when the owner says so.
- **A plan for the day** is a note in this hub's own brain, tagged `daily-plan`:
  `reinstall-brain new note "Plan for YYYY-MM-DD" --tag daily-plan --body-file -`.
