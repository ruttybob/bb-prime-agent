import { z } from "zod";
import { primeChildSchema } from "../subagents/children.js";

/**
 * Typed views of the daemon wire facts this bridge actually consumes.
 *
 * The daemon protocol is not a published contract (ADR-0002): these schemas are
 * deliberately *loose* (`passthrough`, optional everything we only read) so a
 * prime release that adds fields keeps working, and the versions this bridge
 * depends on are the ones spelled out here. Wire facts were captured in the
 * protocol spike (`docs/spikes/0001-prime-daemon-protocol.md`).
 */

/** `{generation, sequence}` — the daemon's per-session event clock. */
export const daemonEventCursorSchema = z
  .object({
    generation: z.string(),
    sequence: z.number(),
  })
  .passthrough();
export type DaemonEventCursor = z.infer<typeof daemonEventCursorSchema>;

/** Envelope of a session event push: `{type:"session_event", activeSessionId, event, meta}`. */
export const sessionEventEnvelopeSchema = z
  .object({
    type: z.literal("session_event"),
    activeSessionId: z.string(),
    event: z.unknown(),
    meta: z
      .object({
        sequence: z.number().optional(),
        cursor: daemonEventCursorSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type SessionEventEnvelope = z.infer<typeof sessionEventEnvelopeSchema>;

/** The `create` response (a summary while the worker boots — readiness is attach). */
export const daemonCreateResultSchema = z
  .object({
    activeSessionId: z.string().optional(),
    sessionFile: z.string().optional(),
    sessionName: z.string().optional(),
    cwd: z.string().optional(),
    lifecycle: z.string().optional(),
  })
  .passthrough();
export type DaemonCreateResult = z.infer<typeof daemonCreateResultSchema>;

export const daemonSessionSummarySchema = z
  .object({
    sessionId: z.string().optional(),
    activeSessionId: z.string().optional(),
    sessionFile: z.string().optional(),
    sessionName: z.string().optional(),
    cwd: z.string().optional(),
    model: z.unknown().optional(),
    isStreaming: z.boolean().optional(),
    /**
     * How many clients are attached to the session right now (the story 21
     * badge). Read off `get_state`/`list` and the attach snapshot's summary:
     * prime announces no attach or detach of other clients, so there is no
     * push to subscribe to (protocol spike, wire facts).
     */
    attachedClients: z.number().optional(),
  })
  .passthrough();
export type DaemonSessionSummary = z.infer<typeof daemonSessionSummarySchema>;

/** A model as prime puts it on the wire (pi-ai's `Model`, read loosely). */
export const primeModelSchema = z
  .object({
    id: z.string().min(1),
    provider: z.string().min(1),
    name: z.string().optional(),
    reasoning: z.boolean().optional(),
    input: z.array(z.string()).optional(),
    /** pi thinking level → provider value; `null` marks a level unsupported. */
    thinkingLevelMap: z
      .record(z.string(), z.union([z.string(), z.null()]))
      .optional(),
    contextWindow: z.number().optional(),
  })
  .passthrough();
export type PrimeModel = z.infer<typeof primeModelSchema>;

/**
 * The session facts prime reports about itself (`AgentConnectionState`, read
 * loosely): the current model and thinking ladder, and the compaction flags.
 * These ride every attach snapshot's `state`, so the lane learns them for free
 * — including which levels a model does *not* support, which is what lets the
 * bridge refuse an unsupported level instead of letting prime clamp it.
 */
export const primeConnectionStateSchema = z
  .object({
    model: primeModelSchema.optional(),
    thinkingLevel: z.string().optional(),
    availableThinkingLevels: z.array(z.string()).optional(),
    isCompacting: z.boolean().optional(),
    autoCompactionEnabled: z.boolean().optional(),
  })
  .passthrough();
export type PrimeConnectionState = z.infer<typeof primeConnectionStateSchema>;

export const daemonSessionSnapshotSchema = z
  .object({
    activeSessionId: z.string(),
    summary: daemonSessionSummarySchema.optional(),
    state: primeConnectionStateSchema.optional(),
    messages: z.array(z.unknown()).default([]),
    /** The session's live RLM children (the Subagents panel roster, bbpa-ggf.9). */
    children: z.array(z.unknown()).optional(),
    lastEventSequence: z.number().optional(),
    lastEventCursor: daemonEventCursorSchema.optional(),
  })
  .passthrough();
export type DaemonSessionSnapshot = z.infer<typeof daemonSessionSnapshotSchema>;

/** The `attach` response: the snapshot plus the boundary cursor to drop stale pushes against. */
export const daemonAttachResultSchema = z
  .object({
    activeSessionId: z.string(),
    snapshot: daemonSessionSnapshotSchema.optional(),
    replay: z.unknown().optional(),
    lastEventSequence: z.number().optional(),
    lastEventCursor: daemonEventCursorSchema.optional(),
  })
  .passthrough();
export type DaemonAttachResult = z.infer<typeof daemonAttachResultSchema>;

/* ----------------------------- fork/rename reads ----------------------------- */
/* bbpa-ggf.7: the fork choreography reads prime's session tree and fork-point
 * discovery, branches with `fork`, and hands the source session its own
 * transcript back with `switch_session`. All loose, read-only views. */

export const daemonSessionTreeEntrySchema = z
  .object({
    id: z.string(),
    parentId: z.string().nullable().optional(),
    type: z.string().optional(),
    message: z.object({ role: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

/** `get_session_tree` → `{flatNodes, leafId}` (the entry id space `fork` speaks). */
export const daemonSessionTreeSchema = z
  .object({
    flatNodes: z
      .array(z.object({ entry: daemonSessionTreeEntrySchema }).passthrough())
      .default([]),
    leafId: z.string().nullable().optional(),
  })
  .passthrough();
export type DaemonSessionTree = z.infer<typeof daemonSessionTreeSchema>;

/** `get_user_messages_for_forking` → the fork selector prime's own TUI uses. */
export const daemonUserMessagesForForkingSchema = z
  .object({
    messages: z
      .array(z.object({ entryId: z.string(), text: z.string() }).passthrough())
      .default([]),
  })
  .passthrough();
export type DaemonUserMessagesForForking = z.infer<
  typeof daemonUserMessagesForForkingSchema
>;

/** `fork` → `{cancelled, selectedText?}`: the source session was replaced in place. */
export const daemonForkResultSchema = z
  .object({
    cancelled: z.boolean().optional(),
    selectedText: z.string().optional(),
  })
  .passthrough();

/** `switch_session` → `{cancelled}`: the state now runs the given file. */
export const daemonSwitchSessionResultSchema = z
  .object({ cancelled: z.boolean().optional() })
  .passthrough();

/** `{type:"session_closed", reason}` — the daemon closed a session we held. */
export const sessionClosedSchema = z
  .object({
    type: z.literal("session_closed"),
    activeSessionId: z.string().optional(),
    reason: z.string().optional(),
  })
  .passthrough();

/* ---------- session event payloads (the parts the translator reads) ---------- */

const contentBlockSchema = z
  .object({ type: z.string() })
  .passthrough();

export const usageShapeSchema = z
  .object({
    input: z.number().optional(),
    output: z.number().optional(),
    cacheRead: z.number().optional(),
    cacheWrite: z.number().optional(),
    totalTokens: z.number().optional(),
  })
  .passthrough();
export type UsageShape = z.infer<typeof usageShapeSchema>;

/** An assistant (or user/toolResult) message as prime puts it on the wire. */
export const agentMessageSchema = z
  .object({
    role: z.string(),
    content: z.union([z.string(), z.array(contentBlockSchema)]).optional(),
    stopReason: z.string().optional(),
    errorMessage: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    usage: usageShapeSchema.optional(),
  })
  .passthrough();
export type AgentMessage = z.infer<typeof agentMessageSchema>;

/** `message_update` carries the streaming event *and* the full message so far. */
export const messageUpdateEventSchema = z
  .object({
    type: z.literal("message_update"),
    message: agentMessageSchema.optional(),
    assistantMessageEvent: z
      .object({
        type: z.string(),
        contentIndex: z.number().optional(),
        delta: z.string().optional(),
        content: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();
export type MessageUpdateEvent = z.infer<typeof messageUpdateEventSchema>;

export const toolExecutionStartEventSchema = z
  .object({
    type: z.literal("tool_execution_start"),
    toolCallId: z.string(),
    toolName: z.string(),
    args: z.unknown().optional(),
  })
  .passthrough();

export const toolExecutionUpdateEventSchema = z
  .object({
    type: z.literal("tool_execution_update"),
    toolCallId: z.string(),
    toolName: z.string(),
    partialResult: z.unknown().optional(),
  })
  .passthrough();

export const toolExecutionEndEventSchema = z
  .object({
    type: z.literal("tool_execution_end"),
    toolCallId: z.string(),
    toolName: z.string(),
    result: z.unknown().optional(),
    isError: z.boolean(),
  })
  .passthrough();

export const agentEndEventSchema = z
  .object({
    type: z.literal("agent_end"),
    messages: z.array(agentMessageSchema).default([]),
    willRetry: z.boolean().optional(),
  })
  .passthrough();
export type AgentEndEvent = z.infer<typeof agentEndEventSchema>;

export const compactionStartEventSchema = z
  .object({
    type: z.literal("compaction_start"),
    reason: z.string().optional(),
  })
  .passthrough();

export const compactionEndEventSchema = z
  .object({
    type: z.literal("compaction_end"),
    aborted: z.boolean().optional(),
    willRetry: z.boolean().optional(),
    errorMessage: z.string().optional(),
    errorSeverity: z.string().optional(),
  })
  .passthrough();

/**
 * `{type:"thinking_level_changed", level}` — pushed when the session's thinking
 * level moves, whether the bridge asked (set_thinking_level) or prime did
 * (a model switch re-clamps). The timeline has no bb delta for it; the lane
 * tracks it so the next turn's level change is judged against reality.
 */
export const thinkingLevelChangedEventSchema = z
  .object({
    type: z.literal("thinking_level_changed"),
    level: z.string().optional(),
  })
  .passthrough();

export const autoRetryStartEventSchema = z
  .object({
    type: z.literal("auto_retry_start"),
    attempt: z.number().optional(),
    maxAttempts: z.number().optional(),
    errorMessage: z.string().optional(),
  })
  .passthrough();

export const autoRetryEndEventSchema = z
  .object({
    type: z.literal("auto_retry_end"),
    success: z.boolean().optional(),
    finalError: z.string().optional(),
  })
  .passthrough();

export const rlmChildUpdateEventSchema = z
  .object({
    type: z.literal("rlm_child_update"),
    child: primeChildSchema,
  })
  .passthrough();

export const authStaleEventSchema = z
  .object({
    type: z.literal("auth_stale"),
    provider: z.string().optional(),
  })
  .passthrough();

/**
 * `get_queue`'s answer — the same lane previews the push carries, read at
 * attach so a session adopted with work already waiting shows it at once
 * (`followUp` is prime's singular spelling there; the push spells it
 * `followUps`).
 */
export const daemonQueueResultSchema = z
  .object({
    steering: z.array(z.unknown()).default([]),
    followUp: z.array(z.unknown()).default([]),
  })
  .passthrough();
export type DaemonQueueResult = z.infer<typeof daemonQueueResultSchema>;

/**
 * `session_action_update` — prime's queue announcement (`bbpa-ggf.5`). The
 * previews are what prime's own TUI shows for the waiting steering and
 * follow-up lanes; read defensively (strings only) so a prime that reshapes
 * the projection degrades to fewer previews instead of failing the event.
 */
export const sessionActionUpdateEventSchema = z
  .object({
    type: z.literal("session_action_update"),
    actions: z
      .object({
        steering: z.array(z.unknown()).default([]),
        followUps: z.array(z.unknown()).default([]),
      })
      .passthrough(),
  })
  .passthrough();

/** Event types the bridge understands but deliberately renders nothing for. */
export const IGNORED_SESSION_EVENT_TYPES = new Set([
  // UI/telemetry state that has no bb timeline meaning. `session_action_update`
  // is deliberately NOT here: the queued-message lanes it announces are
  // surfaced as queue state (bbpa-ggf.5).
  "session_info_changed",
  "thinking_level_changed",
  "service_tier_changed",
  "recap_update",
  "goal_update",
  "connection_status",
  "heartbeats_changed",
  "ipython_sent_agent_message",
  "turn_start",
  "turn_end",
  "message_start",
  "message_end",
  // pi streams text through message_update; the boundary is agent_end's job.
  // Model-round boundaries would fabricate extra turns.
]);
