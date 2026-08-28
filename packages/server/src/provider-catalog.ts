/** Providers available without installing an additional AI SDK package. */
export const AI_APP_ASSISTANT_PROVIDERS = ["anthropic", "google", "mistral", "ollama", "openai"] as const;

/** Provider identifier derived from the runtime-neutral exported catalog. */
export type BuiltInProvider = typeof AI_APP_ASSISTANT_PROVIDERS[number];

/** Identifies where endpoint and credential configuration is owned. */
export type AiProviderConnectionManagement = "settings" | "host";

/** Stable provider metadata suitable for a settings interface. */
export interface AiProviderInfo {
  id: string;
  label: string;
  requiresApiKey: boolean;
  supportsModelDiscovery: boolean;
  /** Built-ins use the generic settings UI; private adapters default to the host. */
  connectionManagement: AiProviderConnectionManagement;
}

/** Provider-neutral model metadata returned by discovery endpoints. */
export interface AiModelInfo {
  id: string;
  provider: string;
  label?: string;
  createdAt?: string;
}

/** Credentials and transport options used only by the host backend. */
export interface ListAiModelsOptions {
  provider: BuiltInProvider;
  apiKey?: string;
  baseURL?: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

const PROVIDERS: readonly AiProviderInfo[] = Object.freeze([
  { id: "anthropic", label: "Anthropic", requiresApiKey: true, supportsModelDiscovery: true, connectionManagement: "settings" },
  { id: "google", label: "Google Gemini", requiresApiKey: true, supportsModelDiscovery: true, connectionManagement: "settings" },
  { id: "mistral", label: "Mistral AI", requiresApiKey: true, supportsModelDiscovery: true, connectionManagement: "settings" },
  { id: "openai", label: "OpenAI", requiresApiKey: true, supportsModelDiscovery: true, connectionManagement: "settings" },
  { id: "ollama", label: "Ollama", requiresApiKey: false, supportsModelDiscovery: true, connectionManagement: "settings" }
]);

/** Returns a copy so consumers cannot mutate the library's provider registry. */
export function listAiProviders(): AiProviderInfo[] {
  return PROVIDERS.map((provider) => ({ ...provider }));
}

/**
 * Discovers models with the provider's own API.
 *
 * The API key is used only for this backend request. It is never included in
 * the returned metadata or in an error message.
 */
export async function listAiModels(options: ListAiModelsOptions): Promise<AiModelInfo[]> {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new TypeError("A Fetch API implementation is required");
  }

  const request = providerModelRequest(options);
  const response = await fetchImplementation(request.url, {
    method: "GET",
    headers: request.headers,
    ...(options.signal ? { signal: options.signal } : {})
  });
  if (!response.ok) {
    throw new AiModelDiscoveryError(options.provider, response.status);
  }

  const payload = await response.json() as unknown;
  return normalizeModels(options.provider, payload)
    .sort((left, right) => left.id.localeCompare(right.id));
}

/** Safe discovery error that deliberately excludes provider response bodies. */
export class AiModelDiscoveryError extends Error {
  public constructor(
    public readonly provider: BuiltInProvider,
    public readonly status: number
  ) {
    super(`Could not list ${provider} models (HTTP ${status})`);
    this.name = "AiModelDiscoveryError";
  }
}

function providerModelRequest(options: ListAiModelsOptions): {
  url: string;
  headers: Record<string, string>;
} {
  const apiKey = options.apiKey?.trim();
  if (options.provider !== "ollama" && !apiKey) {
    throw new TypeError(`An API key is required to list ${options.provider} models`);
  }

  switch (options.provider) {
    case "openai":
      return bearerRequest(resolveEndpoint(options.baseURL, "https://api.openai.com/v1/models"), apiKey!);
    case "mistral":
      return bearerRequest(resolveEndpoint(options.baseURL, "https://api.mistral.ai/v1/models"), apiKey!);
    case "anthropic":
      return {
        url: resolveEndpoint(options.baseURL, "https://api.anthropic.com/v1/models"),
        headers: {
          accept: "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": apiKey!
        }
      };
    case "google":
      return {
        url: resolveEndpoint(options.baseURL, "https://generativelanguage.googleapis.com/v1beta/models"),
        headers: { accept: "application/json", "x-goog-api-key": apiKey! }
      };
    case "ollama":
      return bearerRequest(
        resolveEndpoint(options.baseURL, "http://localhost:11434/v1/models"),
        apiKey || "ollama"
      );
  }
}

function bearerRequest(url: string, apiKey: string): {
  url: string;
  headers: Record<string, string>;
} {
  return {
    url,
    headers: { accept: "application/json", authorization: `Bearer ${apiKey}` }
  };
}

function resolveEndpoint(baseURL: string | undefined, defaultEndpoint: string): string {
  if (!baseURL) return defaultEndpoint;
  const parsed = new URL(baseURL);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new TypeError("baseURL must be an HTTP(S) URL without credentials");
  }
  const pathname = parsed.pathname.replace(/\/$/, "");
  parsed.pathname = pathname.endsWith("/models") ? pathname : `${pathname}/models`;
  return parsed.toString();
}

function normalizeModels(provider: BuiltInProvider, payload: unknown): AiModelInfo[] {
  if (!isRecord(payload)) return [];
  if (provider === "google") {
    return Array.isArray(payload.models)
      ? payload.models.flatMap((model) => normalizeGoogleModel(model))
      : [];
  }
  if (!Array.isArray(payload.data)) return [];
  return payload.data.flatMap((model) => normalizeDataModel(provider, model));
}

function normalizeGoogleModel(value: unknown): AiModelInfo[] {
  if (!isRecord(value) || typeof value.name !== "string") return [];
  const methods = Array.isArray(value.supportedGenerationMethods)
    ? value.supportedGenerationMethods
    : [];
  if (methods.length > 0 && !methods.includes("generateContent")) return [];
  return [{
    provider: "google",
    id: value.name.replace(/^models\//, ""),
    ...(typeof value.displayName === "string" ? { label: value.displayName } : {})
  }];
}

function normalizeDataModel(provider: BuiltInProvider, value: unknown): AiModelInfo[] {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()) return [];
  const createdAt = typeof value.created_at === "string"
    ? value.created_at
    : typeof value.created === "number"
      ? new Date(value.created * 1_000).toISOString()
      : undefined;
  return [{
    provider,
    id: value.id,
    ...(typeof value.display_name === "string" ? { label: value.display_name } : {}),
    ...(createdAt ? { createdAt } : {})
  }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
