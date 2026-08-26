import { createHash } from "node:crypto";

export interface AiAppAssistantQuotaPolicy {
  maxRequests: number;
  windowSeconds: number;
}

export interface AiAppAssistantQuotaResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  resetAt: Date;
}

/** Atomic quota contract implemented by shared or local stores. */
export interface AiAppAssistantQuotaStore {
  consume(subject: string, policy: AiAppAssistantQuotaPolicy): Promise<AiAppAssistantQuotaResult>;
}

/** Single-process implementation intended for tests and local development. */
export function createMemoryAiAppAssistantQuotaStore(): AiAppAssistantQuotaStore {
  const counters = new Map<string, { count: number; resetAt: number }>();
  return {
    async consume(subject, policy) {
      const normalized = normalizePolicy(policy);
      const key = fingerprint(subject);
      const now = Date.now();
      let counter = counters.get(key);
      if (!counter || counter.resetAt <= now) {
        counter = { count: 0, resetAt: now + normalized.windowSeconds * 1_000 };
        counters.set(key, counter);
      }
      counter.count += 1;
      return quotaResult(counter.count, counter.resetAt, normalized.maxRequests, now);
    }
  };
}

/** Minimal ioredis-compatible shape needed for one atomic Lua operation. */
export interface AiAppAssistantRedisQuotaClient {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

/**
 * Redis quota with one atomic increment/expiry operation. Subject identifiers
 * are SHA-256 fingerprints, never readable user IDs.
 */
export function createRedisAiAppAssistantQuotaStore(
  client: AiAppAssistantRedisQuotaClient,
  options?: { prefix?: string }
): AiAppAssistantQuotaStore {
  const prefix = options?.prefix ?? "ai-app-assistant:quota:";
  return {
    async consume(subject, policy) {
      const normalized = normalizePolicy(policy);
      const key = `${prefix}${fingerprint(subject)}`;
      const raw = await client.eval(REDIS_QUOTA_SCRIPT, 1, key, normalized.windowSeconds);
      if (!Array.isArray(raw) || raw.length < 2) {
        throw new Error("Redis returned an invalid quota result");
      }
      const count = Number(raw[0]);
      const retryAfterSeconds = Math.max(0, Number(raw[1]));
      if (!Number.isFinite(count) || !Number.isFinite(retryAfterSeconds)) {
        throw new Error("Redis returned an invalid quota counter");
      }
      const now = Date.now();
      return quotaResult(
        count,
        now + retryAfterSeconds * 1_000,
        normalized.maxRequests,
        now
      );
    }
  };
}

const REDIS_QUOTA_SCRIPT = [
  "local count = redis.call('INCR', KEYS[1])",
  "if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end",
  "local ttl = redis.call('TTL', KEYS[1])",
  "return {count, ttl}"
].join("\n");

function normalizePolicy(policy: AiAppAssistantQuotaPolicy): AiAppAssistantQuotaPolicy {
  if (!Number.isInteger(policy.maxRequests) || policy.maxRequests < 1) {
    throw new TypeError("maxRequests must be a positive integer");
  }
  if (!Number.isInteger(policy.windowSeconds) || policy.windowSeconds < 1) {
    throw new TypeError("windowSeconds must be a positive integer");
  }
  return policy;
}

function fingerprint(subject: string): string {
  const normalized = subject.trim();
  if (!normalized) throw new TypeError("A quota subject is required");
  return createHash("sha256").update(normalized).digest("hex");
}

function quotaResult(
  count: number,
  resetAt: number,
  maxRequests: number,
  now: number
): AiAppAssistantQuotaResult {
  return {
    allowed: count <= maxRequests,
    remaining: Math.max(0, maxRequests - count),
    retryAfterSeconds: Math.max(0, Math.ceil((resetAt - now) / 1_000)),
    resetAt: new Date(resetAt)
  };
}
