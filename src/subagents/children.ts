import { z } from "zod";
import type { DeltaDelegationShape } from "@get-bb/plugin-sdk/provider-bridge";

/**
 * prime-agent RLM children (the spec calls them subagents) as the daemon puts
 * them on the wire.
 *
 * Wire facts from the protocol spike (`docs/spikes/0001-prime-daemon-protocol.md`,
 * verdict b): children appear in `attach`'s `snapshot.children` and in
 * `rlm_child_update` events, both carrying the same snapshot shape. The schema
 * is deliberately loose (`passthrough`, optional everything we only read) — a
 * prime release that adds fields keeps working; `label`, `id` and `status` are
 * the only required members and are the ones every consumer here reads.
 */

/**
 * The statuses prime 0.7.3 reports (spike verdict b). The schema accepts any
 * string — a future prime that adds a status must not blank the roster — but
 * only these two are treated as live; anything else settles its delegation
 * item as failed rather than leaving a row open on a guess.
 */
export type PrimeChildStatus =
  | "queued"
  | "running"
  | "done"
  | "error"
  | "cancelled";

export const primeChildActivitySchema = z
  .object({
    kind: z.enum(["waiting", "writing", "executing"]),
    toolName: z.string().optional(),
  })
  .passthrough();
export type PrimeChildActivity = z.infer<typeof primeChildActivitySchema>;

export const primeChildSchema = z
  .object({
    id: z.string(),
    parentId: z.string().optional(),
    /** The child's own daemon session; absent until prime has booted it. */
    activeSessionId: z.string().optional(),
    sessionName: z.string().optional(),
    model: z.string().optional(),
    label: z.string(),
    status: z.string(),
    durationMs: z.number().optional(),
    answerPreview: z.string().optional(),
    toolUseCount: z.number().optional(),
    tokenCount: z.number().optional(),
    recap: z.string().optional(),
    sessionDir: z.string().optional(),
    activity: primeChildActivitySchema.optional(),
    error: z.string().optional(),
  })
  .passthrough();
export type PrimeChild = z.infer<typeof primeChildSchema>;

/** Parse one child off the wire; `undefined` when prime sent something else. */
export function parsePrimeChild(value: unknown): PrimeChild | undefined {
  const parsed = primeChildSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Parse a `snapshot.children`-shaped list, dropping unreadable entries. */
export function parsePrimeChildren(value: unknown): PrimeChild[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(parsePrimeChild)
    .filter((child): child is PrimeChild => child !== undefined);
}

/**
 * The one-line detail a child contributes where only text fits: what it is
 * doing now (recap), else what it answered (answerPreview), else why it died.
 */
export function childDetail(child: PrimeChild): string | undefined {
  const detail = (child.recap ?? child.answerPreview ?? child.error ?? "").trim();
  return detail.length > 0 ? detail : undefined;
}

/**
 * The detail a *finished* child settles its delegation item with: the failure
 * reason wins when prime reports one, the answer otherwise, the last recap as
 * the fallback.
 */
export function childResultDetail(child: PrimeChild): string | undefined {
  const ordered =
    child.status === "error"
      ? [child.error, child.answerPreview, child.recap]
      : [child.answerPreview, child.recap, child.error];
  for (const candidate of ordered) {
    const detail = (candidate ?? "").trim();
    if (detail.length > 0) {
      return detail;
    }
  }
  return undefined;
}

/**
 * Whether a child is still going. A live child opens a delegation item and
 * keeps it open — bb holds the session open for pending background work — so
 * only a terminal status from prime ever closes it.
 */
export function isChildLive(child: PrimeChild): boolean {
  return child.status === "queued" || child.status === "running";
}

/**
 * The delegation item shape for a child: keyed by the child id in the delta
 * (`channel: "delegation"`), referenced by the child's daemon session when it
 * has one, labelled as prime labels it.
 */
export function childDelegationShape(
  child: PrimeChild,
): DeltaDelegationShape {
  const summary = childDetail(child);
  return {
    type: "delegation",
    childRef: child.activeSessionId ?? child.id,
    label: child.label,
    background: true,
    ...(summary === undefined ? {} : { summary }),
  };
}

/** Human activity line for the panel ("executing bash"), when prime reports one. */
export function childActivityLabel(child: PrimeChild): string | undefined {
  const activity = child.activity;
  if (activity === undefined) {
    return undefined;
  }
  const tool = activity.toolName ?? "";
  if (activity.kind === "executing") {
    return tool.length > 0 ? `executing ${tool}` : "executing";
  }
  return activity.kind;
}
