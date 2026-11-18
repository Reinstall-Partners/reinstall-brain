# Reinstall Brain

**Memory for your coding agents, and one ranked to-do list across all your repos.**

Your agent forgets everything when the session ends. The decision you made on Tuesday, the bug you
parked, the plan you agreed: gone, unless you paste it back in. And once you have more than one repo,
nobody (you included) knows what to work on next across all of them.

Reinstall Brain fixes both, with plain markdown files in git:

- **A brain in every repo.** `brain/` holds the project's tasks, decisions, questions, goals and plans,
  one small markdown file each. When an agent opens the repo, it already knows the open tasks and what
  was decided, and it writes down what it learns as it works.
- **One hub over all of them.** A hub is a folder that connects your repos' brains. You rank your
  projects and your goals; every task in every repo then falls into one order. Open the hub, type
  `/hub`, and your agent plans the day with you from the whole picture.
- **Nothing to run, nothing to lose.** The files are the truth. Any agent can read them with `cat` and
  `grep`, git merges them cleanly, and the small CLI that makes it fast is optional.

```
            my-hub/   your project order · your goals · one ranked list
               │
     ┌─────────┼──────────┐
     ▼         ▼          ▼
  web-app/   site/     client-x/      each repo keeps its own brain/
  brain/     brain/    brain/         (tasks, decisions, goals, plans)
```

**[How a hub works →](docs/hub.md)** (what lives where, how the order is made, a worked example)

> Status: early. The format and commands may still change.

## Try it in two minutes

```bash
git clone https://github.com/Reinstall-Partners/reinstall-brain ~/reinstall-brain
node ~/reinstall-brain/setup.mjs
cd ~/reinstall-brain
reinstall-hub priorities --hub examples/demo/acme-hub
```

That is a ready-made hub with two small projects. [docs/hub.md](docs/hub.md#try-it) explains the order
you see and what to try next. Nothing in your own repos is touched.

## Set it up

You need Node 22.13 or newer and git. Install once (the two lines above): `setup.mjs` builds the CLI,
puts `reinstall-brain` and `reinstall-hub` on your PATH, and points `~/.reinstall-brain` at the clone.
`reinstall-brain update` pulls and rebuilds later.

**With your agent (easiest).** Make a hub and let your agent do the rest:

```bash
reinstall-hub init ~/my-hub
```

Open `~/my-hub` in your agent (Claude Code: `claude` in that folder) and type **`/hub`**. It finds the
repos on your machine and asks which to connect, sets up a brain in each, then asks a few short
questions to rank your projects and goals. Commit what it wrote in each repo when it's done.

**By hand.**

```bash
reinstall-hub init ~/my-hub
reinstall-hub connect ~/dev/web-app --hub ~/my-hub    # makes web-app/brain/ if it has none
reinstall-hub connect ~/dev/site --hub ~/my-hub
reinstall-hub place-project web-app --top --hub ~/my-hub
reinstall-hub priorities --hub ~/my-hub
```

Just one repo, no hub: `cd <repo> && reinstall-brain init`.

### What it writes in your repo, and how to undo it

| File | What | Commit it? |
|---|---|---|
| `brain/` | the records, the guide (`brain/README.md`), record templates | yes |
| `CLAUDE.md`, `AGENTS.md` | a short block between `reinstall-brain` markers pointing the agent at `brain/README.md` | yes |
| `.claude/settings.json` | a session-start hook that loads the brain's open tasks, questions and decisions | yes |
| `.claude/skills/brain` (and `hub` in a hub) | links to the skills in your clone | no: git-ignored (managed block in `.gitignore`) |

Everything outside `brain/` is in clearly marked blocks, and your own lines are never touched.
`reinstall-brain unwire` removes all of it again (`--dry-run` shows what it would remove) and leaves
`brain/` alone; `reinstall-hub disconnect <name>` takes a repo out of a hub.

## How it compares

| | What it's good at | What it doesn't do |
|---|---|---|
| `CLAUDE.md` / `AGENTS.md` | Standing instructions for every session | It's one file everyone edits: no tasks, no history, merge conflicts |
| Your agent's built-in memory | Remembers facts about you | Private to one agent and one machine; not in the repo, not shared |
| GitHub Issues, Linear | Team tracking with a UI | Outside the repo, so the agent needs an API to see it; no cross-repo ranking you control |
| Obsidian, Notion | Notes for humans | Not next to the code; agents don't load it by default |
| **Reinstall Brain** | Project memory in the repo, loaded by the agent every session, and one ranked list across repos | No UI yet: you work through your agent and the files |

It doesn't replace your issue tracker for a team; plenty of people use both.

## Why it's built this way

- **Many agents at once, no conflicts.** One file per record, random ids, append-only logs and a field
  order chosen so concurrent edits land on different lines. Two agents, two branches, two people: git
  merges them.
- **Worktrees share one brain.** An agent in a git worktree reads and writes the main checkout's brain,
  so parallel agents see each other's records straight away.
- **Plain files first.** No server, no database to back up. The SQLite index in `brain/.local/` is
  rebuilt from the files whenever they change, and any agent without the CLI can still work from
  `brain/README.md`.
- **Decisions are permanent.** A changed decision is a new record that supersedes the old one, so the
  why behind the code survives.
- **Priority lives apart from facts.** A repo never stores a rank, so it can belong to your hub and your
  team's hub, each ranked their own way.
- **Goals you can measure.** A goal has a finish line, a measure and a pace log; give it a command and
  the hub reads it for you.
- **Bring your agent's own memory in.** Index another tool's files (Claude Code's memory folder, say)
  with `schema: loose`, and they become searchable alongside the records.

## Agents

Claude Code gets the most today: the `/brain` and `/hub` skills, and a session hook that loads the
brain when a session starts. Any agent that reads `AGENTS.md` (Codex, Cursor, Gemini CLI and others)
is pointed at `brain/README.md` and can work every record by hand or through the CLI.

## Commands

```
reinstall-brain new task "Ship the importer" --tag import     # also: decision, question, goal, …
reinstall-brain list --type task --status active [--json]
reinstall-brain search "importer"
reinstall-brain show <id>
reinstall-brain set <id> status=blocked --log "sam: waiting on review"
reinstall-brain done <id>

reinstall-hub priorities                   every open task across your repos, in order
reinstall-hub inbox                        the same, each plan as one row
reinstall-hub projects | goals             what you rank
reinstall-hub place-project <name> --top   rank a project
reinstall-hub place-goal <brain>/<id> --at 2
reinstall-hub place <brain>/<id> --top     pin a task ahead of the order
```

`reinstall-brain --help` and `reinstall-hub --help` list every command and flag. Every command
refreshes the index from the files first, so hand edits are always picked up.

## Docs

- [How a hub works](docs/hub.md): hub and spoke, what lives where, how the order is made, the demo.
- [The brain format](docs/brain-spec.md): records, fields, types, plans, the hub, extending a brain.
- [Where each idea is explained](docs/MAP.md): for contributors keeping the docs in step.

## License

MIT
