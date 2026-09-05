import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { primeProviderDeclaration } from "./src/declaration.js";

/**
 * bb.server entry: what the plugin contributes to bb's own surfaces. The
 * provider declaration is the whole surface for now — settings, the extension
 * picker, and the Subagents panel are their own tickets (bbpa-ggf.12 and the
 * subagent-control ticket).
 */
export default function plugin(bb: BbPluginApi): void {
  const registered = bb.providers.register(primeProviderDeclaration());
  bb.onDispose(() => {
    registered.dispose();
  });
}
