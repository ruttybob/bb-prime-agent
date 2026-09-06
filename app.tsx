import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { SubagentsPanel } from "./src/panel/SubagentsPanel.js";
import { HeartbeatsPanel } from "./src/panel/HeartbeatsPanel.js";

/**
 * The plugin's frontend (bbpa-ggf.9): thread panel actions that open the
 * Subagents panel (bbpa-ggf.9) and the Heartbeats panel (bbpa-b1m.3, with
 * the schedules section of bbpa-b1m.4). The bundle ships to every bb window,
 * so it stays two slots and two small components; the data itself lives on
 * the machine the prime daemon runs on, reached through plugin RPC.
 */
export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "subagents",
    title: "Subagents",
    icon: "Workflow",
    component: SubagentsPanel,
  });
  app.slots.threadPanelAction({
    id: "heartbeats",
    title: "Heartbeats",
    icon: "HeartPulse",
    component: HeartbeatsPanel,
  });
});
