import type { DocumentationSource } from "./types.js";
import {
  createManagedAiAppAssistantFetchHandlers,
  type ManagedAiAppAssistantFetchHandlerOptions,
  type ManagedAiAppAssistantFetchHandlers
} from "./managed-http.js";
import {
  createManagedAiAppAssistantRuntime,
  type CreateManagedAiAppAssistantRuntimeOptions,
  type ManagedAiAppAssistantRuntime
} from "./managed-runtime.js";
import {
  AiAppAssistantConfigurationManager,
  createPollingAiAppAssistantConfigurationSynchronizer,
  type AiAppAssistantConfigurationManagerOptions,
  type AiAppAssistantRuntimeIdentity
} from "./management.js";
import {
  createAes256GcmSecretProtector,
  createAiAppAssistantConfigurationRepository,
  createDisabledSecretProtector,
  createMemoryAiAppAssistantStore,
  createRedisAiAppAssistantStore,
  type AiAppAssistantRedisClient,
  type AiAppAssistantSecretProtector
} from "./configuration.js";
import {
  createMemoryAiAppAssistantQuotaStore,
  createRedisAiAppAssistantQuotaStore,
  type AiAppAssistantRedisQuotaClient,
  type AiAppAssistantQuotaStore
} from "./quota.js";
import {
  createMemoryAiAppAssistantTelemetryStore,
  createRedisAiAppAssistantTelemetryStore,
  type AiAppAssistantTelemetryStore
} from "./telemetry.js";

export type AiAppAssistantManagedStorage =
  | { type: "memory" }
  | {
      type: "redis";
      client: AiAppAssistantRedisClient & AiAppAssistantRedisQuotaClient;
      /** Shared namespace. Defaults to `ai-app-assistant:`. */
      prefix?: string;
      synchronizationIntervalMs?: number;
    };

export interface AiAppAssistantManagedConfigurationSetup extends Omit<
  AiAppAssistantConfigurationManagerOptions,
  "apiKeyStorageAvailable" | "quotaStore" | "repository" | "synchronizer"
> {
  /** Creates configuration, quota and synchronization adapters automatically. */
  storage?: AiAppAssistantManagedStorage;
  /** AES-256-GCM key used to persist administrator-supplied API keys. */
  encryptionKey?: string;
  /** Alternative secret manager; takes precedence over encryptionKey. */
  secretProtector?: AiAppAssistantSecretProtector;
  repositoryKey?: string;
  quotaStore?: AiAppAssistantQuotaStore;
  synchronizer?: AiAppAssistantConfigurationManagerOptions["synchronizer"];
  apiKeyStorageAvailable?: boolean;
}

export interface CreateManagedAiAppAssistantServerOptions<
  TIdentity extends AiAppAssistantRuntimeIdentity,
  TNativeContext = undefined
> {
  /** Pass an existing manager, or its construction options for the common case. */
  configuration:
    | AiAppAssistantConfigurationManager
    | AiAppAssistantConfigurationManagerOptions
    | AiAppAssistantManagedConfigurationSetup;
  /** Stable application documentation. It can also be supplied later with setDocuments(). */
  documents?: DocumentationSource[];
  runtime?: Omit<CreateManagedAiAppAssistantRuntimeOptions<TIdentity>, "configuration" | "documents">;
  http?: Omit<ManagedAiAppAssistantFetchHandlerOptions<TIdentity, TNativeContext>, "runtime">;
  /** Enabled by default; Redis configuration automatically makes it persistent. */
  telemetry?: false | { store?: AiAppAssistantTelemetryStore; recentFailureLimit?: number };
}

export interface ManagedAiAppAssistantServer<
  TIdentity extends AiAppAssistantRuntimeIdentity,
  TNativeContext = undefined
> {
  readonly configuration: AiAppAssistantConfigurationManager;
  readonly runtime: ManagedAiAppAssistantRuntime<TIdentity>;
  readonly fetch: ManagedAiAppAssistantFetchHandlers<TNativeContext>;
  readonly telemetry?: AiAppAssistantTelemetryStore;
  initialize(): Promise<void>;
  setDocuments(documents: DocumentationSource[]): Promise<void>;
  dispose(): void;
}

/**
 * Creates the complete managed assistant: configuration, provider lifecycle,
 * access, quotas, HTTP routes and late-bound documentation.
 *
 * Framework integrations only need to adapt their native request/response and
 * pass the authenticated application identity through `http.resolveIdentity`.
 */
