import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "codexpro-hub-smoke-"));
const projects = path.join(temp, "projects");
const projectA = path.join(projects, "project-a");
const projectB = path.join(projects, "project-b");
const reference = path.join(temp, "reference");
const policyPath = path.join(temp, "agent.json");
const hubConfigPath = path.join(temp, "hub.json");
const token = "codexpro-multidevice-smoke-token-1234567890";
let hubChild;
let clientA;
let clientB;

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close(() => port ? resolve(port) : reject(new Error("No free port available.")));
    });
    server.on("error", reject);
  });
}

function waitForListening(child, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for Hub.\n${stderr}`)), timeoutMs);
    timer.unref();
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.includes("CodexPro Multi-Device Hub listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Hub exited before listening: ${code}\n${stderr}`));
    });
  });
}

function waitForExit(child, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Timeout waiting for process exit.\n${stderr}`));
    }, timeoutMs);
    timer.unref();
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr });
    });
  });
}

async function expectStartupFailure(envOverrides, expectedPattern) {
  const env = { ...process.env, ...envOverrides };
  if (!("CODEXPRO_HTTP_TOKEN" in envOverrides)) delete env.CODEXPRO_HTTP_TOKEN;
  const child = spawn(process.execPath, [path.resolve("dist/hub.js"), "--config", hubConfigPath], {
    cwd: path.resolve("."),
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const result = await waitForExit(child);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, expectedPattern);
}

async function connectClient(baseUrl) {
  const client = new Client({ name: "codexpro-hub-smoke", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  });
  await client.connect(transport);
  return client;
}

function tool(client, name, args = {}) {
  return client.callTool({ name, arguments: args });
}

function comparable(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function serializedPathVariants(secretPath) {
  const slashPath = secretPath.replaceAll("\\", "/");
  return new Set([
    secretPath,
    slashPath,
    JSON.stringify(secretPath).slice(1, -1),
    JSON.stringify(slashPath).slice(1, -1)
  ]);
}

function assertNoControlPlanePaths(value) {
  const serialized = comparable(JSON.stringify(value));
  for (const secretPath of [projects, reference, policyPath, hubConfigPath]) {
    for (const variant of serializedPathVariants(secretPath)) {
      assert(
        !serialized.includes(comparable(variant)),
        `MCP result leaked control-plane or absolute path: ${secretPath}`
      );
    }
  }
}

async function stopHub() {
  if (!hubChild || hubChild.exitCode !== null) return;
  const exited = waitForExit(hubChild);
  hubChild.kill("SIGTERM");
  await exited;
}

try {
  await Promise.all([
    fsp.mkdir(projectA, { recursive: true }),
    fsp.mkdir(projectB, { recursive: true }),
    fsp.mkdir(reference, { recursive: true })
  ]);
  await Promise.all([
    fsp.writeFile(path.join(projectA, "main.txt"), "hub alpha\n", "utf8"),
    fsp.writeFile(path.join(projectB, "other.txt"), "other project\n", "utf8"),
    fsp.writeFile(path.join(reference, "guide.txt"), "reference guide\n", "utf8")
  ]);
  await fsp.writeFile(policyPath, JSON.stringify({
    schemaVersion: 1,
    deviceId: "windows-main",
    label: "Windows Main",
    roots: [
      { id: "projects", label: "Projects", path: projects, mode: "workspace-parent" },
      { id: "reference", label: "Reference", path: reference, mode: "read-only" }
    ]
  }, null, 2), "utf8");

  const port = await getFreePort();
  await fsp.writeFile(hubConfigPath, JSON.stringify({
    schemaVersion: 1,
    host: "127.0.0.1",
    port,
    maxSessions: 8,
    sessionTtlMs: 300000,
    devices: [
      { id: "windows-main", label: "Windows Main", transport: "local", policyPath }
    ]
  }, null, 2), "utf8");

  await expectStartupFailure({}, /CODEXPRO_HTTP_TOKEN is required/);
  await expectStartupFailure({ CODEXPRO_HTTP_TOKEN: "short-token" }, /at least 24/);

  hubChild = spawn(process.execPath, [path.resolve("dist/hub.js"), "--config", hubConfigPath], {
    cwd: path.resolve("."),
    env: { ...process.env, CODEXPRO_HTTP_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitForListening(hubChild);

  const baseUrl = `http://127.0.0.1:${port}`;
  const unauthorized = await fetch(`${baseUrl}/healthz`);
  assert.equal(unauthorized.status, 401);
  const wrongToken = await fetch(`${baseUrl}/healthz`, {
    headers: { Authorization: "Bearer definitely-wrong-token-1234567890" }
  });
  assert.equal(wrongToken.status, 401);
  const authorized = await fetch(`${baseUrl}/healthz`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(authorized.status, 200);
  assertNoControlPlanePaths(await authorized.json());
  const queryAuthorized = await fetch(`${baseUrl}/healthz?codexpro_token=${encodeURIComponent(token)}`);
  assert.equal(queryAuthorized.status, 200);

  clientA = await connectClient(baseUrl);
  const listedTools = await clientA.listTools();
  const names = new Set(listedTools.tools.map((entry) => entry.name));
  for (const required of [
    "list_devices",
    "list_device_roots",
    "open_workspace",
    "list_workspaces",
    "tree",
    "search",
    "read",
    "write",
    "edit",
    "git_status",
    "git_diff"
  ]) {
    assert(names.has(required), `Missing Hub tool: ${required}`);
  }
  assert(![...names].some((name) => name.startsWith("agent_") || name.includes("bash") || name.includes("shell")));

  const writeTool = listedTools.tools.find((entry) => entry.name === "write");
  assert(writeTool, "Missing write tool descriptor.");
  const writeSchema = writeTool.inputSchema ?? {};
  const writeRequired = Array.isArray(writeSchema.required) ? writeSchema.required : [];
  const writeProperties = writeSchema.properties && typeof writeSchema.properties === "object"
    ? writeSchema.properties
    : {};
  assert(writeRequired.includes("workspace_id"));
  assert(!("root_id" in writeProperties));
  assert(!("device_id" in writeProperties));

  const devices = await tool(clientA, "list_devices");
  assert.equal(devices.isError, undefined);
  assertNoControlPlanePaths(devices);

  const roots = await tool(clientA, "list_device_roots", { device_id: "windows-main" });
  assert.equal(roots.isError, undefined);
  assert.equal(roots.structuredContent.roots.length, 2);
  assertNoControlPlanePaths(roots);

  const readonlyOpen = await tool(clientA, "open_workspace", {
    device_id: "windows-main",
    root_id: "reference",
    relative_dir: "."
  });
  assert.equal(readonlyOpen.isError, true);
  assertNoControlPlanePaths(readonlyOpen);

  const openedA = await tool(clientA, "open_workspace", {
    device_id: "windows-main",
    root_id: "projects",
    relative_dir: "project-a"
  });
  assert.equal(openedA.isError, undefined);
  const workspaceA = openedA.structuredContent.workspace_id;
  assert.equal(typeof workspaceA, "string");
  assertNoControlPlanePaths(openedA);

  const workspaceRead = await tool(clientA, "read", { workspace_id: workspaceA, path: "main.txt" });
  assert.equal(workspaceRead.isError, undefined);
  assert.match(workspaceRead.content[0].text, /hub alpha/);

  const rootRead = await tool(clientA, "read", {
    device_id: "windows-main",
    root_id: "reference",
    path: "guide.txt"
  });
  assert.equal(rootRead.isError, undefined);
  assert.match(rootRead.content[0].text, /reference guide/);

  const hubWrite = await tool(clientA, "write", {
    workspace_id: workspaceA,
    path: "hub-created.txt",
    content: "created through hub\n"
  });
  assert.equal(hubWrite.isError, undefined);
  assert.equal(await fsp.readFile(path.join(projectA, "hub-created.txt"), "utf8"), "created through hub\n");

  const escapedWrite = await tool(clientA, "write", {
    workspace_id: workspaceA,
    path: "../project-b/hub-escape.txt",
    content: "must not be written\n"
  });
  assert.equal(escapedWrite.isError, true);
  await assert.rejects(fsp.stat(path.join(projectB, "hub-escape.txt")));
  assertNoControlPlanePaths(escapedWrite);

  const listedWorkspaces = await tool(clientA, "list_workspaces");
  assert.equal(listedWorkspaces.structuredContent.selected_workspace_id, workspaceA);
  assertNoControlPlanePaths(listedWorkspaces);

  clientB = await connectClient(baseUrl);
  const crossSessionWrite = await tool(clientB, "write", {
    workspace_id: workspaceA,
    path: "cross-session.txt",
    content: "must not be written\n"
  });
  assert.equal(crossSessionWrite.isError, true);
  await assert.rejects(fsp.stat(path.join(projectA, "cross-session.txt")));

  const openedB = await tool(clientB, "open_workspace", {
    device_id: "windows-main",
    root_id: "projects",
    relative_dir: "project-a"
  });
  assert.equal(openedB.isError, undefined);
  const workspaceB = openedB.structuredContent.workspace_id;
  assert.notEqual(workspaceB, workspaceA);

  const secondSessionWrite = await tool(clientB, "write", {
    workspace_id: workspaceB,
    path: "second-session.txt",
    content: "second session\n"
  });
  assert.equal(secondSessionWrite.isError, undefined);
  assert.equal(await fsp.readFile(path.join(projectA, "second-session.txt"), "utf8"), "second session\n");

  console.log("multidevice hub smoke: ok");
} finally {
  try {
    await clientA?.close();
  } catch {}
  try {
    await clientB?.close();
  } catch {}
  try {
    await stopHub();
  } catch {}
  await fsp.rm(temp, { recursive: true, force: true });
}
