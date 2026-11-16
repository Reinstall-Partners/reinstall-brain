# This project's brain

This folder is the project's memory: its decisions, tasks, questions, insights, notes and
milestones, one markdown file per record. Read it before starting work, and record what you decide
and learn as you go. It works with plain file tools. The `reinstall-brain` CLI is faster and checks
your work, but you never need it.

## Read

- **Everything active of one kind:** `grep -l "^status: active" brain/records/tasks/*.md`
- **Search:** `grep -ril "<words>" brain/records/`
- **One record:** its id is in the file name: `brain/records/*/<id>-*.md`
- **With the CLI:** `reinstall-brain list --type task --status active --json`,
  `reinstall-brain search "<words>"`, `reinstall-brain show <id>`, or SQL over the index with
  `reinstall-brain sql "SELECT id, title FROM records WHERE type='decision'"`.

Before trusting a decision, check that it isn't `status: superseded`. If it is, follow
`superseded_by` to the record that replaced it.

## Write

**With the CLI:** `reinstall-brain new <type> "<title>" [--tag x] [--parent <id>]` creates the file and
prints its path. Then edit the body.

**By hand:**

1. Pick an id: 4 random characters from `0-9a-z`, for example `k3x9`. Check that no file in
   `brain/records/` already starts with `<id>-`.
2. Copy `brain/templates/<type>.md` to `brain/records/<type>s/<id>-<slug>.md`. The slug is the
   title in lowercase with every run of other characters turned into `-`, at most 60 characters.
3. Fill in `id`, `title` and `created`: the current date and time with its UTC offset, for example
   `2026-11-16T14:02:00-06:00` (`date +%Y-%m-%dT%H:%M:%S%z` prints it; add the colon in the offset).
   Delete any field you leave empty. Write the body.

Types and their folders: `note` → `notes/`, `decision` → `decisions/`, `question` → `questions/`,
`insight` → `insights/`, `task` → `tasks/`, `milestone` → `milestones/`. Extra types are listed
under `types:` in `brain.yaml`.

## Fields you will use most

- `status`: `active` (open), `blocked` (can't move until something else happens), `done`, `dropped`
  (abandoned) or `superseded` (replaced by a newer record).
- `blocked_by`: ids of records that must be resolved first. Use it with `status: blocked`.
- `assignee`: the person who owns a task. `delegate`: the agent doing it for them.
- `author`: who wrote the record. An agent writes `<agent> (for <person>)`, for example
  `claude (for sam)`. Log lines use the same form for `who`.
- `parent`: the record this one came out of, for example the task a decision was made for.
- `scope`: in a monorepo, the sub-project the record belongs to (`apps/web`). Leave it out otherwise.
- `tags`: a few lowercase words for finding things later. Records don't inherit tags from their parent.

## Change

- **Status, corrections, progress:** edit the record in place. Add progress as a
  new line at the end of its `## Log` section: `- YYYY-MM-DD who: what happened`. Append, never
  rewrite earlier lines.
- **Block a task:** `status: blocked`, list what it waits on in `blocked_by`, and add a log line.
- **Finish a task:** `status: done` and `completed: <date-time>`.
- **A decision changed:** never edit the old decision. Write a new one with `supersedes: <old id>`,
  then set the old one's `status: superseded` and `superseded_by: <new id>`.
- **Never delete a record.** Set `status: dropped` instead.

## Rules

- Keep the fields in the order the templates use. It keeps merges clean.
- Tags are lowercase, sorted, with no duplicates.
- Never write to `brain/.local/`: it is a rebuildable cache, and anything written there is lost.
- When you write as an agent on someone's behalf, set `author: <agent> (for <person>)`.
- This brain holds no rankings or priorities. Those live in a hub.

The full format is in the Reinstall Brain spec: https://github.com/Reinstall-Partners/reinstall-brain/blob/main/docs/brain-spec.md
