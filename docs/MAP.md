# Where each idea is explained

Each concept is explained in **one** place. Every other file names it in a line and links there, so a
change is made once and nothing contradicts it. When you change how something works, change its home
first, then check the files that link to it. The tests check the parts that can be checked (commands,
types and fields, links).

| Concept | Explained in | Also mentioned (link, don't re-explain) |
|---|---|---|
| What a brain is, and why | `README.md` (top) | `docs/brain-spec.md`, `templates/brain/README.md` |
| Records: file name, ids, fields, field order, body, log | `docs/brain-spec.md` (Records) | `templates/brain/README.md`, `skills/brain/SKILL.md` |
| Record types (note, decision, question, insight, task, milestone, goal) | `docs/brain-spec.md` (Core types) | `templates/brain/README.md`, `skills/brain/SKILL.md` |
| Merge safety, worktrees share one brain | `docs/brain-spec.md` (Principles, Layout) | `README.md` |
| The index | `docs/brain-spec.md` (The index) | `guide/session.md` |
| Kits, registered types, kit folders, `schema: loose` | `docs/brain-spec.md` (Extending a brain) | `README.md` |
| Plans and phases | `docs/brain-spec.md` (Plans and phases) | `templates/hub/HUB.md`, `skills/hub/SKILL.md` |
| What a hub is, hub and spoke, why, the demo | `docs/hub.md` | `README.md`, `docs/brain-spec.md` (Hub), `templates/hub/HUB.md` |
| Ranking: projects, goals, plans, pins | `docs/brain-spec.md` (Hub) | `docs/hub.md`, `templates/hub/HUB.md`, `skills/hub/SKILL.md` |
| Goals: levels, `serves`, `covers`, pace | `templates/hub/HUB.md` (Goals) | `docs/brain-spec.md`, `skills/hub/SKILL.md` |
| Wiring: skills, session hook, CLAUDE.md / AGENTS.md blocks | `docs/brain-spec.md` (Wiring) | `README.md`, `skills/brain/SKILL.md`, `skills/hub/SKILL.md` |
| Working a brain day to day (agent guide) | `templates/brain/README.md` | `guide/session.md` |
| Working a hub day to day (agent guide) | `templates/hub/HUB.md` | `skills/hub/SKILL.md` |
| Commands and flags | `reinstall-brain --help`, `reinstall-hub --help` | `README.md`, `templates/hub/HUB.md` |
| Install and update | `README.md` (Install) | `skills/brain/SKILL.md` |

**Templates stand alone.** `templates/brain/README.md` and `templates/hub/HUB.md` are copied into
people's repos, where the rest of these docs are not, so they repeat what an agent needs to work. Their
home row above still wins: change the home first, then bring the template in line.
