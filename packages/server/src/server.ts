import { createAiSdkGenerator, type AiSdkGeneratorOptions } from "./ai-sdk.js";
import { createAiAppAssistant, type AiAppAssistant } from "./assistant.js";
import {
  createAiAppAssistantFetchHandlers,
  type AiAppAssistantFetchHandlerOptions,
  type AiAppAssistantFetchHandlers
} from "./http.js";
import type { AnswerGenerator, DocumentationSource, AiAppAssistantOptions } from "./types.js";

type AssistantPolicies = NonNullable<AiAppAssistantOptions["policies"]>;

export interface CreateAiAppAssistantServerOptions<TContext = undefined> {
  /** A custom generator takes precedence over the provider:model shortcut. */
  generator?: AnswerGenerator;
  /** Provider-neutral model identifier, for example `mistral:mistral-small-latest`. */
  model?: string;
  apiKey?: string;
  baseURL?: string;
  timeoutMs?: number;
  maxRetries?: number;
  documents?: DocumentationSource[];
  policies?: AssistantPolicies;
  http?: Omit<AiAppAssistantFetchHandlerOptions<TContext>, "assistant">;
}

export interface AiAppAssistantServer<TContext = undefined> {
  assistant: AiAppAssistant;
  fetch: AiAppAssistantFetchHandlers;
  /** Retained for consumers that want direct programmatic calls. */
  options: Readonly<CreateAiAppAssistantServerOptions<TContext>>;
}

/**
 * Minimal framework-neutral server factory. Applications can start with a
 * model string and documents, then opt into auth, privacy and storage hooks.
 */
export function createAiAppAssistantServer<TContext = undefined>(
  options: CreateAiAppAssistantServerOptions<TContext>
): AiAppAssistantServer<TContext> {
  const generator = options.generator ?? createGenerator(options);
  const assistant = createAiAppAssistant({
    generator,
    ...(options.documents ? { documents: options.documents } : {}),
    ...(options.policies ? { policies: options.policies } : {})
  });
  return {
    assistant,
    fetch: createAiAppAssistantFetchHandlers({ assistant, ...options.http }),
    options: Object.freeze({ ...options })
  };
}

function createGenerator(options: Pick<
  CreateAiAppAssistantServerOptions,
  "model" | "apiKey" | "baseURL" | "timeoutMs" | "maxRetries"
>): AnswerGenerator {
  if (!options.model?.trim()) {
    throw new TypeError("createAiAppAssistantServer requires either generator or model");
  }
  const generatorOptions: AiSdkGeneratorOptions = {
    model: options.model,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {})
  };
  return createAiSdkGenerator(generatorOptions);
}
