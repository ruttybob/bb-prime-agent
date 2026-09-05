import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  experimental_nativeRootsResolveOutputSchema,
} from "@get-bb/plugin-sdk/host";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_LOOSE_SKILL_FILES_PER_ROOT,
  PRIME_NATIVE_ROOTS_DECLARATION,
  resolvePrimeNativeRoots,
} from "./native-roots.js";
import { primeAgentDir, primeProjectAgentDir } from "./session-params.js";

/**
 * The native-roots surface (bbpa-ggf.8): the declaration names prime's fixed
 * skill directories, and the resolver answers what only a host can name — the
 * `skills` arrays of prime's user and project settings files plus the loose
 * top-level `*.md` skill files of the two default skills directories. bb scans
 * the union for the composer "/" menu.
 */

let homeDir: string;
let workspaceDir: string;
/**
 * Stand-in for an absolute directory outside the home (a `/opt/team-skills`):
 * the resolver only resolves paths, so any absolute path works, and a fixture
 * keeps the tests off the machine's real filesystem.
 */
let fixturesDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "bb-prime-roots-home-"));
  workspaceDir = mkdtempSync(join(tmpdir(), "bb-prime-roots-ws-"));
  fixturesDir = mkdtempSync(join(tmpdir(), "bb-prime-roots-fix-"));
});

