import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { editTextFile, writeTextFile } from "../fsOps.js";
import type { AgentRuntime } from "./agentRuntime.js";
import { bool, registerAgentTool, WRITE_ANNOTATIONS } from "./mcpTools.js";
import { textResult } from "./types.js";

export function registerAgentWriteTools(server: McpServer, runtime: AgentRuntime): void {
  const { policy, config, guard } = runtime;

  registerAgentTool(server, runtime, "agent_write", {
    title: "Write Target Workspace File",
    description: "Create or replace a text file inside an explicitly opened workspace. No root-only write scope exists.",
    inputSchema: {
      workspace_id: z.string().describe("Agent workspace id from agent_open_workspace."),
      path: z.string().describe("File path relative to the workspace."),
      content: z.string().describe("Complete UTF-8 file content."),
      create_dirs: z.boolean().optional(),
      overwrite: z.boolean().optional(),
      expected_sha256: z.string().optional()
    },
    annotations: WRITE_ANNOTATIONS
  }, async (args) => {
    const stored = runtime.requireWorkspace(args.workspace_id);
    const filePath = runtime.relativePath(args.path, "path", "");
    runtime.assertSingleLinkWriteTarget(stored.workspace, filePath);
    const result = await writeTextFile(config, guard, stored.workspace, filePath, String(args.content ?? ""), {
      createDirs: bool(args.create_dirs, false),
      overwrite: args.overwrite === undefined ? true : bool(args.overwrite, true),
      expectedSha256: args.expected_sha256
    });
    return textResult(
      `Wrote ${result.path} on ${policy.label}.\nBytes: ${result.bytes}\nSHA-256: ${result.sha256}\n\n${result.diff.diff}`,
      { device_id: policy.deviceId, workspace_id: stored.descriptor.id, ...result }
    );
  });

  registerAgentTool(server, runtime, "agent_edit", {
    title: "Edit Target Workspace File",
    description: "Perform an exact text replacement inside an explicitly opened workspace. No root-only edit scope exists.",
    inputSchema: {
      workspace_id: z.string().describe("Agent workspace id from agent_open_workspace."),
      path: z.string().describe("File path relative to the workspace."),
      old_text: z.string().describe("Exact existing text."),
      new_text: z.string().describe("Replacement text."),
      replace_all: z.boolean().optional(),
      expected_replacements: z.number().int().min(1).optional(),
      expected_sha256: z.string().optional()
    },
    annotations: WRITE_ANNOTATIONS
  }, async (args) => {
    const stored = runtime.requireWorkspace(args.workspace_id);
    const filePath = runtime.relativePath(args.path, "path", "");
    runtime.assertSingleLinkWriteTarget(stored.workspace, filePath);
    const result = await editTextFile(
      config,
      guard,
      stored.workspace,
      filePath,
      String(args.old_text ?? ""),
      String(args.new_text ?? ""),
      {
        replaceAll: bool(args.replace_all, false),
        expectedReplacements: args.expected_replacements,
        expectedSha256: args.expected_sha256
      }
    );
    return textResult(
      `Edited ${result.path} on ${policy.label}.\nReplacements: ${result.replacements}\nSHA-256: ${result.sha256}\n\n${result.diff.diff}`,
      { device_id: policy.deviceId, workspace_id: stored.descriptor.id, ...result }
    );
  });
}
