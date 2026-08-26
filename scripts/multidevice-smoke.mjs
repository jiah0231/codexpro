import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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
  await fsp.writeFile(policyPath, JSON.stringify({
    schemaVersion: 1,
    deviceId: "smoke-device",
    label: "Smoke Device",
    roots: [
      { id: "projects", label: "Projects", path: projects, mode: "workspace-parent" },
      { id: "reference", label: "Reference", path: reference, mode: "read-only" }
    ]
  }, null, 2), "utf8");

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

  const opened = await tool(client, "agent_open_workspace", { root_id: "projects", relative_dir: "project-a" });
  assert.equal(opened.isError, undefined);
  const workspaceId = opened.structuredContent.workspace_id;
  assert.equal(typeof workspaceId, "string");

  const workspaceRead = await tool(client, "agent_read", { workspace_id: workspaceId, path: "main.txt" });
  assert.equal(workspaceRead.isError, undefined);
  assert.match(workspaceRead.content[0].text, /alpha/);

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
