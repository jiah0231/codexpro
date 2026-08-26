import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AgentPolicyInput, HubConfigInput } from "./types.js";
import { DeviceRegistry } from "./deviceClient.js";
import { loadAgentPolicy, loadHubConfig } from "./policy.js";
import { resultStructured, resultText } from "./types.js";

const MAX_LOG_LINES = 500;
const HUB_START_TIMEOUT_MS = 15_000;
const HUB_STOP_TIMEOUT_MS = 7_000;

function parseJson(text: string, label: string): any {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function safeConfigHost(host: unknown): string {
  const value = String(host ?? "127.0.0.1").trim();
  if (value === "0.0.0.0" || value === "::" || value === "::0") return "127.0.0.1";
  return value || "127.0.0.1";
}

function resolvePolicyPath(configPath: string, policyPathInput: unknown): string {
  const raw = String(policyPathInput ?? "").trim();
  if (!raw) throw new Error("Local device policyPath is required.");
  if (raw === "~") return path.join(process.env.USERPROFILE || process.env.HOME || "", ".config", "codexpro", "agent.json");
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    const home = process.env.USERPROFILE || process.env.HOME;
    if (!home) throw new Error("Cannot expand ~ because the user home directory is unavailable.");
    return path.resolve(home, raw.slice(2));
  }
  return path.isAbsolute(raw) || path.win32.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(path.dirname(configPath), raw);
}

