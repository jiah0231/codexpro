import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorResult } from "./types.js";
import type { AgentRuntime } from "./agentRuntime.js";

export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  openWorldHint: false,
  destructiveHint: false,
  idempotentHint: true
};

export const SESSION_ANNOTATIONS = {
  readOnlyHint: true,
  openWorldHint: false,
  destructiveHint: false,
  idempotentHint: false
};

export const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  openWorldHint: false,
  destructiveHint: true,
  idempotentHint: false
};

export const readScopeSchema = {
  workspace_id: z.string().min(1).max(64).optional().describe("Agent workspace id from agent_open_workspace."),
  root_id: z.string().min(1).max(64).optional().describe("Approved root id for read-only browsing. Provide exactly one of workspace_id or root_id.")
};

export function bool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null) return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export function int(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

export function registerAgentTool(
  server: McpServer,
  runtime: AgentRuntime,
  name: string,
  options: Record<string, unknown>,
  handler: (args: Record<string, any>) => Promise<any> | any
): void {
  server.registerTool(name, options as any, async (args: Record<string, any>) => {
    try {
      return await handler(args ?? {});
    } catch (error) {
      return errorResult(runtime.publicError(error));
    }
  });
}
