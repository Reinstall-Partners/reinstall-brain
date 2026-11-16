# Reinstall Brain

A brain for every project, and one hub over all of them.

- **Brain** keeps a project's decisions, tasks, questions, insights and notes as plain markdown
  files in the repo: one file per record, readable by any agent with `cat` and `grep`, diffable
  and mergeable in git. A local SQLite index is built from the files automatically, so agents can
  query and search fast. The index is never the source of truth.
- **Hub** connects many brains into one view for a person or a team, and keeps the one thing a
  brain never holds: the order of what matters most.

Brain and Hub are primitives with their own skills for using them. Your way of working (planning,
reviews, release flow) is yours to build on top.

> Status: early development. The format and commands are not stable yet.

## Install

From GitHub, no package registry needed (Node 22.13+):

```bash
git clone https://github.com/Reinstall-Partners/reinstall-brain ~/reinstall-brain
node ~/reinstall-brain/setup.mjs --hub ~/my-hub     # --hub is optional
```

`setup.mjs` builds the CLI, puts `reinstall-brain` and `reinstall-hub` on your PATH, and points
`~/.reinstall-brain` at the clone. Every folder you wire links its skills through that pointer, so
`reinstall-brain update` (a pull and a rebuild) updates all of them at once.

## Use it through your agent

Brain and Hub ship their own skills and agent guidance, and wire them into the folders that use them:

- **A hub** is where you start: `reinstall-hub init <folder>` (or `--hub` above) makes one, then open
  that folder with your agent (Claude Code, or any agent that reads `AGENTS.md`) and run **`/hub`**. It
  finds your repos and asks which to connect, then helps you rank everything across them in short
  rounds of choices, and plans your day.
- **Each connected repo** gets a brain (if it had none), the **`/brain`** skill, a session hook that
  loads the brain's open tasks, questions and decisions, and a short block in `CLAUDE.md` and
  `AGENTS.md` pointing any agent at the guide. One repo alone: `cd <repo> && reinstall-brain init`.
- **Many hubs** are fine: one for your own work, one per team or client. A repo can be in more than
  one. Commands act on the hub you are in, or `--hub <name>`; `reinstall-hub list` shows them all.

Everything is plain files, so an agent without the CLI can still read and write a brain
(`brain/README.md`) and work a hub (`brain/HUB.md`).

## Commands

```
reinstall-brain init                         create brain/ in this repository
reinstall-brain new task "Ship the importer" --tag import
reinstall-brain list --type task --status active [--json]
reinstall-brain search "importer"
reinstall-brain show <id>
reinstall-brain set <id> status=blocked --log "sam: waiting on review"
reinstall-brain done <id>
reinstall-brain supersede <old-id> <new-id>
reinstall-brain sql "SELECT type, count(*) FROM records GROUP BY type"
reinstall-brain lint
reinstall-brain doctor
reinstall-brain wire                         re-link this repo's skill, session hook and guide
reinstall-brain update                       pull, rebuild, re-wire every hub

reinstall-hub init <folder>                  create or adopt a hub, register it, wire it
reinstall-hub connect <repo>                 connect a repo (sets up its brain) and wire it
reinstall-hub priorities | inbox             the ranking, and what is not ranked yet
reinstall-hub place <brain>/<id> --at 3      rank a task
reinstall-hub sync [--all] | list | use <name>
```

Every command refreshes the index from the files first, so hand edits are always picked up.
The format is specified in [docs/brain-spec.md](docs/brain-spec.md).

## License

MIT
