import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { DeviceStatus, HubDevice } from "./types.js";
import { errorMessage, resultStructured } from "./types.js";
import { CODEXPRO_MULTIDEVICE_VERSION } from "./version.js";

const REQUIRED_AGENT_CAPABILITIES = [
  "tree",
  "search",
  "read",
  "write",
  "edit",
  "git-status",
  "git-diff"
] as const;

function posixShellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function publicConnectionError(device: HubDevice): string {
  return `Unable to connect to device ${device.label} (${device.id}). Check the Windows Hub terminal.`;
}

function terminalDiagnostic(error: unknown): string {
  return errorMessage(error)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "?")
    .slice(0, 8000);
}

function localAgentParameters(device: HubDevice): { command: string; args: string[] } {
  const builtAgent = fileURLToPath(new URL("../agent.js", import.meta.url));
  if (fs.existsSync(builtAgent)) {
    return {
      command: process.execPath,
      args: [builtAgent, "--policy", device.policyPath]
    };
  }

  // `npm run dev:hub` executes this module from src/. In that case launch the
  // TypeScript entry through the project's pinned tsx development dependency.
  const sourceAgent = fileURLToPath(new URL("../agent.ts", import.meta.url));
  const tsxCli = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));
  if (!fs.existsSync(sourceAgent) || !fs.existsSync(tsxCli)) {
    throw new Error("Local CodexPro Agent entrypoint is unavailable. Run npm run build first.");
  }
  return {
    command: process.execPath,
    args: [tsxCli, sourceAgent, "--policy", device.policyPath]
  };
}

function transportParameters(device: HubDevice): { command: string; args: string[] } {
  if (device.transport === "local") return localAgentParameters(device);

  const remoteCommand = `codexpro-agent --policy ${posixShellQuote(device.policyPath)}`;
  return {
    command: "ssh",
    args: [
      "-T",
      "-o", "BatchMode=yes",
      "-o", "ClearAllForwardings=yes",
      "-o", "ForwardAgent=no",
      "-o", "ForwardX11=no",
      "-o", "RequestTTY=no",
      "-o", "PermitLocalCommand=no",
      "-o", "ControlMaster=no",
      "-o", "ControlPath=none",
      "-o", "EscapeChar=none",
      "-o", "StrictHostKeyChecking=yes",
      "-o", "ConnectionAttempts=1",
      "-o", "ConnectTimeout=15",
      "-o", "ServerAliveInterval=30",
      "-o", "ServerAliveCountMax=2",
      "-o", "LogLevel=ERROR",
      device.sshHostAlias,
      remoteCommand
    ]
  };
}

function validateAgentHandshake(client: Client, device: HubDevice, structured: Record<string, unknown>): void {
  const serverVersion = client.getServerVersion();
  if (!serverVersion || serverVersion.version !== CODEXPRO_MULTIDEVICE_VERSION) {
    throw new Error(
      `Agent version mismatch: expected ${CODEXPRO_MULTIDEVICE_VERSION}, received ${serverVersion?.version ?? "unknown"}.`
    );
  }
  if (structured.schema_version !== 1) {
    throw new Error(`Unsupported Agent schema version: ${String(structured.schema_version ?? "unknown")}.`);
  }
  if (structured.device_id !== device.id) {
    throw new Error(
      `Agent identity mismatch: expected ${device.id}, received ${String(structured.device_id ?? "unknown")}.`
    );
  }
  if (structured.shell_execution !== false) {
    throw new Error("Target Agent did not confirm that shell execution is disabled.");
  }
  if (!Array.isArray(structured.capabilities) || structured.capabilities.some((value) => typeof value !== "string")) {
    throw new Error("Target Agent returned an invalid capability list.");
  }
  const capabilities = new Set(structured.capabilities as string[]);
  for (const capability of REQUIRED_AGENT_CAPABILITIES) {
    if (!capabilities.has(capability)) {
      throw new Error(`Target Agent is missing required capability: ${capability}.`);
    }
  }
}

