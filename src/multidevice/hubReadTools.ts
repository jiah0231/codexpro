import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HubSession } from "./hubSession.js";
import { HUB_READ_ONLY, hubReadScopeSchema, registerHubTool } from "./hubTooling.js";

function definedArgs(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

export function registerHubReadTools(server: McpServer, session: HubSession): void {
  registerHubTool(server, "tree", {
    title: "Device File Tree",
    description: "List files in an opened workspace or browse an approved root in read-only mode.",
    inputSchema: {
      ...hubReadScopeSchema,
      path: z.string().optional().describe("Relative directory. Default: ."),
      max_depth: z.number().int().min(1).max(12).optional(),
      include_hidden: z.boolean().optional(),
      max_entries: z.number().int().min(1).max(3000).optional()
    },
    annotations: HUB_READ_ONLY
  }, async (args) => {
    const scope = session.readScope(args);
    return session.forward(scope, "agent_tree", definedArgs({
      path: args.path,
      max_depth: args.max_depth,
      include_hidden: args.include_hidden,
      max_entries: args.max_entries
    }));
  });

  registerHubTool(server, "search", {
    title: "Search Device Files",
    description: "Search an opened workspace or an approved root in read-only mode.",
    inputSchema: {
      ...hubReadScopeSchema,
      query: z.string().describe("Text or regular expression to search for."),
      regex: z.boolean().optional(),
      path: z.string().optional().describe("Relative file or directory. Default: ."),
      glob: z.string().optional(),
      include_hidden: z.boolean().optional(),
      max_results: z.number().int().min(1).max(2000).optional()
    },
    annotations: HUB_READ_ONLY
  }, async (args) => {
    const scope = session.readScope(args);
    return session.forward(scope, "agent_search", definedArgs({
      query: args.query,
      regex: args.regex,
      path: args.path,
      glob: args.glob,
      include_hidden: args.include_hidden,
      max_results: args.max_results
    }));
  });

  registerHubTool(server, "read", {
    title: "Read Device File",
    description: "Read a text file from an opened workspace or an approved root. Credential and secret patterns remain blocked by the target agent.",
    inputSchema: {
      ...hubReadScopeSchema,
      path: z.string().describe("File path relative to the chosen workspace or root."),
      start_line: z.number().int().min(1).optional(),
      end_line: z.number().int().min(1).optional(),
      max_bytes: z.number().int().min(1000).max(2000000).optional()
    },
    annotations: HUB_READ_ONLY
  }, async (args) => {
    const scope = session.readScope(args);
    return session.forward(scope, "agent_read", definedArgs({
      path: args.path,
      start_line: args.start_line,
      end_line: args.end_line,
      max_bytes: args.max_bytes
    }));
  });

  registerHubTool(server, "git_status", {
    title: "Device Git Status",
    description: "Show Git status for an explicitly opened workspace.",
    inputSchema: {
      workspace_id: z.string().describe("Hub workspace id from open_workspace."),
      path: z.string().optional(),
      staged: z.boolean().optional()
    },
    annotations: HUB_READ_ONLY
  }, async (args) => {
    const scope = session.writeScope(args.workspace_id);
    return session.forward(scope, "agent_git_status", definedArgs({ path: args.path, staged: args.staged }));
  });

  registerHubTool(server, "git_diff", {
    title: "Device Git Diff",
    description: "Show a no-external-driver Git diff for an explicitly opened workspace.",
    inputSchema: {
      workspace_id: z.string().describe("Hub workspace id from open_workspace."),
      path: z.string().optional(),
      staged: z.boolean().optional()
    },
    annotations: HUB_READ_ONLY
  }, async (args) => {
    const scope = session.writeScope(args.workspace_id);
    return session.forward(scope, "agent_git_diff", definedArgs({ path: args.path, staged: args.staged }));
  });
}
