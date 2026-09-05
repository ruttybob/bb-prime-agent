# bb ↔ prime dynamic-tools channel protocol

Version 1. The two implementations are `src/dynamic-tools/` (the bb bridge
side) and `extension/bb-tools-extension.ts` (the prime side, loaded by prime
itself). A unit test asserts both files keep the same message vocabulary; if
you change a message here, change both and bump `BB_TOOLS_PROTOCOL_VERSION`.

## Purpose and placement

bb-provided (dynamic) tools must reach a prime session. prime 0.7.3 has no
post-create way to add extension paths and no env-var channel (session env is
allowlisted to `HERDR_*`), so the channel is established at create time
(ADR-0003):

```
create {
  name: "[bb] <thread>",
  lifecycle: "resident",
  config: {
    cwd: <bb thread cwd>,
    noExtensions: true,                       // discovery off
    extensions: [<extension/bb-tools-extension.ts>],   // our companion only
    extensionFlagValues: { bb_tools_channel: <socket path> }
  }
}
```

`bb_tools_channel` is a `string` extension flag the companion registers with
`pi.registerFlag` and reads with `pi.getFlag` in its `session_start` handler
(flag values are applied by prime after extension load, so reading at factory
time would see `undefined`). The value is the path of a per-session unix
socket the bridge listens on **before** sending `create`; the extension
connects while the prime worker boots.

## Framing

Newline-delimited JSON (JSONL), UTF-8, one object per line, both directions.
Unknown message types and malformed lines are ignored by both sides — the
channel never fatal-errors a prime session.

## Messages

### bridge → extension: `tools/set` (full-set replace, idempotent)

```json
{ "type": "tools/set", "tools": [
  { "name": "bb_echo",
    "description": "Echo the message back.",
    "parameters": { "type": "object", "properties": { "message": { "type": "string" } }, "required": ["message"] },
    "label": "bb echo",
    "promptSnippet": "optional",
    "promptGuidelines": ["optional"] } ] }
```

- `tools` is the **complete** desired set for the session; a tool omitted from
  a later `tools/set` is removed. Publishing the same set twice converges.
- `parameters` is bb's adopted JSON Schema, passed to prime's
  `ToolDefinition.parameters` as-is. Missing/non-object schemas become an
  empty object schema. `label` maps to prime's tool label (defaults to the
  name); bb `presentation` icons/tints are bb-side display metadata and are
  not carried.
- Sent: (a) whenever the bridge learns/changes the set, (b) automatically
  whenever the extension (re)connects, so tool state follows a prime worker
  replacement without bb knowing.

### extension → bridge: `tools/ack`

```json
{ "type": "tools/ack", "ok": true, "registered": ["bb_echo"], "active": ["bb_echo", "bash"] }
```

`registered` = names now in the requested set; `active` = prime's active tool
names after reconciliation (built-ins included). On failure:
`{ "type": "tools/ack", "ok": false, "error": "…" }`. Exactly one ack per
`tools/set`; a bridge `setTools` call resolves with it (bounded by a timeout).

### extension → bridge: `tool/call`

```json
{ "type": "tool/call", "callId": "bb-tc-1", "name": "bb_echo", "args": { "message": "ping" } }
```

The model called a bb tool. `callId` is unique per extension instance. The
bridge executes the tool against bb (via its outbound `item/tool/call`
request) and answers exactly once.

### bridge → extension: `tool/result`

```json
{ "type": "tool/result", "callId": "bb-tc-1", "ok": true,
  "result": { "content": "text", "contentBlocks": [], "images": [] } }
```

```json
{ "type": "tool/result", "callId": "bb-tc-1", "ok": false, "error": "why it failed" }
```

`result.content` is plain text; `contentBlocks` may add further
`{type:"text"}` / `{type:"image", data, mimeType}` blocks; `images` carries
bare images. The extension maps this onto prime's `AgentToolResult` content,
or throws (a failed tool call) on `ok: false`.

## Semantics on the prime side

- **Registration**: `pi.registerTool()` per tool, re-run on every `tools/set`
  (prime has no `unregisterTool`; re-registering a name replaces its
  definition, and a brand-new name is auto-activated by prime).
- **Removal** is availability toggling: after applying a set, the extension
  reconciles `pi.setActiveTools()` to *(prime's current active set) ∪
  (requested bb tools) − (bb tools that left the set)*. Prime's own tools are
  never touched beyond that reconciliation.
- **Abort**: if prime aborts the run while a `tool/call` is outstanding, the
  extension rejects its own execute promise and forgets the `callId`; a late
  `tool/result` for it is dropped. The bridge learns nothing — cancelling the
  corresponding outbound call is the chat path's job (turn-scoped tracker).
- **Channel loss**: when the socket closes with calls outstanding, the
  extension fails those calls; it retries connecting (bounded) so a replaced
  bridge process can be re-paired, and a `session_shutdown` closes the socket
  without reconnecting.

## Non-goals (v1)

No streaming tool progress, no partial results, no server→extension requests
other than `tools/set`, no multiplexing of several sessions over one socket
(one socket per session), no permission/approval interplay — bb executes bb
tools under the thread's own policy.
