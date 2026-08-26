#!/usr/bin/env node
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { ClientRuntime } from "./multidevice/clientRuntime.js";
import { startClientHttp } from "./multidevice/clientHttp.js";
import { CODEXPRO_MULTIDEVICE_VERSION } from "./multidevice/version.js";

function optionValue(argv: string[], name: string): string | undefined {
  const inline = argv.find((value) => value.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function numberOption(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function defaultConfigPath(): string {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path.join(home, ".config", "codexpro", "hub.json");
}

function openBrowser(url: string): void {
  try {
    let command: string;
    let args: string[];
    if (process.platform === "win32") {
      command = "cmd.exe";
      args = ["/d", "/s", "/c", "start", "", url];
    } else if (process.platform === "darwin") {
      command = "open";
      args = [url];
    } else {
      command = "xdg-open";
      args = [url];
    }
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
  } catch {}
}

function printHelp(): void {
  console.log(`CodexPro Control Center\n\nUsage:\n  codexpro-client [--config PATH] [--port 8791] [--no-open]\n\nDefaults:\n  config: ~/.config/codexpro/hub.json\n  UI:     http://127.0.0.1:8791/\n\nThe management UI is always bound to 127.0.0.1. It can configure local/SSH devices, edit local Agent roots, test devices, manage the Hub process, and copy the ChatGPT MCP URL.`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv.includes("-v") || argv[0] === "version") {
    console.log(CODEXPRO_MULTIDEVICE_VERSION);
    return;
  }
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    printHelp();
    return;
  }

  const configPath = optionValue(argv, "config") ?? process.env.CODEXPRO_HUB_CONFIG ?? defaultConfigPath();
  const port = numberOption(optionValue(argv, "port") ?? process.env.CODEXPRO_CLIENT_PORT, 8791, 1, 65535);
  const runtime = new ClientRuntime(configPath);
  const running = await startClientHttp(runtime, port);
  console.error(`CodexPro Control Center: ${running.url}`);
  console.error(`Hub config: ${runtime.configPath}`);
  if (!argv.includes("--no-open") && process.env.CODEXPRO_CLIENT_NO_OPEN !== "1") openBrowser(running.url);

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    try {
      await runtime.close();
    } finally {
      await running.close().catch(() => undefined);
    }
  };
  process.on("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.on("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
