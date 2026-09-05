# bb-plugin-prime-agent

A [bb](https://github.com/get-bb/bb) provider plugin that runs bb threads on
[prime-agent](https://github.com/PrimeIntellect-ai/prime-agent) — through
prime's own daemon, not a generic ACP adapter, so steer/follow-up semantics,
fork points, and RLM subagent control survive the crossing.

Package name `bb-plugin-prime-agent` → plugin id `prime-agent` → provider id
`prime-agent`.

## What is wired (v1, bbpa-ggf)

- **Provider registration** with installed-only visibility: bb lists Prime
  Agent only when this plugin's bridge answers `provider/health` with
  something other than `not_installed`. The probe (`src/daemon/probe.ts`)
  connects to the prime daemon unix socket, validates the `daemon_hello`
  greeting against the calibration (a protocol version below the floor is
  `unsupported_version`; drift is a warning, never a block) and reports the
  found prime version. It never spawns, replaces, or stops a daemon — prime
  owns its daemon's lifecycle.
- **Resident sessions**: every bb thread is one prime daemon resident session
  (`[bb] <thread>` in prime's own agents list, attachable from the TUI).
  Closing bb never stops them; reopening a thread re-attaches and fills the
  timeline from a snapshot; stopping a thread soft-stops the agent and keeps
  the session file, discarding stops it and cleans up.
- **Turns**: streamed text, thinking and tool calls rendered in the normal bb
  timeline; steer and follow-up while a turn is running; stop the turn.
- **Thread hygiene**: fork from an earlier message, rename, manual compaction
  with the auto-compaction state surfaced.
- **Models**: the model catalog and thinking levels come from prime itself.
- **Skills**: prime skills (user + project roots) appear in the composer
  "/"-menu as `skill:<name>`; bb skill mentions are rewritten into prime's
  command form before they reach the session.
- **Subagents**: live RLM children in a thread panel and as delegation items
  in the timeline; a running child can be steered or stopped from bb.
- **Dynamic tools** (ADR-0003): a companion prime extension
  (`extension/bb-tools-extension.ts`) connects to a per-session socket at
  worker boot and carries bb-provided tools into the prime session
  (full-set-replace `tools/set`, JSONL framing, never fatal).
- **Resilience**: bounded reconnect with fresh-snapshot re-attach and
  stale-daemon no-takeover; conformance + recorded-replay test lanes and a
  live smoke check (`npm run smoke`).

Deferred to v2 (bbpa-ydo): goal set/clear, heartbeats, schedules, `/refine`,
autonomous launch, UI attach to resident sessions, full subagent transcript
panel.

## Trust model

prime-agent runs without a sandbox: model-generated code executes with your
user permissions, and bb adds no confirmation gates on top. The provider
declares `permissionModes: ["full"]` only, and repeats the notice in its
provider copy. prime-agent must be installed and signed in (`/login` inside
its TUI) on every machine; bb never installs, updates, or starts it.

## Layout

```
server.ts                 bb.server — bb.providers.register(...)
host.ts                   bb.host — the provider bridge export + host RPC entry
app.tsx                   the plugin frontend: the thread Subagents panel
src/declaration.ts        the PluginProviderDeclaration
src/provider-bridge.ts    the bridge: canonical method map, reply hygiene, turn grammar
src/prime-session.ts      one resident session: turns, steering, snapshot replay
src/session-table.ts      thread ↔ resident-session records
src/skill-mentions.ts     "/"-menu mentions → prime's command form
src/model-catalog.ts      model + thinking-level catalog, read from prime
src/fork-points.ts        fork-from-checkpoint mapping
src/health.ts             probe → ProviderHealth mapping + short-TTL cache
src/daemon/               wire facts (protocol), socket path, JSONL client, hello probe
src/subagents/            live roster + steer/stop control of RLM children
src/panel/                the subagents roster panel UI
src/dynamic-tools/        the bb side of the bb↔prime tools channel
extension/                the companion prime extension (loaded with -e at create)
icons/prime-agent.svg     prime-agent butterfly brand icon (same art as Prime Agent (ACP) plugin)
```

## Developing

```
npm install
npm test          # vitest: conformance, daemon, dynamic-tools, subagents, ...
npm run typecheck
npm run smoke     # live check against a running prime daemon
bb plugin build   # dist/server.js + dist/host.js (+ meta, digest)
bb plugin install .
```

`BB_PRIME_AGENT_DAEMON_SOCKET` overrides the daemon socket path (declared in
the provider's `env.passthrough`, so the daemon forwards it to the bridge).
Tests never require a live daemon: the daemon suites run against an in-process
socket fixture, and the live lanes are guarded behind `BBPA_LIVE_DAEMON=1`.
