import { describe, expect, it } from "vitest";
import {
  forkCheckpointFor,
  parseForkCheckpoint,
  resolveForkTarget,
  type ForkSessionTree,
} from "./fork-points.js";

/**
 * The fork-point identity layer (bbpa-ggf.7): the checkpoint the bridge mints
 * per settled turn, and the pure resolution of a checkpoint (or a tip) onto
 * prime's entry id space. Everything here runs without a daemon — the daemon
 * answers are plain arguments.
 */

const TREE: ForkSessionTree = {
  leafId: "e_a2",
  flatNodes: [
    { entry: { id: "e_u1", parentId: null, type: "message", message: { role: "user" } } },
    { entry: { id: "e_a1", parentId: "e_u1", type: "message", message: { role: "assistant" } } },
    { entry: { id: "e_u2", parentId: "e_a1", type: "message", message: { role: "user" } } },
    { entry: { id: "e_a2", parentId: "e_u2", type: "message", message: { role: "assistant" } } },
  ],
};

const USER_MESSAGES = [
  { entryId: "e_u1", text: "first prompt" },
  { entryId: "e_u2", text: "second prompt" },
];

describe("fork checkpoints", () => {
  it("round-trips through parse and normalizes the prompt text", () => {
    const checkpoint = forkCheckpointFor(2, "first  prompt\n");
    const parsed = parseForkCheckpoint(checkpoint);
    expect(parsed).toEqual({ ordinal: 2, digest: expect.any(String) });
    // Whitespace is not identity: the same words hash the same.
    expect(forkCheckpointFor(2, "first prompt")).toBe(checkpoint);
  });

  it("distinguishes repeated prompts by their ordinal", () => {
    const first = forkCheckpointFor(1, "continue");
    const second = forkCheckpointFor(2, "continue");
    expect(first).not.toBe(second);
    expect(parseForkCheckpoint(first)?.ordinal).toBe(1);
    expect(parseForkCheckpoint(second)?.ordinal).toBe(2);
  });

  it("rejects everything that is not one of ours", () => {
    for (const junk of [
      "",
      "claude_ckpt",
      "bbpa-",
      "bbpa-ck-",
      "bbpa-ck-1-",
      "bbpa-ck-0-deadbeefdeadbeef",
      "bbpa-ck-3-deadbeef",
      "bbpa-ck-3-deadbeefdeadbeefzz",
      "bbpa-ck-x-deadbeefdeadbeef",
    ]) {
      expect(parseForkCheckpoint(junk)).toBeUndefined();
    }
  });
});

describe("resolveForkTarget", () => {
  it("branches a tip fork at the leaf", () => {
    expect(resolveForkTarget({ checkpointId: undefined, tree: TREE })).toEqual({
      kind: "entry",
      entryId: "e_a2",
    });
  });

  it("creates fresh when the source session has no entries at all", () => {
    expect(
      resolveForkTarget({
        checkpointId: undefined,
        tree: { leafId: null, flatNodes: [] },
      }),
    ).toEqual({ kind: "empty" });
  });

  it("branches a checkpoint fork at the END of the anchored turn", () => {
    // bb's copied timeline carries the anchor turn's answer, so the branch
    // must too: not the user entry e_u1, but the entry before turn 2 begins.
    expect(
      resolveForkTarget({
        checkpointId: forkCheckpointFor(1, "first prompt"),
        tree: TREE,
        userMessages: USER_MESSAGES,
      }),
    ).toEqual({ kind: "entry", entryId: "e_a1" });
  });

  it("extends the last turn's anchor to the leaf", () => {
    expect(
      resolveForkTarget({
        checkpointId: forkCheckpointFor(2, "second prompt"),
        tree: TREE,
        userMessages: USER_MESSAGES,
      }),
    ).toEqual({ kind: "entry", entryId: "e_a2" });
  });

  it("counts repeated texts by their position among the sent inputs", () => {
    const tree: ForkSessionTree = {
      leafId: "e_u3",
      flatNodes: [
        ...TREE.flatNodes!,
        { entry: { id: "e_u3", parentId: "e_a2", type: "message", message: { role: "user" } } },
      ],
    };
    // The second "first prompt" (the lane's 2nd input) anchors at that later
    // message, whose turn extends to the leaf — not at the first occurrence.
    expect(
      resolveForkTarget({
        checkpointId: forkCheckpointFor(2, "first prompt"),
        tree,
        userMessages: [
          { entryId: "e_u1", text: "first prompt" },
          { entryId: "e_u3", text: "first prompt" },
        ],
      }),
    ).toEqual({ kind: "entry", entryId: "e_u3" });
  });

  it("still finds the anchor when out-of-band messages shifted the list", () => {
    expect(
      resolveForkTarget({
        checkpointId: forkCheckpointFor(1, "first prompt"),
        tree: TREE,
        userMessages: [
          { entryId: "e_extra", text: "typed at prime's own TUI" },
          { entryId: "e_u1", text: "first prompt" },
          { entryId: "e_u2", text: "second prompt" },
        ],
      }),
    ).toEqual({ kind: "entry", entryId: "e_a1" });
  });

  it("fails honestly when the anchor's text is no longer in the session", () => {
    const target = resolveForkTarget({
      checkpointId: forkCheckpointFor(1, "a prompt nobody sent"),
      tree: TREE,
      userMessages: USER_MESSAGES,
    });
    expect(target).toMatchObject({ kind: "error" });
    expect((target as { message: string }).message).toMatch(/no longer matches/);
  });

  it("fails honestly when the anchor was branched away inside prime", () => {
    // e_side exists in the tree but not on the active branch (the leaf's
    // root path is e_a2 → e_u2 → e_a1 → e_u1).
    const tree: ForkSessionTree = {
      leafId: "e_a2",
      flatNodes: [
        ...TREE.flatNodes!,
        { entry: { id: "e_side", parentId: "e_u1", type: "message", message: { role: "user" } } },
      ],
    };
    const target = resolveForkTarget({
      checkpointId: forkCheckpointFor(1, "first prompt"),
      tree,
      userMessages: [{ entryId: "e_side", text: "first prompt" }],
    });
    expect(target).toMatchObject({ kind: "error", message: expect.stringMatching(/active branch/) });
  });

  it("fails honestly on a checkpoint it did not mint", () => {
    const target = resolveForkTarget({
      checkpointId: "claude_ckpt_9",
      tree: TREE,
      userMessages: USER_MESSAGES,
    });
    expect(target).toMatchObject({ kind: "error", message: expect.stringMatching(/bbpa-ck-/) });
  });
});
