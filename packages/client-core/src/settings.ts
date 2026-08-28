import type {
  AiAppAssistantConfigurationInput,
  AiAppAssistantConfigurationOptions,
  AiAppAssistantAccessView,
  AiAppAssistantConnectionResult,
  AiAppAssistantConnectionTestInput,
  AiAppAssistantCredentials,
  AiAppAssistantManagedConfigurationView,
  AiAppAssistantModelInfoContract,
  AiAppAssistantProviderInfoContract
} from "@123toto/ai-app-assistant-contracts";
import {
  aiAppAssistantConfigurationOptionsSchema,
  aiAppAssistantAccessViewSchema,
  aiAppAssistantConfigurationSaveResultSchema,
  aiAppAssistantConnectionResultSchema,
  aiAppAssistantManagedConfigurationViewSchema,
  aiAppAssistantModelInfoSchema,
  aiAppAssistantProviderInfoSchema
} from "@123toto/ai-app-assistant-contracts";
import { AiAppAssistantHttpError } from "./client.js";

export interface AiAppAssistantSettingsClientOptions {
  /** Base endpoint, for example `/api/ai-app-assistant`. */
  endpoint: string;
  fetch?: typeof globalThis.fetch;
  headers?: () => HeadersInit | Promise<HeadersInit>;
}

export interface AiAppAssistantSettingsClient {
  getAccess(): Promise<AiAppAssistantAccessView>;
  getConfiguration(): Promise<AiAppAssistantManagedConfigurationView>;
  getOptions(): Promise<AiAppAssistantConfigurationOptions>;
  listProviders(): Promise<AiAppAssistantProviderInfoContract[]>;
  listModels(input: AiAppAssistantCredentials): Promise<AiAppAssistantModelInfoContract[]>;
  testConnection(input: AiAppAssistantConnectionTestInput): Promise<AiAppAssistantConnectionResult>;
  save(input: AiAppAssistantConfigurationInput): Promise<{
    saved: boolean;
    connection: AiAppAssistantConnectionResult;
    configuration?: AiAppAssistantManagedConfigurationView | undefined;
  }>;
  revokeApiKey(): Promise<AiAppAssistantManagedConfigurationView>;
}

/** Small framework-neutral client for the optional managed settings API. */
export function createAiAppAssistantSettingsClient(options: AiAppAssistantSettingsClientOptions): AiAppAssistantSettingsClient {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (!fetchImplementation) throw new Error("A fetch implementation is required.");
  const endpoint = options.endpoint.replace(/\/+$/, "");
  const request = async <T>(
    path: string,
    schema: { parse(input: unknown): T },
    init: RequestInit = {}
  ): Promise<T> => {
    const headers = await options.headers?.();
    const response = await fetchImplementation(`${endpoint}${path}`, {
      credentials: "same-origin",
      ...init,
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...headers,
        ...init.headers
      }
    });
    if (!response.ok) throw new AiAppAssistantHttpError(response.status, await response.text());
    return schema.parse(await response.json() as unknown);
  };

  return {
    getAccess: () => request("/access", aiAppAssistantAccessViewSchema),
    getConfiguration: () => request("/configuration", aiAppAssistantManagedConfigurationViewSchema),
    getOptions: () => request("/configuration/options", aiAppAssistantConfigurationOptionsSchema),
    listProviders: () => request("/providers", aiAppAssistantProviderInfoSchema.array()),
    listModels: (input) => request("/models", aiAppAssistantModelInfoSchema.array(), {
      method: "POST",
      body: JSON.stringify(input)
    }),
    testConnection: (input) => request("/configuration/test", aiAppAssistantConnectionResultSchema, {
      method: "POST",
      body: JSON.stringify(input)
    }),
    save: (input) => request("/configuration", aiAppAssistantConfigurationSaveResultSchema, {
      method: "PUT",
      body: JSON.stringify(input)
    }),
    revokeApiKey: () => request("/configuration/api-key", aiAppAssistantManagedConfigurationViewSchema, {
      method: "DELETE"
    })
  };
}

export interface AiAppAssistantSettingsSnapshot {
  status: "idle" | "loading" | "ready" | "saving" | "testing" | "loading-models" | "error";
  configuration?: AiAppAssistantManagedConfigurationView;
  providers: readonly AiAppAssistantProviderInfoContract[];
  models: readonly AiAppAssistantModelInfoContract[];
  options: AiAppAssistantConfigurationOptions;
  /** False when the host deliberately exposes no role/user directory adapter. */
  optionsAvailable: boolean;
  connectionTest?: AiAppAssistantConnectionResult;
  error?: Error | undefined;
  errorScope?: "connection" | "usage" | "global" | undefined;
}

export type AiAppAssistantSettingsListener = (snapshot: AiAppAssistantSettingsSnapshot) => void;

function modelDiscoverySignature(input: AiAppAssistantCredentials): string {
  return JSON.stringify([
    input.provider,
    input.apiKey?.trim() ?? "",
    input.baseURL?.trim().replace(/\/+$/, "") ?? ""
  ]);
}

