import { describe, expect, it, vi } from "vitest";
import {
  AiModelDiscoveryError,
  listAiModels,
  listAiProviders
} from "./provider-catalog.js";

describe("provider catalog", () => {
  it("exposes providers without hard-coding model names", () => {
    expect(listAiProviders()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "mistral", requiresApiKey: true }),
      expect.objectContaining({ id: "ollama", requiresApiKey: false })
    ]));
  });

  it("discovers and normalizes Mistral models", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: "mistral-small-latest", created: 1_700_000_000 }]
    }), { status: 200 }));

    await expect(listAiModels({
      provider: "mistral",
      apiKey: "secret",
      fetch: fetchMock
    })).resolves.toEqual([{
      provider: "mistral",
      id: "mistral-small-latest",
      createdAt: "2023-11-14T22:13:20.000Z"
    }]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.mistral.ai/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer secret" })
      })
    );
  });

  it("keeps only Gemini models supporting text generation", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      models: [
        { name: "models/gemini-pro", displayName: "Gemini Pro", supportedGenerationMethods: ["generateContent"] },
        { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] }
      ]
    }), { status: 200 }));

    await expect(listAiModels({ provider: "google", apiKey: "secret", fetch: fetchMock }))
      .resolves.toEqual([{ provider: "google", id: "gemini-pro", label: "Gemini Pro" }]);
  });

  it("does not leak provider response content in discovery errors", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("secret provider details", { status: 401 })
    );

    const request = listAiModels({ provider: "openai", apiKey: "bad", fetch: fetchMock });
    await expect(request).rejects.toBeInstanceOf(AiModelDiscoveryError);
    await expect(request).rejects.not.toThrow("secret provider details");
  });

  it.each([
    ["openai", undefined, "https://api.openai.com/v1/models", "authorization", "Bearer secret"],
    ["anthropic", undefined, "https://api.anthropic.com/v1/models", "x-api-key", "secret"],
    ["ollama", undefined, "http://localhost:11434/v1/models", "authorization", "Bearer ollama"],
    ["openai", "https://gateway.example.test/v1/", "https://gateway.example.test/v1/models", "authorization", "Bearer secret"]
  ] as const)("builds the documented %s discovery request", async (
    provider, baseURL, expectedUrl, header, expectedHeader
  ) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: "model-b" }, { id: "model-a", display_name: "Model A" }]
    }), { status: 200 }));
    const signal = new AbortController().signal;

    const models = await listAiModels({
      provider,
      ...(provider === "ollama" ? {} : { apiKey: "secret" }),
      ...(baseURL ? { baseURL } : {}),
      signal,
      fetch: fetchMock
    });

    expect(models.map(({ id }) => id)).toEqual(["model-a", "model-b"]);
    expect(fetchMock).toHaveBeenCalledWith(expectedUrl, expect.objectContaining({
      method: "GET",
      headers: expect.objectContaining({ [header]: expectedHeader }),
      signal
    }));
    if (provider === "anthropic") {
      expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
        "anthropic-version": "2023-06-01"
      });
    }
  });

  it("requires public-provider credentials and rejects unsafe custom endpoints", async () => {
    await expect(listAiModels({ provider: "openai", fetch: vi.fn() }))
      .rejects.toThrow("API key is required");
    await expect(listAiModels({
      provider: "openai",
      apiKey: "secret",
      baseURL: "ftp://gateway.example.test",
      fetch: vi.fn()
    })).rejects.toThrow("HTTP(S) URL without credentials");
    await expect(listAiModels({
      provider: "openai",
      apiKey: "secret",
      baseURL: "https://user:password@gateway.example.test",
      fetch: vi.fn()
    })).rejects.toThrow("HTTP(S) URL without credentials");
  });

  it("returns a fresh provider catalogue on every call", () => {
    const first = listAiProviders();
    first[0]!.label = "Mutated";
    expect(listAiProviders()[0]?.label).not.toBe("Mutated");
  });
});
