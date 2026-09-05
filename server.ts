import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { primeProviderDeclaration } from "./src/declaration.js";
import {
  discoverUserPrimeExtensions,
  userExtensionSettingsDescriptors,
} from "./src/user-extensions.js";

/**
 * bb.server entry: what the plugin contributes to bb's own surfaces.
 *
 * The extension picker (bbpa-ggf.12) lives here too: the user-level extension
 * scan is a snapshot taken once per plugin load (the descriptors are plain data
 * the host renders without running plugin code — see `src/user-extensions.ts`
 * for why that is the right place), and the same snapshot feeds both the
 * settings toggles and the declaration's `deriveProviderOptions`, so the page
 * the user sees and the paths a new session loads can never disagree.
 *
 * The Subagents panel remains its own ticket.
 */
export default function plugin(bb: BbPluginApi): void {
  const userExtensions = discoverUserPrimeExtensions();
  bb.settings.define(userExtensionSettingsDescriptors(userExtensions));
  const registered = bb.providers.register(
    primeProviderDeclaration({ userExtensions }),
  );
  bb.onDispose(() => {
    registered.dispose();
  });
}
