import type { AgentWorkspaceDescriptor, HubWorkspaceDescriptor } from "./types.js";
import { resultStructured, resultText, sessionNonce, stableToken } from "./types.js";
import { DeviceRegistry, type DeviceClient } from "./deviceClient.js";

export type PublicHubWorkspace = Omit<HubWorkspaceDescriptor, "remoteWorkspaceId">;

interface ForwardScope {
  client: DeviceClient;
  remoteArgs: Record<string, unknown>;
  tags: Record<string, unknown>;
}

function publicWorkspace(workspace: HubWorkspaceDescriptor): PublicHubWorkspace {
  const { remoteWorkspaceId: _remoteWorkspaceId, ...visible } = workspace;
  return visible;
}

function requireRemoteSuccess(result: any, operation: string): Record<string, unknown> {
  if (result?.isError) throw new Error(`${operation} failed: ${resultText(result) || "target agent returned an error"}`);
  return resultStructured(result);
}

function parseRemoteWorkspace(value: unknown): AgentWorkspaceDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Target agent returned an invalid workspace descriptor.");
  const candidate = value as Record<string, unknown>;
  const id = String(candidate.id ?? "").trim();
  const rootId = String(candidate.rootId ?? "").trim();
  const relativeDir = String(candidate.relativeDir ?? "").trim();
  const displayPath = String(candidate.displayPath ?? "").trim();
  const openedAt = String(candidate.openedAt ?? "").trim();
  if (!id || !rootId || !relativeDir || !displayPath || !openedAt) {
    throw new Error("Target agent returned an incomplete workspace descriptor.");
  }
  return { id, rootId, relativeDir, displayPath, openedAt };
}

export class HubSession {
  private readonly nonce = sessionNonce();
  private readonly workspaces = new Map<string, HubWorkspaceDescriptor>();
  private selectedWorkspaceId?: string;

  constructor(readonly registry: DeviceRegistry) {}

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
    return workspace;
  }

  async listRoots(deviceIdInput: unknown): Promise<{ client: DeviceClient; result: any }> {
    const client = this.registry.require(deviceIdInput);
    const result = await client.callTool("agent_list_roots", {});
    requireRemoteSuccess(result, "list_device_roots");
    return { client, result };
  }

  async openWorkspace(deviceIdInput: unknown, rootIdInput: unknown, relativeDirInput: unknown): Promise<PublicHubWorkspace> {
    const client = this.registry.require(deviceIdInput);
    const rootId = String(rootIdInput ?? "").trim();
    const result = await client.callTool("agent_open_workspace", {
      root_id: rootId,
      relative_dir: String(relativeDirInput ?? ".")
    });
    const structured = requireRemoteSuccess(result, "open_workspace");
    const remote = parseRemoteWorkspace(structured.workspace);
    if (remote.rootId !== rootId) throw new Error("Target agent returned a workspace for a different root.");
    const id = stableToken("hws", this.nonce, client.device.id, remote.id);
    const descriptor: HubWorkspaceDescriptor = {
      id,
      deviceId: client.device.id,
      deviceLabel: client.device.label,
      rootId: remote.rootId,
      relativeDir: remote.relativeDir,
      displayPath: `${client.device.label}:${remote.displayPath}`,
      openedAt: remote.openedAt,
      remoteWorkspaceId: remote.id
    };
    this.workspaces.set(id, descriptor);
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
      remoteArgs: { root_id: rootId },
      tags: { device_id: client.device.id, workspace_id: null, root_id: rootId, scope: "root" }
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
    const result = await scope.client.callTool(toolName, { ...scope.remoteArgs, ...args });
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
