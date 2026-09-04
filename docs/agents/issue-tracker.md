# Issue tracker: bd (beads)

Issues and specs for this repo live in a local [bd (beads)](https://github.com/gastownhall/beads) database — a dependency-aware issue tracker backed by an embedded Dolt SQL store (no server, no external service). Use the `bd` CLI for all operations; it emits JSON via `--json`, so a pi session in this repo drives it directly (treat it like `gh`).

**Commands live in one place: the CLI's own reference.** Run `bd prime` (or `<cmd> --help`) for the full, up-to-date syntax — this doc deliberately caches no CLI reference. What follows are **this repo's flow conventions** only: what the fields mean, which labels exist, and how the skills use them.

> **Recorded values** (fill once at setup):
>
> - Prefix: `bbpa` — issue identifiers look like `bbpa-<hash>` (`bbpa-a3f2dd`).
> - Visibility: `committed` — `.beads/` is tracked in git (enables Dolt-remote sync across machines).
> - Sync remote: _none_ (no git origin yet — once one exists, add it and run `bd dolt push`).

Init and sync are **setup-time procedures**, not runtime conventions — they live in the `/setup-matt-bd-skills` skill, not here.

## Model

One layer: the repo's `.beads/` directory holds an embedded Dolt database. There is **no workspace/project split** and **no per-feature project** — every issue in this repo shares one flat space, scoped only by types, parent-child links, labels, and dependency edges. Each issue gets a prefix-wide identifier `<PREFIX>-<hash>` and carries a **status** (lifecycle), **type** (what kind of work it is), **priority** (0–4), **assignee**, **labels**, and **dependency edges** (bd's first-class feature).

## Memory (persistent, prime-injected)

bd holds persistent project memory in the same database — insights that survive across sessions and **auto-inject at `bd prime` time**, so every session has them without manual loading. This is the replacement for ad-hoc `NOTES.md` / memory files. Conventions:

- **Store** with `bd remember "<insight>"` (`--key <slug>` for a stable, re-recordable key); **recall** with `bd recall <key>`; **search** with `bd memories "<phrase>"`; **forget** with `bd forget <key>`.
- Use it for the unwritten conventions, gotchas, and reasons-behind-choices a new session needs but no config confesses. Do **not** use it for issue state (issues are for that) or per-session scratch (`bd note` on an issue is).

## Types (hard convention — what kind of work it is)

Every issue gets exactly one type, and the type comes from **how the work was born**, not from taste:

| Type | Meaning | Born from |
| --- | --- | --- |
| `epic` | A container, never claimed: a spec or a wayfinder map. Closed when its last child closes. | `/to-spec`, `/wayfinder` |
| `task` | A tracer-bullet ticket from a spec. | `/to-tickets` |
| `bug` | A ticket from a bug-fix spec. | `/to-tickets` |
| `feature` | A ticket from a new-capability spec. | `/to-tickets` |
| `chore` | A small, well-understood task with no spec — one session, no unknowns. | `/to-chore` |
| `decision` | A recorded decision (ADR-like); rare. | ad hoc |

## Labels (the only two workflow labels)

This repo deliberately has **no triage vocabulary and no go-labels**: work is born from specs, tickets, and chores, and readiness is computed, not stamped — an open issue with no active blockers is ready. Exactly two workflow labels exist:

- **`needs-info`** — the issue is parked waiting on the user's answer. Any skill may add it when a question blocks the work; the answer removes it. While present, the issue is outside the frontier.
- **`human`** — bd's native label: the work must be done by a **person**, not an agent. Surfaces in `bd human list`; a skill that hits work it must not do unattended parks it here.

Anything else you'd want to say about an issue goes in its type, status, priority, notes, or close reason — not in a new label. The `wayfinder:*` labels (`wayfinder:map`, `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, `wayfinder:task`) are the one standing exception: `/wayfinder` owns them, unchanged from the shared matt convention (see *Wayfinding operations*).

## Conventions

The flow's conventions, one line each — syntax from `bd prime`:

- **Create**: `bd create "Title" -t <type> -p 2`. Multiline bodies go in via `--stdin`. **A child born from a labelled parent passes `--no-inherit-labels`** — labels never propagate: the flow's labels are per-issue statements (`needs-info`, `human`, `wayfinder:*`), not inheritable taxonomy.
- **Claim** before work: `bd update <id> --claim` (sets assignee + `in_progress`; idempotent if already yours) — or `bd ready --claim` for the atomic frontier claim. The claim _is_ the assignment; do not bare-`--assignee` (that leaves status `open` and the issue in the frontier).
- **Conversation** on an issue is `bd comment`; **persistent state** is `bd note`.
- **Won't do** is not a label: `bd close <id> --reason "wontfix: <why>"` — the close reason is the record.

## Dependencies / blocking (bd's first-class feature)

