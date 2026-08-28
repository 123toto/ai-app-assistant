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

  it("covers every managed endpoint with host headers and the expected payload", async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const value = url.endsWith("/access")
        ? { available: true, maxConversationTurns: 3 }
        : url.endsWith("/configuration/options")
          ? { roles: [{ id: "consumer-admin", label: "Administrator" }], users: [] }
          : url.endsWith("/providers")
            ? [{ id: "ollama", label: "Ollama", requiresApiKey: false, supportsModelDiscovery: true }]
            : url.endsWith("/models")
              ? [{ id: "qwen3", provider: "ollama" }]
              : url.endsWith("/configuration/test")
                ? { success: true, model: "ollama:qwen3", latencyMs: 1 }
                : url.endsWith("/configuration/api-key")
                  ? configuration()
                  : init?.method === "PUT"
                    ? {
                        saved: true,
                        connection: { success: true, model: "ollama:qwen3", latencyMs: 1 },
                        configuration: configuration()
                      }
                    : configuration();
      return new Response(JSON.stringify(value), { status: 200 });
    });
    const client = createAiAppAssistantSettingsClient({
      endpoint: "/api/ai-app-assistant///",
      fetch: fetch as typeof globalThis.fetch,
      headers: async () => ({ authorization: "Bearer host-token" })
    });
    const connection = { provider: "ollama" as const, model: "qwen3" };

    await client.getAccess();
    await client.getConfiguration();
    await client.getOptions();
    await client.listProviders();
    await client.listModels({ provider: "ollama" });
    await client.testConnection(connection);
    await client.save({ ...connection, access: { mode: "all" } });
    await client.revokeApiKey();

    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/ai-app-assistant/access",
      "/api/ai-app-assistant/configuration",
      "/api/ai-app-assistant/configuration/options",
      "/api/ai-app-assistant/providers",
      "/api/ai-app-assistant/models",
      "/api/ai-app-assistant/configuration/test",
      "/api/ai-app-assistant/configuration",
      "/api/ai-app-assistant/configuration/api-key"
    ]);
    expect(fetch.mock.calls.every(([, init]) =>
      (init?.headers as Record<string, string>).authorization === "Bearer host-token"
    )).toBe(true);
    expect(fetch.mock.calls[4]?.[1]).toMatchObject({
      method: "POST", body: JSON.stringify({ provider: "ollama" })
    });
    expect(fetch.mock.calls[6]?.[1]).toMatchObject({ method: "PUT" });
    expect(fetch.mock.calls[7]?.[1]).toMatchObject({ method: "DELETE" });
  });

  it("preserves the managed response status and body on HTTP failures", async () => {
    const client = createAiAppAssistantSettingsClient({
      endpoint: "/api/ai-app-assistant",
      fetch: async () => new Response('{"error":"forbidden"}', { status: 403 })
    });

    await expect(client.getConfiguration()).rejects.toMatchObject({
      name: "AiAppAssistantHttpError",
      status: 403,
      responseBody: '{"error":"forbidden"}'
    });
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

  it("refreshes a stale connected badge after a failed active connection test", async () => {
    const connected = configuration();
    const disconnected = {
      ...connected,
      connection: { status: "disconnected" as const, model: "ollama:qwen3" }
    };
    const getConfiguration = vi.fn()
      .mockResolvedValueOnce(connected)
      .mockResolvedValueOnce(disconnected);
    const controller = new AiAppAssistantSettingsController({
      getAccess: async () => ({ available: true, maxConversationTurns: 3 }),
      getConfiguration,
      listProviders: async () => [{
        id: "ollama", label: "Ollama", requiresApiKey: false, supportsModelDiscovery: true
      }],
      getOptions: async () => ({ roles: [], users: [] }),
      listModels: async () => [],
      testConnection: async () => ({
        success: false,
        model: "ollama:qwen3",
        latencyMs: 45_000,
        error: { code: "TIMEOUT", message: "Timed out", retryable: true }
      }),
      save: async () => ({
        saved: true,
        connection: { success: true, model: "ollama:qwen3", latencyMs: 1 },
        configuration: connected
      }),
      revokeApiKey: async () => connected
    });

    await controller.initialize();
    await controller.test({ provider: "ollama", model: "qwen3" });

    expect(getConfiguration).toHaveBeenCalledTimes(2);
    expect(controller.snapshot.configuration?.connection.status).toBe("disconnected");
    expect(controller.snapshot.connectionTest).toMatchObject({ success: false });
  });

  it("tracks the exact normalized credentials used for successful model discovery", async () => {
    const listModels = vi.fn(async () => [{ id: "qwen3", provider: "ollama" as const }]);
    const controller = new AiAppAssistantSettingsController(settingsClient({ listModels }));

    await controller.loadModels({ provider: "ollama", apiKey: " secret ", baseURL: "https://local.test///" });

    expect(controller.modelsAreLoadedFor({
      provider: "ollama", apiKey: "secret", baseURL: "https://local.test"
    })).toBe(true);
    expect(controller.modelsAreLoadedFor({
      provider: "ollama", apiKey: "different", baseURL: "https://local.test"
    })).toBe(false);
    expect(controller.snapshot.models).toEqual([{ id: "qwen3", provider: "ollama" }]);
  });

  it("uses a safe connection-scoped model error and keeps model discovery retryable", async () => {
    const listModels = vi.fn()
      .mockRejectedValueOnce(new Error("Technical provider response"))
      .mockResolvedValueOnce([{ id: "qwen3", provider: "ollama" }]);
    const controller = new AiAppAssistantSettingsController(settingsClient({ listModels }));

    await expect(controller.loadModels({ provider: "ollama" }))
      .rejects.toThrow("Unable to load the model list");
    expect(controller.snapshot).toMatchObject({
      status: "error",
      errorScope: "connection",
      error: { message: "Unable to load the model list." }
    });

    await expect(controller.loadModels({ provider: "ollama" }))
      .resolves.toEqual([{ id: "qwen3", provider: "ollama" }]);
    expect(controller.snapshot.status).toBe("ready");
  });

  it.each([
    ["connection", { ...configurationInput(), model: "qwen3-next" }],
    ["usage", { ...configurationInput(), maxConversationTurns: 4 }],
    ["global", { ...configurationInput(), model: "qwen3-next", maxConversationTurns: 4 }]
  ] as const)("scopes a failed %s save to the affected settings module", async (scope, input) => {
    const controller = new AiAppAssistantSettingsController(settingsClient({
      save: vi.fn(async () => { throw new Error("Save unavailable"); })
    }));
    await controller.initialize();

    await expect(controller.save(input)).rejects.toThrow("Save unavailable");
    expect(controller.snapshot).toMatchObject({ status: "error", errorScope: scope });
  });

  it("clears discovered models after revoking the stored API key", async () => {
    const revoked = { ...configuration(), apiKeyConfigured: false };
    const controller = new AiAppAssistantSettingsController(settingsClient({
      listModels: vi.fn(async () => [{ id: "qwen3", provider: "ollama" as const }]),
      revokeApiKey: vi.fn(async () => revoked)
    }));
    await controller.loadModels({ provider: "ollama" });

    await controller.revokeApiKey();

    expect(controller.snapshot.configuration).toEqual(revoked);
    expect(controller.snapshot.models).toEqual([]);
    expect(controller.modelsAreLoadedFor({ provider: "ollama" })).toBe(false);
  });
});

function configurationInput() {
  return {
    provider: "ollama" as const,
    model: "qwen3",
    access: { mode: "all" as const },
    maxConversationTurns: 3
  };
}

function settingsClient(
  overrides: Partial<ConstructorParameters<typeof AiAppAssistantSettingsController>[0]> = {}
) {
  return {
    getAccess: async () => ({ available: true, maxConversationTurns: 3 }),
    getConfiguration: async () => configuration(),
    listProviders: async () => [{
      id: "ollama" as const, label: "Ollama", requiresApiKey: false, supportsModelDiscovery: true
    }],
    getOptions: async () => ({ roles: [], users: [] }),
    listModels: async () => [],
    testConnection: async () => ({ success: true as const, model: "ollama:qwen3", latencyMs: 1 }),
    save: async () => ({
      saved: true,
      connection: { success: true as const, model: "ollama:qwen3", latencyMs: 1 },
      configuration: configuration()
    }),
    revokeApiKey: async () => configuration(),
    ...overrides
  };
}

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
