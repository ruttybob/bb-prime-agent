# Spike 0001: prime daemon protocol (installed 0.7.3)

Ticket: `bbpa-ggf.1` · Date: 2026-09-05 · Method: static read of the installed
package plus a live probe of the running daemon with captured traffic.

- Probed install: `prime-agent` 0.7.3 (npm global; bin `prime-agent` → `dist/bundle/cli.js`).
  Below, `$P` = that package root. Code evidence is `file:line` inside it.
- Live probe: JSONL client over the daemon unix socket (`os.tmpdir()/prime-agent-<uid>/daemon.sock`),
  hello → `create` → `attach` → prompt round-trip → `kill` → `delete_saved_session`,
  all traffic captured (`capture.ndjson`). Probe created exactly one throwaway
  session and removed it afterwards.
- Lineage note: prime identifiers inside the code (`pi.registerTool`, `pi.exec`)
  are pi-lineage names, not the separate `pi` product.

## Verdict (a): create parameters — everything the bridge needs is per-session

`create` (`$P/dist/modes/daemon/daemon-protocol.d.ts:231-241`) takes
`{name?, sessionPath?, continueRecent?, noSession?, config?: AgentSessionRuntimeConfig,
runtimeMetadata?, lifecycle?: "resident"|"client_owned"}`. `config`
(`$P/dist/core/agent-session-config.d.ts:4-49`) fields are merged per session over the
daemon default config (`daemon-mode.js:1111-1112`):

| create.config field | per-session meaning |
|---|---|
| `cwd`, `agentDir`, `sessionDir` | paths (cwd required after merge — bb thread environment) |
| `provider`, `model`, `apiKey`, `models` | model selection |
| `thinking` | `"off"…"max"` (`pi-agent-core/dist/types.d.ts:250`) |
| `systemPrompt`, `appendSystemPrompt` | prompt shaping |
| **`extensions`** | explicit extension paths = CLI `-e` (`main.js:512`) |
| **`noExtensions`** | discovery off = CLI `-ne`; only `extensions` load (`resource-loader.js:281-283`) |
| **`skills` / `noSkills`** | omit → skills discovery stays on (`resource-loader.js:305-307`) |
| `tools/noTools/noBuiltinTools`, `promptTemplates`, `themes`, `noContextFiles` | same pattern |
| `autonomous`, `initialGoal`, `extensionFlagValues` | autonomy / goal seed / extension flags |
| top-level `name` | session display name (prime TUI catalog, `daemon-supervisor.js:1650-1655`) |
| top-level `lifecycle` | omit ⇒ resident (default); `"client_owned"` = owner-tied, dies 30 s after disconnect (`OWNED_WORKER_DISCONNECT_GRACE_MS`, `daemon-supervisor.js:58,851-859`) |

Settings-only (no create counterpart): `mcpServers`, `defaultProvider/Model/ThinkingLevel`,
`enabledModels`, `extensions/skills` discovery lists, `sessionDir`, `idleEvictionMinutes`
(global-only), compaction/retry, `markdown.*` (`$P/docs/settings.md`).
**No `permissionModes` field exists in 0.7.3** — prime has no approval gate; the intent's
`permissionModes: ["full"]` is a bb-side declaration only.
Unknown create fields are ignored (`daemon-supervisor.js:988-991`).

Live confirmation: one `create` with `{name:"[bb] …", cwd:<tmp>, noExtensions:true,
extensions:[<our ext>], noSkills:false}` produced a session with that exact name/cwd in
the prime catalog; a repeat `create` with the same shape converged onto the same
`activeSessionId` instead of double-opening.

## Verdict (b): child cancellation exists (`cancel_rlm_child`)

`cancel_rlm_child {activeSessionId, childId}` — gate `minProtocol: 7` only, no capability
(`daemon-protocol.js:136`; type `daemon-protocol.d.ts:403-406`). Semantics
(`agent-session.js:7418-7432,8216-8220`; `daemon-mode.js:1897-1942,805-807`):

