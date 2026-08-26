import { randomUUID, timingSafeEqual } from "node:crypto";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { HubConfig } from "./types.js";
import { DeviceRegistry } from "./deviceClient.js";
import { createHubServer } from "./hubServer.js";
import { isLoopbackHost } from "./policy.js";

interface TransportRecord {
  transport: StreamableHTTPServerTransport;
  createdAt: number;
  lastSeenAt: number;
}

export interface RunningHub {
  url: string;
  close(): Promise<void>;
}

function tokenMatches(expectedToken: string | undefined, value: unknown): boolean {
  if (!expectedToken || typeof value !== "string") return false;
  const expected = Buffer.from(expectedToken);
  const actual = Buffer.from(value);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function sessionIdFrom(req: Request): string | undefined {
  const value = req.headers["mcp-session-id"];
  return Array.isArray(value) ? value[0] : value;
}

function sendSessionError(res: Response, sessionId: string | undefined): void {
  const pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const missing = !sessionId;
  const malformed = Boolean(sessionId && !pattern.test(sessionId));
  res.status(missing || malformed ? 400 : 404).json({
    jsonrpc: "2.0",
    error: missing
      ? { code: -32000, message: "Bad Request: Mcp-Session-Id header is required" }
      : malformed
        ? { code: -32000, message: "Bad Request: invalid MCP session id" }
        : { code: -32001, message: "Session not found" },
    id: null
  });
}

function validateAuthentication(config: HubConfig): string | undefined {
  const token = process.env.CODEXPRO_HTTP_TOKEN?.trim();
  if (token && Buffer.byteLength(token, "utf8") < 24) {
    throw new Error("CODEXPRO_HTTP_TOKEN must contain at least 24 UTF-8 bytes.");
  }
  const localNoToken = isLoopbackHost(config.host) && process.env.CODEXPRO_ALLOW_NO_HTTP_TOKEN === "1";
  if (!token && !localNoToken) {
    throw new Error(
      "CODEXPRO_HTTP_TOKEN is required. Set a strong token, or set CODEXPRO_ALLOW_NO_HTTP_TOKEN=1 only for a trusted loopback-only test."
    );
  }
  return token;
}

export async function startHubHttp(config: HubConfig, registry: DeviceRegistry): Promise<RunningHub> {
  const authToken = validateAuthentication(config);
  const app = express();
  const transports = new Map<string, TransportRecord>();
  const sessionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const authFailures = new Map<string, { count: number; resetAt: number }>();

  function prune(): void {
    const now = Date.now();
    for (const [sessionId, record] of transports) {
      if (now - record.lastSeenAt > config.sessionTtlMs) {
        transports.delete(sessionId);
        void record.transport.close();
      }
    }
    while (transports.size > config.maxSessions) {
      const oldest = [...transports.entries()].sort((left, right) => left[1].lastSeenAt - right[1].lastSeenAt)[0];
      if (!oldest) break;
      transports.delete(oldest[0]);
      void oldest[1].transport.close();
    }
  }

  function getTransport(sessionId: string | undefined): StreamableHTTPServerTransport | undefined {
    if (!sessionId || !sessionPattern.test(sessionId)) return undefined;
    prune();
    const record = transports.get(sessionId);
    if (!record) return undefined;
    record.lastSeenAt = Date.now();
    return record.transport;
  }

  app.use(cors({ exposedHeaders: ["Mcp-Session-Id"] }));
  app.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });

  app.use((req, res, next) => {
    if (!authToken) {
      next();
      return;
    }
    const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    const queryToken = typeof req.query.codexpro_token === "string"
      ? req.query.codexpro_token
      : typeof req.query.token === "string"
        ? req.query.token
        : undefined;
    if (tokenMatches(authToken, bearer) || tokenMatches(authToken, queryToken)) {
      next();
      return;
    }
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const current = authFailures.get(key);
    if (!current || current.resetAt <= now) {
      authFailures.set(key, { count: 1, resetAt: now + 60_000 });
      res.status(401).send("Unauthorized");
      return;
    }
    current.count += 1;
    if (current.count > 10) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((current.resetAt - now) / 1000))));
      res.status(429).send("Too Many Authentication Attempts");
      return;
    }
    res.status(401).send("Unauthorized");
  });

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      name: "CodexPro Multi-Device Hub",
      authEnabled: Boolean(authToken),
      sessions: transports.size,
      devices: registry.list()
    });
  });

  app.post("/mcp", express.json({ limit: "12mb" }), async (req, res) => {
    try {
      const sessionId = sessionIdFrom(req);
      let transport = getTransport(sessionId);
      if (!transport && !sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId: string) => {
            prune();
            transports.set(newSessionId, { transport: transport!, createdAt: Date.now(), lastSeenAt: Date.now() });
            prune();
          },
          onsessionclosed: (closedSessionId: string) => {
            transports.delete(closedSessionId);
          }
        } as any);
        (transport as any).onclose = () => {
          const closedSessionId = (transport as any).sessionId;
          if (closedSessionId) transports.delete(closedSessionId);
        };
        await createHubServer(registry).connect(transport);
      } else if (!transport) {
        sendSessionError(res, sessionId);
        return;
      }
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal CodexPro Hub error. Check the Windows Hub terminal." },
          id: null
        });
      }
    }
  });

  const handleSessionRequest = async (req: Request, res: Response): Promise<void> => {
    const sessionId = sessionIdFrom(req);
    const transport = getTransport(sessionId);
    if (!transport) {
      sendSessionError(res, sessionId);
      return;
    }
    await transport.handleRequest(req, res);
  };
  app.get("/mcp", handleSessionRequest);
  app.delete("/mcp", handleSessionRequest);

  app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (!error || typeof error !== "object" || !("type" in error)) {
      next(error);
      return;
    }
    const type = String((error as { type?: unknown }).type ?? "");
    if (type !== "entity.parse.failed" && type !== "entity.too.large") {
      next(error);
      return;
    }
    res.status(type === "entity.too.large" ? 413 : 400).json({
      jsonrpc: "2.0",
      error: {
        code: type === "entity.too.large" ? -32000 : -32700,
        message: type === "entity.too.large" ? "Payload too large." : "Parse error."
      },
      id: null
    });
  });

  const pruneTimer = setInterval(prune, Math.min(config.sessionTtlMs, 60_000));
  pruneTimer.unref();

  const httpServer = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const server = app.listen(config.port, config.host, () => resolve(server));
    server.once("error", reject);
  });

  return {
    url: `http://${config.host}:${config.port}/mcp`,
    async close(): Promise<void> {
      clearInterval(pruneTimer);
      for (const record of transports.values()) await record.transport.close();
      transports.clear();
      await registry.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => error ? reject(error) : resolve());
      });
    }
  };
}
