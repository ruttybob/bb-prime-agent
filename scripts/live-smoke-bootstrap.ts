import { createRequire } from "node:module";

/**
 * The smoke's first import, and it must stay first: ESM evaluates static
 * imports in order, so this runs before the scenario loads the SDK.
 *
 * The published `@get-bb/plugin-sdk` bundles a few CommonJS dependencies
 * (cross-spawn among them) whose `require` is only defined when the host
 * daemon evaluates the artifact. Under a plain node ESM module runner there
 * is no `require`, so the bundle's fallback throws "Dynamic require of
 * 'child_process' is not supported". Defining it globally restores the
 * environment the artifact expects — exactly what `vitest.setup.ts` does for
 * the test suite, which is why the smoke does not need vitest to run.
 */
const globalWithRequire = globalThis as typeof globalThis & {
  require?: NodeJS.Require;
};
globalWithRequire.require ??= createRequire(import.meta.url);