`bd dep add <issue> <depends-on>` wires a hard `blocks` edge (`bd prime` carries the full dep reference). A ticket is unblocked when every blocker is `closed`.

The **frontier** is built in — open issues with no active blockers, minus anything parked on the user, minus containers:

```bash
bd ready --exclude-label needs-info --exclude-type epic
```

The whole readiness story (see *Labels*) — and no epic ever offered as claimable work.

## Lifecycle (statuses)

`open` → `in_progress` (claimed) → `closed`, with `blocked` / `deferred` as operational states — all driven natively by `--claim` / `--status` / `close` / `defer`. No intake queue, no triage pass — issues are born ready to work.

## Spec lifecycle (epics)

A spec published by `/to-spec` is an `epic` — a container, never claimed, never labelled. Its tickets (`/to-tickets` output) are children (`--parent <spec-id>`): the edge is containment, not blocking. The session that closes the **last** ticket also closes the spec:

```bash
bd close <spec-id> --reason "all tickets done"
```

## Resolving an issue

`bd close <id> --reason "Landed in PR #42, commit abc1234"` — `closed` means *landed / worked*, and the reason is the link to where the work shipped (bd has no auto-linking to git). Closed issues fall out of every active scan automatically.

## Wayfinding operations

`/wayfinder` consults this section. **Wayfinder runs natively on bd** — bd's first-class dependencies (`bd dep`) and built-in scoped frontier (`bd ready --parent`) render the map without any body-convention. A **map** is one bd issue; its **decision tickets** are child issues.

- **Create the map**: `bd create "<Destination>" -t epic -d "<map body>" --labels wayfinder:map`. Body uses the map template (`## Destination`, `## Notes`, `## Not yet specified`, `## Out of scope` — see `/wayfinder`). The map is an index: a decision lives in its ticket; the map only gists + links. `## Decisions so far` is **not** in the body — it is the map's **notes** field, appended one line per resolution (below).
- **Create a ticket**: `bd create "<Question title>" --parent <map-id> --labels wayfinder:<type> -d "<question body>" --no-inherit-labels` (multiline body via `--stdin` / heredoc). Types: `research` / `prototype` / `grilling` / `task`. The `--parent` edge is the containment (every ticket is a child of its map); the bd issue id is the ticket's identity.
- **Verify wiring**: after the create pass, confirm every new ticket is visible under the map: `bd list --parent <map-id>` — a ticket created without `--parent` silently falls out of the frontier (`bd ready --parent` never offers it).
- **Wire blocking** (second pass, after tickets have ids): `bd dep add <child> <blocker>` — the native dependency that renders the frontier in `bd ready --parent <map-id>` and the `bd dep tree` visual the human checks without opening the map.
- **Frontier query**: `bd ready --parent <map-id> --exclude-label needs-info` — open, unblocked descendants of the map; claimed tickets fall out automatically. Pick the first by priority, or the one the user named.
- **Claim**: `bd update <ticket-id> --claim` — the session's first write, before any work.
- **Resolve**: `bd comment <ticket-id> "<answer>"` (the resolution), then `bd close <ticket-id>`, then append the index line to the map's Decisions-so-far: `bd note <map-id> "- [<ticket title>](link) — <one-line gist>"`. A **research** ticket is resolved by a `/research` subagent whose findings land on a throwaway branch — link the branch from the ticket as its asset (`bd note <ticket-id> "branch: …"`). Keep exact commands and URLs in the branch doc — the ticket comment is a pointer, not a store; summaries drift and the next session pays for it.
- **Close the map**: when the **last ticket is closed** and the map's `## Not yet specified` (fog) is **empty**, the map is done — close it, then hand the destination to `/to-spec`:
  ```bash
  bd close <map-id> --reason "map complete: destination specified, handed to /to-spec"
  ```
  A map with closed tickets but fog remaining is **not** done: spawn tickets for the remaining fog first.
- **Refer by name** (`/wayfinder` rule): cite tickets by **title**, never a bare id — the id rides inside the name.
- **Concurrency**: bd is a single database with atomic `--claim`; other sessions may edit concurrently. Re-`bd show` the map / re-run the frontier before acting.

## When a skill says "publish to the issue tracker"

- A **spec** (`/to-spec`): `bd create "<short title>" -t epic --stdin` — no labels.
- A **ticket** (`/to-tickets`): `bd create "<Title>" -t <task|bug|feature> -p 2 --stdin [--parent <spec-id>] [--no-inherit-labels]` — type by the spec's nature, `--parent` when born from a spec (with `--no-inherit-labels` if the parent is labelled), then wire blocking edges second-pass: `bd dep add <ticket> <blocker>`. No labels of their own — born ready.
- A **chore** (`/to-chore`): `bd create "<title>" -t chore -p 2 --stdin`.

## When a skill says "fetch the relevant ticket"

`bd show <id>` (or `bd show <id> --json --include-comments` for full context).
