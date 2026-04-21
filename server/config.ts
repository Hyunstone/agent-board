import { existsSync, readFileSync } from "fs";
import path from "path";

const defaultHost = "127.0.0.1";
const defaultApiPort = 4317;
const defaultClientPort = 5173;

loadEnvFile();

export function getHost(): string {
  const host = process.env.AGENT_BOARD_HOST?.trim() || defaultHost;
  if (isLoopbackHost(host) || process.env.AGENT_BOARD_ALLOW_REMOTE === "1") {
    return host;
  }

  throw new Error("Refusing non-loopback AGENT_BOARD_HOST without AGENT_BOARD_ALLOW_REMOTE=1");
}

export function getApiPort(): number {
  return getPort("AGENT_BOARD_API_PORT", defaultApiPort);
}

export function getClientPort(): number {
  return getPort("AGENT_BOARD_CLIENT_PORT", defaultClientPort);
}

export function getDefaultWorkspaceRoot(homeDir: string): string | null {
  const configuredPath = process.env.AGENT_BOARD_DEFAULT_WORKSPACE_ROOT?.trim();
  return configuredPath ? expandHome(configuredPath, homeDir) : null;
}

export function getCommonWorkspaceRoots(homeDir: string): string[] {
  const configuredPaths = process.env.AGENT_BOARD_COMMON_PATHS;
  if (configuredPaths !== undefined) {
    return splitPathList(configuredPaths).map((candidate) => expandHome(candidate, homeDir));
  }

  return [];
}

function getPort(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

function splitPathList(value: string): string[] {
  return value
    .split(path.delimiter)
    .map((candidate) => candidate.trim())
    .filter(Boolean);
}

function expandHome(candidate: string, homeDir: string): string {
  if (candidate === "~") {
    return homeDir;
  }
  if (candidate.startsWith("~/")) {
    return path.join(homeDir, candidate.slice(2));
  }
  return candidate;
}

function loadEnvFile(): void {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) {
    return;
  }

  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = unquoteEnvValue(trimmed.slice(separatorIndex + 1).trim());
    process.env[key] ??= value;
  }
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}
