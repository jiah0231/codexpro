#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAgentServer } from "./multidevice/agentServer.js";
import { agentCodexProConfig, loadAgentPolicy } from "./multidevice/policy.js";
import { CODEXPRO_MULTIDEVICE_VERSION } from "./multidevice/version.js";

function optionValue(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function printHelp(): void {
  console.log(`CodexPro target-device agent\n\nUsage:\n  codexpro-agent --policy /path/to/agent-policy.json\n\nEnvironment:\n  CODEXPRO_AGENT_POLICY=/path/to/agent-policy.json\n\nThe agent uses MCP over stdin/stdout. It is intended to be launched locally by codexpro-hub or through a fixed SSH host alias.`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv.includes("-v") || argv[0] === "version") {
    console.log(CODEXPRO_MULTIDEVICE_VERSION);
    return;
  }
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    printHelp();
    return;
  }
  const policyPath = optionValue(argv, "policy") ?? process.env.CODEXPRO_AGENT_POLICY;
  if (!policyPath) throw new Error("Missing agent policy. Pass --policy or set CODEXPRO_AGENT_POLICY.");
  const policy = loadAgentPolicy(policyPath);
  const server = createAgentServer(policy, agentCodexProConfig(policy));
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
