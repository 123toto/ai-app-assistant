import type { AiAppAssistantConfiguration } from "./configuration.js";
import { listAiProviders, type BuiltInProvider } from "./provider-catalog.js";

export interface AiAppAssistantDeploymentDefaultsOptions {
  enabled: boolean;
  /** Provider selected by the host application. Allows `model` to remain a plain model identifier. */
  provider?: BuiltInProvider;
  /** Plain model identifier when `provider` is set, or legacy `provider:model` identifier. */
  model?: string;
  /** API key for the selected provider. Prefer this for one-provider deployments. */
  apiKey?: string;
  /** Provider endpoint override. Required by local providers such as Ollama. */
  baseURL?: string;
  /** @deprecated Prefer `provider` with the singular `apiKey` option. */
  apiKeys?: Partial<Record<BuiltInProvider, string | undefined>>;
  /** @deprecated Prefer `provider` with the singular `baseURL` option. */
  baseURLs?: Partial<Record<BuiltInProvider, string | undefined>>;
  access?: AiAppAssistantConfiguration["access"];
  quota?: AiAppAssistantConfiguration["quota"];
  maxConversationTurns?: number;
}

export interface AiAppAssistantDeploymentDefaults {
  configuration?: AiAppAssistantConfiguration;
  resolveApiKey(provider: BuiltInProvider): string | undefined;
}

/** Parses deployment defaults once while retaining provider-neutral runtime configuration. */
export function createAiAppAssistantDeploymentDefaults(
  options: AiAppAssistantDeploymentDefaultsOptions
): AiAppAssistantDeploymentDefaults {
  const apiKeys = Object.fromEntries(
    Object.entries(options.apiKeys ?? {}).map(([provider, value]) => [provider, value?.trim() || undefined])
  ) as Partial<Record<BuiltInProvider, string | undefined>>;
  const selectedProvider = options.provider;
  const selectedApiKey = options.apiKey?.trim() || undefined;
  const resolveApiKey = (provider: BuiltInProvider): string | undefined =>
    provider === selectedProvider ? selectedApiKey ?? apiKeys[provider] : apiKeys[provider];
  if (!options.enabled || !options.model?.trim()) return { resolveApiKey };

  const rawModel = options.model.trim();
  const legacyMatch = selectedProvider ? undefined : rawModel.match(/^([^:/]+)[:/](.+)$/);
  const explicitMatch = selectedProvider ? rawModel.match(/^([^:]+):(.+)$/) : undefined;
  if (!selectedProvider && !legacyMatch) {
    throw new TypeError(`Invalid AI App Assistant model identifier: ${options.model}`);
  }
  const parsedProvider = legacyMatch?.[1] ?? explicitMatch?.[1];
  const modelProvider = parsedProvider === "gemini" ? "google" : parsedProvider ?? selectedProvider;
  const provider = modelProvider as BuiltInProvider;
  if (!listAiProviders().some((candidate) => candidate.id === provider)) {
    throw new TypeError(`Unsupported AI App Assistant provider: ${modelProvider}`);
  }
  if (selectedProvider && explicitMatch && provider !== selectedProvider) {
    throw new TypeError(
      `AI App Assistant provider '${selectedProvider}' does not match model identifier '${options.model}'`
    );
  }
  // A slash may be part of a provider-native model id. It is parsed as a
  // separator only by the legacy provider:model/provider/model form.
  const model = legacyMatch?.[2]?.trim() ?? explicitMatch?.[2]?.trim() ?? rawModel;
  const apiKey = resolveApiKey(provider);
  const baseURL =
    (provider === selectedProvider ? options.baseURL?.trim() : undefined) ||
    options.baseURLs?.[provider]?.trim() ||
    undefined;
  if (provider === "ollama" && !baseURL) {
    throw new TypeError("AI App Assistant local provider 'ollama' requires a base URL");
  }
  return {
    resolveApiKey,
    configuration: {
      provider,
      model,
      connectionSource: "environment",
      ...(apiKey ? { apiKey } : {}),
      ...(baseURL ? { baseURL } : {}),
      access: options.access ?? { mode: "all" },
      ...(options.quota ? { quota: options.quota } : {}),
      ...(options.maxConversationTurns !== undefined
        ? { maxConversationTurns: options.maxConversationTurns }
        : {})
    }
  };
}
