import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { DeviceStatus, HubDevice } from "./types.js";
import { errorMessage, resultStructured } from "./types.js";

function posixShellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function publicConnectionError(error: unknown, device: HubDevice): string {
  return errorMessage(error)
    .split(device.policyPath).join("$POLICY")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 500);
}

function transportParameters(device: HubDevice): { command: string; args: string[] } {
  if (device.transport === "local") {
    const agentEntry = fileURLToPath(new URL("../agent.js", import.meta.url));
    return {
      command: process.execPath,
      args: [agentEntry, "--policy", device.policyPath]
    };
  }
  const remoteCommand = `codexpro-agent --policy ${posixShellQuote(device.policyPath)}`;
  return {
    command: "ssh",
    args: [
      "-T",
      "-o", "BatchMode=yes",
      "-o", "ClearAllForwardings=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", "ConnectTimeout=15",
      "-o", "ServerAliveInterval=30",
      "-o", "ServerAliveCountMax=2",
      device.sshHostAlias,
      remoteCommand
    ]
  };
}

export class DeviceClient {
  private client?: Client;
  private transport?: StdioClientTransport;
  private connecting?: Promise<Client>;
  private state: DeviceStatus["status"] = "unknown";
  private lastError?: string;

  constructor(readonly device: HubDevice) {}

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
    const client = new Client({ name: `codexpro-hub-${this.device.id}`, version: "0.31.0" });
    try {
      await client.connect(transport);
      const description = await client.callTool({ name: "agent_describe", arguments: {} });
      if ((description as any).isError) throw new Error(`Agent handshake failed: ${stderr || "agent_describe returned an error"}`);
      const structured = resultStructured(description);
      if (structured.device_id !== this.device.id) {
        throw new Error(`Agent identity mismatch: expected ${this.device.id}, received ${String(structured.device_id ?? "unknown")}.`);
      }
      this.transport = transport;
      this.client = client;
      this.state = "online";
      this.lastError = undefined;
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
      this.lastError = publicConnectionError(combined, this.device);
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
      const result = await client.callTool({ name, arguments: args });
      this.state = "online";
      this.lastError = undefined;
      return result;
    } catch (error) {
      this.state = "offline";
      this.lastError = publicConnectionError(error, this.device);
      await this.reset();
      throw new Error(`Device ${this.device.id} is unavailable: ${this.lastError}`);
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

  constructor(devices: HubDevice[]) {
    for (const device of devices) this.clients.set(device.id, new DeviceClient(device));
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
