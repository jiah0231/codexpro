import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DEFAULT_ANALYSIS_LIMITS } from "../analysis/types.js";
import type { CodexProConfig } from "../config.js";
import {
  assertPlainObject,
  assertSafeId,
  boundedInt,
  type AgentPolicy,
  type AgentPolicyInput,
  type AgentRootPolicy,
  type HubConfig,
  type HubConfigInput,
  type HubDevice,
  type HubDeviceInput
} from "./types.js";

const DEFAULT_AGENT_BLOCKED_GLOBS = [
  ".git",
  ".git/**",
  "**/.git/**",
  "node_modules",
  "node_modules/**",
  "**/node_modules/**",
  ".env",
  ".env/**",
  ".env.*",
  ".env.*/**",
  "**/.env",
  "**/.env/**",
  "**/.env.*",
  "**/.env.*/**",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa",
  "**/id_rsa.*",
  "**/id_ed25519",
  "**/id_ed25519.*",
  "**/.ssh/**",
  "**/.gnupg/**",
  "**/credentials*",
  "dist",
  "dist/**",
  "**/dist/**",
  "build",
  "build/**",
  "**/build/**",
  ".next",
  ".next/**",
  "**/.next/**",
  "coverage",
  "coverage/**",
  "**/coverage/**",
  ".cache",
  ".cache/**",
  "**/.cache/**"
] as const;

function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function canonicalExistingFile(filePathInput: string, field: string): string {
  const resolved = path.resolve(expandHome(filePathInput));
  if (!fs.existsSync(resolved)) throw new Error(`${field} does not exist: ${resolved}`);
  const realPath = fs.realpathSync.native(resolved);
  if (!fs.statSync(realPath).isFile()) throw new Error(`${field} is not a file: ${realPath}`);
  return realPath;
}

function isPathInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function readJsonFile(filePath: string): unknown {
  const text = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function resolveExistingDirectory(value: unknown, baseDir: string, field: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error(`${field} is required.`);
  const expanded = expandHome(raw);
  const resolved = path.isAbsolute(expanded) || path.win32.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(baseDir, expanded);
  if (!fs.existsSync(resolved)) throw new Error(`${field} does not exist: ${resolved}`);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error(`${field} is not a directory: ${resolved}`);
  return fs.realpathSync.native(resolved);
}

function safeLabel(value: unknown, fallback: string, field: string): string {
  const label = String(value ?? fallback).trim();
  if (!label || label.length > 120 || /[\r\n\0]/.test(label)) {
    throw new Error(`${field} must be a single line with 1-120 characters.`);
  }
  return label;
}

function stringArray(value: unknown, field: string, maximum: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of strings.`);
  if (value.length > maximum) throw new Error(`${field} may contain at most ${maximum} entries.`);
  return value.map((item, index) => {
    const text = String(item ?? "").trim();
    if (!text || text.length > 300 || /[\r\n\0]/.test(text)) {
      throw new Error(`${field}[${index}] must be a non-empty single-line string of at most 300 characters.`);
    }
    if (text.startsWith("!")) {
      throw new Error(`${field}[${index}] must not be a negated glob.`);
    }
    return text;
  });
}

function validateAgentRoot(value: unknown, baseDir: string, index: number): AgentRootPolicy {
  assertPlainObject(value, `roots[${index}]`);
  const id = assertSafeId(value.id, `roots[${index}].id`);
  const mode = value.mode;
  if (mode !== "workspace-parent" && mode !== "read-only") {
    throw new Error(`roots[${index}].mode must be workspace-parent or read-only.`);
  }
  return {
    id,
    label: safeLabel(value.label, id, `roots[${index}].label`),
    path: resolveExistingDirectory(value.path, baseDir, `roots[${index}].path`),
    mode
  };
}

export function loadAgentPolicy(policyPathInput: string): AgentPolicy {
  const policyPath = canonicalExistingFile(policyPathInput.trim(), "Agent policy");
  const raw = readJsonFile(policyPath) as AgentPolicyInput;
  assertPlainObject(raw, "agent policy");
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) {
    throw new Error(`Unsupported agent policy schemaVersion: ${String(raw.schemaVersion)}.`);
  }
  const deviceId = assertSafeId(raw.deviceId, "deviceId");
  if (!Array.isArray(raw.roots) || raw.roots.length === 0) {
    throw new Error("roots must contain at least one approved directory.");
  }
  if (raw.roots.length > 64) throw new Error("roots may contain at most 64 entries.");
  const roots = raw.roots.map((root, index) => validateAgentRoot(root, path.dirname(policyPath), index));
  const rootIds = new Set<string>();
  const rootPaths = new Set<string>();
  for (const root of roots) {
    if (rootIds.has(root.id)) throw new Error(`Duplicate root id: ${root.id}.`);
    rootIds.add(root.id);
    const normalizedPath = process.platform === "win32" ? root.path.toLowerCase() : root.path;
    if (rootPaths.has(normalizedPath)) throw new Error(`Duplicate root path: ${root.path}.`);
    rootPaths.add(normalizedPath);
    if (isPathInside(policyPath, root.path)) {
      throw new Error(
        `Agent policy must be stored outside every approved root. Move the policy file out of root ${root.id}.`
      );
    }
  }
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      const leftRoot = roots[left];
      const rightRoot = roots[right];
      if (isPathInside(leftRoot.path, rightRoot.path) || isPathInside(rightRoot.path, leftRoot.path)) {
        throw new Error(
          `Approved roots must not overlap: ${leftRoot.id} and ${rightRoot.id}. Use disjoint directories to keep read-only and workspace permissions unambiguous.`
        );
      }
    }
  }
  return {
    schemaVersion: 1,
    deviceId,
    label: safeLabel(raw.label, deviceId, "label"),
    roots,
    blockedGlobs: [...DEFAULT_AGENT_BLOCKED_GLOBS, ...stringArray(raw.blockedGlobs, "blockedGlobs", 256)],
    maxReadBytes: boundedInt(raw.maxReadBytes, 180_000, 4_000, 2_000_000),
    maxWriteBytes: boundedInt(raw.maxWriteBytes, 1_000_000, 1_000, 10_000_000),
    maxSearchResults: boundedInt(raw.maxSearchResults, 200, 5, 2_000),
    maxOutputBytes: boundedInt(raw.maxOutputBytes, 120_000, 4_000, 2_000_000)
  };
}

export function agentCodexProConfig(policy: AgentPolicy): CodexProConfig {
  return {
    defaultRoot: policy.roots[0].path,
    allowedRoots: policy.roots.map((root) => root.path),
    host: "127.0.0.1",
    port: 0,
    widgetDomain: "https://rebel0789.github.io",
    authToken: undefined,
    requireHttpToken: false,
    bashMode: "off",
    bashTranscript: "compact",
    bashSessionId: undefined,
    requireBashSession: false,
    codexSessions: "off",
    codexDir: "",
    writeMode: "workspace",
    toolMode: "minimal",
    inheritEnv: false,
    maxReadBytes: policy.maxReadBytes,
    maxWriteBytes: policy.maxWriteBytes,
    maxOutputBytes: policy.maxOutputBytes,
    maxBashTimeoutMs: 1_000,
    maxImportBytes: policy.maxWriteBytes,
    maxSearchResults: policy.maxSearchResults,
    maxHttpSessions: 1,
    httpSessionTtlMs: 60_000,
    blockedGlobs: policy.blockedGlobs,
    contextDir: ".ai-bridge",
    toolCards: false,
    connectionTest: false,
    analysisEnabled: false,
    analysisLimits: { ...DEFAULT_ANALYSIS_LIMITS }
  };
}

function validateRemotePolicyPath(value: unknown, field: string): string {
  const text = String(value ?? "").trim();
  if (!text || text.length > 4096 || /[\r\n\0]/.test(text)) {
    throw new Error(`${field} must be a single-line path with 1-4096 characters.`);
  }
  return text;
}

function validateHubDevice(value: unknown, baseDir: string, index: number): HubDevice {
  assertPlainObject(value, `devices[${index}]`);
  const input = value as unknown as HubDeviceInput;
  const id = assertSafeId(input.id, `devices[${index}].id`);
  const label = safeLabel(input.label, id, `devices[${index}].label`);
  if (input.transport === "local") {
    const rawPolicyPath = validateRemotePolicyPath(input.policyPath, `devices[${index}].policyPath`);
    const expanded = expandHome(rawPolicyPath);
    const candidate = path.isAbsolute(expanded) || path.win32.isAbsolute(expanded)
      ? path.resolve(expanded)
      : path.resolve(baseDir, expanded);
    const policyPath = canonicalExistingFile(candidate, `devices[${index}].policyPath`);
    return { id, label, transport: "local", policyPath };
  }
  if (input.transport === "ssh") {
    return {
      id,
      label,
      transport: "ssh",
      sshHostAlias: assertSafeId(input.sshHostAlias, `devices[${index}].sshHostAlias`),
      policyPath: validateRemotePolicyPath(input.policyPath, `devices[${index}].policyPath`)
    };
  }
  throw new Error(`devices[${index}].transport must be local or ssh.`);
}

export function loadHubConfig(configPathInput: string): HubConfig {
  const configPath = canonicalExistingFile(configPathInput.trim(), "Hub config");
  const raw = readJsonFile(configPath) as HubConfigInput;
  assertPlainObject(raw, "hub config");
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) {
    throw new Error(`Unsupported hub config schemaVersion: ${String(raw.schemaVersion)}.`);
  }
  if (!Array.isArray(raw.devices) || raw.devices.length === 0) {
    throw new Error("devices must contain at least one approved device.");
  }
  if (raw.devices.length > 64) throw new Error("devices may contain at most 64 entries.");
  const devices = raw.devices.map((device, index) => validateHubDevice(device, path.dirname(configPath), index));
  const ids = new Set<string>();
  for (const device of devices) {
    if (ids.has(device.id)) throw new Error(`Duplicate device id: ${device.id}.`);
    ids.add(device.id);
    if (device.transport === "local") {
      const localPolicy = loadAgentPolicy(device.policyPath);
      if (localPolicy.deviceId !== device.id) {
        throw new Error(
          `Local device identity mismatch: Hub device ${device.id} uses an Agent policy for ${localPolicy.deviceId}.`
        );
      }
      for (const root of localPolicy.roots) {
        if (isPathInside(configPath, root.path)) {
          throw new Error(
            `Hub config must be stored outside every approved local root. Move it out of device ${device.id} root ${root.id}.`
          );
        }
      }
    }
  }
  const host = String(raw.host ?? "127.0.0.1").trim();
  if (!host || host.length > 253 || /[\r\n\0/]/.test(host)) throw new Error("host is invalid.");
  const agentConnectTimeoutMs = boundedInt(raw.agentConnectTimeoutMs, 20_000, 5_000, 120_000);
  const agentCallTimeoutMs = boundedInt(raw.agentCallTimeoutMs, 60_000, 5_000, 300_000);
  if (agentCallTimeoutMs < agentConnectTimeoutMs) {
    throw new Error("agentCallTimeoutMs must be greater than or equal to agentConnectTimeoutMs.");
  }
  return {
    schemaVersion: 1,
    host,
    port: boundedInt(raw.port, 8790, 1, 65_535),
    maxSessions: boundedInt(raw.maxSessions, 64, 1, 512),
    sessionTtlMs: boundedInt(raw.sessionTtlMs, 30 * 60_000, 60_000, 24 * 60 * 60_000),
    agentConnectTimeoutMs,
    agentCallTimeoutMs,
    devices
  };
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
