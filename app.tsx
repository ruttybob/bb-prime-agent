import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { SubagentsPanel } from "./src/panel/SubagentsPanel.js";

/**
 * The plugin's frontend (bbpa-ggf.9): one thread panel action that opens the
 * Subagents panel. The bundle ships to every bb window, so it stays one slot
 * and one small component; the roster itself lives on the machine the prime
 * daemon runs on, reached through plugin RPC.
 */
export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "subagents",
    title: "Subagents",
    icon: "Workflow",
    component: SubagentsPanel,
  });
});
