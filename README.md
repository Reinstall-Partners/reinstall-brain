# Reinstall Brain

A brain for every project, and one hub over all of them.

- **Brain** keeps a project's decisions, tasks, questions, insights and notes as plain markdown
  files in the repo: one file per record, readable by any agent with `cat` and `grep`, diffable
  and mergeable in git. A local SQLite index is built from the files automatically, so agents can
  query and search fast. The index is never the source of truth.
- **Hub** connects many brains into one view for a person or a team, and keeps the one thing a
  brain never holds: the order of what matters most.

Brain and Hub are primitives, not workflows. Build your own way of working on top of them.

> Status: early development. The format and commands are not stable yet.

## Install

```bash
npx reinstall-brain doctor        # needs Node 22.13+
```

Standalone binaries for macOS, Linux and Windows (no Node needed) will be attached to releases.

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
```

Every command refreshes the index from the files first, so hand edits are always picked up.
The format is specified in [docs/brain-spec.md](docs/brain-spec.md).

## License

MIT