async function atomicWriteText(filePath: string, text: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.codexpro-client-${process.pid}-${randomBytes(5).toString("hex")}.tmp`
  );
  try {
    await fsp.writeFile(temp, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fsp.rename(temp, filePath);
  } catch (error) {
    try {
      await fsp.rm(temp, { force: true });
    } catch {}
    throw error;
  }
}

async function readOptionalText(filePath: string): Promise<string | undefined> {
  try {
    return await fsp.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw error;
  }
}

export interface ClientHubStatus {
  owned: boolean;
  reachable: boolean;
  pid: number | null;
  localMcpUrl: string | null;
  localHealthUrl: string | null;
}

export interface ClientState {
  configPath: string;
  configExists: boolean;
  config: HubConfigInput | null;
  localPolicies: Record<string, AgentPolicyInput>;
  hubToken: string;
  hubTokenMasked: string;
  hub: ClientHubStatus;
  logs: string[];
}

export class ClientRuntime {
  readonly configPath: string;
  readonly tokenPath: string;
  private hubChild?: ChildProcess;
  private readonly logs: string[] = [];
  private cachedToken?: string;

  constructor(configPathInput: string) {
    this.configPath = path.resolve(configPathInput);
    this.tokenPath = path.join(path.dirname(this.configPath), ".codexpro-hub-token");
  }

  private log(line: string): void {
    const sanitized = line.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "?").trimEnd();
    if (!sanitized) return;
    const timestamp = new Date().toISOString();
    for (const part of sanitized.split(/\r?\n/)) {
      this.logs.push(`${timestamp} ${part}`);
    }
    if (this.logs.length > MAX_LOG_LINES) this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
  }

  logLines(): string[] {
    return [...this.logs];
  }

  private readHubDraft(): HubConfigInput | null {
    if (!fs.existsSync(this.configPath)) return null;
    return parseJson(fs.readFileSync(this.configPath, "utf8"), "Hub config") as HubConfigInput;
  }

  private readLocalPolicies(config: HubConfigInput | null): Record<string, AgentPolicyInput> {
    const out: Record<string, AgentPolicyInput> = {};
    if (!config || !Array.isArray(config.devices)) return out;
    for (const device of config.devices) {
      if (!device || device.transport !== "local") continue;
      const policyPath = resolvePolicyPath(this.configPath, device.policyPath);
      if (!fs.existsSync(policyPath)) continue;
      out[device.id] = parseJson(fs.readFileSync(policyPath, "utf8"), `Agent policy for ${device.id}`) as AgentPolicyInput;
    }
    return out;
  }

  async hubToken(): Promise<string> {
    if (this.cachedToken) return this.cachedToken;
    const fromEnv = process.env.CODEXPRO_HTTP_TOKEN?.trim();
    if (fromEnv && Buffer.byteLength(fromEnv, "utf8") >= 24) {
      this.cachedToken = fromEnv;
      return fromEnv;
    }
    const saved = (await readOptionalText(this.tokenPath))?.trim();
    if (saved && Buffer.byteLength(saved, "utf8") >= 24) {
      this.cachedToken = saved;
      return saved;
    }
    const generated = randomBytes(32).toString("hex");
    await atomicWriteText(this.tokenPath, `${generated}\n`);
    try {
      await fsp.chmod(this.tokenPath, 0o600);
    } catch {}
    this.cachedToken = generated;
    return generated;
  }

  private endpointFromDraft(config: HubConfigInput | null): { mcp: string | null; health: string | null } {
    if (!config) return { mcp: null, health: null };
    const host = safeConfigHost(config.host);
    const port = Number(config.port ?? 8790);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { mcp: null, health: null };
    const bracketedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    const base = `http://${bracketedHost}:${port}`;
    return { mcp: `${base}/mcp`, health: `${base}/healthz` };
  }

  private hubOwnedRunning(): boolean {
    return Boolean(this.hubChild && this.hubChild.exitCode === null && !this.hubChild.killed);
  }

  async hubStatus(): Promise<ClientHubStatus> {
    const config = this.readHubDraft();
    const endpoint = this.endpointFromDraft(config);
    let reachable = false;
    if (endpoint.health) {
      try {
        const response = await fetch(endpoint.health, {
          headers: { Authorization: `Bearer ${await this.hubToken()}` },
          signal: AbortSignal.timeout(1_500)
        });
        reachable = response.ok;
      } catch {}
    }
    return {
      owned: this.hubOwnedRunning(),
      reachable,
      pid: this.hubOwnedRunning() ? this.hubChild?.pid ?? null : null,
      localMcpUrl: endpoint.mcp,
      localHealthUrl: endpoint.health
    };
  }

  async state(): Promise<ClientState> {
    const config = this.readHubDraft();
    const token = await this.hubToken();
    return {
      configPath: this.configPath,
      configExists: Boolean(config),
      config,
      localPolicies: this.readLocalPolicies(config),
      hubToken: token,
      hubTokenMasked: token.length <= 12 ? "********" : `${token.slice(0, 6)}…${token.slice(-6)}`,
      hub: await this.hubStatus(),
      logs: this.logLines()
    };
  }

  async saveState(input: { config: HubConfigInput; localPolicies?: Record<string, AgentPolicyInput> }): Promise<ClientState> {
    const config = input?.config;
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("config is required.");
    if (!Array.isArray(config.devices) || config.devices.length === 0) throw new Error("Add at least one device before saving.");
    const localPolicies = input.localPolicies ?? {};
    const backups = new Map<string, string | undefined>();
    const touchedPolicyPaths: string[] = [];
    const configDir = path.dirname(this.configPath);
    await fsp.mkdir(configDir, { recursive: true });

    try {
      for (const device of config.devices) {
        if (!device || device.transport !== "local") continue;
        const policyPath = resolvePolicyPath(this.configPath, device.policyPath);
        const policy = localPolicies[device.id];
        if (!policy) {
          if (!fs.existsSync(policyPath)) throw new Error(`Missing local Agent policy for device ${device.id}.`);
          continue;
        }
        if (String(policy.deviceId ?? "").trim() !== device.id) {
          throw new Error(`Local Agent policy deviceId must match Hub device id ${device.id}.`);
        }
        backups.set(policyPath, await readOptionalText(policyPath));
        touchedPolicyPaths.push(policyPath);
        await atomicWriteText(policyPath, prettyJson(policy));
        loadAgentPolicy(policyPath);
      }

      const tempConfig = path.join(configDir, `.${path.basename(this.configPath)}.validate-${process.pid}-${randomBytes(5).toString("hex")}.json`);
      try {
        await fsp.writeFile(tempConfig, prettyJson(config), { encoding: "utf8", mode: 0o600, flag: "wx" });
        loadHubConfig(tempConfig);
      } finally {
        await fsp.rm(tempConfig, { force: true });
      }
      await atomicWriteText(this.configPath, prettyJson(config));
      this.log(`Saved Hub configuration: ${this.configPath}`);
      return this.state();
    } catch (error) {
      for (const policyPath of touchedPolicyPaths.reverse()) {
        const previous = backups.get(policyPath);
        try {
          if (previous === undefined) await fsp.rm(policyPath, { force: true });
          else await atomicWriteText(policyPath, previous);
        } catch (rollbackError) {
          this.log(`WARNING: could not roll back ${policyPath}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      throw error;
    }
  }

  async testDevice(deviceIdInput: unknown): Promise<Record<string, unknown>> {
    const config = loadHubConfig(this.configPath);
    const deviceId = String(deviceIdInput ?? "").trim();
    const device = config.devices.find((entry) => entry.id === deviceId);
    if (!device) throw new Error(`Unknown device: ${deviceId || "(empty)"}.`);
    const registry = new DeviceRegistry([device]);
    try {
      const result = await registry.require(device.id).callTool("agent_describe", {});
      if (result?.isError) throw new Error(resultText(result) || "Target Agent returned an error.");
      const structured = resultStructured(result);
      this.log(`Device test passed: ${device.id}`);
      return structured;
    } finally {
      await registry.close();
    }
  }

  async startHub(): Promise<ClientHubStatus> {
    if (this.hubOwnedRunning()) return this.hubStatus();
    loadHubConfig(this.configPath);
    const hubEntry = fileURLToPath(new URL("../hub.js", import.meta.url));
    const token = await this.hubToken();
    const child = spawn(process.execPath, [hubEntry, "--config", this.configPath], {
      env: { ...process.env, CODEXPRO_HTTP_TOKEN: token },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.hubChild = child;
    child.stdout?.on("data", (chunk) => this.log(`[hub] ${String(chunk)}`));
    child.stderr?.on("data", (chunk) => this.log(`[hub] ${String(chunk)}`));
    child.on("exit", (code, signal) => {
      this.log(`Hub exited: code=${String(code)} signal=${String(signal)}`);
      if (this.hubChild === child) this.hubChild = undefined;
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Timed out waiting for CodexPro Hub to start."));
      }, HUB_START_TIMEOUT_MS);
      const done = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve();
      };
      const inspect = (chunk: unknown) => {
        const text = String(chunk);
        if (text.includes("CodexPro Multi-Device Hub listening")) done();
      };
      child.stderr?.on("data", inspect);
      child.stdout?.on("data", inspect);
      child.once("error", (error) => done(error));
      child.once("exit", (code) => done(new Error(`CodexPro Hub exited during startup with code ${String(code)}.`)));
    });

    this.log(`Hub started with pid ${String(child.pid ?? "unknown")}.`);
    return this.hubStatus();
  }

  async stopHub(): Promise<ClientHubStatus> {
    const child = this.hubChild;
    if (!child || child.exitCode !== null) return this.hubStatus();
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
        finish();
      }, HUB_STOP_TIMEOUT_MS);
      child.once("exit", finish);
      try {
        child.kill("SIGTERM");
      } catch {
        finish();
      }
    });
    if (this.hubChild === child) this.hubChild = undefined;
    this.log("Hub stopped.");
    return this.hubStatus();
  }

  async restartHub(): Promise<ClientHubStatus> {
    await this.stopHub();
    return this.startHub();
  }

  async close(): Promise<void> {
    await this.stopHub();
  }
}
