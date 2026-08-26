import fs from "node:fs";
import path from "node:path";
import type { CodexProConfig } from "../config.js";
import { CodexProError, isSubpath, normalizeRelPath, PathGuard, type Workspace } from "../guard.js";
import type { AgentPolicy, AgentRootPolicy, AgentWorkspaceDescriptor, RootDescriptor } from "./types.js";
import { stableToken } from "./types.js";

const MAX_AGENT_WORKSPACES = 256;
const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/;

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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replacePathVariant(message: string, variant: string, replacement: string): string {
  if (!variant) return message;
  if (process.platform === "win32") {
    return message.replace(new RegExp(escapeRegExp(variant), "gi"), replacement);
  }
  return message.split(variant).join(replacement);
}

function portableRelativePath(value: unknown, field: string, fallback = "."): string {
  const raw = String(value ?? fallback).trim().replaceAll("\\", "/");
  if (!raw) {
    if (fallback) return fallback;
    throw new CodexProError(`${field} is required.`);
  }
  if (raw.length > 4096 || /[\0\r\n]/.test(raw)) {
    throw new CodexProError(`${field} is invalid.`);
  }
  if (path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw) || WINDOWS_DRIVE_PREFIX.test(raw)) {
    throw new CodexProError(`${field} must be relative to the selected workspace or approved root.`);
  }
  if (raw.split("/").some((segment) => segment === "..")) {
    throw new CodexProError(`${field} must not contain parent traversal segments.`);
  }
  const normalized = path.posix.normalize(raw);
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new CodexProError(`${field} escapes the selected workspace or approved root.`);
  }
  if (process.platform === "win32" && normalized.includes(":")) {
    throw new CodexProError(`${field} must not contain a Windows alternate data stream.`);
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

  relativePath(value: unknown, field = "path", fallback = "."): string {
    return portableRelativePath(value, field, fallback);
  }

  publicError(error: unknown): Error {
    let message = error instanceof Error ? error.message : String(error);
    for (const root of this.policy.roots) {
      const replacement = `$ROOT[${root.id}]`;
      const variants = [...new Set([
        root.path,
        root.path.replaceAll("\\", "/"),
        root.path.replaceAll("/", "\\")
      ])].sort((left, right) => right.length - left.length);
      for (const variant of variants) message = replacePathVariant(message, variant, replacement);
    }
    message = message
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "?")
      .slice(0, 4000);
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

  private rememberWorkspace(id: string, stored: StoredAgentWorkspace): StoredAgentWorkspace {
    this.workspaces.delete(id);
    while (this.workspaces.size >= MAX_AGENT_WORKSPACES) {
      const oldestId = this.workspaces.keys().next().value as string | undefined;
      if (!oldestId) break;
      this.workspaces.delete(oldestId);
    }
    this.workspaces.set(id, stored);
    return stored;
  }

  openWorkspace(rootIdInput: unknown, relativeDirInput: unknown): StoredAgentWorkspace {
    const root = this.requireRoot(rootIdInput);
    if (root.mode !== "workspace-parent") {
      throw new CodexProError(`Root ${root.id} is read-only and cannot contain a writable workspace.`);
    }
    const requestedRelative = this.relativePath(relativeDirInput, "relative_dir", ".");
    const parts = requestedRelative.split("/").filter((part) => part && part !== ".");
    const candidate = path.resolve(root.path, ...parts);
    if (!fs.existsSync(candidate)) throw new CodexProError(`Workspace directory does not exist under root ${root.id}: ${requestedRelative}`);
    if (!fs.statSync(candidate).isDirectory()) throw new CodexProError(`Workspace path is not a directory under root ${root.id}: ${requestedRelative}`);
    const realRoot = fs.realpathSync.native(candidate);
    if (!isSubpath(realRoot, root.path)) throw new CodexProError(`Workspace path resolves outside approved root ${root.id}.`);

    const relativeDir = normalizeRelPath(path.relative(root.path, realRoot) || ".");
    const id = stableToken("aws", this.policy.deviceId, root.id, realRoot);
    const existing = this.workspaces.get(id);
    if (existing) return this.rememberWorkspace(id, existing);
    const openedAt = new Date().toISOString();
    const descriptor: AgentWorkspaceDescriptor = {
      id,
      rootId: root.id,
      relativeDir,
      displayPath: relativeDir === "." ? root.label : `${root.label}/${relativeDir}`,
      openedAt
    };
    return this.rememberWorkspace(id, {
      descriptor,
      root,
      workspace: { id, root: realRoot, openedAt }
    });
  }

  listWorkspaces(): AgentWorkspaceDescriptor[] {
    return [...this.workspaces.values()].map((item) => item.descriptor);
  }

  requireWorkspace(workspaceIdInput: unknown): StoredAgentWorkspace {
    const workspaceId = String(workspaceIdInput ?? "").trim();
    const stored = this.workspaces.get(workspaceId);
    if (!stored) throw new CodexProError(`Unknown workspace_id: ${workspaceId || "(empty)"}. Call agent_open_workspace first.`);
    this.rememberWorkspace(workspaceId, stored);
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
