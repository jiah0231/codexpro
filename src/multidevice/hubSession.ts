import path from "node:path";
import type { HubWorkspaceDescriptor, RootDescriptor } from "./types.js";
import { resultStructured, resultText, SAFE_ID_PATTERN, sessionNonce, stableToken } from "./types.js";
import { DeviceRegistry, type DeviceClient } from "./deviceClient.js";

const MAX_HUB_WORKSPACES = 128;
const MAX_REMOTE_ROOTS = 64;

export type PublicHubWorkspace = Omit<HubWorkspaceDescriptor, "remoteWorkspaceId">;

interface ForwardScope {
  client: DeviceClient;
  remoteArgs: Record<string, unknown>;
  tags: Record<string, unknown>;
}

interface RemoteWorkspaceRef {
  id: string;
  rootId: string;
  relativeDir: string;
}

function publicWorkspace(workspace: HubWorkspaceDescriptor): PublicHubWorkspace {
  const { remoteWorkspaceId: _remoteWorkspaceId, ...visible } = workspace;
  return visible;
}

function safeRemoteText(value: unknown, maximum: number): string {
  const text = String(value ?? "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "?")
    .trim();
  if (!text || text.length > maximum) throw new Error("Target agent returned invalid descriptor text.");
  return text;
}

function safeRemoteLabel(value: unknown): string {
  const label = String(value ?? "").trim();
  if (!label || label.length > 120 || /[\r\n\0]/.test(label)) {
    throw new Error("Target agent returned an invalid root label.");
  }
  return label.replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "?");
}

function safeRemoteId(value: unknown, field: string): string {
  const id = safeRemoteText(value, 64);
  if (!SAFE_ID_PATTERN.test(id)) throw new Error(`Target agent returned an invalid ${field}.`);
  return id;
}

function safeRemoteRelativeDirectory(value: unknown): string {
  const relativeDir = safeRemoteText(value, 4096).replaceAll("\\", "/");
  if (path.posix.isAbsolute(relativeDir) || path.win32.isAbsolute(relativeDir)) {
    throw new Error("Target agent returned an absolute workspace directory.");
  }
  if (relativeDir.split("/").some((segment) => segment === "..")) {
    throw new Error("Target agent returned a traversing workspace directory.");
  }
  const normalized = path.posix.normalize(relativeDir);
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error("Target agent returned a workspace outside its approved root.");
  }
  return normalized;
}

function requireRemoteSuccess(result: any, operation: string): Record<string, unknown> {
  if (result?.isError) {
    const detail = resultText(result)
      .replace(/[\x00-\x1f\x7f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1000);
    throw new Error(`${operation} failed: ${detail || "target agent returned an error"}`);
  }
  return resultStructured(result);
}

function parseRemoteRoots(value: unknown): RootDescriptor[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REMOTE_ROOTS) {
    throw new Error("Target agent returned an invalid root list.");
  }
  const seen = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Target agent returned an invalid root descriptor.");
    }
    const candidate = entry as Record<string, unknown>;
    const id = safeRemoteId(candidate.id, "root id");
    if (seen.has(id)) throw new Error(`Target agent returned duplicate root id: ${id}.`);
    seen.add(id);
    const mode = candidate.mode;
    if (mode !== "workspace-parent" && mode !== "read-only") {
      throw new Error(`Target agent returned an invalid mode for root ${id}.`);
    }
    return {
      id,
      label: safeRemoteLabel(candidate.label),
      mode
    };
  });
}

function parseRemoteWorkspace(value: unknown): RemoteWorkspaceRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Target agent returned an invalid workspace descriptor.");
  }
  const candidate = value as Record<string, unknown>;
  return {
    id: safeRemoteId(candidate.id, "workspace id"),
    rootId: safeRemoteId(candidate.rootId, "root id"),
    relativeDir: safeRemoteRelativeDirectory(candidate.relativeDir)
  };
}

export class HubSession {
  private readonly nonce = sessionNonce();
  private readonly workspaces = new Map<string, HubWorkspaceDescriptor>();
  private selectedWorkspaceId?: string;

  constructor(readonly registry: DeviceRegistry) {}

  private rememberWorkspace(workspace: HubWorkspaceDescriptor): HubWorkspaceDescriptor {
    this.workspaces.delete(workspace.id);
    while (this.workspaces.size >= MAX_HUB_WORKSPACES) {
      const oldestId = this.workspaces.keys().next().value as string | undefined;
      if (!oldestId) break;
      this.workspaces.delete(oldestId);
    }
    this.workspaces.set(workspace.id, workspace);
    return workspace;
  }

