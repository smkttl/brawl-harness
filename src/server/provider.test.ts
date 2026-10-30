import { afterEach, describe, expect, it } from "vitest";
import type { ProviderConfig } from "../shared/protocol.js";
import { discoverModels } from "./provider.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function provider(): ProviderConfig {
  return {
    id: "provider-test",
    name: "Test",
    baseUrl: "https://provider.example/v1/",
    api: "chat",
    apiKey: "secret",
    headers: {},
    models: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

describe("discoverModels", () => {
  it("normalizes and deduplicates OpenAI-compatible model lists", async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://provider.example/v1/models");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
      return new Response(
        JSON.stringify({
          data: [{ id: "beta" }, { id: "alpha" }, { id: "alpha" }],
          models: [{ name: "gamma" }]
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    await expect(discoverModels(provider())).resolves.toEqual(["alpha", "beta", "gamma"]);
  });

  it("reports upstream HTTP failures without throwing a generic server error", async () => {
    globalThis.fetch = (async () =>
      new Response('{"error":"models are not supported"}', { status: 404 })) as typeof fetch;

    await expect(discoverModels(provider())).rejects.toMatchObject({
      statusCode: 502,
      message: 'Model discovery failed (404): {"error":"models are not supported"}'
    });
  });

  it("reports unreachable endpoints as a provider error", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    await expect(discoverModels(provider())).rejects.toMatchObject({
      statusCode: 502,
      message: "Model discovery request failed: fetch failed"
    });
  });

  it("rejects a non-JSON model response", async () => {
    globalThis.fetch = (async () =>
      new Response("<html>bad gateway</html>", { status: 200 })) as typeof fetch;

    await expect(discoverModels(provider())).rejects.toMatchObject({
      statusCode: 502,
      message: "Model discovery returned invalid JSON"
    });
  });
});
