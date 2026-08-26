import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createAes256GcmSecretProtector,
  createAiDocsConfigurationRepository,
  createMemoryAiDocsStore,
  createRedisAiDocsStore
} from "./configuration.js";

describe("AI Docs configuration persistence", () => {
  it("encrypts API keys and never exposes them in configuration views", async () => {
    const raw = new Map<string, string>();
    const store = {
      async get(key: string) { return raw.get(key); },
      async set(key: string, value: string) { raw.set(key, value); },
      async delete(key: string) { raw.delete(key); }
    };
    const repository = createAiDocsConfigurationRepository({
      store,
      secretProtector: createAes256GcmSecretProtector(randomBytes(32).toString("base64"))
    });

    const view = await repository.save({
      provider: "mistral",
      model: "mistral-small-latest",
      apiKey: "very-secret-key",
      access: { mode: "roles", roles: ["ADMIN"] },
      maxConversationTurns: 4
    });

    expect(view).not.toHaveProperty("apiKey");
    expect(view.apiKeyConfigured).toBe(true);
    expect([...raw.values()][0]).not.toContain("very-secret-key");
    await expect(repository.load()).resolves.toMatchObject({
      apiKey: "very-secret-key",
      maxConversationTurns: 4
    });
  });

  it("supports a dependency-free in-memory store", async () => {
    const store = createMemoryAiDocsStore();
    await store.set("key", "value");
    await expect(store.get("key")).resolves.toBe("value");
    await store.delete("key");
    await expect(store.get("key")).resolves.toBeUndefined();
  });

  it("retries atomic mutations instead of losing concurrent changes", async () => {
    const repository = createAiDocsConfigurationRepository({
      store: createMemoryAiDocsStore(),
      secretProtector: { protect: String, unprotect: String }
    });
    await repository.save({ provider: "ollama", model: "qwen3", access: { mode: "all" } });
    let arrivals = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const synchronizeFirstAttempt = async () => {
      arrivals += 1;
      if (arrivals === 2) release();
      await gate;
    };
    let firstQuotaAttempt = true;
    let firstConversationAttempt = true;

    await Promise.all([
      repository.mutate!(async (current) => {
        if (firstQuotaAttempt) {
          firstQuotaAttempt = false;
          await synchronizeFirstAttempt();
        }
        return { ...current!, quota: { maxRequests: 7, windowSeconds: 60 } };
      }),
      repository.mutate!(async (current) => {
        if (firstConversationAttempt) {
          firstConversationAttempt = false;
          await synchronizeFirstAttempt();
        }
        return { ...current!, maxConversationTurns: 5 };
      })
    ]);

    await expect(repository.load()).resolves.toMatchObject({
      quota: { maxRequests: 7, windowSeconds: 60 },
      maxConversationTurns: 5
    });
  });

  it("namespaces keys when reusing a Redis client", async () => {
    const redis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue("OK"),
      del: vi.fn().mockResolvedValue(1)
    };
    const store = createRedisAiDocsStore(redis, { prefix: "test-app:" });

    await store.set("configuration", "value");
    await store.get("configuration");
    await store.delete("configuration");

    expect(redis.set).toHaveBeenCalledWith("test-app:configuration", "value");
    expect(redis.get).toHaveBeenCalledWith("test-app:configuration");
    expect(redis.del).toHaveBeenCalledWith("test-app:configuration");
  });

  it("uses Redis compare-and-set when EVAL is available", async () => {
    const redis = {
      get: vi.fn().mockResolvedValue("previous"),
      set: vi.fn().mockResolvedValue("OK"),
      del: vi.fn().mockResolvedValue(1),
      eval: vi.fn().mockResolvedValue(1)
    };
    const store = createRedisAiDocsStore(redis, { prefix: "test-app:" });

    await expect(store.compareAndSet!("configuration", "previous", "next")).resolves.toBe(true);
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('GET'"),
      1,
      "test-app:configuration",
      "1",
      "previous",
      "next"
    );
  });

  it("persists ownership and audit history without exposing API key values", async () => {
    const repository = createAiDocsConfigurationRepository({
      store: createMemoryAiDocsStore(),
      secretProtector: createAes256GcmSecretProtector(randomBytes(32).toString("base64"))
    });
    const actor = { id: "user-a", label: "User A" };
    const changedAt = new Date().toISOString();

    await repository.save({
      provider: "mistral",
      model: "mistral-small-latest",
      apiKey: "secret",
      access: { mode: "all" },
      administration: {
        keyCreatedBy: actor,
        keyCreatedAt: changedAt,
        modelUpdatedBy: actor,
        modelUpdatedAt: changedAt,
        allowModelChangesByOthers: false,
        history: [{
          id: "change-1",
          actor,
          changedAt,
          changes: [
            { field: "apiKey", to: "configured" },
            { field: "model", to: "mistral-small-latest" }
          ]
        }]
      }
    });

    const view = await repository.loadView();
    expect(view?.administration?.keyCreatedBy).toEqual(actor);
    expect(view?.administration?.history).toHaveLength(1);
    expect(JSON.stringify(view)).not.toContain("secret");
  });
});
