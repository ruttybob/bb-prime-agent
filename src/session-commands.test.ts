import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PRIME_SESSION_COMMANDS,
  materializePrimeSessionCommandFiles,
  primeSessionCommandRoots,
  primeSessionCommandsDir,
} from "./session-commands.js";

/**
 * The session-command catalog and its materialization (bbpa-b1m.1, trimmed in
 * bbpa-b1m.3): the three prime session commands the bb "/" menu offers —
 * goal, refine, autonomous (no `compact`: bb ships a builtin; no
 * `heartbeat`/`heartbeats`/`rlm-max-depth`: prime's TUI handles those
 * client-side, they are not session commands, and their surface here is the
 * Heartbeats panel instead) — one `command-file` per command written into a
 * host directory, and the resolved roots answer pointing at those files.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bb-prime-commands-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The frontmatter of one command file, parsed back (`key: "value"` lines). */
function frontmatter(path: string): Record<string, string> {
  const source = readFileSync(path, "utf-8");
  const fenced = /^---\n([\s\S]*?)\n---\n/u.exec(source);
  expect(fenced, `${path} must open with a YAML frontmatter fence`).not.toBeNull();
  const fields: Record<string, string> = {};
  for (const line of (fenced?.[1] ?? "").split("\n")) {
    const match = /^([a-zA-Z]+): (.*)$/u.exec(line);
    expect(
      match,
      "frontmatter lines must be key: value — got ".concat(line),
    ).not.toBeNull();
    fields[match![1]!] = JSON.parse(match![2]!) as string;
  }
  return fields;
}

describe("the session-command catalog", () => {
  it("lists exactly the three session commands, prime's names", () => {
    expect(PRIME_SESSION_COMMANDS.map((command) => command.name)).toEqual([
      "goal",
      "refine",
      "autonomous",
    ]);
  });

  it("lists no TUI-only commands: they are not session commands", () => {
    // prime parses only `execution: "session"` builtins as session commands
    // (SESSION_SLASH_COMMAND_NAMES in its slash-commands.js): heartbeat,
    // heartbeats and rlm-max-depth are prime-TUI client commands, and from bb
    // their text would reach the model as a literal prompt.
    expect(PRIME_SESSION_COMMANDS.map((command) => command.name)).not.toContain(
      "heartbeat",
    );
    expect(PRIME_SESSION_COMMANDS.map((command) => command.name)).not.toContain(
      "heartbeats",
    );
    expect(PRIME_SESSION_COMMANDS.map((command) => command.name)).not.toContain(
      "rlm-max-depth",
    );
  });

  it("leaves `compact` out: bb ships a builtin /compact already", () => {
    expect(PRIME_SESSION_COMMANDS.map((command) => command.name)).not.toContain(
      "compact",
    );
  });

  it("carries prime's own description and argumentHint per command", () => {
    // Spot-check the verbatim strings the menu shows (prime's
    // CANONICAL_BUILTIN_SLASH_COMMANDS): the hints especially, since the
    // composer renders them next to the entry.
    expect(PRIME_SESSION_COMMANDS).toMatchObject([
      {
        name: "goal",
        description: "Set or view a persistent goal; supports pause, resume, and clear",
        argumentHint: "[objective]",
      },
      {
        name: "refine",
        description: "Refine continual harness prompt notes, skills, subagents, and memory",
        argumentHint: undefined,
      },
      { name: "autonomous", argumentHint: "[status|on|off]" },
    ]);
  });
});

describe("materializePrimeSessionCommandFiles", () => {
  it("writes one command file per catalog entry, with parseable frontmatter", () => {
    materializePrimeSessionCommandFiles(dir);
    expect(readdirSync(dir).sort()).toEqual(
      PRIME_SESSION_COMMANDS.map((command) => `${command.name}.md`).sort(),
    );
    for (const command of PRIME_SESSION_COMMANDS) {
      const fields = frontmatter(join(dir, `${command.name}.md`));
      expect(fields.description).toBe(command.description);
      if (command.argumentHint === undefined) {
        expect(fields.argumentHint).toBeUndefined();
      } else {
        expect(fields.argumentHint).toBe(command.argumentHint);
      }
    }
  });

  it("writes a body that says the command runs on the prime session", () => {
    materializePrimeSessionCommandFiles(dir);
    for (const command of PRIME_SESSION_COMMANDS) {
      const body = readFileSync(join(dir, `${command.name}.md`), "utf-8");
      expect(body).toContain("prime-agent session");
    }
  });

  it("is idempotent: a rerun overwrites, even over stale content", () => {
    materializePrimeSessionCommandFiles(dir);
    const first = readFileSync(join(dir, "goal.md"), "utf-8");
    // A stale file from an older plugin version must heal, not survive.
    writeFileSync(join(dir, "goal.md"), "---\ndescription: stale\n---\n");
    materializePrimeSessionCommandFiles(dir);
    expect(readFileSync(join(dir, "goal.md"), "utf-8")).toBe(first);

    materializePrimeSessionCommandFiles(dir);
    expect(readFileSync(join(dir, "goal.md"), "utf-8")).toBe(first);
  });

  it("creates its directory when missing", () => {
    const nested = join(dir, "made-up");
    materializePrimeSessionCommandFiles(nested);
    expect(existsSync(join(nested, "goal.md"))).toBe(true);
  });
});

describe("primeSessionCommandRoots", () => {
  it("answers one user command-file root per command file", () => {
    expect(primeSessionCommandRoots(dir)).toEqual(
      PRIME_SESSION_COMMANDS.map((command) => ({
        path: join(dir, `${command.name}.md`),
        origin: "user",
        shape: "command-file",
      })),
    );
  });
});

describe("primeSessionCommandsDir", () => {
  it("lives under the temp dir, namespaced per uid", () => {
    const dir = primeSessionCommandsDir();
    expect(dir.startsWith(tmpdir())).toBe(true);
    expect(dir).toBe(
      join(tmpdir(), `bb-prime-agent-commands-${userInfo().uid}`),
    );
  });
});
