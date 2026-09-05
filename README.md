# bb-plugin-prime-agent

A [bb](https://github.com/get-bb/bb) provider plugin that runs bb threads on
[prime-agent](https://github.com/PrimeIntellect-ai/prime-agent) — through
prime's own daemon, not a generic ACP adapter, so steer/follow-up semantics,
fork points, and (later) RLM subagent control survive the crossing.

Package name `bb-plugin-prime-agent` → plugin id `prime-agent` → provider id
`prime-agent`.

## What is wired today (bbpa-ggf.2)

- **Provider registration** with `experimental_visibility: "installed"`: bb
  lists Prime Agent only when this plugin's bridge answers `provider/health`
  with something other than `not_installed`.
- **Health probe** (`src/daemon/probe.ts`): connects to the prime daemon unix
  socket (`os.tmpdir()/prime-agent-<uid>/daemon.sock`), waits for the
  `daemon_hello` greeting, validates protocol name and version floor, reports
  the found prime version. It never spawns, replaces, or stops a daemon —
  prime owns its daemon's lifecycle.
- **Protocol drift** (`src/daemon/protocol.ts`): the greeting is compared
  against the calibration (prime-agent 0.7.3, protocol 7, schema revision 16).
  Drift is a warning in the health message, never a block; only a protocol
  version below the floor is reported as `unsupported_version`.
- **Bridge skeleton** (`src/provider-bridge.ts`): every canonical Provider
  Bridge Protocol method answers. Session and turn handlers run the protocol
  grammar in-process over a synthetic session record and settle turns with a
  visible `provider.warning` saying no model is attached yet — **prompts are
  not sent to prime-agent yet**. Resident daemon sessions, turn streaming,
  steering, and fork arrive with bbpa-ggf.3.

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
src/declaration.ts        the PluginProviderDeclaration
src/provider-bridge.ts    the bridge: canonical method map, reply hygiene, turn grammar
src/session-table.ts      skeleton session records (replaced by bbpa-ggf.3)
src/health.ts             probe → ProviderHealth mapping + short-TTL cache
src/daemon/protocol.ts    wire facts: hello validation, compat gate, drift
src/daemon/socket.ts      socket path resolution (BB_PRIME_AGENT_DAEMON_SOCKET)
src/daemon/client.ts      JSONL client: handshake, gate, correlation, reconnect
src/daemon/probe.ts       the read-only hello probe
icons/prime-agent.svg     compact monochrome provider icon
```

## Developing

```
npm install
npm test          # vitest: conformance + protocol + health suites
npm run typecheck
bb plugin build   # dist/server.js + dist/host.js (+ meta, digest)
bb plugin install .
```

`BB_PRIME_AGENT_DAEMON_SOCKET` overrides the daemon socket path (declared in
the provider's `env.passthrough`, so the daemon forwards it to the bridge).
Tests never require a live daemon: the daemon suites run against an in-process
socket fixture, and the one live-daemon check is guarded behind
`BBPA_LIVE_DAEMON=1`.
