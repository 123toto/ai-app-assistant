import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  testAiSdkConnection,
  type AiSdkConnectionTestResult
} from "./ai-sdk.js";
import type { BuiltInProvider } from "./provider-catalog.js";

/** Generic access rule; host applications map their own roles and user IDs. */
export type AiAppAssistantAccessRule =
  | { mode: "all" }
  | { mode: "roles"; roles: string[] }
  | { mode: "users"; userIds: string[] };

/** Stable identity used for ownership and audit without coupling the library to a user directory. */
export interface AiAppAssistantConfigurationActor {
  id: string;
  label: string;
}

export type AiAppAssistantConfigurationAuditField =
  | "provider"
  | "apiKey"
  | "model"
  | "access"
  | "quota"
  | "conversation"
  | "modelChangePolicy";

/** One safe configuration change. API key values must never be placed in from/to. */
export interface AiAppAssistantConfigurationAuditChange {
  field: AiAppAssistantConfigurationAuditField;
  from?: string;
  to?: string;
}

export interface AiAppAssistantConfigurationAuditEntry {
  id: string;
  actor: AiAppAssistantConfigurationActor;
  changedAt: string;
  changes: AiAppAssistantConfigurationAuditChange[];
}

/** Ownership and persisted audit metadata managed by the host application's authenticated backend. */
export interface AiAppAssistantConfigurationAdministration {
  keyCreatedBy?: AiAppAssistantConfigurationActor;
  keyCreatedAt?: string;
  modelUpdatedBy?: AiAppAssistantConfigurationActor;
  modelUpdatedAt?: string;
  allowModelChangesByOthers: boolean;
  history: AiAppAssistantConfigurationAuditEntry[];
}

/** Provider configuration owned by the library and persisted by an adapter. */
export interface AiAppAssistantConfiguration {
  provider: BuiltInProvider;
  model: string;
  /** Whether provider fields override deployment defaults or merely accompany stored policies. */
  connectionSource?: "environment" | "override";
  apiKey?: string;
  baseURL?: string;
  access: AiAppAssistantAccessRule;
  quota?: {
    maxRequests: number;
    windowSeconds: number;
  };
  /** Maximum number of user questions kept in one assistant conversation. */
  maxConversationTurns?: number;
  administration?: AiAppAssistantConfigurationAdministration;
}

/** Safe representation returned to a frontend; it never contains the secret. */
export type AiAppAssistantConfigurationView = Omit<AiAppAssistantConfiguration, "apiKey"> & {
  apiKeyConfigured: boolean;
};

/** Minimal persistence contract supported by Redis, databases or secret stores. */
export interface AiAppAssistantKeyValueStore {
  get(key: string): Promise<string | null | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Optional atomic compare-and-set used to prevent lost concurrent updates. */
  compareAndSet?(key: string, expected: string | null, value: string): Promise<boolean>;
}

/** Secret protection is explicit so plaintext keys can never be persisted. */
export interface AiAppAssistantSecretProtector {
  protect(secret: string): Promise<string> | string;
  unprotect(protectedSecret: string): Promise<string> | string;
}

export interface AiAppAssistantConfigurationRepository {
  load(): Promise<AiAppAssistantConfiguration | undefined>;
  loadView(): Promise<AiAppAssistantConfigurationView | undefined>;
  save(configuration: AiAppAssistantConfiguration): Promise<AiAppAssistantConfigurationView>;
  /** Atomic when the underlying key/value store supports compare-and-set. */
  mutate?(
    update: (current: AiAppAssistantConfiguration | undefined) => AiAppAssistantConfiguration | Promise<AiAppAssistantConfiguration>
  ): Promise<AiAppAssistantConfigurationView>;
  clear(): Promise<void>;
}

export interface CreateAiAppAssistantConfigurationRepositoryOptions {
  store: AiAppAssistantKeyValueStore;
  secretProtector: AiAppAssistantSecretProtector;
  /** Allows several applications or environments to share one storage system. */
  key?: string;
}

