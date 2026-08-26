import type {
  AiDocsConfigurationInput,
  AiDocsConfigurationOptions,
  AiDocsAccessView,
  AiDocsConnectionResult,
  AiDocsConnectionTestInput,
  AiDocsCredentials,
  AiDocsManagedConfigurationView,
  AiDocsModelInfoContract,
  AiDocsProviderInfoContract
} from "@123toto/ai-app-assistant-contracts";
import {
  aiDocsConfigurationOptionsSchema,
  aiDocsAccessViewSchema,
  aiDocsConfigurationSaveResultSchema,
  aiDocsConnectionResultSchema,
  aiDocsManagedConfigurationViewSchema,
  aiDocsModelInfoSchema,
  aiDocsProviderInfoSchema
} from "@123toto/ai-app-assistant-contracts";
import { AiDocsHttpError } from "./client.js";

export interface AiDocsSettingsClientOptions {
  /** Base endpoint, for example `/api/ai-docs`. */
  endpoint: string;
  fetch?: typeof globalThis.fetch;
  headers?: () => HeadersInit | Promise<HeadersInit>;
}

export interface AiDocsSettingsClient {
  getAccess(): Promise<AiDocsAccessView>;
  getConfiguration(): Promise<AiDocsManagedConfigurationView>;
  getOptions(): Promise<AiDocsConfigurationOptions>;
  listProviders(): Promise<AiDocsProviderInfoContract[]>;
  listModels(input: AiDocsCredentials): Promise<AiDocsModelInfoContract[]>;
  testConnection(input: AiDocsConnectionTestInput): Promise<AiDocsConnectionResult>;
  save(input: AiDocsConfigurationInput): Promise<{
    saved: boolean;
    connection: AiDocsConnectionResult;
    configuration?: AiDocsManagedConfigurationView | undefined;
  }>;
  revokeApiKey(): Promise<AiDocsManagedConfigurationView>;
}

/** Small framework-neutral client for the optional managed settings API. */
export function createAiDocsSettingsClient(options: AiDocsSettingsClientOptions): AiDocsSettingsClient {
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
    if (!response.ok) throw new AiDocsHttpError(response.status, await response.text());
    return schema.parse(await response.json() as unknown);
  };

  return {
    getAccess: () => request("/access", aiDocsAccessViewSchema),
    getConfiguration: () => request("/configuration", aiDocsManagedConfigurationViewSchema),
    getOptions: () => request("/configuration/options", aiDocsConfigurationOptionsSchema),
    listProviders: () => request("/providers", aiDocsProviderInfoSchema.array()),
    listModels: (input) => request("/models", aiDocsModelInfoSchema.array(), {
      method: "POST",
      body: JSON.stringify(input)
    }),
    testConnection: (input) => request("/configuration/test", aiDocsConnectionResultSchema, {
      method: "POST",
      body: JSON.stringify(input)
    }),
    save: (input) => request("/configuration", aiDocsConfigurationSaveResultSchema, {
      method: "PUT",
      body: JSON.stringify(input)
    }),
    revokeApiKey: () => request("/configuration/api-key", aiDocsManagedConfigurationViewSchema, {
      method: "DELETE"
    })
  };
}

export interface AiDocsSettingsSnapshot {
  status: "idle" | "loading" | "ready" | "saving" | "testing" | "loading-models" | "error";
  configuration?: AiDocsManagedConfigurationView;
  providers: readonly AiDocsProviderInfoContract[];
  models: readonly AiDocsModelInfoContract[];
  options: AiDocsConfigurationOptions;
  /** False when the host deliberately exposes no role/user directory adapter. */
  optionsAvailable: boolean;
  connectionTest?: AiDocsConnectionResult;
  error?: Error | undefined;
}

export type AiDocsSettingsListener = (snapshot: AiDocsSettingsSnapshot) => void;

/** Reusable state controller for Angular, React, Vue or a custom settings page. */
export class AiDocsSettingsController {
  #snapshot: AiDocsSettingsSnapshot = {
    status: "idle",
    providers: [],
    models: [],
    options: { roles: [], users: [] },
    optionsAvailable: false
  };
  readonly #listeners = new Set<AiDocsSettingsListener>();

  public constructor(readonly client: AiDocsSettingsClient) {}

  public get snapshot(): AiDocsSettingsSnapshot {
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

  public subscribe(listener: AiDocsSettingsListener): () => void {
    this.#listeners.add(listener);
    listener(this.snapshot);
    return () => this.#listeners.delete(listener);
  }

  /** Loads all non-secret values required by a settings screen. */
  public async initialize(): Promise<AiDocsSettingsSnapshot> {
    this.update({ status: "loading", error: undefined });
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
        error: undefined
      });
      return this.snapshot;
    } catch (error) {
      throw this.fail(error);
    }
  }

  /** Loads provider models; the configured secret can stay server-side. */
  public async loadModels(input: AiDocsCredentials): Promise<readonly AiDocsModelInfoContract[]> {
    this.update({ status: "loading-models", error: undefined });
    try {
      const models = await this.client.listModels(input);
      this.update({ status: "ready", models, error: undefined });
      return models;
    } catch (error) {
      throw this.fail(error);
    }
  }

  /** Tests a draft connection without persisting it. */
  public async test(input: AiDocsConnectionTestInput): Promise<AiDocsConnectionResult> {
    this.update({ status: "testing", error: undefined });
    try {
      const connectionTest = await this.client.testConnection(input);
      this.update({ status: "ready", connectionTest, error: undefined });
      return connectionTest;
    } catch (error) {
      throw this.fail(error);
    }
  }

  /** Persists only when the server accepts any connection-sensitive changes. */
  public async save(input: AiDocsConfigurationInput): Promise<boolean> {
    this.update({ status: "saving", error: undefined });
    try {
      const result = await this.client.save(input);
      this.update({
        status: "ready",
        ...(result.configuration ? { configuration: result.configuration } : {}),
        connectionTest: result.connection,
        error: undefined
      });
      return result.saved;
    } catch (error) {
      throw this.fail(error);
    }
  }

  /** Revokes the stored secret and refreshes the safe configuration snapshot. */
  public async revokeApiKey(): Promise<void> {
    this.update({ status: "saving", error: undefined });
    try {
      const configuration = await this.client.revokeApiKey();
      this.update({ status: "ready", configuration, models: [], error: undefined });
    } catch (error) {
      throw this.fail(error);
    }
  }

  private update(patch: Partial<AiDocsSettingsSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener(this.snapshot);
  }

  private fail(error: unknown): Error {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.update({ status: "error", error: normalized });
    return normalized;
  }
}
