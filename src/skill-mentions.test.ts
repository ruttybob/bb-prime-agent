import { describe, expect, it } from "vitest";
import type { PromptInput } from "@get-bb/plugin-sdk/provider-bridge";
import { primePromptText } from "./skill-mentions.js";

/**
 * The prompt path (bbpa-ggf.8): bb serializes a "/" pick as the text `/name`
 * plus a mention covering that span, and prime expands only `/skill:<name>` —
 * so the bridge rewrites exactly the mentioned span and nothing else.
 */

function skillInput(args: {
  text: string;
  name: string;
  start?: number;
  end?: number;
  origin?: "builtin" | "project" | "user";
}): PromptInput[] {
  const start = args.start ?? 0;
  const end = args.end ?? start + args.name.length + 1;
  return [
    {
      type: "text",
      text: args.text,
      mentions: [
        {
          start,
          end,
          resource: {
            kind: "command",
            trigger: "/",
            name: args.name,
            source: "skill",
            origin: args.origin ?? "user",
            label: args.name,
            argumentHint: null,
          },
        },
      ],
    },
  ];
}

describe("primePromptText", () => {
  it("passes plain text through untouched", () => {
    expect(primePromptText([{ type: "text", text: "hello there", mentions: [] }])).toBe(
      "hello there",
    );
  });

  it("rewrites a skill mention into prime's /skill: command form", () => {
    expect(primePromptText(skillInput({ text: "/review the diff", name: "review" }))).toBe(
      "/skill:review the diff",
    );
  });

  it("rewrites a bare invocation with no arguments", () => {
    expect(primePromptText(skillInput({ text: "/review", name: "review" }))).toBe(
      "/skill:review",
    );
  });

  it("rewrites a mention that is not at the start of the text", () => {
    expect(
      primePromptText(skillInput({ text: "please /review the diff now", name: "review", start: 7, end: 14 })),
    ).toBe("please /skill:review the diff now");
  });

  it("leaves non-skill command mentions (bb's builtin compact) alone", () => {
    const input: PromptInput[] = [
      {
        type: "text",
        text: "/compact",
        mentions: [
          {
            start: 0,
            end: 8,
            resource: {
              kind: "command",
              trigger: "/",
              name: "compact",
              source: "command",
              origin: "builtin",
              label: "compact",
              argumentHint: null,
            },
          },
        ],
      },
    ];
    expect(primePromptText(input)).toBe("/compact");
  });

  it("leaves a name that is already in prime's command form alone", () => {
    expect(
      primePromptText(skillInput({ text: "/skill:review", name: "skill:review" })),
    ).toBe("/skill:review");
  });

  it("leaves the span alone when the offsets disagree with the text", () => {
    // Defensive: bb owns both the text and the offsets; if they ever drift,
    // rewriting blind would corrupt the prompt.
    expect(primePromptText(skillInput({ text: "/other args", name: "review" }))).toBe(
      "/other args",
    );
  });

  it("rewrites several mentions, including out-of-order mention arrays", () => {
    const input: PromptInput[] = [
      {
        type: "text",
        text: "/review then /deploy",
        mentions: [
          skillMention("deploy", 13, 20),
          skillMention("review", 0, 7),
        ],
      },
    ];
    expect(primePromptText(input)).toBe("/skill:review then /skill:deploy");
  });

  it("joins the text parts the way prime receives one prompt", () => {
    expect(
      primePromptText([
        { type: "text", text: "/review", mentions: [skillMention("review", 0, 7)] },
        { type: "text", text: "   ", mentions: [] },
        { type: "text", text: "and then some", mentions: [] },
      ]),
    ).toBe("/skill:review\nand then some");
  });
});

type TextMention = Extract<PromptInput, { type: "text" }>["mentions"][number];

function skillMention(name: string, start: number, end: number): TextMention {
  return {
    start,
    end,
    resource: {
      kind: "command",
      trigger: "/",
      name,
      source: "skill",
      origin: "user",
      label: name,
      argumentHint: null,
    },
  };
}
