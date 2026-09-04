## Agent skills

### Issue tracker

bd (beads): prefix `bbpa`, visibility `committed`. Specs, tickets, and chores all live in `.beads/` — readiness is `bd ready`; the only workflow labels are `needs-info` and `human`. See `docs/agents/issue-tracker.md`.

### Persistent memory

In bd, via `bd remember` / `bd recall` — auto-injected at `bd prime` time, so present in every session. Reach for `bd remember "<insight>"` for anything worth keeping across sessions. See *Memory* in `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
