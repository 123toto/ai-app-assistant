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
});
