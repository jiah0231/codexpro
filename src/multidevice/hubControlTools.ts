import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HubSession } from "./hubSession.js";
import { HUB_READ_ONLY, HUB_SESSION, registerHubTool } from "./hubTooling.js";
import { textResult } from "./types.js";

export function registerHubControlTools(server: McpServer, session: HubSession): void {
  registerHubTool(server, "list_devices", {
    title: "List CodexPro Devices",
    description: "List devices approved by the Windows Hub administrator. Device configuration cannot be changed through ChatGPT.",
    inputSchema: {},
    annotations: HUB_READ_ONLY
  }, async () => {
    const devices = session.registry.list();
    const text = devices
      .map((device) => `- ${device.id}: ${device.label} (${device.transport}, ${device.status})`)
      .join("\n") || "- none";
    return textResult(text, { devices, count: devices.length });
  });

  registerHubTool(server, "list_device_roots", {
    title: "List Device Roots",
    description: "Connect to one approved device and list its administrator-approved roots and access modes.",
    inputSchema: {
      device_id: z.string().min(1).max(64).describe("Device id from list_devices.")
    },
    annotations: HUB_READ_ONLY
  }, async (args) => {
    const { client, roots } = await session.listRoots(args.device_id);
    const text = roots.map((root) => `- ${root.id}: ${root.label} (${root.mode})`).join("\n") || "- none";
    return textResult(text, {
      device_id: client.device.id,
      device_label: client.device.label,
      roots,
      count: roots.length
    });
  });

  registerHubTool(server, "open_workspace", {
    title: "Open Device Workspace",
    description: "Select a device and an existing project directory inside one workspace-parent root. The returned hub workspace id is required for writes.",
    inputSchema: {
      device_id: z.string().min(1).max(64).describe("Device id from list_devices."),
      root_id: z.string().min(1).max(64).describe("workspace-parent root id from list_device_roots."),
      relative_dir: z.string().max(4096).optional().describe("Project directory relative to the approved root. Default: .")
    },
    annotations: HUB_SESSION
  }, async (args) => {
    const workspace = await session.openWorkspace(args.device_id, args.root_id, args.relative_dir);
    return textResult(`Opened ${workspace.displayPath}.`, {
      workspace_id: workspace.id,
      selected_workspace_id: workspace.id,
      workspace
    });
  });

  registerHubTool(server, "list_workspaces", {
    title: "List Hub Workspaces",
    description: "List workspaces opened in this ChatGPT MCP session and identify the selected workspace.",
    inputSchema: {},
    annotations: HUB_READ_ONLY
  }, async () => {
    const workspaces = session.listWorkspaces();
    const selected = session.selectedWorkspace();
    const text = workspaces
      .map((workspace) => `- ${workspace.id}: ${workspace.displayPath}${workspace.id === selected?.id ? " (selected)" : ""}`)
      .join("\n") || "- none";
    return textResult(text, {
      workspaces,
      count: workspaces.length,
      selected_workspace_id: selected?.id ?? null
    });
  });
}
