#!/usr/bin/env node
import { DeviceRegistry } from "./multidevice/deviceClient.js";
import { startHubHttp } from "./multidevice/hubHttp.js";
import { loadHubConfig } from "./multidevice/policy.js";
import { CODEXPRO_MULTIDEVICE_VERSION } from "./multidevice/version.js";

function optionValue(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function printHelp(): void {
  console.log(`CodexPro Multi-Device Hub\n\nUsage:\n  codexpro-hub --config C:\\path\\to\\hub.json\n\nEnvironment:\n  CODEXPRO_HUB_CONFIG=path/to/hub.json\n  CODEXPRO_HTTP_TOKEN=<required, at least 24 UTF-8 bytes>\n\nThe Hub refuses to start without authentication, including on loopback.`);
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
  const configPath = optionValue(argv, "config") ?? process.env.CODEXPRO_HUB_CONFIG;
  if (!configPath) throw new Error("Missing Hub config. Pass --config or set CODEXPRO_HUB_CONFIG.");
  const config = loadHubConfig(configPath);
  const registry = new DeviceRegistry(config.devices);
  const running = await startHubHttp(config, registry);
  console.error(`CodexPro Multi-Device Hub listening at ${running.url}`);

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    try {
      await running.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
