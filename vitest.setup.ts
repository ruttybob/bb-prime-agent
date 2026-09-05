import { createRequire } from "node:module";

/**
 * Test-only shim.
 *
 * The published `@get-bb/plugin-sdk` bundles a few CommonJS dependencies
 * (cross-spawn among them) whose `require` is only defined when the host
 * daemon evaluates the artifact. Under vitest's ESM module runner there is no
 * `require`, so the bundle's fallback throws "Dynamic require of
 * 'child_process' is not supported". Defining it globally restores the
 * environment the artifact expects.
 */
const globalWithRequire = globalThis as typeof globalThis & {
  require?: NodeJS.Require;
};
globalWithRequire.require ??= createRequire(import.meta.url);
