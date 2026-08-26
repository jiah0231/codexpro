import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { CodexProConfig } from "../config.js";
import type { Workspace } from "../guard.js";
import { CodexProError, isSubpath, PathGuard } from "../guard.js";
import { redactSensitiveText } from "../redact.js";

const AGENT_GIT_TIMEOUT_MS = 30_000;

export function agentGitGlobalArgs(): string[] {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  return [
    "--no-pager",
    "--literal-pathspecs",
    "-c", "core.fsmonitor=false",
    "-c", `core.hooksPath=${nullDevice}`,
    "-c", "maintenance.auto=false",
    "-c", "gc.auto=0",
    "-c", "credential.helper=",
    "-c", "core.askPass="
  ];
}

export function agentGitEnvironment(workspaceRoot: string): NodeJS.ProcessEnv {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    if (upper.startsWith("GIT_") || upper === "SSH_ASKPASS" || upper === "DISPLAY") continue;
    env[key] = value;
  }
  env.NO_COLOR = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_PAGER = "cat";
  env.GIT_CONFIG_SYSTEM = nullDevice;
  env.GIT_CONFIG_GLOBAL = nullDevice;
  env.GIT_ATTR_NOSYSTEM = "1";
  env.GIT_CEILING_DIRECTORIES = workspaceRoot;
  return env;
}

interface GitInvocationResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

function invokeGit(config: CodexProConfig, workspace: Workspace, args: string[]): GitInvocationResult {
  const result = spawnSync("git", [...agentGitGlobalArgs(), ...args], {
    cwd: workspace.root,
    encoding: "utf8",
    maxBuffer: config.maxOutputBytes,
    timeout: AGENT_GIT_TIMEOUT_MS,
    windowsHide: true,
    env: agentGitEnvironment(workspace.root)
  });
  return {
    status: result.status,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    ...(result.error ? { error: result.error } : {})
  };
}

function successfulOutput(result: GitInvocationResult, operation: string): string {
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      throw new CodexProError(`${operation} timed out after ${AGENT_GIT_TIMEOUT_MS} ms.`);
    }
    throw new CodexProError(`${operation} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new CodexProError(result.stderr || result.stdout || `${operation} exited with status ${result.status}.`);
  }
  return redactSensitiveText(result.stdout || "(no output)");
}

function requireRepositoryRoot(config: CodexProConfig, workspace: Workspace): void {
  const result = invokeGit(config, workspace, ["rev-parse", "--show-toplevel"]);
  const topLevelOutput = successfulOutput(result, "git rev-parse");
  const topLevel = fs.realpathSync.native(path.resolve(workspace.root, topLevelOutput));
  if (!isSubpath(topLevel, workspace.root)) {
    throw new CodexProError("Git repository root is outside the opened workspace.");
  }
}

function pathspec(guard: PathGuard, workspace: Workspace, filePath?: string): string[] {
  if (!filePath?.trim()) return [];
  return ["--", guard.resolve(workspace, filePath).relPath];
}

export function agentGitStatus(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  filePath?: string,
  staged = false
): string {
  requireRepositoryRoot(config, workspace);
  const command = staged
    ? ["diff", "--cached", "--name-status"]
    : ["status", "--short", "--branch"];
  const result = invokeGit(config, workspace, [...command, ...pathspec(guard, workspace, filePath)]);
  return successfulOutput(result, "git status");
}

export function agentGitDiff(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  filePath?: string,
  staged = false
): string {
  requireRepositoryRoot(config, workspace);
  const command = ["diff", "--no-color", "--no-ext-diff", "--no-textconv"];
  if (staged) command.push("--staged");
  const result = invokeGit(config, workspace, [...command, ...pathspec(guard, workspace, filePath)]);
  return successfulOutput(result, "git diff");
}
