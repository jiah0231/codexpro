import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { agentGitEnvironment, agentGitGlobalArgs } from "../dist/multidevice/agentGitOps.js";
import { loadAgentPolicy, loadHubConfig } from "../dist/multidevice/policy.js";

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "codexpro-multidevice-"));
const projects = path.join(temp, "projects");
const projectA = path.join(projects, "project-a");
const projectB = path.join(projects, "project-b");
const reference = path.join(temp, "reference");
const policyPath = path.join(temp, "agent.json");
let client;
let transport;

async function tool(activeClient, name, args = {}) {
  return activeClient.callTool({ name, arguments: args });
}

function agentPolicy(deviceId = "smoke-device") {
  return {
    schemaVersion: 1,
    deviceId,
    label: "Smoke Device",
    roots: [
      { id: "projects", label: "Projects", path: projects, mode: "workspace-parent" },
      { id: "reference", label: "Reference", path: reference, mode: "read-only" }
    ]
  };
}

try {
  await Promise.all([
    fsp.mkdir(projectA, { recursive: true }),
    fsp.mkdir(projectB, { recursive: true }),
    fsp.mkdir(reference, { recursive: true })
  ]);
  await Promise.all([
    fsp.writeFile(path.join(projectA, "main.txt"), "alpha\n", "utf8"),
    fsp.writeFile(path.join(projectA, ".env"), "TOKEN=should-not-be-readable\n", "utf8"),
    fsp.writeFile(path.join(projectB, "other.txt"), "other project\n", "utf8"),
    fsp.writeFile(path.join(reference, "guide.txt"), "read only guide\n", "utf8")
  ]);
  await fsp.writeFile(path.join(projectA, ".ENV"), "UPPERCASE=also-blocked\n", "utf8");
  await fsp.writeFile(policyPath, JSON.stringify(agentPolicy(), null, 2), "utf8");

  const loadedPolicy = loadAgentPolicy(policyPath);
  assert.equal(loadedPolicy.deviceId, "smoke-device");

  const validHubPath = path.join(temp, "hub.json");
  await fsp.writeFile(validHubPath, JSON.stringify({
    schemaVersion: 1,
    host: "127.0.0.1",
    port: 8799,
    devices: [
      { id: "smoke-device", label: "Smoke Device", transport: "local", policyPath }
    ]
  }, null, 2), "utf8");
  const loadedHub = loadHubConfig(validHubPath);
  assert.equal(loadedHub.devices.length, 1);
  assert.equal(loadedHub.agentConnectTimeoutMs, 20_000);
  assert.equal(loadedHub.agentCallTimeoutMs, 60_000);

  const invalidTimeoutHubPath = path.join(temp, "hub-invalid-timeout.json");
  await fsp.writeFile(invalidTimeoutHubPath, JSON.stringify({
    schemaVersion: 1,
    agentConnectTimeoutMs: 60_000,
    agentCallTimeoutMs: 5_000,
    devices: [
      { id: "smoke-device", label: "Smoke Device", transport: "local", policyPath }
    ]
  }, null, 2), "utf8");
  assert.throws(() => loadHubConfig(invalidTimeoutHubPath), /greater than or equal/);

  const policyInsideWritableRoot = path.join(projectA, "agent-policy.json");
  await fsp.writeFile(policyInsideWritableRoot, JSON.stringify(agentPolicy(), null, 2), "utf8");
  assert.throws(() => loadAgentPolicy(policyInsideWritableRoot), /outside every approved root/);

  const overlappingPolicyPath = path.join(temp, "agent-overlapping-roots.json");
  await fsp.writeFile(overlappingPolicyPath, JSON.stringify({
    schemaVersion: 1,
    deviceId: "overlapping-device",
    roots: [
      { id: "parent", path: projects, mode: "workspace-parent" },
      { id: "nested", path: projectA, mode: "read-only" }
    ]
  }, null, 2), "utf8");
  assert.throws(() => loadAgentPolicy(overlappingPolicyPath), /must not overlap/);

  const negatedGlobPolicyPath = path.join(temp, "agent-negated-glob.json");
  await fsp.writeFile(negatedGlobPolicyPath, JSON.stringify({
    ...agentPolicy("negated-glob-device"),
    blockedGlobs: ["!**/.env"]
  }, null, 2), "utf8");
  assert.throws(() => loadAgentPolicy(negatedGlobPolicyPath), /must not be a negated glob/);

  const hubInsideWritableRoot = path.join(projectA, "hub.json");
  await fsp.writeFile(hubInsideWritableRoot, JSON.stringify({
    schemaVersion: 1,
    devices: [
      { id: "smoke-device", label: "Smoke Device", transport: "local", policyPath }
    ]
  }, null, 2), "utf8");
  assert.throws(() => loadHubConfig(hubInsideWritableRoot), /outside every approved local root/);

  const mismatchedHubPath = path.join(temp, "hub-mismatched.json");
  await fsp.writeFile(mismatchedHubPath, JSON.stringify({
    schemaVersion: 1,
    devices: [
      { id: "different-device", label: "Different", transport: "local", policyPath }
    ]
  }, null, 2), "utf8");
  assert.throws(() => loadHubConfig(mismatchedHubPath), /identity mismatch/);

  const originalGitDir = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(temp, "must-not-be-inherited");
  const safeGitEnv = agentGitEnvironment(projectA);
  if (originalGitDir === undefined) delete process.env.GIT_DIR;
  else process.env.GIT_DIR = originalGitDir;
  assert.equal(safeGitEnv.GIT_DIR, undefined);
  assert.equal(safeGitEnv.GIT_TERMINAL_PROMPT, "0");
  assert.equal(safeGitEnv.GIT_OPTIONAL_LOCKS, "0");
  const safeGitArgs = agentGitGlobalArgs().join("\0");
  assert.match(safeGitArgs, /core\.fsmonitor=false/);
  assert.match(safeGitArgs, /core\.hooksPath=/);
  assert.match(safeGitArgs, /credential\.helper=/);

  const gitAvailable = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true }).status === 0;
  if (gitAvailable) {
    const parentInit = spawnSync("git", ["init", "-q"], {
      cwd: projects,
      encoding: "utf8",
      windowsHide: true
    });
    assert.equal(parentInit.status, 0, parentInit.stderr);
  }

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/agent.js"), "--policy", policyPath],
    stderr: "pipe"
  });
  client = new Client({ name: "codexpro-multidevice-smoke", version: "1.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  const names = new Set(tools.tools.map((entry) => entry.name));
  assert(names.has("agent_open_workspace"));
  assert(names.has("agent_write"));
  assert(![...names].some((name) => name.includes("bash") || name.includes("shell")));

  const description = await tool(client, "agent_describe");
  assert.equal(description.isError, undefined);
  assert.equal(description.structuredContent.device_id, "smoke-device");
  const descriptionJson = JSON.stringify(description);
  assert(!descriptionJson.includes(projects));
  assert(!descriptionJson.includes(reference));

  const readonlyOpen = await tool(client, "agent_open_workspace", { root_id: "reference", relative_dir: "." });
  assert.equal(readonlyOpen.isError, true);

  for (const invalidRelativeDir of ["C:", "C:project-a", "C:\\project-a", "\\\\server\\share"]) {
    const invalidOpen = await tool(client, "agent_open_workspace", {
      root_id: "projects",
      relative_dir: invalidRelativeDir
    });
    assert.equal(invalidOpen.isError, true, `Expected relative_dir to be rejected: ${invalidRelativeDir}`);
    assert(!JSON.stringify(invalidOpen).includes(projects));
  }

  const opened = await tool(client, "agent_open_workspace", { root_id: "projects", relative_dir: "project-a" });
  assert.equal(opened.isError, undefined);
  const workspaceId = opened.structuredContent.workspace_id;
  assert.equal(typeof workspaceId, "string");

  const workspaceRead = await tool(client, "agent_read", { workspace_id: workspaceId, path: "main.txt" });
  assert.equal(workspaceRead.isError, undefined);
  assert.match(workspaceRead.content[0].text, /alpha/);

  const driveRelativeRead = await tool(client, "agent_read", {
    workspace_id: workspaceId,
    path: "C:main.txt"
  });
  assert.equal(driveRelativeRead.isError, true);

  const rootRead = await tool(client, "agent_read", { root_id: "reference", path: "guide.txt" });
  assert.equal(rootRead.isError, undefined);
  assert.match(rootRead.content[0].text, /read only guide/);

  const rootTree = await tool(client, "agent_tree", { root_id: "projects", max_depth: 3 });
  assert.equal(rootTree.isError, undefined);
  assert.match(rootTree.content[0].text, /project-b/);

  const rootSearch = await tool(client, "agent_search", { root_id: "reference", query: "read only" });
  assert.equal(rootSearch.isError, undefined);
  assert.equal(rootSearch.structuredContent.matches.length, 1);

  const blockedRead = await tool(client, "agent_read", { workspace_id: workspaceId, path: ".env" });
  assert.equal(blockedRead.isError, true);
  const uppercaseBlockedRead = await tool(client, "agent_read", { workspace_id: workspaceId, path: ".ENV" });
  assert.equal(uppercaseBlockedRead.isError, true);

  const writeResult = await tool(client, "agent_write", {
    workspace_id: workspaceId,
    path: "new.txt",
    content: "inside workspace\n"
  });
  assert.equal(writeResult.isError, undefined);
  assert.equal(await fsp.readFile(path.join(projectA, "new.txt"), "utf8"), "inside workspace\n");

  const editResult = await tool(client, "agent_edit", {
    workspace_id: workspaceId,
    path: "main.txt",
    old_text: "alpha",
    new_text: "beta"
  });
  assert.equal(editResult.isError, undefined);
  assert.equal(await fsp.readFile(path.join(projectA, "main.txt"), "utf8"), "beta\n");

  const driveRelativeWrite = await tool(client, "agent_write", {
    workspace_id: workspaceId,
    path: "C:escape.txt",
    content: "must not be written\n"
  });
  assert.equal(driveRelativeWrite.isError, true);

  const outsideHardLinkSource = path.join(temp, "outside-hard-link.txt");
  const insideHardLink = path.join(projectA, "inside-hard-link.txt");
  await fsp.writeFile(outsideHardLinkSource, "outside must remain unchanged\n", "utf8");
  try {
    await fsp.link(outsideHardLinkSource, insideHardLink);
    const hardLinkWrite = await tool(client, "agent_write", {
      workspace_id: workspaceId,
      path: "inside-hard-link.txt",
      content: "must not replace shared inode\n"
    });
    assert.equal(hardLinkWrite.isError, true);
    assert.equal(await fsp.readFile(outsideHardLinkSource, "utf8"), "outside must remain unchanged\n");
  } catch (error) {
    if (!error || !["EPERM", "EACCES", "ENOTSUP", "EXDEV"].includes(error.code)) throw error;
  }

  const escapeWrite = await tool(client, "agent_write", {
    workspace_id: workspaceId,
    path: "../project-b/escape.txt",
    content: "must not be written\n"
  });
  assert.equal(escapeWrite.isError, true);
  await assert.rejects(fsp.stat(path.join(projectB, "escape.txt")));

  const absoluteWrite = await tool(client, "agent_write", {
    workspace_id: workspaceId,
    path: path.join(projectB, "absolute-escape.txt"),
    content: "must not be written\n"
  });
  assert.equal(absoluteWrite.isError, true);
  await assert.rejects(fsp.stat(path.join(projectB, "absolute-escape.txt")));

  const symlinkPath = path.join(projectA, "outside-link");
  try {
    await fsp.symlink(reference, symlinkPath, process.platform === "win32" ? "junction" : "dir");
    const symlinkRead = await tool(client, "agent_read", {
      workspace_id: workspaceId,
      path: "outside-link/guide.txt"
    });
    assert.equal(symlinkRead.isError, true);
  } catch (error) {
    if (!error || !["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
  }

  if (gitAvailable) {
    const parentRepositoryStatus = await tool(client, "agent_git_status", { workspace_id: workspaceId });
    assert.equal(parentRepositoryStatus.isError, true, "Agent must not use a Git repository above the workspace.");

    const nestedInit = spawnSync("git", ["init", "-q"], {
      cwd: projectA,
      encoding: "utf8",
      windowsHide: true
    });
    assert.equal(nestedInit.status, 0, nestedInit.stderr);
    const workspaceRepositoryStatus = await tool(client, "agent_git_status", { workspace_id: workspaceId });
    assert.equal(workspaceRepositoryStatus.isError, undefined);
    assert.match(workspaceRepositoryStatus.content[0].text, /##/);
  }

  const escapeOpen = await tool(client, "agent_open_workspace", {
    root_id: "projects",
    relative_dir: "../reference"
  });
  assert.equal(escapeOpen.isError, true);

  const fakeWorkspace = await tool(client, "agent_write", {
    workspace_id: "aws_not_valid",
    path: "bad.txt",
    content: "nope\n"
  });
  assert.equal(fakeWorkspace.isError, true);

  console.log("multidevice smoke: ok");
} finally {
  try {
    await client?.close();
  } catch {}
  try {
    await transport?.close();
  } catch {}
  await fsp.rm(temp, { recursive: true, force: true });
}
