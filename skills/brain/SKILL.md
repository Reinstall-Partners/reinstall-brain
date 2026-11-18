---
name: brain
description: Read, write and search this repo's brain (Reinstall Brain): decisions, tasks, questions, insights, notes and milestones as markdown records. Also sets a brain up in a repo. The everyday interface for project knowledge and task tracking.
argument-hint: "[setup|update|audit|goals|add <type>|done [id]|search <words>|show <id>|resolve <id>|supersede <old> [new]|depends <id> <on>|tag <id> <tags>|lint]"
---

**When Reinstall Brain itself gets in your way** (a flag that doesn't exist, confusing output, a wrong
assumption in this guide), tell the user in one line and offer to report it:
`reinstall-brain feedback "<what happened>" --kind bug|nit|idea --body "<detail>" --command "<what you ran>"`.
It shows the issue first; show it to the user and add `--yes` once they agree. The repository is public:
use generic names (acme, widgets), never a client's, a person's or a path.

## Goals
!`"$(command -v reinstall-brain || echo ~/.reinstall-brain/shim/reinstall-brain)" sql "SELECT id, title, json_extract(fields,'$.measure') AS measure, due, path FROM records WHERE type = 'goal' AND status = 'active' ORDER BY created" 2>/dev/null || true`

## Active tasks
!`"$(command -v reinstall-brain || echo ~/.reinstall-brain/shim/reinstall-brain)" sql "SELECT id, status, substr(created,1,10) AS created, title, path FROM records WHERE type = 'task' AND status IN ('active','blocked') ORDER BY status = 'blocked' DESC, created DESC LIMIT 25" 2>/dev/null || echo "No brain here, or the reinstall-brain CLI is not installed: see Setup"`

## Open questions
!`"$(command -v reinstall-brain || echo ~/.reinstall-brain/shim/reinstall-brain)" sql "SELECT id, substr(created,1,10) AS created, title, path FROM records WHERE type = 'question' AND status = 'active' ORDER BY created DESC LIMIT 15" 2>/dev/null || echo "None"`

## Recent decisions
!`"$(command -v reinstall-brain || echo ~/.reinstall-brain/shim/reinstall-brain)" sql "SELECT id, substr(created,1,10) AS created, title, path FROM records WHERE type = 'decision' AND status = 'active' ORDER BY created DESC LIMIT 10" 2>/dev/null || echo "None"`

---

# Brain

The project's memory lives in `brain/` at the repo root: one markdown file per record (decisions,
questions, insights, tasks, notes, milestones, goals), committed to git. The files are the truth; the
`reinstall-brain` CLI reads and writes them safely and keeps a disposable SQLite index in
`brain/.local/` for fast queries. The format, the fields and how to work by hand are in
`brain/README.md`; read it once if anything below is unclear.

## Input

Optional argument: `$ARGUMENTS`

Dispatch on the first word:

- `setup` — **Setup**: create or repair this repo's brain and its wiring
- (empty) — **Review**: the "what's going on" view
- `update` — **Update**: make the brain match what just happened this session
- `audit` — **Audit**: a health check of the whole brain
- `goals` — **Goals**: each goal, its pace, and the tasks serving it (or none)
- `add <type>` — **Add**: create a record (note, decision, question, insight, task, milestone, goal)
- `done <id>` — **Done**: finish a task. `done` with no id closes the session: run **Update**
- `search <words>` — **Search**: full-text search over titles, bodies and tags
- `show <id>` — **Show**: one record, its children and its links
- `resolve <question id>` — **Resolve**: answer a question with a linked decision
- `supersede <old id> [new id]` — **Supersede**: replace a decision (or any record whose history matters)
- `depends <id> <other id>` — **Depends**: mark that a task waits on another record
- `tag <id> <tags>` — **Tag**: replace a record's tags
- `lint` — **Lint**: check every record file

A tag word as the only argument (e.g. `billing`) is a **Review** filtered to that tag.

**Talking to the user:** name every record by a markdown link to its file, with its title as the
text (`[Ship the importer](brain/records/tasks/k3x9-ship-the-importer.md)`), never by a bare id. Every
`--json` result carries `path`. When the user has choices to make (what to drop, which answer), put
them in small rounds with your question tool when you have one, recommendation first, rather than in
a long list to read.

## The CLI in one screen