  listWorkspaces(): PublicHubWorkspace[] {
    return [...this.workspaces.values()].map(publicWorkspace);
  }

  selectedWorkspace(): PublicHubWorkspace | undefined {
    const selected = this.selectedWorkspaceId ? this.workspaces.get(this.selectedWorkspaceId) : undefined;
    return selected ? publicWorkspace(selected) : undefined;
  }

  requireWorkspace(workspaceIdInput: unknown): HubWorkspaceDescriptor {
    const workspaceId = String(workspaceIdInput ?? "").trim();
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new Error(`Unknown workspace_id: ${workspaceId || "(empty)"}. Call open_workspace in this MCP session first.`);
    return this.rememberWorkspace(workspace);
  }

  async listRoots(deviceIdInput: unknown): Promise<{ client: DeviceClient; roots: RootDescriptor[] }> {
    const client = this.registry.require(deviceIdInput);
    const result = await client.callTool("agent_list_roots", {});
    const structured = requireRemoteSuccess(result, "list_device_roots");
    return {
      client,
      roots: parseRemoteRoots(structured.roots)
    };
  }

  async openWorkspace(deviceIdInput: unknown, rootIdInput: unknown, relativeDirInput: unknown): Promise<PublicHubWorkspace> {
    const client = this.registry.require(deviceIdInput);
    const rootId = safeRemoteId(rootIdInput, "root id");
    const result = await client.callTool("agent_open_workspace", {
      root_id: rootId,
      relative_dir: String(relativeDirInput ?? ".")
    });
    const structured = requireRemoteSuccess(result, "open_workspace");
    const remote = parseRemoteWorkspace(structured.workspace);
    if (remote.rootId !== rootId) throw new Error("Target agent returned a workspace for a different root.");
    const id = stableToken("hws", this.nonce, client.device.id, remote.id);
    const displayPath = remote.relativeDir === "."
      ? `${client.device.label}:${remote.rootId}`
      : `${client.device.label}:${remote.rootId}/${remote.relativeDir}`;
    const descriptor = this.rememberWorkspace({
      id,
      deviceId: client.device.id,
      deviceLabel: client.device.label,
      rootId: remote.rootId,
      relativeDir: remote.relativeDir,
      displayPath,
      openedAt: new Date().toISOString(),
      remoteWorkspaceId: remote.id
    });
    this.selectedWorkspaceId = id;
    return publicWorkspace(descriptor);
  }

  readScope(args: Record<string, unknown>): ForwardScope {
    const workspaceId = typeof args.workspace_id === "string" ? args.workspace_id.trim() : "";
    const deviceId = typeof args.device_id === "string" ? args.device_id.trim() : "";
    const rootId = typeof args.root_id === "string" ? args.root_id.trim() : "";
    if (workspaceId) {
      if (deviceId || rootId) throw new Error("Do not combine workspace_id with device_id or root_id.");
      const workspace = this.requireWorkspace(workspaceId);
      return {
        client: this.registry.require(workspace.deviceId),
        remoteArgs: { workspace_id: workspace.remoteWorkspaceId },
        tags: { device_id: workspace.deviceId, workspace_id: workspace.id, root_id: workspace.rootId, scope: "workspace" }
      };
    }
    if (!deviceId || !rootId) {
      throw new Error("Provide workspace_id, or provide both device_id and root_id for read-only root access.");
    }
    const client = this.registry.require(deviceId);
    return {
      client,
      remoteArgs: { root_id: safeRemoteId(rootId, "root id") },
      tags: { device_id: client.device.id, workspace_id: null, root_id: safeRemoteId(rootId, "root id"), scope: "root" }
    };
  }

  writeScope(workspaceIdInput: unknown): ForwardScope {
    const workspace = this.requireWorkspace(workspaceIdInput);
    return {
      client: this.registry.require(workspace.deviceId),
      remoteArgs: { workspace_id: workspace.remoteWorkspaceId },
      tags: { device_id: workspace.deviceId, workspace_id: workspace.id, root_id: workspace.rootId, scope: "workspace" }
    };
  }

  async forward(scope: ForwardScope, toolName: string, args: Record<string, unknown>): Promise<any> {
    const result = await scope.client.callTool(toolName, { ...args, ...scope.remoteArgs });
    const structured = { ...resultStructured(result) };
    delete structured.device_id;
    delete structured.workspace_id;
    delete structured.root_id;
    delete structured.scope;
    return {
      ...result,
      structuredContent: { ...structured, ...scope.tags }
    };
  }
}
