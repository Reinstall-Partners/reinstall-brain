# How a hub works

You have several repos: an app, a marketing site, a client project, maybe a side project. Each one has
its own brain: the tasks, decisions and goals of that project, in `brain/`, next to the code. That is
the right place for them: the agent working in the repo sees exactly that project's memory, and
nothing else's.

But you are one person, and you need one answer to "what should I work on next?" across all of them.
That is what a **hub** is for.

## The picture

```
                          ┌──────────────────────────────┐
                          │  my-hub/            (a hub)  │
                          │  brain/brain.yaml            │
                          │    connects:  1. web-app     │  ← your project order
                          │               2. site        │
                          │               3. client-x    │
                          │  brain/priorities.md         │  ← your goal order (+ a few pins)
                          │  brain/records/              │  ← goals and plans that span projects
                          └──────┬──────────┬──────────┬─┘
                     reads       │          │          │       reads
              ┌──────────────────┘          │          └─────────────────┐
              ▼                             ▼                            ▼
   ┌────────────────────┐       ┌────────────────────┐       ┌────────────────────┐
   │ web-app/           │       │ site/              │       │ client-x/          │
   │ brain/records/     │       │ brain/records/     │       │ brain/records/     │
   │   tasks, decisions,│       │   tasks, decisions,│       │   tasks, decisions,│
   │   goals, plans     │       │   goals            │       │   goals, plans     │
   └────────────────────┘       └────────────────────┘       └────────────────────┘
        (a spoke)                     (a spoke)                     (a spoke)
```

The hub is a brain like any other, plus a list of the brains it **connects** (the spokes). It reads
them; they never know it exists. So one repo can sit in several hubs (yours, your team's), and
connecting a repo changes nothing about how it works on its own.

## What lives where

| In each project's brain (a spoke) | In the hub |
|---|---|
| The project's tasks, decisions, questions, insights, notes | The **order of your projects** (`connects:` in `brain.yaml`) |
| The project's goals ("the importer handles every bank file") | Goals that span projects ("first paying customer by March") |
| Plans for work in that repo | Plans for work across repos, and their decisions |
| Nothing about priority, ever | The **order of your goals**, and the few tasks you pin (`brain/priorities.md`) |
| | Your plan for the day (a note) |

The rule that makes this work: **a project's brain records facts; only the hub ranks.** A task never
carries a priority number. If it did, two people (or two hubs) who rank differently would fight over
the same field, and every re-prioritization would be a commit in every repo.

## How the order is made

You rank only two things, and both are short lists:

1. **Projects:** the order of `connects:`. Which project matters most right now?
2. **Goals:** the numbered list under `## Goals` in `priorities.md`. Which outcomes matter most?

Every open task in every connected repo then takes its place on its own, by:

1. its project's rank;
2. the rank of the goal it serves (`serves:` in the task);
3. its plan: a plan's open phases stay together, in phase order;
4. its due date, then its age.

When one task really must jump the queue (someone is waiting on it, a hard deadline), you **pin** it
under `## Tasks` in `priorities.md`. Pins are the exception. Because the order is derived, adding a
task to a repo never means re-ranking a list by hand, and moving a project up moves all its work
with it.

The exact rules are in the spec: [brain-spec.md, Hub](brain-spec.md#hub).

## Goals at two levels

- A **project goal** lives in its project's brain. Tasks there point at it with `serves: <goal id>`.
- A **hub goal** lives in the hub and spans projects. It counts project work by listing it in
  `covers:` (`web-app/k2m4`, a project goal or a task). The link runs one way: the project never
  names the hub.
- Each goal has `done_when` (the finish line) and `measure` (how to read progress), and a `## Pace`
  log of readings over time. Give it a `measure_cmd` and `reinstall-hub pace --run` reads it for you.

A task whose project has goals but which serves none is a question worth asking: should it exist?

## Plans across repos

A plan is one markdown document cut into phases, with one task per phase
([brain-spec.md, Plans and phases](brain-spec.md#plans-and-phases)). A plan for work in one repo lives
in that repo's brain. A plan that changes several repos can live in the hub: its phase tasks go in the
brain of the repo each phase changes, with `meta.plan_brain` naming the hub, so the hub still shows the
plan as one item, with its next open phase.

## Which folder to open your agent in

- **Work on one project:** open that repo. The session hook loads its open tasks, questions and
  decisions; the agent writes what it learns into that brain.
- **Decide what to do, plan the day, work across repos:** open the hub and type `/hub`. The agent sees
  every project's brain, ranks with you in short rounds of choices, and edits other repos by path when a
  plan spans them.

## Try it

`examples/demo/` in this repository is a ready hub (`acme-hub`) with two projects (`widgets`, an app,
and `gadgets`, its website). From the clone:

```bash
reinstall-hub priorities --hub examples/demo/acme-hub
```

```
  1.  widgets/xy79   Plan 001 Phase 2: Column mapping screen  -> The importer handles every bank CSV …
  2.  widgets/ngub   Plan 001 Phase 3: Error report  -> The importer handles every bank CSV …
  3.  widgets/jzqb   Upgrade the date library
  4.  gadgets/zbo2   Write the launch post  (due 2026-12-01)
  5.  acme-hub/0jtt  Pick a payment provider
  6.  gadgets/aakp   Fix the typo on the pricing page
```

Why that order: `widgets` is the first project, and its importer plan serves the top-ranked project
goal, so its open phases lead, in phase order (Phase 1 is marked done in the plan, so it is gone).
`gadgets` is second; its dated task comes before its undated one. "Pick a payment provider" is kept in
the hub but marked `project: gadgets`, so it ranks with that project. Now try:

```bash
reinstall-hub place-project gadgets --top --hub examples/demo/acme-hub   # gadgets' work moves up, all of it
reinstall-hub inbox --hub examples/demo/acme-hub                         # each plan is one row
reinstall-hub goals --hub examples/demo/acme-hub
git checkout examples/demo                                              # put it back
```

## Many hubs

A machine can hold many hubs: one for your own work, one per team or client. Each has its own project
order and goals; a repo can be in more than one. Commands act on the hub folder you are in, or
`--hub <name or path>`; `reinstall-hub list` shows them, `reinstall-hub use <name>` sets the default.