export class AiAppAssistantConfigurationConflictError extends Error {
  public constructor() {
    super("AI App Assistant configuration changed concurrently; retry the operation");
    this.name = "AiAppAssistantConfigurationConflictError";
  }
}

const accessRuleSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }),
  z.object({ mode: z.literal("roles"), roles: z.array(z.string().min(1)).min(1) }),
  z.object({ mode: z.literal("users"), userIds: z.array(z.string().min(1)).min(1) })
]);

const actorSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1)
});

const administrationSchema = z.object({
  keyCreatedBy: actorSchema.optional(),
  keyCreatedAt: z.string().datetime().optional(),
  modelUpdatedBy: actorSchema.optional(),
  modelUpdatedAt: z.string().datetime().optional(),
  allowModelChangesByOthers: z.boolean(),
  history: z.array(z.object({
    id: z.string().min(1),
    actor: actorSchema,
    changedAt: z.string().datetime(),
    changes: z.array(z.object({
      field: z.enum(["provider", "apiKey", "model", "access", "quota", "conversation", "modelChangePolicy"]),
      from: z.string().optional(),
      to: z.string().optional()
    })).min(1)
  })).max(200)
});

const persistedConfigurationSchema = z.object({
  version: z.literal(1),
  provider: z.enum(["anthropic", "google", "mistral", "ollama", "openai"]),
  model: z.string().min(1),
  connectionSource: z.enum(["environment", "override"]).optional(),
  protectedApiKey: z.string().min(1).optional(),
  baseURL: z.string().url().optional(),
  access: accessRuleSchema,
  quota: z.object({
    maxRequests: z.number().int().positive(),
    windowSeconds: z.number().int().positive()
  }).optional(),
  maxConversationTurns: z.number().int().min(1).max(10).optional(),
  administration: administrationSchema.optional()
});

/** Creates a repository that validates and encrypts configuration data. */
export function createAiAppAssistantConfigurationRepository(
  options: CreateAiAppAssistantConfigurationRepositoryOptions
): AiAppAssistantConfigurationRepository {
  const key = options.key?.trim() || "ai-app-assistant:configuration";

  const deserialize = async (serialized: string | null | undefined): Promise<AiAppAssistantConfiguration | undefined> => {
    if (!serialized) return undefined;
    const stored = persistedConfigurationSchema.parse(JSON.parse(serialized) as unknown);
    const apiKey = stored.protectedApiKey
      ? await options.secretProtector.unprotect(stored.protectedApiKey)
      : undefined;
    return {
      provider: stored.provider,
      model: stored.model,
      ...(stored.connectionSource ? { connectionSource: stored.connectionSource } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(stored.baseURL ? { baseURL: stored.baseURL } : {}),
      access: stored.access,
      ...(stored.quota ? { quota: stored.quota } : {}),
      ...(stored.maxConversationTurns ? { maxConversationTurns: stored.maxConversationTurns } : {}),
      ...(stored.administration ? { administration: normalizeAdministration(stored.administration) } : {})
    };
  };

  const load = async (): Promise<AiAppAssistantConfiguration | undefined> => deserialize(await options.store.get(key));

  const serialize = async (configuration: AiAppAssistantConfiguration): Promise<{
    normalized: AiAppAssistantConfiguration;
    serialized: string;
  }> => {
    const normalized = normalizeConfiguration(configuration);
    const protectedApiKey = normalized.apiKey
      ? await options.secretProtector.protect(normalized.apiKey)
      : undefined;
    return {
      normalized,
      serialized: JSON.stringify({
        version: 1,
        provider: normalized.provider,
        model: normalized.model,
        ...(normalized.connectionSource ? { connectionSource: normalized.connectionSource } : {}),
        ...(protectedApiKey ? { protectedApiKey } : {}),
        ...(normalized.baseURL ? { baseURL: normalized.baseURL } : {}),
        access: normalized.access,
        ...(normalized.quota ? { quota: normalized.quota } : {}),
        ...(normalized.maxConversationTurns ? { maxConversationTurns: normalized.maxConversationTurns } : {}),
        ...(normalized.administration ? { administration: normalized.administration } : {})
      })
    };
  };

  return {
    load,
    async loadView() {
      const configuration = await load();
      return configuration ? toConfigurationView(configuration) : undefined;
    },
    async save(configuration) {
      const { normalized, serialized } = await serialize(configuration);
      await options.store.set(key, serialized);
      return toConfigurationView(normalized);
    },
    async mutate(update) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const previousSerialized = await options.store.get(key);
        const next = await update(await deserialize(previousSerialized));
        const { normalized, serialized } = await serialize(next);
        if (!options.store.compareAndSet ||
          await options.store.compareAndSet(key, previousSerialized ?? null, serialized)) {
          if (!options.store.compareAndSet) await options.store.set(key, serialized);
          return toConfigurationView(normalized);
        }
      }
      throw new AiAppAssistantConfigurationConflictError();
    },
    async clear() {
      await options.store.delete(key);
    }
  };
}

