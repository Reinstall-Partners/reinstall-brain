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
3. Fill in `id`, `title` and `created` (ISO 8601, with time and offset, for example
   `2026-11-16T14:02:00-06:00`). Delete any field you leave empty. Write the body.

Types and their folders: `note` → `notes/`, `decision` → `decisions/`, `question` → `questions/`,
`insight` → `insights/`, `task` → `tasks/`, `milestone` → `milestones/`. Extra types are listed
under `types:` in `brain.yaml`.

## Change

- **Status, corrections, progress:** edit the record in place. Add progress as a
  new line at the end of its `## Log` section: `- YYYY-MM-DD who: what happened`. Append, never
  rewrite earlier lines.
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