afterEach(() => {
  for (const dir of [homeDir, workspaceDir, fixturesDir]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const USER_SETTINGS = () => join(primeAgentDir(homeDir), "settings.json");
const PROJECT_SETTINGS = () =>
  join(primeProjectAgentDir(workspaceDir), "settings.json");

function fixture(name: string): string {
  return join(fixturesDir, name);
}

function writeSettings(path: string, settings: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(settings));
}

function writeSkill(dir: string, name: string, description = "Does things."): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
}

function writeLooseSkill(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: Loose.\n---\n`,
  );
}

/** The resolver's answer, validated against the contract's output schema. */
function resolve(args?: { cwd?: string | null }): string[] {
  const answer = resolvePrimeNativeRoots({
    homeDir,
    cwd: args?.cwd === undefined ? workspaceDir : args.cwd,
  });
  const parsed = experimental_nativeRootsResolveOutputSchema.parse(answer);
  expect(parsed.commands).toEqual([]);
  for (const root of parsed.skills) {
    expect(root.namePrefix).toBe("");
    expect(root.recursive).toBe(false);
    expect(root.ancestors).toBe(false);
  }
  return parsed.skills.map((root) => root.path);
}

describe("the native-roots declaration", () => {
  it("names prime's fixed skill directories and opts into host resolution", () => {
    expect(PRIME_NATIVE_ROOTS_DECLARATION).toEqual({
      experimental_nativeSkillRoots: {
        user: [".prime/agent/skills", ".agents/skills"],
        project: [
          ".prime/agent/skills",
          { path: ".agents/skills", ancestors: true },
        ],
      },
      experimental_resolvesNativeRoots: true,
    });
  });

  it("keeps every declared path a relative path without dot segments", () => {
    const roots = PRIME_NATIVE_ROOTS_DECLARATION.experimental_nativeSkillRoots;
    for (const side of ["user", "project"] as const) {
      const paths = (roots?.[side] ?? []).map((entry) =>
        typeof entry === "string" ? entry : entry.path,
      );
      expect(paths.length).toBeGreaterThan(0);
      expect(paths.length).toBeLessThanOrEqual(32);
      expect(new Set(paths).size).toBe(paths.length);
      for (const path of paths) {
        expect(path).not.toMatch(/^\/|^[A-Za-z]:\//u);
        for (const segment of path.split("/")) {
          expect(segment).not.toBe("");
          expect(segment).not.toBe(".");
          expect(segment).not.toBe("..");
        }
      }
    }
  });

  it("uses the same agent dirs the session create pins", () => {
    // The resolver reads prime's config from the directory `create` pins, so
    // the "/" menu can never advertise what the session will not read.
    expect(primeAgentDir(homeDir)).toBe(join(homeDir, ".prime", "agent"));
    expect(primeProjectAgentDir(workspaceDir)).toBe(
      join(workspaceDir, ".prime", "agent"),
    );
  });
});

describe("resolvePrimeNativeRoots", () => {
  it("answers empty on a machine with no prime config at all", () => {
    expect(resolve({ cwd: null })).toEqual([]);
    expect(resolve()).toEqual([]);
  });

  it("tolerates an unparsable or non-object settings file", () => {
    mkdirSync(primeAgentDir(homeDir), { recursive: true });
    writeFileSync(USER_SETTINGS(), "{not json");
    expect(resolve({ cwd: null })).toEqual([]);
    writeFileSync(USER_SETTINGS(), JSON.stringify({ skills: "nope" }));
    expect(resolve({ cwd: null })).toEqual([]);
  });

  it("answers user settings directory entries as skills roots", () => {
    writeSettings(USER_SETTINGS(), {
      skills: [fixture("team-skills"), "~/shared/skills", "local-skills"],
    });
    writeSkill(join(fixture("team-skills"), "review"), "review");
    writeSkill(join(homeDir, "shared", "skills", "deploy"), "deploy");
    writeSkill(join(primeAgentDir(homeDir), "local-skills", "lint"), "lint");

    // In settings order, not sorted: prime reads the array top to bottom.
    expect(resolve({ cwd: null })).toEqual([
      fixture("team-skills"),
      join(homeDir, "shared", "skills"),
      join(primeAgentDir(homeDir), "local-skills"),
    ]);
  });

  it("reads a directory holding SKILL.md as that one skill, and a .md file as a skill file", () => {
    writeSettings(USER_SETTINGS(), {
      skills: [fixture("one-skill"), fixture("single.md"), fixture("not-markdown.txt")],
    });
    writeSkill(fixture("one-skill"), "one-skill");
    writeFileSync(
      fixture("single.md"),
      "---\nname: single\ndescription: A lone file skill.\n---\n",
    );
    writeFileSync(fixture("not-markdown.txt"), "nope");

    const answer = resolvePrimeNativeRoots({ homeDir, cwd: null });
    expect(answer.skills).toEqual([
      { path: fixture("one-skill"), origin: "user", shape: "skill" },
      {
        path: fixture("single.md"),
        origin: "user",
        shape: "skill-file",
        fallbackName: "single",
      },
    ]);
  });

  it("adds the loose skill files a directory entry contributes", () => {
    writeSettings(USER_SETTINGS(), { skills: [fixture("pack")] });
    writeSkill(join(fixture("pack"), "nested"), "nested");
    writeLooseSkill(fixture("pack"), "top-note");

    const answer = resolvePrimeNativeRoots({ homeDir, cwd: null });
    expect(answer.skills).toEqual([
      { path: fixture("pack"), origin: "user", shape: "skills" },
      {
        path: join(fixture("pack"), "top-note.md"),
        origin: "user",
        shape: "skill-file",
        fallbackName: "top-note",
      },
    ]);
  });

  it("skips prime's override patterns, glob entries, and remote sources", () => {
    writeSettings(USER_SETTINGS(), {
      skills: [
        "-disabled-dir",
        "+enabled-dir",
        "!forced-out",
        "glob-*/skills",
        "what?",
        "npm:@acme/skills",
        "git:github.com/acme/skills",
        "https://example.invalid/skills",
        "git@github.com:acme/skills.git",
        "   ",
        "",
        42,
      ],
    });
    expect(resolve({ cwd: null })).toEqual([]);
  });

  it("answers project settings entries only for the workspace that holds them", () => {
    writeSettings(PROJECT_SETTINGS(), { skills: ["shared-skills", "../outside"] });
    // Entries resolve against the project agent dir that holds the settings
    // file, exactly as prime resolves them (`resolvePathFromBase`).
    writeSkill(
      join(primeProjectAgentDir(workspaceDir), "shared-skills", "review"),
      "review",
    );
    // `..` climbs out of the project agent dir, so `../outside` is the
    // workspace's own `.prime/outside`.
    writeSkill(join(workspaceDir, ".prime", "outside", "audit"), "audit");

    expect(resolve({ cwd: null })).toEqual([]);
    expect(resolve({ cwd: workspaceDir })).toEqual([
      join(primeProjectAgentDir(workspaceDir), "shared-skills"),
      join(workspaceDir, ".prime", "outside"),
    ]);
    expect(
      resolvePrimeNativeRoots({
        homeDir,
        cwd: join(workspaceDir, "nested"),
      }).skills,
    ).toEqual([]);
  });

  it("answers project origins for project entries and user origins for user entries", () => {
    writeSettings(USER_SETTINGS(), { skills: [fixture("team-skills")] });
    writeSettings(PROJECT_SETTINGS(), { skills: [fixture("project-skills")] });
    mkdirSync(join(fixture("team-skills"), "review"), { recursive: true });
    mkdirSync(join(fixture("project-skills"), "audit"), { recursive: true });

    const answer = resolvePrimeNativeRoots({ homeDir, cwd: workspaceDir });
    expect(answer.skills).toEqual([
      { path: fixture("team-skills"), origin: "user", shape: "skills" },
      { path: fixture("project-skills"), origin: "project", shape: "skills" },
    ]);
  });

  it("answers the loose top-level skill files of the default skills directories", () => {
    writeLooseSkill(join(primeAgentDir(homeDir), "skills"), "user-note");
    writeLooseSkill(join(primeProjectAgentDir(workspaceDir), "skills"), "project-note");
    // Nested directories belong to the declared roots, not to this answer.
    writeSkill(join(primeAgentDir(homeDir), "skills", "nested"), "nested");
    // And a non-markdown file is not a skill.
    mkdirSync(join(primeAgentDir(homeDir), "skills"), { recursive: true });
    writeFileSync(join(primeAgentDir(homeDir), "skills", "README.txt"), "hi");

    const answer = resolvePrimeNativeRoots({ homeDir, cwd: workspaceDir });
    expect(answer.skills).toEqual([
      {
        path: join(primeProjectAgentDir(workspaceDir), "skills", "project-note.md"),
        origin: "project",
        shape: "skill-file",
        fallbackName: "project-note",
      },
      {
        path: join(primeAgentDir(homeDir), "skills", "user-note.md"),
        origin: "user",
        shape: "skill-file",
        fallbackName: "user-note",
      },
    ]);
  });

  it("caps the loose files it answers and never repeats a path", () => {
    const skillsDir = join(primeAgentDir(homeDir), "skills");
    for (let index = 0; index < MAX_LOOSE_SKILL_FILES_PER_ROOT + 10; index += 1) {
      writeLooseSkill(skillsDir, `note-${String(index).padStart(3, "0")}`);
    }
    // A settings entry pointing back at that same directory must not double
    // the roots, and a dot-segment entry survives as its normalized self.
    writeSettings(USER_SETTINGS(), {
      skills: [join(fixturesDir, "escaped", "..", "settled"), "skills"],
    });
    writeSkill(join(fixturesDir, "settled", "inside"), "inside");

    const answer = resolvePrimeNativeRoots({ homeDir, cwd: null });
    const roots = answer.skills ?? [];
    const paths = roots.map((root) => root.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toContain(join(fixturesDir, "settled"));
    expect(paths).toContain(skillsDir);
    const loose = roots.filter((root) => root.shape === "skill-file");
    expect(loose).toHaveLength(MAX_LOOSE_SKILL_FILES_PER_ROOT);
  });

  it("leaves a missing referenced directory out instead of failing", () => {
    writeSettings(USER_SETTINGS(), { skills: [fixture("vanished")] });
    expect(resolve({ cwd: null })).toEqual([]);
    expect(existsSync(fixture("vanished"))).toBe(false);
  });
});