/**
 * Tests the exact model configuration and persists it only after a successful
 * structured-output response.
 */
export async function validateAndSaveAiAppAssistantConfiguration(
  repository: AiAppAssistantConfigurationRepository,
  configuration: AiAppAssistantConfiguration,
  options?: { timeoutMs?: number }
): Promise<{
  saved: boolean;
  connection: AiSdkConnectionTestResult;
  configuration?: AiAppAssistantConfigurationView;
}> {
  const normalized = normalizeConfiguration(configuration);
  const connection = await testAiSdkConnection({
    model: `${normalized.provider}:${normalized.model}`,
    ...(normalized.apiKey ? { apiKey: normalized.apiKey } : {}),
    ...(normalized.baseURL ? { baseURL: normalized.baseURL } : {}),
    ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {})
  });
  if (!connection.success) return { saved: false, connection };
  return {
    saved: true,
    connection,
    configuration: await repository.save(normalized)
  };
}

/**
 * AES-256-GCM protector for applications that keep configuration outside a
 * dedicated secret manager. The key must be a random 32-byte base64 value.
 */
export function createAes256GcmSecretProtector(base64Key: string): AiAppAssistantSecretProtector {
  const key = Buffer.from(base64Key.trim(), "base64");
  if (key.length !== 32) {
    throw new TypeError("The secret protection key must contain exactly 32 base64-encoded bytes");
  }
  const additionalData = Buffer.from("ai-app-assistant-configuration:v1", "utf8");

  return {
    protect(secret) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(additionalData);
      const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
      return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
    },
    unprotect(protectedSecret) {
      const [version, ivValue, tagValue, encryptedValue] = protectedSecret.split(".");
      if (version !== "v1" || !ivValue || !tagValue || !encryptedValue) {
        throw new TypeError("Unsupported protected secret format");
      }
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64url"));
      decipher.setAAD(additionalData);
      decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(encryptedValue, "base64url")),
        decipher.final()
      ]).toString("utf8");
    }
  };
}

/**
 * Allows environment-only configurations while failing closed if a caller
 * attempts to persist a secret without configuring encryption.
 */
export function createDisabledSecretProtector(): AiAppAssistantSecretProtector {
  const unavailable = (): never => {
    throw new Error("Secret persistence requires a configured secret protector");
  };
  return { protect: unavailable, unprotect: unavailable };
}