```bash
reinstall-brain list [--type T] [--status S] [--tag X] [--limit N] --json   # newest first
reinstall-brain search "<words>" [--limit N] --json                         # FTS: a b | a OR b | "a phrase" | pre*
reinstall-brain show <id> --json                                             # also takes a legacy number: 512 or '#512'
reinstall-brain sql "<SELECT ...>" --json                                    # read-only, table: records
reinstall-brain new <type> "<title>" --author "claude (for <owner>)" [--tag x]... [--parent id] [--body-file -|F] [--set field=value]... --json
reinstall-brain set <id> field=value... [--log "claude (for <owner>): what happened"]
reinstall-brain done <id> [--log "claude (for <owner>): what happened"]
reinstall-brain supersede <old-id> <new-id>
reinstall-brain lint
```

The `records` table has `id, type, title, status, created, scope, assignee, author, delegate,
updated, parent, supersedes, superseded_by, due, completed, legacy_id, importance, tags,
blocked_by, docs, meta, fields, body, path`. `tags`, `blocked_by` and `docs` are JSON arrays
(`EXISTS (SELECT 1 FROM json_each(tags) WHERE value = 'x')`), `meta` is JSON
(`json_extract(meta, '$.plan_id')`). Ids are random 4-character strings: order by `created`, never
by id.

---

## Setup

Run when the repo has no `brain/`, the CLI is missing, or the session said the wiring drifted.

1. **The CLI.** `reinstall-brain version`. If it is missing, tell the user how to install it in one
   step, from GitHub (no npm registry needed):
   ```bash
   git clone https://github.com/Reinstall-Partners/reinstall-brain ~/reinstall-brain
   node ~/reinstall-brain/setup.mjs
   ```
   (Any folder works for the clone; `setup.mjs` points `~/.reinstall-brain` at it.) Until it is
   installed, work from the files as `brain/README.md` says.
2. **The brain.** `reinstall-brain init` creates `brain/` (never overwriting anything) and wires this
   repo: the `/brain` skill, a session hook that loads the brain's context, and a short guide block in
   `CLAUDE.md` and `AGENTS.md`. On a brain that already exists it only repairs the wiring
   (`reinstall-brain wire` does that alone).
3. **A hub.** If the user keeps one, offer to connect this repo to it:
   `reinstall-hub list`, then `reinstall-hub connect . --hub <name>`. Connecting is what puts this
   repo's tasks in the hub's ranking.
