import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HubSession } from "./hubSession.js";
import { HUB_WRITE, registerHubTool } from "./hubTooling.js";

function definedArgs(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

export function registerHubWriteTools(server: McpServer, session: HubSession): void {
  registerHubTool(server, "write", {
    title: "Write Device Workspace File",
    description: "Create or replace a text file inside an explicitly opened workspace. This tool cannot write to a root scope.",
    inputSchema: {
      workspace_id: z.string().describe("Hub workspace id from open_workspace."),
      path: z.string().describe("File path relative to the workspace."),
      content: z.string().describe("Complete UTF-8 file content."),
      create_dirs: z.boolean().optional(),
      overwrite: z.boolean().optional(),
      expected_sha256: z.string().optional()
    },
    annotations: HUB_WRITE
  }, async (args) => {
    const scope = session.writeScope(args.workspace_id);
    return session.forward(scope, "agent_write", definedArgs({
      path: args.path,
      content: args.content,
      create_dirs: args.create_dirs,
      overwrite: args.overwrite,
      expected_sha256: args.expected_sha256
    }));
  });

  registerHubTool(server, "edit", {
    title: "Edit Device Workspace File",
    description: "Perform an exact text replacement inside an explicitly opened workspace. This tool cannot edit a root scope.",
    inputSchema: {
      workspace_id: z.string().describe("Hub workspace id from open_workspace."),
      path: z.string().describe("File path relative to the workspace."),
      old_text: z.string().describe("Exact existing text."),
      new_text: z.string().describe("Replacement text."),
      replace_all: z.boolean().optional(),
      expected_replacements: z.number().int().min(1).optional(),
      expected_sha256: z.string().optional()
    },
    annotations: HUB_WRITE
  }, async (args) => {
    const scope = session.writeScope(args.workspace_id);
    return session.forward(scope, "agent_edit", definedArgs({
      path: args.path,
      old_text: args.old_text,
      new_text: args.new_text,
      replace_all: args.replace_all,
      expected_replacements: args.expected_replacements,
      expected_sha256: args.expected_sha256
    }));
  });
}