export class DeviceClient {
  private client?: Client;
  private transport?: StdioClientTransport;
  private connecting?: Promise<Client>;
  private state: DeviceStatus["status"] = "unknown";
  private lastError?: string;
  private lastDiagnostic?: string;

  constructor(
    readonly device: HubDevice,
    private readonly connectTimeoutMs = 20_000,
    private readonly callTimeoutMs = 60_000
  ) {}

  status(): DeviceStatus {
    return {
      id: this.device.id,
      label: this.device.label,
      transport: this.device.transport,
      status: this.state,
      ...(this.lastError ? { lastError: this.lastError } : {})
    };
  }

  private async start(): Promise<Client> {
    const params = transportParameters(this.device);
    const transport = new StdioClientTransport({ ...params, stderr: "pipe" });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4000);
    });
    const client = new Client({
      name: `codexpro-hub-${this.device.id}`,
      version: CODEXPRO_MULTIDEVICE_VERSION
    });
    try {
      await client.connect(transport, {
        timeout: this.connectTimeoutMs,
        maxTotalTimeout: this.connectTimeoutMs
      });
      const description = await client.callTool(
        { name: "agent_describe", arguments: {} },
        CallToolResultSchema,
        { timeout: this.connectTimeoutMs, maxTotalTimeout: this.connectTimeoutMs }
      );
      if ((description as any).isError) {
        throw new Error(`Agent handshake failed: ${stderr || "agent_describe returned an error"}`);
      }
      validateAgentHandshake(client, this.device, resultStructured(description));
      this.transport = transport;
      this.client = client;
      this.state = "online";
      this.lastError = undefined;
      this.lastDiagnostic = undefined;
      return client;
    } catch (error) {
      try {
        await client.close();
      } catch {}
      try {
        await transport.close();
      } catch {}
      const combined = stderr.trim() ? `${errorMessage(error)}; stderr: ${stderr.trim()}` : errorMessage(error);
      this.state = "offline";
      this.lastDiagnostic = combined;
      this.lastError = publicConnectionError(this.device);
      throw new Error(this.lastError);
    }
  }

  async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = this.start().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    try {
      const client = await this.connect();
      const result = await client.callTool(
        { name, arguments: args },
        CallToolResultSchema,
        { timeout: this.callTimeoutMs, maxTotalTimeout: this.callTimeoutMs }
      );
      this.state = "online";
      this.lastError = undefined;
      this.lastDiagnostic = undefined;
      return result;
    } catch (error) {
      const diagnostic = this.lastDiagnostic ?? error;
      console.error(`[codexpro-hub] Device ${this.device.id} failed: ${terminalDiagnostic(diagnostic)}`);
      this.state = "offline";
      this.lastError = publicConnectionError(this.device);
      this.lastDiagnostic = undefined;
      await this.reset();
      throw new Error(this.lastError);
    }
  }

  private async reset(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    try {
      await client?.close();
    } catch {}
    try {
      await transport?.close();
    } catch {}
  }

  async close(): Promise<void> {
    await this.reset();
    this.state = "unknown";
  }
}

export class DeviceRegistry {
  private readonly clients = new Map<string, DeviceClient>();

  constructor(
    devices: HubDevice[],
    connectTimeoutMs = 20_000,
    callTimeoutMs = 60_000
  ) {
    for (const device of devices) {
      this.clients.set(device.id, new DeviceClient(device, connectTimeoutMs, callTimeoutMs));
    }
  }

  list(): DeviceStatus[] {
    return [...this.clients.values()].map((client) => client.status());
  }

  require(deviceIdInput: unknown): DeviceClient {
    const deviceId = String(deviceIdInput ?? "").trim();
    const client = this.clients.get(deviceId);
    if (!client) throw new Error(`Unknown device_id: ${deviceId || "(empty)"}. Call list_devices first.`);
    return client;
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((client) => client.close()));
  }
}
