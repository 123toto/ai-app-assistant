import { describe, expect, it, vi } from "vitest";
import {
  createMemoryAiAppAssistantQuotaStore,
  createRedisAiAppAssistantQuotaStore
} from "./quota.js";

describe("AI App Assistant quota stores", () => {
  it("enforces a fixed window in memory", async () => {
    const store = createMemoryAiAppAssistantQuotaStore();
    const policy = { maxRequests: 2, windowSeconds: 60 };

    await expect(store.consume("user@example.test", policy)).resolves.toMatchObject({ allowed: true, remaining: 1 });
    await expect(store.consume("user@example.test", policy)).resolves.toMatchObject({ allowed: true, remaining: 0 });
    await expect(store.consume("user@example.test", policy)).resolves.toMatchObject({ allowed: false, remaining: 0 });
  });

  it("uses one atomic Redis operation and hashes the subject", async () => {
    const redis = { eval: vi.fn().mockResolvedValue([3, 42]) };
    const store = createRedisAiAppAssistantQuotaStore(redis, { prefix: "test-app:quota:" });

    await expect(store.consume("visible-user-id", { maxRequests: 2, windowSeconds: 60 }))
      .resolves.toMatchObject({ allowed: false, retryAfterSeconds: 42 });
    const [, , key, ttl] = redis.eval.mock.calls[0] ?? [];
    expect(key).toMatch(/^test-app:quota:[a-f0-9]{64}$/);
    expect(key).not.toContain("visible-user-id");
    expect(ttl).toBe(60);
  });

  it.each([
    ["empty subjects", "", { maxRequests: 1, windowSeconds: 60 }],
    ["non-positive request limits", "user", { maxRequests: 0, windowSeconds: 60 }],
    ["fractional request limits", "user", { maxRequests: 1.5, windowSeconds: 60 }],
    ["non-positive windows", "user", { maxRequests: 1, windowSeconds: 0 }]
  ])("rejects %s before changing a quota counter", async (_description, subject, policy) => {
    const store = createMemoryAiAppAssistantQuotaStore();
    await expect(store.consume(subject, policy)).rejects.toBeInstanceOf(TypeError);
  });

  it("rejects malformed Redis quota replies", async () => {
    const invalidShape = createRedisAiAppAssistantQuotaStore({ eval: vi.fn().mockResolvedValue("invalid") });
    await expect(invalidShape.consume("user", { maxRequests: 1, windowSeconds: 60 }))
      .rejects.toThrow("invalid quota result");

    const invalidCounter = createRedisAiAppAssistantQuotaStore({
      eval: vi.fn().mockResolvedValue(["not-a-number", 60])
    });
    await expect(invalidCounter.consume("user", { maxRequests: 1, windowSeconds: 60 }))
      .rejects.toThrow("invalid quota counter");
  });
});