4. Commit `brain/`, `CLAUDE.md`, `AGENTS.md`, `.claude/settings.json` and `.gitignore` when the user
   agrees. The skill links themselves are git-ignored (they hold this machine's paths).

---

## Review (default)

Start from the state loaded above, then go deeper where it helps:

```bash
reinstall-brain list --type task --status active --json        # with bodies, for context
reinstall-brain list --type task --status blocked --json
reinstall-brain sql "SELECT id, substr(created,1,10) AS created, title, substr(body,1,160) AS gist FROM records WHERE type = 'decision' AND status = 'active' ORDER BY created DESC LIMIT 10" --json
```

With a tag argument, filter tasks and questions with `--tag <tag>`.

Present it conversationally:
- Goals first, each with how many open tasks serve it (`reinstall-brain goals --json`)
- Active tasks, grouped by the goal they serve (or by tag) where that helps
- Blocked tasks, with what each waits on (`blocked_by`) and whether that has moved
- Open questions that need an answer
- Recent decisions that set direction

The brain holds no ranking. If the user keeps a hub, the order of what matters lives in its
`priorities.md`; otherwise offer your view of what to do next and hold it loosely.

---

## Goals

A goal is an outcome the work is for. Its fields: `done_when` (when it counts as reached), `measure`
(how to read progress: a command, a query, a count), optional `due`, and a `## Pace` log in the body.
A task serves one goal: `serves: <goal id>`.

```bash
reinstall-brain goals --json          # each active goal with open_tasks and done_tasks, and the unserved tasks
```

1. Show each goal as a link with its latest Pace line and how many open tasks serve it.
2. **Read the pace** when asked, or when the last Pace line is more than a week old: run or read the
   measure, then append a line to the goal's `## Pace` section: `- YYYY-MM-DD: <reading>` (edit the file).
3. **Tasks serving no goal:** put them to the user in rounds of up to 4 (your question tool if you have one, otherwise a short numbered list). For each,
   offer the active goals that fit (recommendation first) and **No goal: drop it** or **No goal: keep**.
   Record a choice with `reinstall-brain set <task id> serves=<goal id>`, or drop it (see **Done**).
4. **A goal reached:** `reinstall-brain done <goal id> --log "claude (for <owner>): <the reading that met done_when>"`.

---

## Update

Make the brain match what actually happened this session. Lighter than an audit: the audit looks
back over weeks and asks strategic questions; update asks "does the brain match what just
happened?"

1. **What shipped.** `git log --oneline --since='3 hours ago'` (or since the session began), plus
   the work in this conversation.
2. **Tasks that are now done.** Check each active task against what shipped:
   ```bash
   reinstall-brain list --type task --status active --json
   ```
   For each one the work completed:
   ```bash
   reinstall-brain done <id> --log "claude (for <owner>): <what was accomplished>"
   ```
   `done` sets `completed` and appends the log line.
3. **Decisions made but not logged.** Architectural choices, direction changes or settled
   trade-offs from this session that weren't captured by `/brainstorm` or `/brain add`. Write each
   one (see **Add**), with the reasoning in the body.
4. **Linked documents.** A record with `docs:` points at a longer file (a plan, a spec). If that
   document moved on this session, check the record still says the right thing.
5. **Stale state.** Tasks the codebase shows are done, blocked tasks whose blockers are done,
   decisions this session replaced (supersede them, see **Supersede**).
6. **A lesson.** If a reusable lesson emerged, write it as an insight tagged `lesson`: one
   sentence stating the rule, then **Why** and **How to apply**.
7. **Show what changed**: tasks closed, records written, links fixed. Never change the brain
   silently.

---

## Audit

A health check of the whole brain: what moved, what's stale, what's unanswered, and what was
decided without saying why. Run it whenever the brain needs a checkup. Every query is read-only;
propose changes and wait for direction before closing or dropping anything.

### 1. Since when

```bash
reinstall-brain sql "SELECT id, created FROM records WHERE type = 'milestone' AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = 'audit') ORDER BY created DESC LIMIT 1" --json
```

No prior audit means 30 days ago. Call that date `<since>` (YYYY-MM-DD).

### 2. What moved

```bash
git log --oneline --since='<since>'
reinstall-brain sql "SELECT id, type, title, substr(coalesce(completed, created),1,10) AS date FROM records WHERE (completed >= '<since>' OR (created >= '<since>' AND type IN ('decision','insight','milestone'))) ORDER BY coalesce(completed, created) DESC" --json
```

Start with what was accomplished, grouped by theme. Progress first, problems second.

### 3. Stale active tasks

Open tasks older than 30 days:

```bash
reinstall-brain sql "SELECT id, status, substr(created,1,10) AS created, title, tags, json_extract(meta,'$.plan_id') AS plan FROM records WHERE type = 'task' AND status IN ('active','blocked') AND created < date('now','-30 days') ORDER BY created" --json
```

Leave out tasks whose plan had a task completed in the last 14 days (that plan has momentum):

```bash
reinstall-brain sql "SELECT DISTINCT json_extract(meta,'$.plan_id') AS plan FROM records WHERE completed >= date('now','-14 days') AND json_extract(meta,'$.plan_id') IS NOT NULL" --json
```

Blocked tasks whose blockers are already closed, or missing:

```bash
reinstall-brain sql "SELECT t.id, t.title, b.value AS waits_on, w.status AS waits_on_status FROM records t, json_each(t.blocked_by) b LEFT JOIN records w ON w.id = b.value WHERE t.status IN ('active','blocked') AND (w.id IS NULL OR w.status IN ('done','dropped','superseded'))" --json
```

For each: still relevant? Check the codebase and recent decisions. Propose keep, unblock, finish
or drop.

### 4. Unanswered questions

```bash
reinstall-brain sql "SELECT q.id, substr(q.created,1,10) AS created, CAST(julianday('now') - julianday(substr(q.created,1,10)) AS INTEGER) AS days_open, q.title, (SELECT count(*) FROM records t, json_each(t.blocked_by) b WHERE b.value = q.id AND t.status IN ('active','blocked')) AS blocking FROM records q WHERE q.type = 'question' AND q.status = 'active' ORDER BY q.created" --json
```

For each: has the answer emerged from recent work or decisions? If so, propose resolving it (see
**Resolve**). Questions that block tasks come first.

### 4b. Goals

```bash
reinstall-brain goals --json
```

Flag goals with no open tasks serving them (stalled, or done without being closed), goals whose last
Pace line is old, and open tasks serving no goal. Propose: tie each unserved task to a goal or drop
it, close goals that are reached, and read the pace of the stale ones.

### 5. Decisions without reasoning

A decision whose body doesn't say why can't be revisited well. Flag short bodies and untouched
templates:

```bash
reinstall-brain sql "SELECT id, substr(created,1,10) AS created, title, length(trim(coalesce(body,''))) AS body_chars FROM records WHERE type = 'decision' AND status = 'active' AND (length(trim(coalesce(body,''))) < 80 OR trim(body) LIKE 'What was decided.%') ORDER BY created DESC" --json
```

Read each flagged body: some short ones say enough. For the rest, propose the reasoning from
context (the parent record, the conversation, the commit that made it) and, once the user agrees,
add it to the record file under a **Why:** line.

### 6. Decisions nothing acted on

Recent decisions with no child records and no task waiting on them:

```bash
reinstall-brain sql "SELECT d.id, substr(d.created,1,10) AS created, d.title FROM records d WHERE d.type = 'decision' AND d.status = 'active' AND d.created >= '<since>' AND NOT EXISTS (SELECT 1 FROM records c WHERE c.parent = d.id) AND NOT EXISTS (SELECT 1 FROM records t, json_each(t.blocked_by) b WHERE b.value = d.id) ORDER BY d.created DESC" --json
```

Many decisions need no follow-up. Flag only those that imply work nobody has picked up.

### 7. Shape of the brain

```bash
reinstall-brain sql "SELECT type, status, count(*) AS n FROM records GROUP BY type, status ORDER BY type, status" --json
reinstall-brain sql "SELECT j.value AS tag, count(*) AS n FROM records, json_each(records.tags) j WHERE records.status IN ('active','blocked') GROUP BY j.value ORDER BY n DESC LIMIT 20" --json
reinstall-brain lint
```

Note what's out of balance: a pile of open tasks against few completions, tag sprawl (near
duplicates such as `billing` and `payments`), lint errors.

