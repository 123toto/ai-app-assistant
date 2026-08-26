import type { DocumentationSource } from "./types.js";
import {
  createManagedAiDocsFetchHandlers,
  type ManagedAiDocsFetchHandlerOptions,
  type ManagedAiDocsFetchHandlers
} from "./managed-http.js";
import {
  createManagedAiDocsRuntime,
  type CreateManagedAiDocsRuntimeOptions,
  type ManagedAiDocsRuntime
} from "./managed-runtime.js";
import {
  AiDocsConfigurationManager,
  createPollingAiDocsConfigurationSynchronizer,
  type AiDocsConfigurationManagerOptions,
  type AiDocsRuntimeIdentity
} from "./management.js";
import {
  createAes256GcmSecretProtector,
  createAiDocsConfigurationRepository,
  createDisabledSecretProtector,
  createMemoryAiDocsStore,
  createRedisAiDocsStore,
  type AiDocsRedisClient,
  type AiDocsSecretProtector
} from "./configuration.js";
import {
  createMemoryAiDocsQuotaStore,
  createRedisAiDocsQuotaStore,
  type AiDocsRedisQuotaClient,
  type AiDocsQuotaStore
} from "./quota.js";
import {
  createMemoryAiDocsTelemetryStore,
  createRedisAiDocsTelemetryStore,
  type AiDocsTelemetryStore
} from "./telemetry.js";

export type AiDocsManagedStorage =
  | { type: "memory" }
  | {
      type: "redis";
      client: AiDocsRedisClient & AiDocsRedisQuotaClient;
      /** Shared namespace. Defaults to `ai-docs:`. */
      prefix?: string;
      synchronizationIntervalMs?: number;
    };

export interface AiDocsManagedConfigurationSetup extends Omit<
  AiDocsConfigurationManagerOptions,
  "apiKeyStorageAvailable" | "quotaStore" | "repository" | "synchronizer"
> {
  /** Creates configuration, quota and synchronization adapters automatically. */
  storage?: AiDocsManagedStorage;
  /** AES-256-GCM key used to persist administrator-supplied API keys. */
  encryptionKey?: string;
  /** Alternative secret manager; takes precedence over encryptionKey. */
  secretProtector?: AiDocsSecretProtector;
  repositoryKey?: string;
  quotaStore?: AiDocsQuotaStore;
  synchronizer?: AiDocsConfigurationManagerOptions["synchronizer"];
  apiKeyStorageAvailable?: boolean;
}

export interface CreateManagedAiDocsServerOptions<
  TIdentity extends AiDocsRuntimeIdentity,
  TNativeContext = undefined
> {
  /** Pass an existing manager, or its construction options for the common case. */
  configuration:
    | AiDocsConfigurationManager
    | AiDocsConfigurationManagerOptions
    | AiDocsManagedConfigurationSetup;
  /** Stable application documentation. It can also be supplied later with setDocuments(). */
  documents?: DocumentationSource[];
  runtime?: Omit<CreateManagedAiDocsRuntimeOptions<TIdentity>, "configuration" | "documents">;
  http?: Omit<ManagedAiDocsFetchHandlerOptions<TIdentity, TNativeContext>, "runtime">;
  /** Enabled by default; Redis configuration automatically makes it persistent. */
  telemetry?: false | { store?: AiDocsTelemetryStore; recentFailureLimit?: number };
}

export interface ManagedAiDocsServer<
  TIdentity extends AiDocsRuntimeIdentity,
  TNativeContext = undefined
> {
  readonly configuration: AiDocsConfigurationManager;
  readonly runtime: ManagedAiDocsRuntime<TIdentity>;
  readonly fetch: ManagedAiDocsFetchHandlers<TNativeContext>;
  readonly telemetry?: AiDocsTelemetryStore;
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
export function createManagedAiDocsServer<
  TIdentity extends AiDocsRuntimeIdentity,
  TNativeContext = undefined
>(
  options: CreateManagedAiDocsServerOptions<TIdentity, TNativeContext>
): ManagedAiDocsServer<TIdentity, TNativeContext> {
  const telemetry = resolveTelemetry(options.configuration, options.telemetry);
  const configuration = resolveConfiguration(options.configuration);
  const runtime = createManagedAiDocsRuntime<TIdentity>({
    configuration,
    ...(options.documents ? { documents: options.documents } : {}),
    ...options.runtime,
    ...(telemetry ? { telemetryStore: telemetry } : {})
  });
  const fetch = createManagedAiDocsFetchHandlers<TIdentity, TNativeContext>({
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
    | AiDocsConfigurationManager
    | AiDocsConfigurationManagerOptions
    | AiDocsManagedConfigurationSetup,
  telemetry: CreateManagedAiDocsServerOptions<AiDocsRuntimeIdentity>["telemetry"]
): AiDocsTelemetryStore | undefined {
  if (telemetry === false) return undefined;
  if (telemetry?.store) return telemetry.store;
  const recentFailureLimit = telemetry?.recentFailureLimit;
  if (!(configuration instanceof AiDocsConfigurationManager)
    && !("repository" in configuration)
    && configuration.storage?.type === "redis") {
    return createRedisAiDocsTelemetryStore(configuration.storage.client, {
      prefix: `${configuration.storage.prefix ?? "ai-docs:"}telemetry:`,
      ...(recentFailureLimit !== undefined ? { recentFailureLimit } : {})
    });
  }
  return createMemoryAiDocsTelemetryStore(
    recentFailureLimit !== undefined ? { recentFailureLimit } : undefined
  );
}

function resolveConfiguration(
  configuration:
    | AiDocsConfigurationManager
    | AiDocsConfigurationManagerOptions
    | AiDocsManagedConfigurationSetup
): AiDocsConfigurationManager {
  // Keep advanced/custom managers untouched; assemble storage, encryption,
  // quotas and synchronization only for the plug-and-play configuration.
  if (configuration instanceof AiDocsConfigurationManager) return configuration;
  if ("repository" in configuration) return new AiDocsConfigurationManager(configuration);

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
  const prefix = storage.type === "redis" ? storage.prefix ?? "ai-docs:" : "ai-docs:";
  const store = storage.type === "redis"
    ? createRedisAiDocsStore(storage.client, { prefix: `${prefix}persistent:` })
    : createMemoryAiDocsStore();
  const protector = secretProtector
    ?? (encryptionKey
      ? createAes256GcmSecretProtector(encryptionKey)
      : createDisabledSecretProtector());
  return new AiDocsConfigurationManager({
    ...manager,
    repository: createAiDocsConfigurationRepository({
      store,
      secretProtector: protector,
      ...(repositoryKey ? { key: repositoryKey } : {})
    }),
    quotaStore: quotaStore ?? (storage.type === "redis"
      ? createRedisAiDocsQuotaStore(storage.client, { prefix: `${prefix}quota:` })
      : createMemoryAiDocsQuotaStore()),
    apiKeyStorageAvailable: apiKeyStorageAvailable ?? Boolean(secretProtector || encryptionKey),
    ...(synchronizer ? { synchronizer } : storage.type === "redis" ? {
      synchronizer: createPollingAiDocsConfigurationSynchronizer(store, {
        key: "configuration-revision",
        intervalMs: storage.synchronizationIntervalMs ?? 2_000
      })
    } : {})
  });
}
