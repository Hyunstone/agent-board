import { describe, expect, it } from "vitest";
import { buildAllowedOrigins, createApp, validateWorkspaceRoots } from "./app";

describe("server api", () => {
  it("registers the expected express routes", () => {
    const app = createApp();
    const routeEntries = ((app as unknown as { _router?: { stack: Array<{ name: string; route?: { path: string; methods: Record<string, boolean> } }> } })._router?.stack ?? [])
      .filter((layer) => layer.route)
      .map((layer) => ({
        path: layer.route?.path,
        methods: Object.keys(layer.route?.methods ?? {}).sort()
      }));

    expect(routeEntries).toEqual(
      expect.arrayContaining([
        { path: "/api/health", methods: ["get"] },
        { path: "/api/defaults", methods: ["get"] },
        { path: "/api/scan", methods: ["post"] },
        { path: "/api/resources/:id/preview", methods: ["get"] }
      ])
    );
  });

  it("builds a narrow origin allowlist for browser requests", () => {
    const origins = buildAllowedOrigins("127.0.0.1", 4317, 5173);

    expect(origins.has("http://127.0.0.1:4317")).toBe(true);
    expect(origins.has("http://127.0.0.1:5173")).toBe(true);
    expect(origins.has("http://localhost:5173")).toBe(true);
    expect(origins.has("http://example.com")).toBe(false);
  });

  it("validates scan workspace roots before scanning", () => {
    expect(() => validateWorkspaceRoots(["relative/path"])).toThrow("workspaceRoots entries must be absolute paths");
    expect(() => validateWorkspaceRoots([1])).toThrow("workspaceRoots entries must be strings");
    expect(validateWorkspaceRoots(["/tmp/project"])).toEqual(["/tmp/project"]);
  });
});
