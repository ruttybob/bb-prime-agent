import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The bb.server artifact's import graph, guarded.
 *
 * When bb reloads a plugin from source, its server loads the server entry
 * (`server.ts`) through jiti with one alias: `@get-bb/plugin-sdk` maps to
 * bb-app's single-file `plugin-sdk-runtime.js` (three exports:
 * `experimental_defineHostEntry`, `defineRpcContract`,
 * `PLUGIN_CLI_OUTPUT_MAX_BYTES`). The alias is applied as a prefix, so ANY
 * `@get-bb/plugin-sdk/<subpath>` value import resolves to
 * `<shim>/<subpath>` and dies with "Cannot find module" — bbpa-cry. Built
 * artifacts never see this (the builder inlines the SDK from the plugin's
 * own install), which is exactly why only reload-from-source breaks and why
 * the breakage hides until someone reloads.
 *
 * The rule this test enforces: the server graph may not carry a runtime
 * (value) import of any SDK subpath. Subpath surfaces belong to the artifact
 * whose builder bundles them — `/host` and `/provider-bridge` to `bb.host`,
 * `/app` to `bb.app`. Bare `@get-bb/plugin-sdk` value imports would resolve
 * to the shim (fine for its three names, fatal for anything else); the
 * server graph currently needs none, and `import type` is erased before the
 * alias can care, so both are out of scope here.
 */

const ROOT = dirname(fileURLToPath(import.meta.url));

/** One parsed import edge: the specifier and whether it executes at runtime. */
interface ParsedEdge {
  readonly specifier: string;
  readonly value: boolean;
}

/** Every import, re-export, and side-effect-import specifier in one file. */
function parseEdges(source: string): ParsedEdge[] {
  const edges: ParsedEdge[] = [];
  const fromPattern = /from\s*["']([^"']+)["']/gu;
  for (const match of source.matchAll(fromPattern)) {
    edges.push({ specifier: match[1] ?? "", value: !isTypeOnlyStatement(source, match.index ?? 0) });
  }
  const sideEffectPattern = /^\s*import\s*["']([^"']+)["']/gmu;
  for (const match of source.matchAll(sideEffectPattern)) {
    edges.push({ specifier: match[1] ?? "", value: true });
  }
  return edges;
}

/**
 * `import type … from` / `export type … from` are erased before any runtime
 * loader runs, so their specifiers never execute. Find the statement that
 * owns this `from` and check its first keyword.
 */
function isTypeOnlyStatement(source: string, fromIndex: number): boolean {
  const statementStart = Math.max(
    source.lastIndexOf(";", fromIndex),
    source.lastIndexOf("\n", fromIndex),
  );
  const head = source.slice(statementStart + 1, fromIndex);
  return /^\s*(?:import|export)\s+type\b/u.test(head);
}

/** Resolve a relative specifier the way this repo writes them (`.js` → `.ts`). */
function resolveLocalFile(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base.replace(/\.js$/u, ".ts"),
    `${base}.ts`,
    join(base, "index.ts"),
  ];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

/** The transitive runtime import graph of the server entry, as repo paths. */
function serverGraph(): Set<string> {
  const entry = join(ROOT, "server.ts");
  const graph = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined || graph.has(file)) {
      continue;
    }
    graph.add(file);
    const source = readFileSync(file, "utf-8");
    for (const edge of parseEdges(source)) {
      if (!edge.value) {
        continue;
      }
      const local = resolveLocalFile(file, edge.specifier);
      if (local !== undefined) {
        queue.push(local);
      }
    }
  }
  return graph;
}

describe("the server entry's runtime import graph", () => {
  const graph = serverGraph();

  it("starts at the server entry and reaches the provider declaration", () => {
    expect(graph.has(join(ROOT, "server.ts"))).toBe(true);
    expect(graph.has(join(ROOT, "src", "declaration.ts"))).toBe(true);
  });

  it("never value-imports an SDK subpath (bb reloads the server entry through jiti, where subpaths die)", () => {
    const violations: string[] = [];
    for (const file of graph) {
      const source = readFileSync(file, "utf-8");
      for (const edge of parseEdges(source)) {
        if (edge.value && /^@get-bb\/plugin-sdk\//u.test(edge.specifier)) {
          violations.push(`${file}: "${edge.specifier}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
