import type { AiAppAssistantConfiguration } from "./configuration.js";
import { listAiProviders, type BuiltInProvider } from "./provider-catalog.js";

export interface AiAppAssistantDeploymentDefaultsOptions {
  enabled: boolean;
  /** `provider:model`, for example `mistral:mistral-small-latest`. */
  model?: string;
  apiKeys?: Partial<Record<BuiltInProvider, string | undefined>>;
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
  const resolveApiKey = (provider: BuiltInProvider): string | undefined => apiKeys[provider];
  if (!options.enabled || !options.model?.trim()) return { resolveApiKey };

  const match = options.model.trim().match(/^([^:/]+)[:/](.+)$/);
  if (!match) throw new TypeError(`Invalid AI App Assistant model identifier: ${options.model}`);
  const provider = (match[1] === "gemini" ? "google" : match[1]) as BuiltInProvider;
  if (!listAiProviders().some((candidate) => candidate.id === provider)) {
    throw new TypeError(`Unsupported AI App Assistant provider: ${match[1]}`);
  }
  const apiKey = resolveApiKey(provider);
  const baseURL = options.baseURLs?.[provider]?.trim() || undefined;
  return {
    resolveApiKey,
    configuration: {
      provider,
      model: match[2]!.trim(),
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
