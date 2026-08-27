import { createHash, randomUUID } from "node:crypto";
import type {
  AiAppAssistantConfigurationFieldSource,
  AiAppAssistantConfigurationInput,
  AiAppAssistantConnectionResult,
  AiAppAssistantConnectionTestInput,
  AiAppAssistantCredentials,
  AiAppAssistantManagedConfigurationView,
  AiAppAssistantRuntimeConnection
} from "@123toto/ai-app-assistant-contracts";
import {
  type AiAppAssistantConfiguration,
  type AiAppAssistantConfigurationActor,
  type AiAppAssistantConfigurationAdministration,
  type AiAppAssistantConfigurationAuditChange,
  type AiAppAssistantConfigurationAuditEntry,
  AiAppAssistantConfigurationConflictError,
  type AiAppAssistantConfigurationRepository,
  type AiAppAssistantKeyValueStore
} from "./configuration.js";
import {
  createMemoryAiAppAssistantQuotaStore,
  type AiAppAssistantQuotaPolicy,
  type AiAppAssistantQuotaResult,
  type AiAppAssistantQuotaStore
} from "./quota.js";
import {
  listAiModels,
  listAiProviders,
  type AiModelInfo,
  type AiProviderInfo
} from "./provider-catalog.js";
import {
  testAiSdkConnection,
  type AiSdkConnectionTestResult
} from "./ai-sdk.js";

/** Minimal identity understood by the generic access and audit policies. */
export interface AiAppAssistantRuntimeIdentity extends AiAppAssistantConfigurationActor {
  roles?: readonly string[];
}

export interface AiAppAssistantConfigurationChangeEvent {
  reason: "saved" | "revoked" | "connection-tested" | "remote-change";
  reloadRequired: boolean;
  /** A successful provider call already validated the current configuration. */
  connectionValidated: boolean;
  remote: boolean;
}

export interface AiAppAssistantConfigurationSynchronizer {
  start(onChange: (event: AiAppAssistantConfigurationChangeEvent) => Promise<void> | void): Promise<() => void> | (() => void);
  publish(event: AiAppAssistantConfigurationChangeEvent): Promise<void>;
}

export interface AiAppAssistantConfigurationManagerOptions {
  repository: AiAppAssistantConfigurationRepository;
  /** Global kill switch. When false, no provider operation is allowed. */
  enabled?: boolean | (() => boolean);
  /** Defaults to the local in-memory quota implementation. */
  quotaStore?: AiAppAssistantQuotaStore;
  /** Environment or deployment defaults. They are never persisted automatically. */
  defaultConfiguration?: AiAppAssistantConfiguration | (() => AiAppAssistantConfiguration | undefined);
  /** Resolves a secret supplied by the host environment or secret manager. */
  resolveDefaultApiKey?: (provider: AiAppAssistantConfiguration["provider"]) => string | undefined;
  apiKeyStorageAvailable?: boolean;
  defaultQuota?: AiAppAssistantQuotaPolicy;
  connectionTimeoutMs?: number;
  /** Minimum delay before retrying a disconnected provider on demand. */
  reconnectIntervalMs?: number;
  synchronizer?: AiAppAssistantConfigurationSynchronizer;
  testConnection?: (input: AiAppAssistantConnectionTestInput) => Promise<AiAppAssistantConnectionResult>;
  listModels?: (input: AiAppAssistantCredentials) => Promise<AiModelInfo[]>;
  now?: () => Date;
  createId?: () => string;
  logger?: Pick<Console, "info" | "warn">;
}

export interface AiAppAssistantConfigurationSaveResult {
  saved: boolean;
  connection: AiAppAssistantConnectionResult;
  configuration?: AiAppAssistantManagedConfigurationView;
  reloadRequired: boolean;
}

export type AiAppAssistantManagementErrorCode =
  | "unauthorized"
  | "forbidden"
  | "conflict"
  | "invalid_request"
  | "not_configured"
  | "assistant_disabled"
  | "quota_reached"
  | "secret_storage_unavailable";

/** Framework-neutral policy error that HTTP adapters can map safely. */
export class AiAppAssistantManagementError extends Error {
  public constructor(
    readonly status: number,
    readonly code: AiAppAssistantManagementErrorCode,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "AiAppAssistantManagementError";
  }
}

/**
 * Owns provider configuration, access, quota, audit and runtime connection
 * state. Hosts only supply identity mapping, storage and optional defaults.
 */