1. Resolves the run through nested grandchildren; only `running`/`queued` cancel.
2. Soft-aborts the child agent (`run.abort()`), does not wait for it, emits `rlm_child_update` at once.
3. Parent receives an injected `agent_message` "cancelled" notice and its turn continues.
4. Child session closed with reason `"killed"`; ledger tombstone reason `"revoked"`
   (**no ledger deletion**); transcript `.jsonl` + display tombstone retained; only the
   runtime artifact dir is swept.
5. Siblings and the parent turn are untouched.

`delete_rlm_subagent` (capability `delete_rlm_subagent`) is the full-delete variant and
refuses while the child is resident-and-running. Children appear in
`snapshot.children` / `rlm_child_update` as
`{id, parentId?, activeSessionId?, sessionName?, model?, label, status: "queued"|"running"|"done"|"error"|"cancelled", durationMs?, answerPreview?, toolUseCount?, tokenCount?, recap?, sessionDir, activity?: {kind:"waiting"|"writing"|"executing", toolName?}, error?}`
(`agent-connection/types.d.ts:458-481`) — exactly the Subagents panel roster.

## Verdict (c): dynamic tools channel = explicitly loaded companion extension

- `PI_BB_TOOLS_FILE` — **absent** in 0.7.3 (verified; env forwarding to sessions is
  allowlisted to `HERDR_*`, `daemon-protocol.js:55-61`).
- `replace_acp_mcp_servers` — **absent** (verified).
- MCP is not a tools channel here: `mcpServers` is settings-only, HTTP-only, and MCP
  integrations are "not exposed as new agent tools" — they are Python-backed kernel
  skills (`docs/mcp-integrations.md:6-9,91-110`).
- The extension channel works and is per-session: `config.extensions` + `config.noExtensions:true`
  is exactly `-e` + `-ne`; a loaded extension may `pi.registerTool()` after startup and
  tools refresh immediately (`docs/extensions.md:1221-1223`; `agent-session.js:3083-3101`);
  `pi.setActiveTools()` toggles availability at runtime. Shipped reference:
  `$P/examples/extensions/dynamic-tools.ts`.
- Live proof (captured traffic): a dependency-free extension registering `bb_probe_echo`
  loaded from an arbitrary path via `create.config.extensions` was visible through
  `get_tool_definition`, was called by the model during a normal prompt
  (`tool_execution_start {toolName:"bb_probe_echo", args:{message:"ping from bb"}}`)
  and returned `[bb-probe] ping from bb` into the assistant message; the turn closed
  with `turn_end` ×2 + `agent_end`.
- No daemon command adds extension paths post-create (`reload` reuses the same config);
  dynamic tool sets must be mutated from inside the already-loaded extension
  (in-process watcher/socket → `registerTool`/`setActiveTools`). Decision recorded in
  `docs/adr/0003-dynamic-tools-via-companion-extension.md`.

## Wire facts implementers need

- Hello: the daemon pushes `daemon_hello` immediately (no client hello):
  `protocol {name:"prime-agent.daemon", version:7}`, `schemaId:"protocol-7-schema-16-1bcb9e7f1a49"`,
  `schemaRevision: 16`, `appVersion`, `runtime`, `clientId`, `serverCapabilities` (15 on 0.7.3).
  (`daemon-supervisor.js:755-795`; `daemon-protocol.js:9-49,20-21`.)
- Commands are envelopes `{type:"command", id, protocol:{name,version}, clientId?, command}`;
  non-envelope or version <7 is rejected (`daemon-supervisor.js` parse; `daemon-protocol.js:258-272`).
- Compatibility gate is client-side from hello: per-command `{minProtocol, minSchemaRevision?, capability?}`
  (`daemon-protocol.js:105-204`) checked pre-send (`daemon-client.js:186-204`).
