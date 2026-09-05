import type { PromptInput } from "@get-bb/plugin-sdk/provider-bridge";

/**
 * How a bb prompt reaches prime when it carries a skill/command mention.
 *
 * bb's composer serializes a "/" pick as the literal text `/name` plus a
 * mention whose offsets cover exactly that span (`promptCommandResource…`:
 * `serializedText = trigger + name`). prime, on its side, expands only
 * `/skill:<name>` — skill-sourced commands (`agent-session.js`
 * `_expandSkillCommand`, and `get_commands` naming every skill
 * `skill:<name>`); a bare `/name` is passed through untouched.
 *
 * So the one thing the bridge owes the session is the daemon command form:
 * every skill mention's `/name` span becomes `/skill:<name>`, args and
 * surrounding text intact, and prime's own worker-side expansion does the
 * rest. That is the "translate into the daemon's command form" branch of the
 * SDK's prime guidance — stripping the mention (the claude-code plan pattern)
 * would delete the invocation, because nothing else would inline the body.
 *
 * Non-skill command mentions (`source: "command"` — bb's builtin `/compact`,
 * plugin composer actions) ride along untouched: prime receives the literal
 * `/compact` and runs its own session command, which is the models/compaction
 * ticket's surface (bbpa-ggf.6), not this one.
 */

/** prime's slash-command prefix for skill-sourced commands. */
const SKILL_COMMAND_PREFIX = "skill:";

type TextPart = Extract<PromptInput, { type: "text" }>;

/**
 * The text prime is prompted with: the text parts, each with its skill
 * mentions rewritten into prime's command form, joined with newlines. This is
 * the only place a bb prompt becomes prime prompt text (`PrimeSession.turn`).
 */
export function primePromptText(input: readonly PromptInput[]): string {
  const parts: string[] = [];
  for (const part of input) {
    if (part.type === "text" && part.text.trim() !== "") {
      parts.push(partWithSkillCommands(part));
    }
  }
  return parts.join("\n");
}

function partWithSkillCommands(part: TextPart): string {
  const mentions = (part.mentions ?? [])
    .filter(isSkillCommandMention)
    .sort((left, right) => left.start - right.start);
  if (mentions.length === 0) {
    return part.text;
  }
  let text = "";
  let cursor = 0;
  for (const mention of mentions) {
    if (mention.start < cursor) {
      continue; // Garbled, overlapping offsets: leave the span alone.
    }
    const name = mention.resource.name;
    const span = part.text.slice(mention.start, mention.end);
    // bb serializes the mention as exactly `/name`; anything else means the
    // offsets and the text disagree, and rewriting blind would corrupt the
    // prompt. A name already in prime's form is left as the user typed it.
    if (span !== `/${name}` || name.startsWith(SKILL_COMMAND_PREFIX)) {
      continue;
    }
    text += part.text.slice(cursor, mention.start);
    text += `/${SKILL_COMMAND_PREFIX}${name}`;
    cursor = mention.end;
  }
  return text + part.text.slice(cursor);
}

/** A type guard, so the rewrite loop sees the command resource directly. */
function isSkillCommandMention(
  mention: TextPart["mentions"][number],
): mention is TextPart["mentions"][number] & {
  resource: Extract<TextPart["mentions"][number]["resource"], { kind: "command" }>;
} {
  const resource = mention.resource;
  return (
    resource.kind === "command" &&
    resource.trigger === "/" &&
    resource.source === "skill"
  );
}