/** Lightweight local store useful for tests and single-process prototypes. */
export function createMemoryAiAppAssistantStore(): AiAppAssistantKeyValueStore {
  const values = new Map<string, string>();
  return {
    async get(key) { return values.get(key); },
    async set(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
    async compareAndSet(key, expected, value) {
      const current = values.get(key) ?? null;
      if (current !== expected) return false;
      values.set(key, value);
      return true;
    }
  };
}

/** Minimal Redis shape; consumers can pass an existing ioredis-like client. */
export interface AiAppAssistantRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<number>;
  eval?(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
}

/** Reuses the host application's Redis connection without adding a dependency. */
export function createRedisAiAppAssistantStore(
  client: AiAppAssistantRedisClient,
  options?: { prefix?: string }
): AiAppAssistantKeyValueStore {
  const prefix = options?.prefix ?? "ai-app-assistant:";
  const namespaced = (key: string) => `${prefix}${key}`;
  return {
    get: (key) => client.get(namespaced(key)),
    async set(key, value) { await client.set(namespaced(key), value); },
    async delete(key) { await client.del(namespaced(key)); },
    ...(client.eval ? {
      async compareAndSet(key: string, expected: string | null, value: string) {
        const result = await client.eval!(COMPARE_AND_SET_SCRIPT, 1, namespaced(key), expected === null ? "0" : "1", expected ?? "", value);
        return Number(result) === 1;
      }
    } : {})
  };
}

function normalizeConfiguration(configuration: AiAppAssistantConfiguration): AiAppAssistantConfiguration {
  const parsed = persistedConfigurationSchema.omit({ version: true, protectedApiKey: true }).extend({
    apiKey: z.string().min(1).optional()
  }).parse({
    ...configuration,
    model: configuration.model.trim(),
    apiKey: configuration.apiKey?.trim() || undefined
  });
  return {
    provider: parsed.provider,
    model: parsed.model,
    ...(parsed.connectionSource ? { connectionSource: parsed.connectionSource } : {}),
    access: parsed.access,
    ...(parsed.apiKey ? { apiKey: parsed.apiKey } : {}),
    ...(parsed.baseURL ? { baseURL: parsed.baseURL } : {}),
    ...(parsed.quota ? { quota: parsed.quota } : {}),
    ...(parsed.maxConversationTurns ? { maxConversationTurns: parsed.maxConversationTurns } : {}),
    ...(parsed.administration ? { administration: normalizeAdministration(parsed.administration) } : {})
  };
}

const COMPARE_AND_SET_SCRIPT = `
  if ARGV[1] == '0' then
    if redis.call('EXISTS', KEYS[1]) == 0 then
      redis.call('SET', KEYS[1], ARGV[3])
      return 1
    end
    return 0
  end
  if redis.call('GET', KEYS[1]) == ARGV[2] then
    redis.call('SET', KEYS[1], ARGV[3])
    return 1
  end
  return 0
`;

function normalizeAdministration(
  administration: z.infer<typeof administrationSchema>
): AiAppAssistantConfigurationAdministration {
  return {
    ...(administration.keyCreatedBy ? { keyCreatedBy: administration.keyCreatedBy } : {}),
    ...(administration.keyCreatedAt ? { keyCreatedAt: administration.keyCreatedAt } : {}),
    ...(administration.modelUpdatedBy ? { modelUpdatedBy: administration.modelUpdatedBy } : {}),
    ...(administration.modelUpdatedAt ? { modelUpdatedAt: administration.modelUpdatedAt } : {}),
    allowModelChangesByOthers: administration.allowModelChangesByOthers,
    history: administration.history.map((entry) => ({
      id: entry.id,
      actor: entry.actor,
      changedAt: entry.changedAt,
      changes: entry.changes.map((change) => ({
        field: change.field,
        ...(change.from !== undefined ? { from: change.from } : {}),
        ...(change.to !== undefined ? { to: change.to } : {})
      }))
    }))
  };
}

function toConfigurationView(configuration: AiAppAssistantConfiguration): AiAppAssistantConfigurationView {
  const { apiKey, ...view } = configuration;
  return { ...view, apiKeyConfigured: Boolean(apiKey) };
}
