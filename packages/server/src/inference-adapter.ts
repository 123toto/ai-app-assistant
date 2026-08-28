import type { AiAppAssistantConnectionResult } from "@123toto/ai-app-assistant-contracts";
import type {
  AiModelInfo,
  AiProviderConnectionManagement
} from "./provider-catalog.js";
import type { AnswerGenerator } from "./types.js";

/** Runtime values selected by the host or the managed settings API. */
export interface AiAppAssistantInferenceAdapterInput {
  model: string;
  apiKey?: string;
  baseURL?: string;
}

/**
 * Host-owned bridge to an LLM, corporate gateway or cloud inference runtime.
 *
 * Authentication and token renewal stay inside the adapter. The library only
 * receives a provider-neutral generator and safe connection metadata.
 */
export interface AiAppAssistantInferenceAdapter {
  /** Stable identifier persisted in managed configuration. */
  readonly id: string;
  readonly label: string;
  /**
   * Defaults to `host`: authentication and endpoint controls stay out of the
   * generic settings UI. Use `settings` only when that UI may manage them.
   */
  readonly connectionManagement?: AiProviderConnectionManagement;
  /** Defaults to false for gateways whose authentication is owned by the host. */
  readonly requiresApiKey?: boolean;
  /** Must only be true when listModels is implemented. */
  readonly supportsModelDiscovery?: boolean;
  createGenerator(
    input: AiAppAssistantInferenceAdapterInput
  ): AnswerGenerator | Promise<AnswerGenerator>;
  /**
   * Optional real inference probe. When omitted, the library probes the
   * generator itself and validates its structured response.
   */
  testConnection?(
    input: AiAppAssistantInferenceAdapterInput
  ): Promise<AiAppAssistantConnectionResult>;
  /** Provider-native model discovery, normalized before it reaches the UI. */
  listModels?(
    input: Omit<AiAppAssistantInferenceAdapterInput, "model">
  ): Promise<Array<Omit<AiModelInfo, "provider">>>;
}