export class AiAppAssistantConfigurationManager {
  readonly #repository: AiAppAssistantConfigurationRepository;
  readonly #quotaStore: AiAppAssistantQuotaStore;
  readonly #options: AiAppAssistantConfigurationManagerOptions;
  readonly #listeners = new Set<(event: AiAppAssistantConfigurationChangeEvent) => Promise<void> | void>();
  #runtimeConnection: AiAppAssistantRuntimeConnection = { status: "unchecked" };
  #recentConnectionValidation: {
    signature: string;
    result: Extract<AiAppAssistantConnectionResult, { success: true }>;
    expiresAt: number;
  } | undefined;
  #stopSynchronization: (() => void) | undefined;
  #synchronizing = false;
  #lastReconnectAttempt = 0;
  #reconnectPromise: Promise<boolean> | undefined;

  public constructor(options: AiAppAssistantConfigurationManagerOptions) {
    this.#options = options;
    this.#repository = options.repository;
    this.#quotaStore = options.quotaStore ?? createMemoryAiAppAssistantQuotaStore();
  }

  /** Returns the current state of the host-controlled global kill switch. */
  public isEnabled(): boolean {
    return typeof this.#options.enabled === "function"
      ? this.#options.enabled()
      : this.#options.enabled ?? true;
  }

  /** Returns the built-in provider catalogue; no credentials are exposed. */
  public listProviders(): AiProviderInfo[] {
    return listAiProviders();
  }

  /** Discovers models with an explicit key or the currently configured secret. */
  public async listModels(input: AiAppAssistantCredentials): Promise<AiModelInfo[]> {
    this.assertEnabled();
    const apiKey = await this.resolveApiKey(input.provider, input.apiKey);
    if (this.#options.listModels) {
      return this.#options.listModels({ ...input, ...(apiKey ? { apiKey } : {}) });
    }
    return listAiModels({
      provider: input.provider,
      ...(apiKey ? { apiKey } : {}),
      ...(input.baseURL ? { baseURL: input.baseURL } : {})
    });
  }

  /** Notifies the runtime when a provider-affecting setting changes. */
  public subscribe(listener: (event: AiAppAssistantConfigurationChangeEvent) => Promise<void> | void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Starts optional cross-instance invalidation. Calling it repeatedly is safe. */
  public async startSynchronization(): Promise<void> {
    if (!this.#options.synchronizer || this.#stopSynchronization) return;
    this.#stopSynchronization = await this.#options.synchronizer.start(async (event) => {
      if (this.#synchronizing) return;
      this.#synchronizing = true;
      try {
        let connected = event.connectionValidated;
        if (event.reloadRequired) {
          this.#recentConnectionValidation = undefined;
          if (!this.isEnabled()) {
            connected = false;
            this.#runtimeConnection = { status: "disabled", checkedAt: this.now() };
          } else if (connected) {
            const configuration = await this.getRuntimeConfiguration();
            this.#runtimeConnection = configuration
              ? {
                  status: "connected",
                  checkedAt: this.now(),
                  model: `${configuration.provider}:${configuration.model}`
                }
              : { status: "not-configured", checkedAt: this.now() };
            connected = Boolean(configuration);
          } else {
            connected = await this.validateRuntimeConnection();
          }
        }
        await this.emit({
          ...event,
          reloadRequired: event.reloadRequired,
          connectionValidated: connected,
          remote: true
        });
      } finally {
        this.#synchronizing = false;
      }
    });
  }

  public dispose(): void {
    this.#stopSynchronization?.();
    this.#stopSynchronization = undefined;
    this.#listeners.clear();
  }

  /** Tests credentials and briefly caches a successful result for the next save. */
  public async testConnection(input: AiAppAssistantConnectionTestInput): Promise<AiAppAssistantConnectionResult> {
    this.assertEnabled();
    const apiKey = await this.resolveApiKey(input.provider, input.apiKey);
    const connection = this.#options.testConnection
      ? await this.#options.testConnection({ ...input, ...(apiKey ? { apiKey } : {}) })
      : await testAiSdkConnection({
          model: `${input.provider}:${input.model}`,
          ...(apiKey ? { apiKey } : {}),
          ...(input.baseURL ? { baseURL: input.baseURL } : {}),
          timeoutMs: this.#options.connectionTimeoutMs ?? 15_000
        });
    if (connection.success) {
      this.#recentConnectionValidation = {
        signature: this.connectionSignature(input.provider, input.model, apiKey, input.baseURL),
        result: connection,
        expiresAt: Date.now() + 5 * 60 * 1_000
      };
    }
    const activeConfigurationTested = await this.applyTestResultToActiveConfiguration(input, connection, apiKey);
    if (activeConfigurationTested) {
      await this.publishAndEmit({
        reason: "connection-tested",
        reloadRequired: connection.success,
        connectionValidated: connection.success,
        remote: false
      });
    }
    return connection;
  }

  /** Checks the effective stored/deployment connection used by live questions. */
  public async validateRuntimeConnection(): Promise<boolean> {
    this.#lastReconnectAttempt = Date.now();
    if (!this.isEnabled()) {
      this.#runtimeConnection = { status: "disabled", checkedAt: this.now() };
      return false;
    }
    const configuration = await this.getRuntimeConfiguration();
    if (!configuration || (configuration.provider !== "ollama" && !configuration.apiKey)) {
      this.#runtimeConnection = {
        status: "not-configured",
        checkedAt: this.now(),
        ...(configuration ? { model: `${configuration.provider}:${configuration.model}` } : {})
      };
      return false;
    }
    const result = await (this.#options.testConnection
      ? this.#options.testConnection({
          provider: configuration.provider,
          model: configuration.model,
          ...(configuration.apiKey ? { apiKey: configuration.apiKey } : {}),
          ...(configuration.baseURL ? { baseURL: configuration.baseURL } : {})
        })
      : testAiSdkConnection({
          model: `${configuration.provider}:${configuration.model}`,
          ...(configuration.apiKey ? { apiKey: configuration.apiKey } : {}),
          ...(configuration.baseURL ? { baseURL: configuration.baseURL } : {}),
          timeoutMs: this.#options.connectionTimeoutMs ?? 15_000
        }));
    this.#runtimeConnection = {
      status: result.success ? "connected" : "disconnected",
      checkedAt: this.now(),
      model: result.model
    };
    if (!result.success) {
      this.#options.logger?.warn(
        `AI assistant connection failed: ${result.error.code}: ${result.error.message}`
      );
    }
    return result.success;
  }

  /** Validates sensitive connection changes, persists safely and records their author. */
  public async save(
    rawInput: AiAppAssistantConfigurationInput,
    actor: AiAppAssistantRuntimeIdentity
  ): Promise<AiAppAssistantConfigurationSaveResult> {
    const input = normalizeInput(rawInput);
    if (input.apiKey && !this.#options.apiKeyStorageAvailable) {
      throw new AiAppAssistantManagementError(
        503,
        "secret_storage_unavailable",
        "Secure API key storage is not configured"
      );
    }
    const initial = await this.#repository.load();
    const initialActive = this.effectiveConfiguration(initial);
    const initialApiKey = input.apiKey ??
      (initialActive?.provider === input.provider ? initialActive.apiKey : undefined) ??
      this.resolveDefaultApiKey(input.provider);
    const initialConnectionChanged = connectionChanged(initialActive, input);
    if (!this.isEnabled() && initialConnectionChanged) throw disabled();
    let connection = initialConnectionChanged
      ? await this.validateConnectionForSave(input, initialApiKey)
      : this.lastKnownConnection(input.provider, input.model);
    if (initialConnectionChanged && !connection.success) {
      return { saved: false, connection, reloadRequired: false };
    }

    let finalConnectionChanged = initialConnectionChanged;
    const persist = this.#repository.mutate?.bind(this.#repository) ?? (async (
      update: (current: AiAppAssistantConfiguration | undefined) => AiAppAssistantConfiguration | Promise<AiAppAssistantConfiguration>
    ) => this.#repository.save(await update(await this.#repository.load())));
    try {
      await persist(async (previous) => {
        const active = this.effectiveConfiguration(previous);
        const previousAdministration = previous?.administration;
        const ownsKey = !previousAdministration?.keyCreatedBy ||
          previousAdministration.keyCreatedBy.id === actor.id;
        const providerChanged = Boolean(active && active.provider !== input.provider);
        const modelChanged = Boolean(!active || active.model !== input.model);
        const allowModelChangesByOthers = input.allowModelChangesByOthers ??
          previousAdministration?.allowModelChangesByOthers ?? false;

        if (!ownsKey && (input.apiKey || providerChanged)) {
          throw forbidden("Only the user who provided the API key can change the provider or key");
        }
        if (!ownsKey && modelChanged && !previousAdministration?.allowModelChangesByOthers) {
          throw forbidden("The API key owner has not allowed other users to change the model");
        }
        if (!ownsKey && allowModelChangesByOthers !== previousAdministration?.allowModelChangesByOthers) {
          throw forbidden("Only the API key owner can change model permissions");
        }

        const apiKey = input.apiKey ??
          (active?.provider === input.provider ? active.apiKey : undefined) ??
          this.resolveDefaultApiKey(input.provider);
        finalConnectionChanged = connectionChanged(active, input);
        if (finalConnectionChanged) {
          connection = await this.validateConnectionForSave(input, apiKey);
          if (!connection.success) throw new ConnectionRejectedError(connection);
        }

        const now = this.now();
        const defaults = this.defaultConfiguration();
        const retainedManualKey = previous?.connectionSource !== "environment" &&
          previous?.provider === input.provider ? previous.apiKey : undefined;
        const usesEnvironmentConnection = !input.apiKey && !retainedManualKey &&
          Boolean(defaults && sameConnection(defaults, input));
        const connectionSource = usesEnvironmentConnection ? "environment" : "override";
        const persistedApiKey = connectionSource === "override" ? input.apiKey ?? retainedManualKey : undefined;
        const changes = configurationChanges(active, input, allowModelChangesByOthers);
        const history: AiAppAssistantConfigurationAuditEntry[] = changes.length
          ? [...(previousAdministration?.history ?? []), {
              id: this.#options.createId?.() ?? randomUUID(),
              actor,
              changedAt: now,
              changes
            }].slice(-200)
          : previousAdministration?.history ?? [];
        const administration: AiAppAssistantConfigurationAdministration = {
          ...(persistedApiKey
            ? input.apiKey
              ? { keyCreatedBy: actor, keyCreatedAt: now }
              : previousAdministration?.keyCreatedBy
                ? { keyCreatedBy: previousAdministration.keyCreatedBy, keyCreatedAt: previousAdministration.keyCreatedAt }
                : {}
            : {}),
          ...(modelChanged
            ? { modelUpdatedBy: actor, modelUpdatedAt: now }
            : previousAdministration?.modelUpdatedBy
              ? { modelUpdatedBy: previousAdministration.modelUpdatedBy, modelUpdatedAt: previousAdministration.modelUpdatedAt }
              : {}),
          allowModelChangesByOthers,
          history
        };

        return {
          provider: input.provider,
          model: input.model,
          connectionSource,
          ...(persistedApiKey ? { apiKey: persistedApiKey } : {}),
          ...(connectionSource === "override" && input.baseURL ? { baseURL: input.baseURL } : {}),
          access: input.access,
          ...(input.quota ?? previous?.quota ? { quota: input.quota ?? previous!.quota } : {}),
          maxConversationTurns: input.maxConversationTurns,
          administration
        };
      });
    } catch (error) {
      if (error instanceof ConnectionRejectedError) {
        return { saved: false, connection: error.connection, reloadRequired: false };
      }
      if (error instanceof AiAppAssistantConfigurationConflictError) {
        throw new AiAppAssistantManagementError(409, "conflict", error.message);
      }
      throw error;
    }

    if (finalConnectionChanged && connection.success) {
      this.#runtimeConnection = {
        status: "connected",
        checkedAt: this.now(),
        model: connection.model
      };
    }
    this.#options.logger?.info(`AI assistant configuration updated for ${input.provider}:${input.model}`);
    await this.publishAndEmit({
      reason: "saved",
      reloadRequired: finalConnectionChanged,
      connectionValidated: finalConnectionChanged && connection.success,
      remote: false
    });
    return {
      saved: true,
      connection,
      configuration: await this.getView(actor),
      reloadRequired: finalConnectionChanged
    };
  }

  /** Removes only the manual key, records the revocation and falls back to defaults. */
  public async revokeApiKey(actor: AiAppAssistantRuntimeIdentity): Promise<AiAppAssistantManagedConfigurationView> {
    const persist = this.#repository.mutate?.bind(this.#repository) ?? (async (
      update: (current: AiAppAssistantConfiguration | undefined) => AiAppAssistantConfiguration | Promise<AiAppAssistantConfiguration>
    ) => this.#repository.save(await update(await this.#repository.load())));
    try {
      await persist((previous) => {
        if (!previous?.apiKey) {
          throw new AiAppAssistantManagementError(400, "not_configured", "No manually configured API key is available to revoke");
        }
        const owner = previous.administration?.keyCreatedBy;
        if (owner && owner.id !== actor.id) {
          throw forbidden("Only the user who provided the API key can revoke it");
        }
        const now = this.now();
        const revocationEntry: AiAppAssistantConfigurationAuditEntry = {
          id: this.#options.createId?.() ?? randomUUID(),
          actor,
          changedAt: now,
          changes: [{ field: "apiKey", from: "configured", to: "revoked" }]
        };
        const administration: AiAppAssistantConfigurationAdministration = {
          ...(previous.administration?.modelUpdatedBy ? {
            modelUpdatedBy: previous.administration.modelUpdatedBy,
            modelUpdatedAt: previous.administration.modelUpdatedAt
          } : {}),
          allowModelChangesByOthers: false,
          history: [...(previous.administration?.history ?? []), revocationEntry].slice(-200)
        };
        const defaults = this.defaultConfiguration();
        return {
          provider: defaults?.provider ?? previous.provider,
          model: defaults?.model ?? previous.model,
          connectionSource: defaults ? "environment" : "override",
          ...(!defaults && previous.baseURL ? { baseURL: previous.baseURL } : {}),
          access: previous.access,
          ...(previous.quota ? { quota: previous.quota } : {}),
          ...(previous.maxConversationTurns ? { maxConversationTurns: previous.maxConversationTurns } : {}),
          administration
        };
      });
    } catch (error) {
      if (error instanceof AiAppAssistantConfigurationConflictError) {
        throw new AiAppAssistantManagementError(409, "conflict", error.message);
      }
      throw error;
    }
    this.#recentConnectionValidation = undefined;
    const connected = await this.validateRuntimeConnection();
    await this.publishAndEmit({
      reason: "revoked",
      reloadRequired: true,
      connectionValidated: connected,
      remote: false
    });
    return this.getView(actor);
  }

  /** Resolves persisted policy against deployment defaults, including the secret. */
  public async getRuntimeConfiguration(): Promise<AiAppAssistantConfiguration | undefined> {
    return this.effectiveConfiguration(await this.#repository.load());
  }

  /** Returns the frontend-safe view: secret presence and permissions, never the key. */
  public async getView(identity?: AiAppAssistantRuntimeIdentity): Promise<AiAppAssistantManagedConfigurationView> {
    const stored = await this.#repository.loadView();
    if (stored) {
      const environmentConnection = stored.connectionSource === "environment";
      const defaults = environmentConnection ? this.defaultConfiguration() : undefined;
      const provider = defaults?.provider ?? (environmentConnection ? null : stored.provider);
      const model = defaults?.model ?? (environmentConnection ? "" : stored.model);
      const baseURL = defaults?.baseURL ?? (environmentConnection ? undefined : stored.baseURL);
      const storedApiKey = !environmentConnection && stored.apiKeyConfigured;
      const defaultApiKey = Boolean(defaults?.apiKey || (provider && this.resolveDefaultApiKey(provider)));
      const apiKeyConfigured = storedApiKey || defaultApiKey;
      const usable = Boolean(provider && (provider === "ollama" || apiKeyConfigured));
      const { connectionSource: _connectionSource, ...safeStored } = stored;
      return {
        ...safeStored,
        provider: usable ? provider : null,
        model: usable ? model : "",
        ...(usable && baseURL ? { baseURL } : {}),
        maxConversationTurns: stored.maxConversationTurns ?? 3,
        apiKeyConfigured,
        apiKeyStorageAvailable: Boolean(this.#options.apiKeyStorageAvailable),
        configured: usable,
        source: "stored",
        ...(stored.administration ? { administration: stored.administration } : {}),
        allowModelChangesByOthers: stored.administration?.allowModelChangesByOthers ?? false,
        ...permissions(stored.administration, storedApiKey, identity),
        fieldSources: {
          provider: usable ? environmentConnection ? "environment" : "override" : "none",
          model: usable ? environmentConnection ? "environment" : "override" : "none",
          apiKey: storedApiKey ? "override" : defaultApiKey ? "environment" : "none",
          baseURL: baseURL ? environmentConnection ? "environment" : "override" : "none",
          access: "override",
          quota: stored.quota ? "override" : "environment",
          conversation: stored.maxConversationTurns ? "override" : "default"
        },
        connection: { ...this.#runtimeConnection }
      };
    }
    const defaults = this.defaultConfiguration();
    const apiKeyConfigured = Boolean(defaults && (defaults.apiKey || this.resolveDefaultApiKey(defaults.provider)));
    const usable = Boolean(defaults && (defaults.provider === "ollama" || apiKeyConfigured));
    return {
      provider: usable ? defaults!.provider : null,
      model: usable ? defaults!.model : "",
      ...(usable && defaults?.baseURL ? { baseURL: defaults.baseURL } : {}),
      access: defaults?.access ?? { mode: "all" },
      ...(defaults?.quota ? { quota: defaults.quota } : {}),
      maxConversationTurns: defaults?.maxConversationTurns ?? 3,
      apiKeyConfigured,
      apiKeyStorageAvailable: Boolean(this.#options.apiKeyStorageAvailable),
      configured: usable,
      source: "environment",
      allowModelChangesByOthers: false,
      canChangeModel: true,
      canManageCredentials: true,
      canManageModelPolicy: true,
      canRevokeApiKey: false,
      fieldSources: {
        provider: usable ? "environment" : "none",
        model: usable ? "environment" : "none",
        apiKey: apiKeyConfigured ? "environment" : "none",
        baseURL: defaults?.baseURL ? "environment" : "none",
        access: defaults ? "environment" : "default",
        quota: defaults?.quota ? "environment" : "default",
        conversation: defaults?.maxConversationTurns ? "environment" : "default"
      },
      connection: { ...this.#runtimeConnection }
    };
  }

  /** Minimal launcher state used by clients before rendering the assistant. */
  public async getAccess(identity: AiAppAssistantRuntimeIdentity): Promise<{
    available: boolean;
    maxConversationTurns: number;
  }> {
    return {
      available: await this.canUse(identity),
      maxConversationTurns: (await this.getRuntimeConfiguration())?.maxConversationTurns ?? 3
    };
  }

  /** Combines configuration, provider health and application access rules. */
  public async canUse(identity: AiAppAssistantRuntimeIdentity): Promise<boolean> {
    if (!this.isEnabled()) return false;
    const configuration = await this.getRuntimeConfiguration();
    if (!configuration || (configuration.provider !== "ollama" && !configuration.apiKey)) return false;
    if (!await this.ensureRuntimeConnection()) return false;
    if (configuration.access.mode === "all") return true;
    if (configuration.access.mode === "users") return configuration.access.userIds.includes(identity.id);
    return (identity.roles ?? []).some((role) => configuration.access.mode === "roles" && configuration.access.roles.includes(role));
  }

  /** Atomically consumes one request from the user's active quota window. */
  public async consumeQuota(identity: AiAppAssistantRuntimeIdentity): Promise<AiAppAssistantQuotaResult> {
    const configuration = await this.getRuntimeConfiguration();
    const policy = configuration?.quota ?? this.#options.defaultQuota ?? {
      maxRequests: 20,
      windowSeconds: 3_600
    };
    return this.#quotaStore.consume(identity.id, policy);
  }

  /** Enforces access and quota immediately before any model call. */
  public async assertCanAsk(identity: AiAppAssistantRuntimeIdentity): Promise<void> {
    this.assertEnabled();
    if (!await this.canUse(identity)) {
      throw forbidden("AI assistant access is not enabled for this user");
    }
    const quota = await this.consumeQuota(identity);
    if (!quota.allowed) {
      throw new AiAppAssistantManagementError(
        429,
        "quota_reached",
        "AI assistant quota reached",
        { retryAfterSeconds: quota.retryAfterSeconds, resetAt: quota.resetAt.toISOString() }
      );
    }
  }

  /** Retries a failed provider lazily, with a shared backoff across requests. */
  public async ensureRuntimeConnection(): Promise<boolean> {
    if (!this.isEnabled()) return false;
    if (this.#runtimeConnection.status === "connected") return true;
    // Concurrent callers share the active check instead of failing fast or
    // launching a second provider request during the reconnect interval.
    if (this.#reconnectPromise) return this.#reconnectPromise;
    const intervalMs = Math.max(1_000, this.#options.reconnectIntervalMs ?? 30_000);
    if (Date.now() - this.#lastReconnectAttempt < intervalMs) return false;
    this.#reconnectPromise = this.validateRuntimeConnection()
      .then(async (connected) => {
        if (connected) {
          await this.publishAndEmit({
            reason: "connection-tested",
            reloadRequired: true,
            connectionValidated: true,
            remote: false
          });
        }
        return connected;
      })
      .finally(() => {
        this.#reconnectPromise = undefined;
      });
    return this.#reconnectPromise;
  }

  private async applyTestResultToActiveConfiguration(
    input: AiAppAssistantConnectionTestInput,
    result: AiAppAssistantConnectionResult,
    apiKey?: string
  ): Promise<boolean> {
    const active = await this.getRuntimeConfiguration();
    if (!active) return false;
    const testedSignature = this.connectionSignature(input.provider, input.model, apiKey, input.baseURL);
    const activeSignature = this.connectionSignature(active.provider, active.model, active.apiKey, active.baseURL);
    if (testedSignature !== activeSignature) return false;
    this.#runtimeConnection = {
      status: result.success ? "connected" : "disconnected",
      checkedAt: this.now(),
      model: result.model
    };
    return true;
  }

  private async resolveApiKey(provider: AiAppAssistantConfiguration["provider"], explicit?: string): Promise<string | undefined> {
    if (explicit?.trim()) return explicit.trim();
    const stored = await this.#repository.load();
    if (stored?.provider === provider && stored.apiKey) return stored.apiKey;
    return this.resolveDefaultApiKey(provider);
  }

  private resolveDefaultApiKey(provider: AiAppAssistantConfiguration["provider"]): string | undefined {
    return this.#options.resolveDefaultApiKey?.(provider)?.trim() || undefined;
  }

  private defaultConfiguration(): AiAppAssistantConfiguration | undefined {
    const configured = typeof this.#options.defaultConfiguration === "function"
      ? this.#options.defaultConfiguration()
      : this.#options.defaultConfiguration;
    return configured ? { ...configured } : undefined;
  }

  /** Resolves stored policy-only data against the current deployment connection. */
  private effectiveConfiguration(stored: AiAppAssistantConfiguration | undefined): AiAppAssistantConfiguration | undefined {
    if (!stored) {
      const defaults = this.defaultConfiguration();
      if (!defaults) return undefined;
      const apiKey = defaults.apiKey ?? this.resolveDefaultApiKey(defaults.provider);
      return { ...defaults, ...(apiKey ? { apiKey } : {}) };
    }
    if (stored.connectionSource === "environment") {
      const defaults = this.defaultConfiguration();
      if (!defaults) return undefined;
      const apiKey = defaults.apiKey ?? this.resolveDefaultApiKey(defaults.provider);
      return {
        provider: defaults.provider,
        model: defaults.model,
        connectionSource: "environment",
        ...(apiKey ? { apiKey } : {}),
        ...(defaults.baseURL ? { baseURL: defaults.baseURL } : {}),
        access: stored.access,
        ...(stored.quota ? { quota: stored.quota } : defaults.quota ? { quota: defaults.quota } : {}),
        ...((stored.maxConversationTurns ?? defaults.maxConversationTurns) !== undefined
          ? { maxConversationTurns: stored.maxConversationTurns ?? defaults.maxConversationTurns }
          : {}),
        ...(stored.administration ? { administration: stored.administration } : {})
      };
    }
    const apiKey = stored.apiKey ?? this.resolveDefaultApiKey(stored.provider);
    return { ...stored, ...(apiKey ? { apiKey } : {}) };
  }

  private async validateConnectionForSave(
    input: AiAppAssistantConfigurationInput,
    apiKey?: string
  ): Promise<AiAppAssistantConnectionResult> {
    const signature = this.connectionSignature(input.provider, input.model, apiKey, input.baseURL);
    if (this.#recentConnectionValidation &&
      this.#recentConnectionValidation.expiresAt > Date.now() &&
      this.#recentConnectionValidation.signature === signature) {
      return this.#recentConnectionValidation.result;
    }
    return this.testConnection({
      provider: input.provider,
      model: input.model,
      ...(apiKey ? { apiKey } : {}),
      ...(input.baseURL ? { baseURL: input.baseURL } : {})
    });
  }

  private connectionSignature(
    provider: AiAppAssistantConfiguration["provider"],
    model: string,
    apiKey?: string,
    baseURL?: string
  ): string {
    return createHash("sha256")
      .update(JSON.stringify({ provider, model, apiKey: apiKey ?? "", baseURL: baseURL ?? "" }))
      .digest("hex");
  }

  private lastKnownConnection(provider: AiAppAssistantConfiguration["provider"], model: string): AiAppAssistantConnectionResult {
    const identifier = `${provider}:${model}`;
    if (this.#runtimeConnection.status === "connected" && this.#runtimeConnection.model === identifier) {
      return { success: true, model: identifier, latencyMs: 0 };
    }
    return {
      success: false,
      model: identifier,
      latencyMs: 0,
      error: {
        code: "CONFIGURATION",
        message: "Connection settings were unchanged and were not tested again.",
        retryable: false
      }
    };
  }

  private now(): string {
    return (this.#options.now?.() ?? new Date()).toISOString();
  }

  private assertEnabled(): void {
    if (!this.isEnabled()) throw disabled();
  }

  private async publishAndEmit(event: AiAppAssistantConfigurationChangeEvent): Promise<void> {
    await this.#options.synchronizer?.publish(event);
    await this.emit(event);
  }

  private async emit(event: AiAppAssistantConfigurationChangeEvent): Promise<void> {
    await Promise.all([...this.#listeners].map((listener) => listener(event)));
  }
}

/**
 * Portable cross-instance invalidation using any key/value store. It avoids a
 * Redis-specific dependency and gives every process an eventual reload.
 */
export function createPollingAiAppAssistantConfigurationSynchronizer(
  store: AiAppAssistantKeyValueStore,
  options: { key?: string; intervalMs?: number } = {}
): AiAppAssistantConfigurationSynchronizer {
  const key = options.key?.trim() || "ai-app-assistant:configuration-revision";
  const intervalMs = Math.max(250, Math.round(options.intervalMs ?? 2_000));
  let current: string | null | undefined;
  return {
    async start(onChange) {
      current = await store.get(key);
      let checking = false;
      const timer = setInterval(async () => {
        if (checking) return;
        checking = true;
        try {
          const next = await store.get(key);
          if (next && next !== current) await onChange(parseSynchronizationEvent(next));
          current = next;
        } finally {
          checking = false;
        }
      }, intervalMs);
      (timer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();
      return () => clearInterval(timer);
    },
    async publish(event) {
      const payload = JSON.stringify({
        revision: `${Date.now()}:${randomUUID()}`,
        event: { ...event, remote: false }
      });
      await store.set(key, payload);
      current = payload;
    }
  };
}

function parseSynchronizationEvent(value: string): AiAppAssistantConfigurationChangeEvent {
  try {
    const parsed = JSON.parse(value) as { event?: Partial<AiAppAssistantConfigurationChangeEvent> };
    const event = parsed.event;
    if (event && typeof event.reloadRequired === "boolean" && typeof event.connectionValidated === "boolean") {
      return {
        reason: event.reason ?? "remote-change",
        reloadRequired: event.reloadRequired,
        connectionValidated: event.connectionValidated,
        remote: true
      };
    }
  } catch {
    // Legacy revision values trigger the safe full reload path once.
  }
  return {
    reason: "remote-change",
    reloadRequired: true,
    connectionValidated: false,
    remote: true
  };
}

function normalizeInput(input: AiAppAssistantConfigurationInput): AiAppAssistantConfigurationInput {
  const { apiKey: rawApiKey, baseURL: rawBaseURL, ...required } = input;
  const apiKey = rawApiKey?.trim();
  const baseURL = rawBaseURL?.trim();
  return {
    ...required,
    model: input.model.trim(),
    ...(apiKey ? { apiKey } : {}),
    ...(baseURL ? { baseURL } : {}),
    maxConversationTurns: input.maxConversationTurns ?? 3
  };
}

function connectionChanged(
  active: AiAppAssistantConfiguration | undefined,
  input: AiAppAssistantConfigurationInput
): boolean {
  return !active || !sameConnection(active, input) || Boolean(input.apiKey);
}

function sameConnection(
  left: Pick<AiAppAssistantConfiguration, "provider" | "model" | "baseURL">,
  right: Pick<AiAppAssistantConfigurationInput, "provider" | "model" | "baseURL">
): boolean {
  return left.provider === right.provider &&
    left.model === right.model &&
    (left.baseURL ?? "") === (right.baseURL ?? "");
}

class ConnectionRejectedError extends Error {
  public constructor(readonly connection: Extract<AiAppAssistantConnectionResult, { success: false }>) {
    super(connection.error.message);
  }
}

function permissions(
  administration: AiAppAssistantConfigurationAdministration | undefined,
  storedApiKey: boolean,
  identity?: AiAppAssistantRuntimeIdentity
): Pick<AiAppAssistantManagedConfigurationView, "canChangeModel" | "canManageCredentials" | "canManageModelPolicy" | "canRevokeApiKey"> {
  const ownerId = administration?.keyCreatedBy?.id;
  const ownsKey = !ownerId || ownerId === identity?.id;
  return {
    canChangeModel: ownsKey || Boolean(administration?.allowModelChangesByOthers),
    canManageCredentials: ownsKey,
    canManageModelPolicy: ownsKey,
    canRevokeApiKey: storedApiKey && ownsKey
  };
}

function configurationChanges(
  previous: AiAppAssistantConfiguration | undefined,
  input: AiAppAssistantConfigurationInput,
  allowModelChangesByOthers: boolean
): AiAppAssistantConfigurationAuditChange[] {
  const changes: AiAppAssistantConfigurationAuditChange[] = [];
  if (!previous || previous.provider !== input.provider) {
    changes.push({ field: "provider", ...(previous ? { from: previous.provider } : {}), to: input.provider });
  }
  if (input.apiKey) changes.push({ field: "apiKey", to: previous?.apiKey ? "replaced" : "configured" });
  if (!previous || previous.model !== input.model) {
    changes.push({ field: "model", ...(previous ? { from: previous.model } : {}), to: input.model });
  }
  if (!previous || JSON.stringify(previous.access) !== JSON.stringify(input.access)) changes.push({ field: "access" });
  if (JSON.stringify(previous?.quota) !== JSON.stringify(input.quota)) changes.push({ field: "quota" });
  if ((previous?.maxConversationTurns ?? 3) !== input.maxConversationTurns) {
    changes.push({
      field: "conversation",
      from: String(previous?.maxConversationTurns ?? 3),
      to: String(input.maxConversationTurns)
    });
  }
  const previousPolicy = previous?.administration?.allowModelChangesByOthers ?? false;
  if (previousPolicy !== allowModelChangesByOthers) {
    changes.push({ field: "modelChangePolicy", from: String(previousPolicy), to: String(allowModelChangesByOthers) });
  }
  return changes;
}

function forbidden(message: string): AiAppAssistantManagementError {
  return new AiAppAssistantManagementError(403, "forbidden", message);
}

function disabled(): AiAppAssistantManagementError {
  return new AiAppAssistantManagementError(
    503,
    "assistant_disabled",
    "AI assistant is disabled"
  );
}

// Compile-time guarantee that the AI SDK result remains compatible with the
// transport-safe contract used by generic settings clients.
const _connectionResultCompatibility: AiAppAssistantConnectionResult | undefined = undefined as AiSdkConnectionTestResult | undefined;
void _connectionResultCompatibility;

export type {
  AiAppAssistantConfigurationActor,
  AiAppAssistantConfigurationAdministration,
  AiAppAssistantConfigurationFieldSource,
  AiAppAssistantConfigurationInput,
  AiAppAssistantConnectionResult,
  AiAppAssistantConnectionTestInput,
  AiAppAssistantCredentials,
  AiAppAssistantManagedConfigurationView,
  AiAppAssistantRuntimeConnection
} from "@123toto/ai-app-assistant-contracts";
