import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "codexpro-client-smoke-"));
const configDir = path.join(temp, "config");
const projects = path.join(temp, "projects");
const project = path.join(projects, "project-a");
const policyPath = path.join(configDir, "windows-main-agent.json");
const hubPath = path.join(configDir, "hub.json");
const adminToken = "codexpro-client-admin-token-1234567890";
const hubToken = "codexpro-client-hub-token-123456789012";
let child;

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close(() => port ? resolve(port) : reject(new Error("Could not reserve a free port.")));
    });
    server.once("error", reject);
  });
}

function waitForClient(activeChild, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for Control Center.\n${stderr}`)), timeoutMs);
    timer.unref();
    const inspect = (chunk) => {
      stderr += String(chunk);
      if (stderr.includes("CodexPro Control Center:")) {
        clearTimeout(timer);
        resolve();
      }
    };
    activeChild.stderr.on("data", inspect);
    activeChild.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Control Center exited before startup: ${code}\n${stderr}`));
    });
  });
}

async function api(base, route, options = {}) {
  const response = await fetch(`${base}${route}`, {
    ...options,
    headers: {
      "x-codexpro-admin-token": adminToken,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers ?? {})
    }
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

try {
  await Promise.all([
    fsp.mkdir(configDir, { recursive: true }),
    fsp.mkdir(project, { recursive: true })
  ]);
  await fsp.writeFile(path.join(project, "main.txt"), "client smoke\n", "utf8");
  await fsp.writeFile(policyPath, JSON.stringify({
    schemaVersion: 1,
    deviceId: "windows-main",
    label: "Windows Main",
    roots: [
      { id: "projects", label: "Projects", path: projects, mode: "workspace-parent" }
    ]
  }, null, 2), "utf8");

  const hubPort = await freePort();
  const clientPort = await freePort();
  await fsp.writeFile(hubPath, JSON.stringify({
    schemaVersion: 1,
    host: "127.0.0.1",
    port: hubPort,
    maxSessions: 8,
    sessionTtlMs: 300000,
    devices: [
      { id: "windows-main", label: "Windows Main", transport: "local", policyPath }
    ]
  }, null, 2), "utf8");

  child = spawn(process.execPath, [path.resolve("dist/client.js"), "--config", hubPath, "--port", String(clientPort), "--no-open"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      CODEXPRO_CLIENT_ADMIN_TOKEN: adminToken,
      CODEXPRO_HTTP_TOKEN: hubToken
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitForClient(child);
  const base = `http://127.0.0.1:${clientPort}`;

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /CodexPro Control Center/);

  const unauthorized = await fetch(`${base}/api/state`);
  assert.equal(unauthorized.status, 403);

  const state = await api(base, "/api/state");
  assert.equal(state.response.status, 200);
  assert.equal(state.data.state.config.devices.length, 1);
  assert.equal(state.data.state.hubToken, hubToken);
  assert.equal(state.data.state.hub.reachable, false);

  const testDevice = await api(base, "/api/device/test", {
    method: "POST",
    body: JSON.stringify({ device_id: "windows-main" })
  });
  assert.equal(testDevice.response.status, 200);
  assert.equal(testDevice.data.device.device_id, "windows-main");
  assert.equal(testDevice.data.device.roots.length, 1);

  const nextState = structuredClone(state.data.state);
  nextState.config.devices[0].label = "Windows Main Updated";
  nextState.localPolicies["windows-main"].label = "Windows Main Updated";
  const saved = await api(base, "/api/state", {
    method: "PUT",
    body: JSON.stringify({ config: nextState.config, localPolicies: nextState.localPolicies })
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.data.state.config.devices[0].label, "Windows Main Updated");

  const start = await api(base, "/api/hub/start", { method: "POST" });
  assert.equal(start.response.status, 200);
  assert.equal(start.data.hub.owned, true);
  assert.equal(start.data.hub.reachable, true);

  const hubHealth = await fetch(`http://127.0.0.1:${hubPort}/healthz`, {
    headers: { Authorization: `Bearer ${hubToken}` }
  });
  assert.equal(hubHealth.status, 200);

  const stop = await api(base, "/api/hub/stop", { method: "POST" });
  assert.equal(stop.response.status, 200);
  assert.equal(stop.data.hub.owned, false);

  const logs = await api(base, "/api/logs");
  assert.equal(logs.response.status, 200);
  assert(logs.data.logs.some((line) => line.includes("Device test passed")));
  assert(logs.data.logs.some((line) => line.includes("Hub started")));

  console.log("multidevice client smoke: ok");
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      timer.unref();
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
  await fsp.rm(temp, { recursive: true, force: true });
}
