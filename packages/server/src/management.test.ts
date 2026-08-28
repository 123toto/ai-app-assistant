import { describe, expect, it, vi } from "vitest";
import {
  createAiAppAssistantConfigurationRepository,
  createMemoryAiAppAssistantStore,
  type AiAppAssistantSecretProtector
} from "./configuration.js";
import {
  AiAppAssistantConfigurationManager,
  createPollingAiAppAssistantConfigurationSynchronizer
} from "./management.js";

const actor = { id: "user-a", label: "User A", roles: ["admin"] };
const protector: AiAppAssistantSecretProtector = {
  protect: (value) => `protected:${value}`,
  unprotect: (value) => value.slice("protected:".length)
};

describe("AiAppAssistantConfigurationManager", () => {
  it("owns the full safe configuration lifecycle", async () => {
    const testConnection = vi.fn(async ({ provider, model }) => ({
      success: true as const,
      model: `${provider}:${model}`,
      latencyMs: 12
    }));
    const manager = createManager({ testConnection });

    const saved = await manager.save({
      provider: "mistral",
      model: "mistral-small-latest",
      apiKey: "secret-value",
      access: { mode: "roles", roles: ["admin"] },
      quota: { maxRequests: 4, windowSeconds: 60 },
      maxConversationTurns: 2
    }, actor);

    expect(saved.saved).toBe(true);
    expect(saved.reloadRequired).toBe(true);
    expect(await manager.canUse(actor)).toBe(true);
    expect(await manager.canUse({ id: "user-b", label: "User B", roles: ["reader"] })).toBe(false);
    expect(saved.configuration).toMatchObject({
      provider: "mistral",
      apiKeyConfigured: true,
      configured: true,
      canRevokeApiKey: true,
      connection: { status: "connected" }
    });
    expect(JSON.stringify(saved.configuration)).not.toContain("secret-value");
    expect(saved.configuration?.administration?.history[0]?.changes.map(({ field }) => field))
      .toEqual(["provider", "apiKey", "model", "access", "quota", "conversation"]);
  });

  it("matches host role identifiers exactly and grants access when any configured role matches", async () => {
    const manager = createManager({
      testConnection: async ({ provider, model }) => ({
        success: true,
        model: `${provider}:${model}`,
        latencyMs: 1
      })
    });
    await manager.save({
      provider: "mistral",
      model: "mistral-small-latest",
      apiKey: "secret",
      access: { mode: "roles", roles: ["consumer-admin", "consumer-editor"] }
    }, actor);

    await expect(manager.canUse({ id: "editor", label: "Editor", roles: ["consumer-reader", "consumer-editor"] }))
      .resolves.toBe(true);
    await expect(manager.canUse({ id: "different-case", label: "Different case", roles: ["CONSUMER-EDITOR"] }))
      .resolves.toBe(false);
    await expect(manager.canUse({ id: "unrelated", label: "Unrelated", roles: ["consumer-reader"] }))
      .resolves.toBe(false);
    await expect(manager.canUse({ id: "without-roles", label: "Without roles" }))
      .resolves.toBe(false);
  });

  it("lets only the API-key owner delegate model changes to other administrators", async () => {
    const manager = createManager({
      testConnection: async ({ provider, model }) => ({
        success: true,
        model: `${provider}:${model}`,
        latencyMs: 1
      })
    });
    const ownerInput = {
      provider: "mistral" as const,
      model: "mistral-small-latest",
      apiKey: "secret",
      access: { mode: "all" as const }
    };
    const storedConnectionInput = {
      provider: ownerInput.provider,
      model: ownerInput.model,
      access: ownerInput.access
    };
    const other = { id: "user-b", label: "User B", roles: ["admin"] };
    await manager.save(ownerInput, actor);

    await expect(manager.getView(other)).resolves.toMatchObject({
      canChangeModel: false,
      canManageCredentials: false,
      canManageModelPolicy: false,
      canRevokeApiKey: false
    });
    await expect(manager.save({ ...storedConnectionInput, model: "mistral-large-latest" }, other))
      .rejects.toMatchObject({ status: 403, code: "forbidden" });

    await manager.save({ ...storedConnectionInput, allowModelChangesByOthers: true }, actor);
    await expect(manager.getView(other)).resolves.toMatchObject({
      canChangeModel: true,
      canManageCredentials: false,
      canManageModelPolicy: false,
      canRevokeApiKey: false
    });
    await expect(manager.save({ ...storedConnectionInput, model: "mistral-large-latest" }, other))
      .resolves.toMatchObject({ saved: true });
    await expect(manager.save({
      ...storedConnectionInput,
      model: "mistral-large-latest",
      allowModelChangesByOthers: false
    }, other)).rejects.toMatchObject({ status: 403, code: "forbidden" });
  });

  it("does not call the provider again for auxiliary changes", async () => {
    const testConnection = vi.fn(async ({ provider, model }) => ({
      success: true as const,
      model: `${provider}:${model}`,
      latencyMs: 3
    }));
    const manager = createManager({ testConnection });
    const base = {
      provider: "ollama" as const,
      model: "qwen3",
      access: { mode: "all" as const },
      maxConversationTurns: 3
    };
    await manager.save(base, actor);
    const result = await manager.save({
      ...base,
      quota: { maxRequests: 10, windowSeconds: 300 },
      maxConversationTurns: 5
    }, actor);

    expect(testConnection).toHaveBeenCalledTimes(1);
    expect(result.saved).toBe(true);
    expect(result.reloadRequired).toBe(false);
  });

  it("blocks every provider operation when globally disabled", async () => {
    const testConnection = vi.fn(async () => ({
      success: true as const,
      model: "mistral:mistral-small-latest",
      latencyMs: 1
    }));
    const listModels = vi.fn(async () => []);
    const manager = createManager({
      enabled: false,
      defaultConfiguration: {
        provider: "mistral",
        model: "mistral-small-latest",
        apiKey: "secret",
        access: { mode: "all" }
      },
      testConnection,
      listModels
    });

    expect(await manager.validateRuntimeConnection()).toBe(false);
    expect(await manager.canUse(actor)).toBe(false);
    await expect(manager.testConnection({ provider: "mistral", model: "test" }))
      .rejects.toMatchObject({ status: 503, code: "assistant_disabled" });
    await expect(manager.listModels({ provider: "mistral" }))
      .rejects.toMatchObject({ status: 503, code: "assistant_disabled" });
    expect((await manager.getView(actor)).connection.status).toBe("disabled");
    expect(testConnection).not.toHaveBeenCalled();
    expect(listModels).not.toHaveBeenCalled();
  });

  it("shares one pending provider validation between concurrent callers", async () => {
    let finishValidation: ((result: {
      success: true;
      model: string;
      latencyMs: number;
    }) => void) | undefined;
    const pendingValidation = new Promise<{
      success: true;
      model: string;
      latencyMs: number;
    }>((resolve) => {
      finishValidation = resolve;
    });
    const testConnection = vi.fn(() => pendingValidation);
    const manager = createManager({
      defaultConfiguration: {
        provider: "ollama",
        model: "qwen3",
        access: { mode: "all" }
      },
      testConnection
    });

    const first = manager.ensureRuntimeConnection();
    const second = manager.ensureRuntimeConnection();

    await vi.waitFor(() => expect(testConnection).toHaveBeenCalledOnce());
    finishValidation?.({ success: true, model: "ollama:qwen3", latencyMs: 1 });
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(testConnection).toHaveBeenCalledOnce();
  });

  it("keeps deployment connection fields automatic when only policies are saved", async () => {
    const manager = createManager({
      defaultConfiguration: {
        provider: "ollama",
        model: "qwen3",
        access: { mode: "all" }
      },
      testConnection: async ({ provider, model }) => ({
        success: true,
        model: `${provider}:${model}`,
        latencyMs: 1
      })
    });
    await manager.validateRuntimeConnection();
    const result = await manager.save({
      provider: "ollama",
      model: "qwen3",
      access: { mode: "roles", roles: ["admin"] },
      quota: { maxRequests: 5, windowSeconds: 60 }
    }, actor);

    expect(result.reloadRequired).toBe(false);
    expect(result.configuration?.source).toBe("stored");
    expect(result.configuration?.fieldSources).toMatchObject({
      provider: "environment",
      model: "environment",
      apiKey: "none"
    });
  });

  it("enforces API-key ownership and records revocation", async () => {
    const manager = createManager({
      testConnection: async ({ provider, model }) => ({
        success: true,
        model: `${provider}:${model}`,
        latencyMs: 1
      })
    });
    await manager.save({
      provider: "openai",
      model: "gpt-5-mini",
      apiKey: "secret",
      access: { mode: "all" }
    }, actor);

    await expect(manager.revokeApiKey({ id: "user-b", label: "User B" }))
      .rejects.toMatchObject({ status: 403, code: "forbidden" });
    const view = await manager.revokeApiKey(actor);
    expect(view.apiKeyConfigured).toBe(false);
    expect(view.administration?.history.at(-1)?.changes).toEqual([
      { field: "apiKey", from: "configured", to: "revoked" }
    ]);
  });
});

