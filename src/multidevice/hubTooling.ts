import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorResult } from "./types.js";

export const HUB_READ_ONLY = {
  readOnlyHint: true,
  openWorldHint: false,
  destructiveHint: false,
  idempotentHint: true
};

export const HUB_SESSION = {
  readOnlyHint: true,
  openWorldHint: false,
  destructiveHint: false,
  idempotentHint: false
};

export const HUB_WRITE = {
  readOnlyHint: false,
  openWorldHint: false,
  destructiveHint: true,
  idempotentHint: false
};

export const hubReadScopeSchema = {
  workspace_id: z.string().min(1).max(64).optional().describe("Hub workspace id from open_workspace."),
  device_id: z.string().min(1).max(64).optional().describe("Device id for read-only root access."),
  root_id: z.string().min(1).max(64).optional().describe("Approved root id for read-only root access.")
};

export function registerHubTool(
  server: McpServer,
  name: string,
  options: Record<string, unknown>,
  handler: (args: Record<string, any>) => Promise<any> | any
): void {
  server.registerTool(name, options as any, async (args: Record<string, any>) => {
    try {
      return await handler(args ?? {});
    } catch (error) {
      return errorResult(error);
    }
  });
}
