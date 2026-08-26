import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import type { ClientRuntime } from "./clientRuntime.js";
import { clientPage } from "./clientPage.js";

export interface RunningClientHttp {
  url: string;
  close(): Promise<void>;
}

function tokenMatches(expected: string, actual: unknown): boolean {
  if (typeof actual !== "string") return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

function loopbackHostHeader(value: string | undefined): boolean {
  const host = String(value ?? "").trim().toLowerCase();
  return /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host);
}

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "?").slice(0, 4000);
}

function jsonError(res: Response, status: number, message: string): void {
  res.status(status).json({ ok: false, error: message });
}

export async function startClientHttp(runtime: ClientRuntime, port = 8791): Promise<RunningClientHttp> {
  const adminToken = process.env.CODEXPRO_CLIENT_ADMIN_TOKEN?.trim() || randomBytes(32).toString("hex");
  if (Buffer.byteLength(adminToken, "utf8") < 24) {
    throw new Error("CODEXPRO_CLIENT_ADMIN_TOKEN must contain at least 24 UTF-8 bytes when set.");
  }

  const app = express();
  app.use((req, res, next) => {
    if (!loopbackHostHeader(req.headers.host)) {
      res.status(403).send("Forbidden host");
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    next();
  });

  app.get("/", (_req, res) => {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    );
    res.type("html").send(clientPage(adminToken));
  });

  app.use("/api", (req, res, next) => {
    if (!tokenMatches(adminToken, req.headers["x-codexpro-admin-token"])) {
      jsonError(res, 403, "Invalid local admin token.");
      return;
    }
    next();
  });

  app.get("/api/state", async (_req, res) => {
    try {
      res.json({ ok: true, state: await runtime.state() });
    } catch (error) {
      jsonError(res, 400, publicError(error));
    }
  });

  app.put("/api/state", express.json({ limit: "2mb" }), async (req, res) => {
    try {
      res.json({ ok: true, state: await runtime.saveState(req.body ?? {}) });
    } catch (error) {
      jsonError(res, 400, publicError(error));
    }
  });

  app.get("/api/status", async (_req, res) => {
    try {
      res.json({ ok: true, hub: await runtime.hubStatus() });
    } catch (error) {
      jsonError(res, 400, publicError(error));
    }
  });

  app.get("/api/logs", (_req, res) => {
    res.json({ ok: true, logs: runtime.logLines() });
  });

  app.post("/api/device/test", express.json({ limit: "16kb" }), async (req, res) => {
    try {
      res.json({ ok: true, device: await runtime.testDevice(req.body?.device_id) });
    } catch (error) {
      jsonError(res, 400, publicError(error));
    }
  });

  app.post("/api/hub/start", async (_req, res) => {
    try {
      res.json({ ok: true, hub: await runtime.startHub() });
    } catch (error) {
      jsonError(res, 400, publicError(error));
    }
  });

  app.post("/api/hub/stop", async (_req, res) => {
    try {
      res.json({ ok: true, hub: await runtime.stopHub() });
    } catch (error) {
      jsonError(res, 400, publicError(error));
    }
  });

  app.post("/api/hub/restart", async (_req, res) => {
    try {
      res.json({ ok: true, hub: await runtime.restartHub() });
    } catch (error) {
      jsonError(res, 400, publicError(error));
    }
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const type = error && typeof error === "object" && "type" in error
      ? String((error as { type?: unknown }).type ?? "")
      : "";
    if (type === "entity.parse.failed" || type === "entity.too.large") {
      jsonError(
        res,
        type === "entity.too.large" ? 413 : 400,
        type === "entity.too.large" ? "Request body is too large." : "Request body must be valid JSON."
      );
      return;
    }
    jsonError(res, 500, publicError(error));
  });

  const server = await new Promise<Server>((resolve, reject) => {
    const created = app.listen(port, "127.0.0.1", () => resolve(created));
    created.once("error", reject);
  });

  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}
