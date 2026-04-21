import type { DefaultsResponse, ResourcePreview, ScanRequest, ScanResult } from "../../shared/types";

export async function fetchDefaults(): Promise<DefaultsResponse> {
  return fetchJson<DefaultsResponse>("/api/defaults");
}

export async function scanWorkspaces(workspaceRoots: string[]): Promise<ScanResult> {
  return fetchJson<ScanResult>("/api/scan", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ workspaceRoots } satisfies ScanRequest)
  });
}

export async function fetchResourcePreview(id: string): Promise<ResourcePreview> {
  return fetchJson<ResourcePreview>(`/api/resources/${encodeURIComponent(id)}/preview`);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}
