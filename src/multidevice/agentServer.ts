import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CodexProConfig } from "../config.js";
import type { AgentPolicy } from "./types.js";
import { AgentRuntime } from "./agentRuntime.js";
import { registerAgentControlTools } from "./agentControlTools.js";
import { registerAgentReadTools } from "./agentReadTools.js";
import { registerAgentWriteTools } from "./agentWriteTools.js";
import { CODEXPRO_MULTIDEVICE_VERSION } from "./version.js";

export function createAgentServer(policy: AgentPolicy, config: CodexProConfig): McpServer {
  const runtime = new AgentRuntime(policy, config);
  const server = new McpServer(
    { name: `CodexPro Agent (${policy.deviceId})`, version: CODEXPRO_MULTIDEVICE_VERSION },
    {
      instructions:
        "Private CodexPro target-device agent. Reads are limited to administrator-approved roots. Writes require an opened workspace inside a workspace-parent root. Shell execution and device administration are not exposed."
    }
  );
  registerAgentControlTools(server, runtime);
  registerAgentReadTools(server, runtime);
  registerAgentWriteTools(server, runtime);
  return server;
}