describe("createPollingAiAppAssistantConfigurationSynchronizer", () => {
  it("notifies other instances but not the publisher", async () => {
    vi.useFakeTimers();
    try {
      const store = createMemoryAiAppAssistantStore();
      const first = createPollingAiAppAssistantConfigurationSynchronizer(store, { intervalMs: 250 });
      const second = createPollingAiAppAssistantConfigurationSynchronizer(store, { intervalMs: 250 });
      const firstChanged = vi.fn();
      const secondChanged = vi.fn();
      const stopFirst = await first.start(firstChanged);
      const stopSecond = await second.start(secondChanged);

      await first.publish({
        reason: "saved",
        reloadRequired: false,
        connectionValidated: false,
        remote: false
      });
      await vi.advanceTimersByTimeAsync(300);

      expect(firstChanged).not.toHaveBeenCalled();
      expect(secondChanged).toHaveBeenCalledTimes(1);
      expect(secondChanged).toHaveBeenCalledWith(expect.objectContaining({ reloadRequired: false }));
      stopFirst();
      stopSecond();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retest providers on remote auxiliary changes", async () => {
    vi.useFakeTimers();
    try {
      const store = createMemoryAiAppAssistantStore();
      const firstTest = vi.fn(async ({ provider, model }) => ({
        success: true as const, model: `${provider}:${model}`, latencyMs: 1
      }));
      const secondTest = vi.fn(async ({ provider, model }) => ({
        success: true as const, model: `${provider}:${model}`, latencyMs: 1
      }));
      const first = new AiAppAssistantConfigurationManager({
        repository: createAiAppAssistantConfigurationRepository({ store, secretProtector: protector }),
        synchronizer: createPollingAiAppAssistantConfigurationSynchronizer(store, { key: "revision", intervalMs: 250 }),
        apiKeyStorageAvailable: true,
        testConnection: firstTest
      });
      const second = new AiAppAssistantConfigurationManager({
        repository: createAiAppAssistantConfigurationRepository({ store, secretProtector: protector }),
        synchronizer: createPollingAiAppAssistantConfigurationSynchronizer(store, { key: "revision", intervalMs: 250 }),
        apiKeyStorageAvailable: true,
        testConnection: secondTest
      });
      const secondEvent = vi.fn();
      second.subscribe(secondEvent);
      await first.startSynchronization();
      await second.startSynchronization();
      const base = { provider: "ollama" as const, model: "qwen3", access: { mode: "all" as const } };
      await first.save(base, actor);
      await vi.advanceTimersByTimeAsync(300);
      secondEvent.mockClear();

      await first.save({ ...base, quota: { maxRequests: 8, windowSeconds: 60 } }, actor);
      await vi.advanceTimersByTimeAsync(300);

      expect(firstTest).toHaveBeenCalledTimes(1);
      expect(secondTest).not.toHaveBeenCalled();
      expect(secondEvent).toHaveBeenCalledWith(expect.objectContaining({
        reloadRequired: false,
        remote: true
      }));
      first.dispose();
      second.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

function createManager(overrides: Partial<ConstructorParameters<typeof AiAppAssistantConfigurationManager>[0]> = {}) {
  const repository = createAiAppAssistantConfigurationRepository({
    store: createMemoryAiAppAssistantStore(),
    secretProtector: protector
  });
  return new AiAppAssistantConfigurationManager({
    repository,
    apiKeyStorageAvailable: true,
    ...overrides
  });
}
