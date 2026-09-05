import { describe, expect, it } from "vitest";
import {
  MAX_STEER_MESSAGE_CHARS,
  steerCommand,
  steerDelivery,
  steerTarget,
  stopCancelled,
  stopCommand,
} from "./control.js";

/**
 * The prime command mapping behind the panel's control actions (bbpa-ggf.10),
 * pinned against the spike's wire facts
 * (`docs/spikes/0001-prime-daemon-protocol.md`, verdict b).
 */

describe("the steer command", () => {
  it("is prime's send_message, addressed to the child and signed by the parent", () => {
    expect(
      steerCommand({
        targetActiveSessionId: "sess_child",
        message: "Focus on the parser",
        fromActiveSessionId: "sess_parent",
      }),
    ).toEqual({
      type: "send_message",
      targetActiveSessionId: "sess_child",
      message: "Focus on the parser",
      fromActiveSessionId: "sess_parent",
    });
  });

  it("targets a booted child by its own session", () => {
    // prime resolves selectors by session id, never by RLM child id.
    expect(
      steerTarget({
        id: "child_1",
        label: "scout",
        status: "running",
        activeSessionId: "sess_child_1",
      }),
    ).toBe("sess_child_1");
  });

  it("targets a child that has not booted yet by its child id", () => {
    expect(
      steerTarget({ id: "child_2", label: "digger", status: "queued" }),
    ).toBe("child_2");
  });

  it("reads the receipt's delivery status, and refuses a receipt-less answer", () => {
    expect(steerDelivery({ deliveryStatus: "delivered" })).toBe("delivered");
    expect(steerDelivery({ deliveryStatus: "queued" })).toBe("queued");
    // A future prime may name a third status; the steer still happened.
    expect(steerDelivery({ deliveryStatus: "scheduled" })).toBe("unknown");
    expect(() => steerDelivery({})).toThrow(/delivery status/u);
    expect(() => steerDelivery(undefined)).toThrow(/delivery status/u);
  });

  it("caps a steer at prime's own message limit", () => {
    expect(MAX_STEER_MESSAGE_CHARS).toBe(16_384);
  });
});

describe("the stop command", () => {
  it("is prime's cancel_rlm_child for one child of one session", () => {
    expect(
      stopCommand({ activeSessionId: "sess_parent", childId: "child_1" }),
    ).toEqual({
      type: "cancel_rlm_child",
      activeSessionId: "sess_parent",
      childId: "child_1",
    });
  });

  it("treats cancelled:false as a refusal, not a success", () => {
    expect(stopCancelled({ cancelled: true })).toBe(true);
    expect(() => stopCancelled({ cancelled: false })).toThrow(
      /cancelled:false/u,
    );
    expect(() => stopCancelled({})).toThrow(/cancelled:false/u);
    expect(() => stopCancelled(undefined)).toThrow(/cancelled:false/u);
  });
});
