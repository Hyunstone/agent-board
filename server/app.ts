import express from "express";
import path from "path";
import { getApiPort, getClientPort, getHost } from "./config";
import { getDefaults, getResourcePreviewById, scanWorkspaceRoots } from "./scanner";

const maxWorkspaceRoots = 50;
const maxWorkspaceRootLength = 4096;

export function createApp() {
  const app = express();
  const host = getHost();
  const allowedOrigins = buildAllowedOrigins(host, getApiPort(), getClientPort());

  app.use(express.json());
  app.use((_request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    next();
  });
  app.use((request, response, next) => {
    const origin = request.get("origin");
    if (origin && !allowedOrigins.has(origin)) {
      response.status(403).json({ error: "Origin not allowed" });
      return;
    }

    next();
  });

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true });
  });

  app.get("/api/defaults", (_request, response) => {
    response.json(getDefaults());
  });

  app.post("/api/scan", async (request, response, next) => {
    try {
      const workspaceRoots = validateWorkspaceRoots(request.body?.workspaceRoots);
      const result = await scanWorkspaceRoots(workspaceRoots);
      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/resources/:id/preview", async (request, response, next) => {
    try {
      const preview = await getResourcePreviewById(request.params.id);
      if (!preview) {
        response.status(404).json({ error: "Resource preview not found" });
        return;
      }

      response.json(preview);
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof ClientError) {
      response.status(error.status).json({ error: error.message });
      return;
    }

    response.status(500).json({ error: "Internal Server Error" });
  });

  return app;
}

class ClientError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export function validateWorkspaceRoots(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new ClientError(400, "workspaceRoots must be an array");
  }

  if (value.length > maxWorkspaceRoots) {
    throw new ClientError(400, `workspaceRoots must contain at most ${maxWorkspaceRoots} entries`);
  }

  return value.map((candidate) => {
    if (typeof candidate !== "string") {
      throw new ClientError(400, "workspaceRoots entries must be strings");
    }

    const trimmed = candidate.trim();
    if (!trimmed || trimmed.length > maxWorkspaceRootLength || !path.isAbsolute(trimmed)) {
      throw new ClientError(400, "workspaceRoots entries must be absolute paths");
    }

    return trimmed;
  });
}

export function buildAllowedOrigins(host: string, apiPort: number, clientPort: number): Set<string> {
  const hosts = new Set([host, "127.0.0.1", "localhost"]);
  const origins = new Set<string>();

  for (const originHost of hosts) {
    origins.add(`http://${originHost}:${apiPort}`);
    origins.add(`http://${originHost}:${clientPort}`);
  }

  return origins;
}
