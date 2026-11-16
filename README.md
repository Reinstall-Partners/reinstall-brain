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
reinstall-brain doctor    check this machine can run the brain
reinstall-hub version
```

## License

MIT
