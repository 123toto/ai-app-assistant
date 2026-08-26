import { describe, expect, it, vi } from "vitest";
import { AiAppAssistantSettingsController, createAiAppAssistantSettingsClient } from "./settings.js";

describe("createAiAppAssistantSettingsClient", () => {
  it("calls the portable administration contract", async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => new Response(JSON.stringify(
      String(url).endsWith("/providers")
        ? [{ id: "mistral", label: "Mistral AI", requiresApiKey: true, supportsModelDiscovery: true }]
        : String(url).endsWith("/access")
          ? { available: true, maxConversationTurns: 2 }
        : { success: true, model: "mistral:small", latencyMs: 1 }
    ), { status: 200 }));
    const client = createAiAppAssistantSettingsClient({ endpoint: "/api/ai-app-assistant/", fetch: fetch as typeof globalThis.fetch });

    await client.listProviders();
    await expect(client.getAccess()).resolves.toEqual({ available: true, maxConversationTurns: 2 });
    await client.testConnection({ provider: "mistral", model: "small", apiKey: "secret" });

    expect(fetch.mock.calls[0]?.[0]).toBe("/api/ai-app-assistant/providers");
    expect(fetch.mock.calls[1]?.[0]).toBe("/api/ai-app-assistant/access");
    expect(fetch.mock.calls[2]?.[0]).toBe("/api/ai-app-assistant/configuration/test");
    expect(fetch.mock.calls[2]?.[1]).toMatchObject({ method: "POST" });
  });

  it("rejects malformed administration responses", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify([{ id: "mistral", label: "Mistral" }]), {
      status: 200
    }));
    const client = createAiAppAssistantSettingsClient({ endpoint: "/api/ai-app-assistant", fetch: fetch as typeof globalThis.fetch });
    await expect(client.listProviders()).rejects.toThrow();
  });
});

describe("AiAppAssistantSettingsController", () => {
  it("loads optional directory values without making them mandatory", async () => {
    const controller = new AiAppAssistantSettingsController({
      getAccess: async () => ({ available: true, maxConversationTurns: 3 }),
      getConfiguration: async () => configuration(),
      listProviders: async () => [{
        id: "ollama", label: "Ollama", requiresApiKey: false, supportsModelDiscovery: true
      }],
      getOptions: async () => { throw new Error("No directory adapter"); },
      listModels: async () => [],
      testConnection: async () => ({ success: true, model: "ollama:qwen3", latencyMs: 1 }),
      save: async () => ({
        saved: true,
        connection: { success: true, model: "ollama:qwen3", latencyMs: 1 },
        configuration: configuration()
      }),
      revokeApiKey: async () => configuration()
    });

    await controller.initialize();
    expect(controller.snapshot.status).toBe("ready");
    expect(controller.snapshot.options).toEqual({ roles: [], users: [] });
    expect(controller.snapshot.optionsAvailable).toBe(false);
  });
});

function configuration() {
  return {
    provider: "ollama" as const,
    model: "qwen3",
    access: { mode: "all" as const },
    maxConversationTurns: 3,
    apiKeyConfigured: false,
    apiKeyStorageAvailable: false,
    configured: true,
    source: "environment" as const,
    allowModelChangesByOthers: false,
    canChangeModel: true,
    canManageCredentials: true,
    canManageModelPolicy: true,
    canRevokeApiKey: false,
    fieldSources: {
      provider: "environment" as const,
      model: "environment" as const,
      apiKey: "none" as const,
      baseURL: "none" as const,
      access: "default" as const,
      quota: "default" as const,
      conversation: "default" as const
    },
    connection: { status: "connected" as const }
  };
}
