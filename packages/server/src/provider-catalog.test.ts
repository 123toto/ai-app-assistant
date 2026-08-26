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
});
