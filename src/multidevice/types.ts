import { createHash, randomUUID } from "node:crypto";

export type RootMode = "workspace-parent" | "read-only";
export type DeviceTransport = "local" | "ssh";

export interface AgentRootPolicyInput {
  id: string;
  label?: string;
  path: string;
  mode: RootMode;
}

export interface AgentPolicyInput {
  schemaVersion?: 1;
  deviceId: string;
  label?: string;
  roots: AgentRootPolicyInput[];
  blockedGlobs?: string[];
  maxReadBytes?: number;
  maxWriteBytes?: number;
  maxSearchResults?: number;
  maxOutputBytes?: number;
}

export interface AgentRootPolicy {
  id: string;
  label: string;
  path: string;
  mode: RootMode;
}

export interface AgentPolicy {
  schemaVersion: 1;
  deviceId: string;
  label: string;
  roots: AgentRootPolicy[];
  blockedGlobs: string[];
  maxReadBytes: number;
  maxWriteBytes: number;
  maxSearchResults: number;
  maxOutputBytes: number;
}

export interface RootDescriptor {
  id: string;
  label: string;
  mode: RootMode;
}

export interface AgentWorkspaceDescriptor {
  id: string;
  rootId: string;
  relativeDir: string;
  displayPath: string;
  openedAt: string;
}

export interface LocalHubDeviceInput {
  id: string;
  label?: string;
  transport: "local";
  policyPath: string;
}

export interface SshHubDeviceInput {
  id: string;
  label?: string;
  transport: "ssh";
  sshHostAlias: string;
  policyPath: string;
}

export type HubDeviceInput = LocalHubDeviceInput | SshHubDeviceInput;

export interface HubConfigInput {
  schemaVersion?: 1;
  host?: string;
  port?: number;
  maxSessions?: number;
  sessionTtlMs?: number;
  agentConnectTimeoutMs?: number;
  agentCallTimeoutMs?: number;
  devices: HubDeviceInput[];
}

export interface LocalHubDevice {
  id: string;
  label: string;
  transport: "local";
  policyPath: string;
}

export interface SshHubDevice {
  id: string;
  label: string;
  transport: "ssh";
  sshHostAlias: string;
  policyPath: string;
}

export type HubDevice = LocalHubDevice | SshHubDevice;

export interface HubConfig {
  schemaVersion: 1;
  host: string;
  port: number;
  maxSessions: number;
  sessionTtlMs: number;
  agentConnectTimeoutMs: number;
  agentCallTimeoutMs: number;
  devices: HubDevice[];
}

export interface HubWorkspaceDescriptor {
  id: string;
  deviceId: string;
  deviceLabel: string;
  rootId: string;
  relativeDir: string;
  displayPath: string;
  openedAt: string;
  remoteWorkspaceId: string;
}

export interface DeviceStatus {
  id: string;
  label: string;
  transport: DeviceTransport;
  status: "unknown" | "online" | "offline";
  lastError?: string;
}

export const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function assertSafeId(value: unknown, field: string): string {
  const text = String(value ?? "").trim();
  if (!SAFE_ID_PATTERN.test(text)) {
    throw new Error(`${field} must be 1-64 characters using letters, numbers, dot, underscore, or dash.`);
  }
  return text;
}

export function assertPlainObject(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
}

export function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

export function stableToken(prefix: string, ...parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return `${prefix}_${hash.digest("hex").slice(0, 24)}`;
}

export function sessionNonce(): string {
  return randomUUID();
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function textResult(text: string, structuredContent: Record<string, unknown> = {}): any {
  return {
    content: [{ type: "text", text }],
    structuredContent
  };
}

export function errorResult(error: unknown): any {
  const message = errorMessage(error);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { error: message }
  };
}

export function resultText(result: any): string {
  if (!result || !Array.isArray(result.content)) return "";
  return result.content
    .filter((item: any) => item?.type === "text" && typeof item.text === "string")
    .map((item: any) => item.text)
    .join("\n");
}

export function resultStructured(result: any): Record<string, unknown> {
  return result?.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)
    ? result.structuredContent as Record<string, unknown>
    : {};
}
