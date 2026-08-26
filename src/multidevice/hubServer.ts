import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DeviceRegistry } from "./deviceClient.js";
import { registerHubControlTools } from "./hubControlTools.js";
import { registerHubReadTools } from "./hubReadTools.js";
import { HubSession } from "./hubSession.js";
import { registerHubWriteTools } from "./hubWriteTools.js";

export function createHubServer(registry: DeviceRegistry): McpServer {
  const session = new HubSession(registry);
  const server = new McpServer(
    { name: "CodexPro Multi-Device Hub", version: "0.31.0" },
    {
      instructions: [
        "CodexPro Hub is the single ChatGPT-facing MCP endpoint for administrator-approved devices.",
        "Start with list_devices, then list_device_roots, then open_workspace with a device, root, and relative project directory.",
        "Reads may use a workspace_id or a device_id + root_id pair. Root access is always read-only.",
        "Every write or edit must include the hub workspace_id returned by open_workspace.",
        "Device enrollment, root policy changes, SSH destinations, and shell execution are not exposed as tools."
      ].join("\n")
    }
  );
  registerHubControlTools(server, session);
  registerHubReadTools(server, session);
  registerHubWriteTools(server, session);
  return server;
}
