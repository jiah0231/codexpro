import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentRuntime } from "./agentRuntime.js";
import { READ_ONLY_ANNOTATIONS, SESSION_ANNOTATIONS, registerAgentTool } from "./mcpTools.js";
import { textResult } from "./types.js";

export function registerAgentControlTools(server: McpServer, runtime: AgentRuntime): void {
  const { policy } = runtime;

  registerAgentTool(server, runtime, "agent_describe", {
    title: "Describe Target Device",
    description: "Return the target device id, platform, capabilities, and approved root descriptors without revealing absolute root paths.",
    inputSchema: {},
    annotations: READ_ONLY_ANNOTATIONS
  }, async () => {
    const roots = runtime.roots();
    const structured = {
      schema_version: 1,
      device_id: policy.deviceId,
      label: policy.label,
      platform: process.platform,
      arch: process.arch,
      capabilities: ["tree", "search", "read", "write", "edit", "git-status", "git-diff"],
      shell_execution: false,
      roots
    };
    return textResult(
      `# CodexPro Agent\n\nDevice: ${policy.label} (${policy.deviceId})\nPlatform: ${process.platform}/${process.arch}\nRoots: ${roots.length}\nShell execution: disabled`,
      structured
    );
  });

  registerAgentTool(server, runtime, "agent_list_roots", {
    title: "List Approved Roots",
    description: "List administrator-approved roots and whether each can contain a writable workspace or is read-only.",
    inputSchema: {},
    annotations: READ_ONLY_ANNOTATIONS
  }, async () => {
    const roots = runtime.roots();
    const text = roots.map((root) => `- ${root.id}: ${root.label} (${root.mode})`).join("\n") || "- none";
    return textResult(text, { device_id: policy.deviceId, roots, count: roots.length });
  });

  registerAgentTool(server, runtime, "agent_open_workspace", {
    title: "Open Target Workspace",
    description: "Open an existing directory inside a workspace-parent root. The returned workspace id is required for every write.",
    inputSchema: {
      root_id: z.string().describe("Approved workspace-parent root id."),
      relative_dir: z.string().optional().describe("Directory relative to the root. Default: .")
    },
    annotations: SESSION_ANNOTATIONS
  }, async (args) => {
    const stored = runtime.openWorkspace(args.root_id, args.relative_dir);
    return textResult(
      `Opened ${stored.descriptor.displayPath} on ${policy.label}.`,
      { device_id: policy.deviceId, workspace: stored.descriptor, workspace_id: stored.descriptor.id }
    );
  });

  registerAgentTool(server, runtime, "agent_list_workspaces", {
    title: "List Target Workspaces",
    description: "List workspaces opened in this private agent session.",
    inputSchema: {},
    annotations: READ_ONLY_ANNOTATIONS
  }, async () => {
    const workspaces = runtime.listWorkspaces();
    return textResult(
      workspaces.map((workspace) => `- ${workspace.id}: ${workspace.displayPath}`).join("\n") || "- none",
      { device_id: policy.deviceId, workspaces, count: workspaces.length }
    );
  });
}
