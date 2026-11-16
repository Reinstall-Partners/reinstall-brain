## Working with the brain

All project knowledge lives in `brain/`: one markdown file per record, committed with the repo.
`brain/README.md` is the format; the `/brain` skill is the everyday interface.

- **Read and write with the `reinstall-brain` CLI.** Reads: `list`, `search`, `show`, `sql "SELECT
  ..."` (table `records`), with `--json`. Writes: `new`, `set`, `done`, `supersede`. Never write to
  `brain/.local/`: the index there is rebuilt from the files, so a write to it is lost. Without the CLI,
  edit the record files as `brain/README.md` says.
- **Author every write** as `claude (for <owner>)`, where `<owner>` is the repo's `git config
  user.name` (`--author`, and the same form in `--log` lines).
- **Record types:** note, decision, question, insight, task, milestone, plus any registered in
  `brain/brain.yaml`.
- **Ids** are short random strings (`k3x9`). Never compare them or order by them; order by `created`.
  A migrated brain's old numbers still resolve: `reinstall-brain show 512`.
- **Talk to the user in links, not ids.** In every message to the user, name a record by a markdown
  link to its file, with its title as the text: `[Form the LLC](brain/records/tasks/k3x9-form-the-llc.md)`,
  never a bare `k3x9` or `#512`. The path is in `--json` output (`path`) and in the context above. Ids
  stay right in commands, records, plans and commit messages.
- **Decisions are permanent.** A changed decision is a new record, linked with `reinstall-brain
  supersede <old> <new>`. Never delete a record: set `status: dropped`.
- **Goals.** A `goal` record is an outcome the work is for (`done_when`, `measure`, a `## Pace` log).
  A task names the one goal it serves with `serves: <goal id>`. When you add a task, ask which goal it
  serves; `reinstall-brain goals` shows each goal with the open tasks serving it, and the tasks
  serving none.
- **No rankings in a brain.** Priority lives in a hub's `priorities.md`, never in a record.
- **Long documents** (plans, research, specs) live in their own files; a record points at one with
  `--set docs=<path relative to brain/>`.
