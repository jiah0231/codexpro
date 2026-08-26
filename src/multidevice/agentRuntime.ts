import fs from "node:fs";
import path from "node:path";
import type { CodexProConfig } from "../config.js";
import { CodexProError, isSubpath, normalizeRelPath, PathGuard, type Workspace } from "../guard.js";
import type { AgentPolicy, AgentRootPolicy, AgentWorkspaceDescriptor, RootDescriptor } from "./types.js";
import { stableToken } from "./types.js";

export interface StoredAgentWorkspace {
  descriptor: AgentWorkspaceDescriptor;
  workspace: Workspace;
  root: AgentRootPolicy;
}

export interface AgentReadScope {
  workspace: Workspace;
  rootId: string;
  workspaceId?: string;
  scope: "workspace" | "root";
}

function portableRelativeDirectory(value: unknown): string {
  const raw = String(value ?? ".").trim().replaceAll("\\", "/");
  if (!raw || raw === ".") return ".";
  if (raw.length > 4096 || /[\0\r\n]/.test(raw)) throw new CodexProError("relative_dir is invalid.");
  if (path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw)) {
    throw new CodexProError("relative_dir must be relative to the approved root.");
  }
  if (raw.split("/").some((segment) => segment === "..")) {
    throw new CodexProError("relative_dir must not contain parent traversal segments.");
  }
  const normalized = path.posix.normalize(raw);
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new CodexProError("relative_dir escapes the approved root.");
  }
  return normalized;
}

export class AgentRuntime {
  readonly guard: PathGuard;
  private readonly rootsById = new Map<string, AgentRootPolicy>();
  private readonly workspaces = new Map<string, StoredAgentWorkspace>();

  constructor(readonly policy: AgentPolicy, readonly config: CodexProConfig) {
    this.guard = new PathGuard(config);
    for (const root of policy.roots) this.rootsById.set(root.id, root);
  }

  roots(): RootDescriptor[] {
    return this.policy.roots.map(({ id, label, mode }) => ({ id, label, mode }));
  }

  publicError(error: unknown): Error {
    let message = error instanceof Error ? error.message : String(error);
    for (const root of this.policy.roots) message = message.split(root.path).join(`$ROOT[${root.id}]`);
    const publicError = new Error(message);
    publicError.name = error instanceof Error ? error.name : "Error";
    return publicError;
  }

  requireRoot(rootIdInput: unknown): AgentRootPolicy {
    const rootId = String(rootIdInput ?? "").trim();
    const root = this.rootsById.get(rootId);
    if (!root) throw new CodexProError(`Unknown root_id: ${rootId || "(empty)"}. Call agent_list_roots first.`);
    return root;
  }

  openWorkspace(rootIdInput: unknown, relativeDirInput: unknown): StoredAgentWorkspace {
    const root = this.requireRoot(rootIdInput);
    if (root.mode !== "workspace-parent") {
      throw new CodexProError(`Root ${root.id} is read-only and cannot contain a writable workspace.`);
    }
    const requestedRelative = portableRelativeDirectory(relativeDirInput);
    const parts = requestedRelative.split("/").filter((part) => part && part !== ".");
    const candidate = path.resolve(root.path, ...parts);
    if (!fs.existsSync(candidate)) throw new CodexProError(`Workspace directory does not exist under root ${root.id}: ${requestedRelative}`);
    if (!fs.statSync(candidate).isDirectory()) throw new CodexProError(`Workspace path is not a directory under root ${root.id}: ${requestedRelative}`);
    const realRoot = fs.realpathSync.native(candidate);
    if (!isSubpath(realRoot, root.path)) throw new CodexProError(`Workspace path resolves outside approved root ${root.id}.`);

    const relativeDir = normalizeRelPath(path.relative(root.path, realRoot) || ".");
    const id = stableToken("aws", this.policy.deviceId, root.id, realRoot);
    const existing = this.workspaces.get(id);
    if (existing) return existing;
    const openedAt = new Date().toISOString();
    const descriptor: AgentWorkspaceDescriptor = {
      id,
      rootId: root.id,
      relativeDir,
      displayPath: relativeDir === "." ? root.label : `${root.label}/${relativeDir}`,
      openedAt
    };
    const stored: StoredAgentWorkspace = { descriptor, root, workspace: { id, root: realRoot, openedAt } };
    this.workspaces.set(id, stored);
    return stored;
  }

  listWorkspaces(): AgentWorkspaceDescriptor[] {
    return [...this.workspaces.values()].map((item) => item.descriptor);
  }

  requireWorkspace(workspaceIdInput: unknown): StoredAgentWorkspace {
    const workspaceId = String(workspaceIdInput ?? "").trim();
    const stored = this.workspaces.get(workspaceId);
    if (!stored) throw new CodexProError(`Unknown workspace_id: ${workspaceId || "(empty)"}. Call agent_open_workspace first.`);
    return stored;
  }

  readScope(args: Record<string, unknown>): AgentReadScope {
    const workspaceId = typeof args.workspace_id === "string" ? args.workspace_id.trim() : "";
    const rootId = typeof args.root_id === "string" ? args.root_id.trim() : "";
    if (Boolean(workspaceId) === Boolean(rootId)) {
      throw new CodexProError("Provide exactly one of workspace_id or root_id for a read operation.");
    }
    if (workspaceId) {
      const stored = this.requireWorkspace(workspaceId);
      return { workspace: stored.workspace, rootId: stored.root.id, workspaceId, scope: "workspace" };
    }
    const root = this.requireRoot(rootId);
    return {
      workspace: { id: stableToken("root", this.policy.deviceId, root.id, root.path), root: root.path, openedAt: "policy" },
      rootId: root.id,
      scope: "root"
    };
  }
}
