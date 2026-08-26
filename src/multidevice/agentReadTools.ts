import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { repoTree, readTextFile } from "../fsOps.js";
import { gitDiff, gitStatus } from "../gitOps.js";
import { searchWorkspace } from "../searchOps.js";
import type { AgentRuntime } from "./agentRuntime.js";
import { bool, int, READ_ONLY_ANNOTATIONS, readScopeSchema, registerAgentTool } from "./mcpTools.js";
import { textResult } from "./types.js";

export function registerAgentReadTools(server: McpServer, runtime: AgentRuntime): void {
  const { policy, config, guard } = runtime;

  registerAgentTool(server, runtime, "agent_tree", {
    title: "Target File Tree",
    description: "List files inside one opened workspace or one approved root. Root scope is always read-only.",
    inputSchema: {
      ...readScopeSchema,
      path: z.string().max(4096).optional().describe("Relative directory. Default: ."),
      max_depth: z.number().int().min(1).max(12).optional(),
      include_hidden: z.boolean().optional(),
      max_entries: z.number().int().min(1).max(3000).optional()
    },
    annotations: READ_ONLY_ANNOTATIONS
  }, async (args) => {
    const scope = runtime.readScope(args);
    const result = await repoTree(config, guard, scope.workspace, {
      path: args.path ?? ".",
      maxDepth: int(args.max_depth, 4, 1, 12),
      includeHidden: bool(args.include_hidden, false),
      maxEntries: int(args.max_entries, 800, 1, 3000)
    });
    return textResult(result.text, {
      device_id: policy.deviceId,
      scope: scope.scope,
      root_id: scope.rootId,
      workspace_id: scope.workspaceId ?? null,
      ...result
    });
  });

  registerAgentTool(server, runtime, "agent_search", {
    title: "Search Target Files",
    description: "Search text inside one opened workspace or approved root. Root scope is always read-only.",
    inputSchema: {
      ...readScopeSchema,
      query: z.string().min(1).max(20000).describe("Text or regular expression to search for."),
      regex: z.boolean().optional(),
      path: z.string().max(4096).optional().describe("Relative file or directory. Default: ."),
      glob: z.string().max(1000).optional(),
      include_hidden: z.boolean().optional(),
      max_results: z.number().int().min(1).max(2000).optional()
    },
    annotations: READ_ONLY_ANNOTATIONS
  }, async (args) => {
    const scope = runtime.readScope(args);
    const result = await searchWorkspace(config, guard, scope.workspace, {
      query: String(args.query ?? ""),
      regex: bool(args.regex, false),
      root: args.path ?? ".",
      glob: args.glob,
      includeHidden: bool(args.include_hidden, false),
      maxResults: int(args.max_results, config.maxSearchResults, 1, config.maxSearchResults)
    });
    return textResult(result.text, {
      device_id: policy.deviceId,
      scope: scope.scope,
      root_id: scope.rootId,
      workspace_id: scope.workspaceId ?? null,
      matches: result.matches,
      truncated: result.truncated,
      used: result.used
    });
  });

  registerAgentTool(server, runtime, "agent_read", {
    title: "Read Target File",
    description: "Read a text file inside one opened workspace or approved root. Blocked credential and secret paths remain inaccessible.",
    inputSchema: {
      ...readScopeSchema,
      path: z.string().min(1).max(4096).describe("File path relative to the selected scope."),
      start_line: z.number().int().min(1).max(10000000).optional(),
      end_line: z.number().int().min(1).max(10000000).optional(),
      max_bytes: z.number().int().min(1000).max(2000000).optional()
    },
    annotations: READ_ONLY_ANNOTATIONS
  }, async (args) => {
    const scope = runtime.readScope(args);
    const result = await readTextFile(config, guard, scope.workspace, String(args.path ?? ""), {
      startLine: args.start_line,
      endLine: args.end_line,
      maxBytes: args.max_bytes
    });
    return textResult(`# ${result.path}\n\n${result.text}`, {
      device_id: policy.deviceId,
      scope: scope.scope,
      root_id: scope.rootId,
      workspace_id: scope.workspaceId ?? null,
      ...result
    });
  });

  registerAgentTool(server, runtime, "agent_git_status", {
    title: "Target Git Status",
    description: "Show Git status for an explicitly opened workspace.",
    inputSchema: {
      workspace_id: z.string().min(1).max(64).describe("Agent workspace id from agent_open_workspace."),
      path: z.string().max(4096).optional(),
      staged: z.boolean().optional()
    },
    annotations: READ_ONLY_ANNOTATIONS
  }, async (args) => {
    const stored = runtime.requireWorkspace(args.workspace_id);
    const output = gitStatus(config, stored.workspace, guard, args.path, bool(args.staged, false));
    return textResult(output, {
      device_id: policy.deviceId,
      workspace_id: stored.descriptor.id,
      status: output,
      path: args.path ?? null,
      staged: bool(args.staged, false)
    });
  });

  registerAgentTool(server, runtime, "agent_git_diff", {
    title: "Target Git Diff",
    description: "Show a no-external-driver Git diff for an explicitly opened workspace.",
    inputSchema: {
      workspace_id: z.string().min(1).max(64).describe("Agent workspace id from agent_open_workspace."),
      path: z.string().max(4096).optional(),
      staged: z.boolean().optional()
    },
    annotations: READ_ONLY_ANNOTATIONS
  }, async (args) => {
    const stored = runtime.requireWorkspace(args.workspace_id);
    const output = gitDiff(config, guard, stored.workspace, args.path, bool(args.staged, false));
    return textResult(output, {
      device_id: policy.deviceId,
      workspace_id: stored.descriptor.id,
      diff: output,
      path: args.path ?? null,
      staged: bool(args.staged, false)
    });
  });
}