### 8. Docs that cite dead records

Documents in the repo may cite records by id (`k3x9`) or by an old number (`#512`). For each
citation you find in the project's main docs, check the record with `reinstall-brain show`; if it
is `superseded` or `dropped`, list the doc and propose the update (follow `superseded_by` to the
replacement).

### 9. Log the audit

```bash
reinstall-brain new milestone "Audit — <YYYY-MM-DD>" --author "claude (for <owner>)" --tag audit --body-file - --json <<'EOF'
<what moved; what was proposed for dropping, unblocking or resolving and what the user chose;
decisions given their reasoning; brain health notes>
EOF
```

---

## Add

Usage: `add <type>` where type is `note`, `decision`, `question`, `insight`, `task` or `milestone`.

1. Parse the type. If missing or invalid, ask.
2. Settle with the user (or infer from the conversation):
   - **Title** (required): one line
   - **Body**: the detail. A decision states what was decided and **Why**; a task says what done
     looks like; a question says why it matters and what depends on it
   - **Tags**: a few lowercase words; reuse existing ones before inventing new ones:
     `reinstall-brain sql "SELECT DISTINCT value FROM records, json_each(records.tags) ORDER BY value"`
   - **Parent**: the record this came out of, if any
   - **Importance** (notes and insights, optional): 0–10. It is not a rank
   - **Goal a task serves**: for a task, when the brain has active goals, ask which one it serves
     (one question, the likeliest goal first, plus **None**) and pass `--set serves=<goal id>`
   - **For a goal**: the outcome as the title, plus `--set done_when="..."` and `--set measure="..."`
     (and `--set due=YYYY-MM-DD` if there is a date). Its body says why it matters
3. Present what you will write and wait for confirmation.
4. Write it, with the body on stdin so quotes and newlines survive:
   ```bash
   reinstall-brain new <type> "<title>" --author "claude (for <owner>)" --tag <tag> [--parent <id>] [--set importance=7] [--set due=YYYY-MM-DD] --body-file - --json <<'EOF'
   <body>
   EOF
   ```
5. Confirm with a link to the new record's file.

---

## Done

`done <id>` finishes a task:

```bash
reinstall-brain done <id> --log "claude (for <owner>): <what was accomplished>"
```

`done` with no id closes the session: run **Update**, then tell the user in two or three lines
what changed in the brain.

To drop a task instead (abandoned, not finished), never delete the file:

```bash
reinstall-brain set <id> status=dropped --log "claude (for <owner>): <why>"
```

---

## Search

```bash
reinstall-brain search "<words>" --limit 20 --json
```