export function createManagedAiAppAssistantServer<
  TIdentity extends AiAppAssistantRuntimeIdentity,
  TNativeContext = undefined
>(
  options: CreateManagedAiAppAssistantServerOptions<TIdentity, TNativeContext>
): ManagedAiAppAssistantServer<TIdentity, TNativeContext> {
  const telemetry = resolveTelemetry(options.configuration, options.telemetry);
  const configuration = resolveConfiguration(options.configuration);
  const runtime = createManagedAiAppAssistantRuntime<TIdentity>({
    configuration,
    ...(options.documents ? { documents: options.documents } : {}),
    ...options.runtime,
    ...(telemetry ? { telemetryStore: telemetry } : {})
  });
  const fetch = createManagedAiAppAssistantFetchHandlers<TIdentity, TNativeContext>({
    runtime,
    ...options.http
  });

  return {
    configuration,
    runtime,
    fetch,
    ...(telemetry ? { telemetry } : {}),
    initialize: () => runtime.initialize(),
    setDocuments: (documents) => runtime.setDocuments(documents),
    dispose: () => runtime.dispose()
  };
}

function resolveTelemetry(
  configuration:
    | AiAppAssistantConfigurationManager
    | AiAppAssistantConfigurationManagerOptions
    | AiAppAssistantManagedConfigurationSetup,
  telemetry: CreateManagedAiAppAssistantServerOptions<AiAppAssistantRuntimeIdentity>["telemetry"]
): AiAppAssistantTelemetryStore | undefined {
  if (telemetry === false) return undefined;
  if (telemetry?.store) return telemetry.store;
  const recentFailureLimit = telemetry?.recentFailureLimit;
  if (!(configuration instanceof AiAppAssistantConfigurationManager)
    && !("repository" in configuration)
    && configuration.storage?.type === "redis") {
    return createRedisAiAppAssistantTelemetryStore(configuration.storage.client, {
      prefix: `${configuration.storage.prefix ?? "ai-app-assistant:"}telemetry:`,
      ...(recentFailureLimit !== undefined ? { recentFailureLimit } : {})
    });
  }
  return createMemoryAiAppAssistantTelemetryStore(
    recentFailureLimit !== undefined ? { recentFailureLimit } : undefined
  );
}

function resolveConfiguration(
  configuration:
    | AiAppAssistantConfigurationManager
    | AiAppAssistantConfigurationManagerOptions
    | AiAppAssistantManagedConfigurationSetup
): AiAppAssistantConfigurationManager {
  // Keep advanced/custom managers untouched; assemble storage, encryption,
  // quotas and synchronization only for the plug-and-play configuration.
  if (configuration instanceof AiAppAssistantConfigurationManager) return configuration;
  if ("repository" in configuration) return new AiAppAssistantConfigurationManager(configuration);

  const {
    storage = { type: "memory" },
    encryptionKey,
    secretProtector,
    repositoryKey,
    quotaStore,
    synchronizer,
    apiKeyStorageAvailable,
    ...manager
  } = configuration;
  const prefix = storage.type === "redis" ? storage.prefix ?? "ai-app-assistant:" : "ai-app-assistant:";
  const store = storage.type === "redis"
    ? createRedisAiAppAssistantStore(storage.client, { prefix: `${prefix}persistent:` })
    : createMemoryAiAppAssistantStore();
  const protector = secretProtector
    ?? (encryptionKey
      ? createAes256GcmSecretProtector(encryptionKey)
      : createDisabledSecretProtector());
  return new AiAppAssistantConfigurationManager({
    ...manager,
    repository: createAiAppAssistantConfigurationRepository({
      store,
      secretProtector: protector,
      ...(repositoryKey ? { key: repositoryKey } : {})
    }),
    quotaStore: quotaStore ?? (storage.type === "redis"
      ? createRedisAiAppAssistantQuotaStore(storage.client, { prefix: `${prefix}quota:` })
      : createMemoryAiAppAssistantQuotaStore()),
    apiKeyStorageAvailable: apiKeyStorageAvailable ?? Boolean(secretProtector || encryptionKey),
    ...(synchronizer ? { synchronizer } : storage.type === "redis" ? {
      synchronizer: createPollingAiAppAssistantConfigurationSynchronizer(store, {
        key: "configuration-revision",
        intervalMs: storage.synchronizationIntervalMs ?? 2_000
      })
    } : {})
  });
}
