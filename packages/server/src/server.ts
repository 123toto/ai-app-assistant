import { createAiSdkGenerator, type AiSdkGeneratorOptions } from "./ai-sdk.js";
import { createDocsAssistant, type DocsAssistant } from "./assistant.js";
import {
  createAiDocsFetchHandlers,
  type AiDocsFetchHandlerOptions,
  type AiDocsFetchHandlers
} from "./http.js";
import type { AnswerGenerator, DocumentationSource, DocsAssistantOptions } from "./types.js";

type AssistantPolicies = NonNullable<DocsAssistantOptions["policies"]>;

export interface CreateAiDocsServerOptions<TContext = undefined> {
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
  http?: Omit<AiDocsFetchHandlerOptions<TContext>, "assistant">;
}

export interface AiDocsServer<TContext = undefined> {
  assistant: DocsAssistant;
  fetch: AiDocsFetchHandlers;
  /** Retained for consumers that want direct programmatic calls. */
  options: Readonly<CreateAiDocsServerOptions<TContext>>;
}

/**
 * Minimal framework-neutral server factory. Applications can start with a
 * model string and documents, then opt into auth, privacy and storage hooks.
 */
export function createAiDocsServer<TContext = undefined>(
  options: CreateAiDocsServerOptions<TContext>
): AiDocsServer<TContext> {
  const generator = options.generator ?? createGenerator(options);
  const assistant = createDocsAssistant({
    generator,
    ...(options.documents ? { documents: options.documents } : {}),
    ...(options.policies ? { policies: options.policies } : {})
  });
  return {
    assistant,
    fetch: createAiDocsFetchHandlers({ assistant, ...options.http }),
    options: Object.freeze({ ...options })
  };
}

function createGenerator(options: Pick<
  CreateAiDocsServerOptions,
  "model" | "apiKey" | "baseURL" | "timeoutMs" | "maxRetries"
>): AnswerGenerator {
  if (!options.model?.trim()) {
    throw new TypeError("createAiDocsServer requires either generator or model");
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