/** Reusable state controller for Angular, React, Vue or a custom settings page. */
export class AiAppAssistantSettingsController {
  #snapshot: AiAppAssistantSettingsSnapshot = {
    status: "idle",
    providers: [],
    models: [],
    options: { roles: [], users: [] },
    optionsAvailable: false
  };
  readonly #listeners = new Set<AiAppAssistantSettingsListener>();
  #modelsLoadedFor: string | undefined;

  public constructor(readonly client: AiAppAssistantSettingsClient) {}

  public get snapshot(): AiAppAssistantSettingsSnapshot {
    return {
      ...this.#snapshot,
      providers: [...this.#snapshot.providers],
      models: [...this.#snapshot.models],
      options: {
        roles: [...this.#snapshot.options.roles],
        users: [...this.#snapshot.options.users]
      }
    };
  }

  public subscribe(listener: AiAppAssistantSettingsListener): () => void {
    this.#listeners.add(listener);
    listener(this.snapshot);
    return () => this.#listeners.delete(listener);
  }

  /** Loads all non-secret values required by a settings screen. */
  public async initialize(): Promise<AiAppAssistantSettingsSnapshot> {
    this.update({ status: "loading", error: undefined, errorScope: undefined });
    try {
      const [configuration, providers, directory] = await Promise.all([
        this.client.getConfiguration(),
        this.client.listProviders(),
        this.client.getOptions()
          .then((value) => ({ value, available: true }))
          .catch(() => ({ value: { roles: [], users: [] }, available: false }))
      ]);
      this.update({
        status: "ready",
        configuration,
        providers,
        options: directory.value,
        optionsAvailable: directory.available,
        error: undefined,
        errorScope: undefined
      });
      return this.snapshot;
    } catch (error) {
      throw this.fail(error);
    }
  }

  /** Loads provider models; the configured secret can stay server-side. */
  public async loadModels(input: AiAppAssistantCredentials): Promise<readonly AiAppAssistantModelInfoContract[]> {
    this.update({ status: "loading-models", error: undefined, errorScope: undefined });
    try {
      const models = await this.client.listModels(input);
      this.#modelsLoadedFor = modelDiscoverySignature(input);
      this.update({ status: "ready", models, error: undefined, errorScope: undefined });
      return models;
    } catch {
      throw this.fail(new Error("Unable to load the model list."), "connection");
    }
  }

  /** True after model discovery succeeded for these exact provider credentials. */
  public modelsAreLoadedFor(input: AiAppAssistantCredentials): boolean {
    return this.#modelsLoadedFor !== undefined && this.#modelsLoadedFor === modelDiscoverySignature(input);
  }

  /** Tests a draft connection without persisting it. */
  public async test(input: AiAppAssistantConnectionTestInput): Promise<AiAppAssistantConnectionResult> {
    this.update({ status: "testing", error: undefined, errorScope: undefined });
    try {
      const connectionTest = await this.client.testConnection(input);
      // The server updates the effective runtime status when the tested draft
      // matches the active connection. Refresh it so the badge cannot keep a
      // stale "Connected" state after a failed inference test.
      const configuration = await this.client.getConfiguration()
        .catch(() => this.#snapshot.configuration);
      this.update({
        status: "ready",
        ...(configuration ? { configuration } : {}),
        connectionTest,
        error: undefined,
        errorScope: undefined
      });
      return connectionTest;
    } catch (error) {
      throw this.fail(error, "connection");
    }
  }

  /** Persists only when the server accepts any connection-sensitive changes. */
  public async save(input: AiAppAssistantConfigurationInput): Promise<boolean> {
    const errorScope = configurationErrorScope(input, this.#snapshot.configuration);
    this.update({ status: "saving", error: undefined, errorScope: undefined });
    try {
      const result = await this.client.save(input);
      this.update({
        status: "ready",
        ...(result.configuration ? { configuration: result.configuration } : {}),
        connectionTest: result.connection,
        error: undefined,
        errorScope: undefined
      });
      return result.saved;
    } catch (error) {
      throw this.fail(error, errorScope);
    }
  }

  /** Revokes the stored secret and refreshes the safe configuration snapshot. */
  public async revokeApiKey(): Promise<void> {
    this.update({ status: "saving", error: undefined, errorScope: undefined });
    try {
      const configuration = await this.client.revokeApiKey();
      this.#modelsLoadedFor = undefined;
      this.update({ status: "ready", configuration, models: [], error: undefined, errorScope: undefined });
    } catch (error) {
      throw this.fail(error, "connection");
    }
  }

  private update(patch: Partial<AiAppAssistantSettingsSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener(this.snapshot);
  }

  private fail(error: unknown, errorScope: "connection" | "usage" | "global" = "global"): Error {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.update({ status: "error", error: normalized, errorScope });
    return normalized;
  }
}

function configurationErrorScope(
  input: AiAppAssistantConfigurationInput,
  configuration: AiAppAssistantManagedConfigurationView | undefined
): "connection" | "usage" | "global" {
  if (!configuration) return "global";
  const connectionChanged = input.provider !== configuration.provider
    || input.model !== configuration.model
    || normalizedOptional(input.baseURL) !== normalizedOptional(configuration.baseURL)
    || Boolean(input.apiKey?.trim());
  const quotaChanged = input.quota !== undefined && (
    input.quota.maxRequests !== configuration.quota?.maxRequests
    || input.quota.windowSeconds !== configuration.quota?.windowSeconds
  );
  const usageChanged = JSON.stringify(input.access) !== JSON.stringify(configuration.access)
    || quotaChanged
    || input.maxConversationTurns !== configuration.maxConversationTurns
    || (input.allowModelChangesByOthers !== undefined
      && input.allowModelChangesByOthers !== configuration.allowModelChangesByOthers);
  if (connectionChanged && usageChanged) return "global";
  if (connectionChanged) return "connection";
  if (usageChanged) return "usage";
  return "global";
}

function normalizedOptional(value: string | undefined): string {
  return value?.trim().replace(/\/+$/, "") ?? "";
}