- Responses are top-level `{type:"response", id, command:<type>, success, data?|error, errorInfo?}` —
  **`command` is the command type, `id` the envelope id** (live-verified).
- Session events arrive as **top-level** `{type:"session_event", activeSessionId, event, meta:{sequence, cursor}}`
  messages — there is no `{type:"event"}` wrapper (live-verified). Payload types at
  `$P/node_modules/@earendil-works/pi-agent-core/dist/types.d.ts:357-407` +
  `$P/dist/modes/agent-connection/types.d.ts:483-560` (`rlm_child_update`, `compaction_*`,
  `goal_update`, `bash_*`, …). Stale-drop by `meta.cursor` generation/sequence
  (`daemon-agent-connection.js:1614-1652`).
- `create` responds early with a summary-style object (`lifecycle:"draft"`,
  `isSessionActive:false`, `sessionFile`, `activeSessionId`, `model`, `workerState`) while
  the worker boots; drive readiness off `attach`/`get_state` rather than create
  (live-verified).
- `prompt {message, streamingBehavior?: "steer"|"followUp"}` — steer is delivered after the
  current tool round, before the next model call; followUp only after the run ends
  (`agent-session.d.ts:845-890`); `prompt` while streaming requires `streamingBehavior`.
- `abort` = soft stop (transcript preserved) — the release primitive; `kill` closes daemon
  state (reason `"killed"`, `session_closed` push observed); `delete_saved_session {sessionPath}`
  trashes the file (`{ok:true, method:"trash"}` observed) and refuses while active.
- Attach: `attach {activeSessionId, capabilities?, clientId?}` → snapshot (+`children`) and
  `lastEventCursor`; big snapshots stream `session_snapshot_begin/chunk/end` when the client
  declares `chunked_snapshot`; per-session replay is `status:"unavailable"` on any gap —
  recovery is a fresh snapshot via `session_resynced` (`daemon-protocol.js:355-405`).
- Fork: `fork {entryId, position?}` with points from `get_user_messages_for_forking`;
  rename: `rename {name}` / `rename_saved_session`; compaction: `compact`,
  `set_auto_compaction`, state flags `isCompacting`/`autoCompactionEnabled`;
  models: `get_model_catalog` (capability `model_catalog`), `set_model`, `set_thinking_level`
  (levels per model in `AgentConnectionState.availableThinkingLevels`);
  skills/commands: `get_resource_snapshot`, `get_commands`.
- Multi-client badge: `SessionSummary.attachedClients` via `get_state`/`list` — **no push
  event for attach/detach of others** (`daemon-session-list.d.ts:40`; `daemon-mode.js:2148`).
- Socket/autostart: default `os.tmpdir()/prime-agent-<uid>/daemon.sock` (mode 0600;
  `daemon-socket.js:28-32`); `ensureInteractiveDaemonRunning` probes hello, spawns
  `--mode daemon` when absent, treats a `stale` daemon as replace-only-if-idle
  (`daemon-launch.js:70-281`) — the bridge must keep the "never touch a foreign busy
  daemon" rule and warn instead.
- Docs drift: `docs/daemon.md` says "protocol v4"; code and wire say **7**/rev 16.
  Idle eviction: `idleEvictionMinutes` default 90 is global-only — long bb threads keep
  activity via prompts or a registered heartbeat (`SessionSummary.hasActiveHeartbeat`).

## Intent open questions → resolution

1. Per-session create params (аналог `-ne`, skills, расширения) — **answered**: all
   per-session via `create.config` (verdict a); no settings.json writes needed.
2. Dynamic-tools channel (`replace_acp_mcp_servers` candidate) — **answered**: candidate
   does not exist; MCP is not a tools channel; companion extension chosen (verdict c, ADR-0003).
3. `cancel_rlm_child` in 0.7.3 — **answered**: exists, semantics in verdict (b); subagent
   stop v1 = cancel only, no ledger deletion.
4. Extension-picker form — design question, stays with `bbpa-ggf.12`.
