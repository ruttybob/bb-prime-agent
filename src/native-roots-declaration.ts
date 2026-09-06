import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";

/**
 * prime-agent's native skill roots in bb's "/" menu (bbpa-ggf.8).
 *
 * The native-roots contract has two halves. The **declared roots** — the
 * fixed, machine-independent directories prime scans, relative to the host
 * home (`user`) or the workspace (`project`) — are declared here. The
 * **resolved roots** — what only a host can name: the `skills` arrays of
 * prime's user and project `settings.json`, plus the loose top-level `*.md`
 * skill files of the default directories — are answered by
 * `resolvePrimeNativeRoots` in `./native-roots.ts` behind the host entry's
 * `resolveNativeRoots` handler.
 *
 * This module holds the declared half and nothing else, because of where it
 * is imported from: `declaration.ts` sits in the bb.server graph, and bb
 * reloads the server entry through jiti, where the SDK package is aliased to
 * bb's one-file runtime shim — any SDK-subpath value import resolves into
 * `<shim>/<subpath>` and dies with "Cannot find module" (bbpa-cry). Type
 * imports are erased before the alias can care; value imports are not. So
 * this file's only SDK contact is a type import, and
 * `server-entry-graph.test.ts` keeps that rule from regressing.
 *
 * The declared directories are the same convention pi declares, with prime's
 * paths (prime's `docs/skills.md` "Locations"): `~/.prime/agent/skills` and
 * `~/.agents/skills` at the user level, `.prime/agent/skills` and the
 * `.agents/skills` chain up to the repository root (`ancestors: true` —
 * prime's `collectAncestorAgentsSkillDirs`) at the project level.
 *
 * The command roots live in the resolved half: prime's session commands are
 * materialized one `command-file` per command and answered by
 * `resolvePrimeNativeRoots` (`src/session-commands.ts`, bbpa-b1m.1). Prime's
 * prompt templates (`~/.prime/agent/prompts`) remain a separate surface this
 * plugin does not own.
 */
export const PRIME_NATIVE_ROOTS_DECLARATION: Pick<
  PluginProviderDeclaration,
  "experimental_nativeSkillRoots" | "experimental_resolvesNativeRoots"
> = {
  experimental_nativeSkillRoots: {
    user: [".prime/agent/skills", ".agents/skills"],
    project: [".prime/agent/skills", { path: ".agents/skills", ancestors: true }],
  },
  experimental_resolvesNativeRoots: true,
};