Search ranks by relevance over titles, bodies and tags. Syntax: `word1 word2` (both),
`word1 OR word2`, `"exact phrase"`, `prefix*`, `NOT word`. It returns every status: say which
results are `done`, `dropped` or `superseded`, and follow `superseded_by` to the current record.
If nothing matches, try fewer words or a prefix, then suggest related tags.

Present results grouped by type, with enough of each body to be useful.

---

## Show

```bash
reinstall-brain show <id> --json
reinstall-brain sql "SELECT id, type, status, title FROM records WHERE parent = '<id>' ORDER BY created" --json
```

Present the record, what it came out of (`parent`), what came out of it (children), what it waits
on (`blocked_by`), and if superseded, what replaced it.

---

## Resolve

Answer an open question with a linked decision. Usage: `resolve <question id>`

1. Read the question (`reinstall-brain show <id> --json`). If it isn't a question, say so.
2. Ask for the answer, or infer it from the conversation and confirm.
3. Write the decision as the question's child:
   ```bash
   reinstall-brain new decision "<the answer, as a decision>" --author "claude (for <owner>)" --parent <question id> --tag <tag> --body-file - --json <<'EOF'
   <what was decided>

   **Why:** <the reasoning>
   EOF
   ```
4. Close the question, pointing at the answer:
   ```bash
   reinstall-brain done <question id> --log "claude (for <owner>): resolved by decision <new id>"
   ```
5. Confirm both.

---

## Supersede

Decisions are permanent: never edit one to change its meaning. Usage: `supersede <old id> [new id]`

- With a new id, link them: `reinstall-brain supersede <old id> <new id>`.
- Without one, write the replacement first (see **Add**: same type, body says what changed and
  why), then link it.

`supersede` sets the new record's `supersedes`, and the old one's `status: superseded` and
`superseded_by`, so anyone reading the old record is sent to the new one.

---

## Depends

Mark that a task waits on another record (a decision, question or task). Usage: `depends <id> <other id>`

1. Read the task's current `blocked_by` with `reinstall-brain show <id> --json`.
2. Set the full list (it replaces, so include the existing ids):
   ```bash
   reinstall-brain set <id> blocked_by=<existing>,<other id> status=blocked --log "claude (for <owner>): waits on <other id>"
   ```
   Use `status=blocked` only if the task truly can't move until then; otherwise leave the status.
3. Confirm: "<id> now waits on <other id>: <title>".

---

## Tag

Replace a record's tags. Usage: `tag <id> <tags>`

```bash
reinstall-brain set <id> tags=<tag1>,<tag2>
```

The CLI lowercases, sorts and deduplicates them. Show the before and after.

---

## Lint

```bash
reinstall-brain lint
```

Report errors and warnings with the file path of each. Fix what is plainly mechanical (a
misspelled status, an unsorted tag list) by editing the file; ask about anything else.

---

## Conventions

- **The CLI, never sqlite3.** Reads use `list|search|show|sql`, writes use
  `new|set|done|supersede`. `sql` refuses anything but SELECT/WITH: the index is rebuilt from the
  files, so a write there would be lost.
- **Bodies are edited in the file.** There is no CLI command for body text: open the record at
  its `path` and edit it. Progress goes on a new line at the end of its `## Log` section
  (`- YYYY-MM-DD claude (for <owner>): what happened`); append, never rewrite earlier lines.
  `set ... --log` and `done --log` append that line for you.
- **Authorship.** Every write passes `--author "claude (for <owner>)"`, and every log line reads
  `claude (for <owner>): ...`. `<owner>` is the person you are working for; default to
  `git config user.name`.
- **Decisions are permanent.** Supersede, never rewrite.
- **Never delete a record.** Set `status=dropped`.
- **No ranking in the brain.** Records hold facts: what, status, who, when. Order of importance
  belongs to a hub's `priorities.md`.
- **Meta values are strings** when they look like numbers: `meta.plan_id='003'`, never `3`.
- **Long documents** (plans, research, specs) live in their own files, often in folders under
  `brain/` such as `brain/plans/`; records point at them with `--set docs=<path relative to brain/>`.

## Rules

- **Reads need no permission.** Review, Search, Show, Audit's queries and Lint run straight away.
- **Writes are proposed first** for Add, and for any status change during Audit. Update and Done
  act on what plainly happened, then show what changed.
- **Keep it conversational.** Narrate results; don't paste raw tables. Records are links, never bare ids.
- **Opinionated but collaborative.** In an audit, propose what to drop, unblock and resolve. Hold
  it loosely: the user makes the call.
