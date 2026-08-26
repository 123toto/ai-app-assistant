import type {
  AskDocumentationRequest,
  AskDocumentationResponse
} from "@123toto/ai-app-assistant-contracts";
import { createAiSdkGenerator } from "./ai-sdk.js";
import { createDocsAssistant, type DocsAssistant, type DocsAssistantStreamEvent } from "./assistant.js";
import {
  AiDocsConfigurationManager,
  AiDocsManagementError,
  type AiDocsConfigurationChangeEvent,
  type AiDocsRuntimeIdentity
} from "./management.js";
import type { AnswerGenerator, DocumentationSource, DocsAssistantOptions } from "./types.js";
import {
  createAiDocsFailureEvent,
  type AiDocsGenerationEvent,
  type AiDocsTelemetryStore
} from "./telemetry.js";

type AssistantPolicies = NonNullable<DocsAssistantOptions["policies"]>;

export interface CreateManagedAiDocsRuntimeOptions<TIdentity extends AiDocsRuntimeIdentity> {
  configuration: AiDocsConfigurationManager;
  documents?: DocumentationSource[];
  policies?: AssistantPolicies;
  /** Overrides the built-in `provider:model` AI SDK generator. */
  createGenerator?: (configuration: {
    model: string;
    apiKey?: string;
    baseURL?: string;
  }) => AnswerGenerator | Promise<AnswerGenerator>;
  timeoutMs?: number;
  maxRetries?: number;
  transformRequest?: (
    input: AskDocumentationRequest,
    identity: TIdentity
  ) => AskDocumentationRequest | Promise<AskDocumentationRequest>;
  transformResponse?: (
    output: AskDocumentationResponse,
    identity: TIdentity
  ) => AskDocumentationResponse | Promise<AskDocumentationResponse>;
  transformStreamEvent?: (
    event: DocsAssistantStreamEvent,
    identity: TIdentity
  ) => DocsAssistantStreamEvent | Promise<DocsAssistantStreamEvent>;
  authorize?: (identity: TIdentity) => Promise<void> | void;
  /** Receives provider/runtime failures without exposing prompts or credentials. */
  onGenerationError?: (
    error: unknown,
    operation: "answer" | "stream",
    identity: TIdentity
  ) => Promise<void> | void;
  /** Receives one safe success/failure event per user request. */
  onGenerationEvent?: (
    event: AiDocsGenerationEvent,
    identity: TIdentity
  ) => Promise<void> | void;
  /** Optional persistence used by the batteries-included managed server. */
  telemetryStore?: AiDocsTelemetryStore;
}

export interface ManagedAiDocsRuntime<TIdentity extends AiDocsRuntimeIdentity> {
  readonly configuration: AiDocsConfigurationManager;
  readonly telemetry?: AiDocsTelemetryStore;
  initialize(): Promise<void>;
  dispose(): void;
  reload(connectionAlreadyValidated?: boolean): Promise<void>;
  /** Replaces the stable documentation without recreating the configuration manager. */
  setDocuments(documents: DocumentationSource[]): Promise<void>;
  answer(input: AskDocumentationRequest, identity: TIdentity): Promise<AskDocumentationResponse>;
  stream(
    input: AskDocumentationRequest,
    identity: TIdentity,
    signal?: AbortSignal
  ): AsyncGenerator<DocsAssistantStreamEvent, AskDocumentationResponse>;
}

/**
 * Optional batteries-included runtime. The minimal `createDocsAssistant` API
 * remains available for applications that want to own the lifecycle.
 */
export function createManagedAiDocsRuntime<TIdentity extends AiDocsRuntimeIdentity>(
  options: CreateManagedAiDocsRuntimeOptions<TIdentity>
): ManagedAiDocsRuntime<TIdentity> {
  let assistant: DocsAssistant | undefined;
  let activeGenerator: AnswerGenerator | undefined;
  let documents = [...(options.documents ?? [])];
  let initialized = false;
  let reloadQueue = Promise.resolve();
  const unsubscribe = options.configuration.subscribe((event) => {
    if (!initialized || !event.reloadRequired) return;
    reloadQueue = reloadQueue.then(() => rebuild(event));
    return reloadQueue;
  });

  /** Recreates the assistant only when a usable provider connection exists. */
  const rebuild = async (event: Pick<AiDocsConfigurationChangeEvent, "connectionValidated">): Promise<void> => {
    const connected = event.connectionValidated || await options.configuration.validateRuntimeConnection();
    const configuration = await options.configuration.getRuntimeConfiguration();
    if (!connected || !configuration) {
      assistant = undefined;
      activeGenerator = undefined;
      return;
    }
    const generator = options.createGenerator
      ? await options.createGenerator({
          model: `${configuration.provider}:${configuration.model}`,
          ...(configuration.apiKey ? { apiKey: configuration.apiKey } : {}),
          ...(configuration.baseURL ? { baseURL: configuration.baseURL } : {})
        })
      : createAiSdkGenerator({
          model: `${configuration.provider}:${configuration.model}`,
          ...(configuration.apiKey ? { apiKey: configuration.apiKey } : {}),
          ...(configuration.baseURL ? { baseURL: configuration.baseURL } : {}),
          ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
          ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {})
        });
    activeGenerator = generator;
    assistant = createDocsAssistant({
      generator,
      documents,
      ...(options.policies ? { policies: options.policies } : {})
    });
  };

  /** Runs host authorization before the generic access and quota policies. */
  const authorize = async (identity: TIdentity): Promise<void> => {
    await options.authorize?.(identity);
    await options.configuration.assertCanAsk(identity);
  };

  const present = async (
    response: AskDocumentationResponse,
    identity: TIdentity
  ): Promise<AskDocumentationResponse> => options.transformResponse
    ? options.transformResponse(response, identity)
    : response;

  /** Records telemetry without ever changing the user-facing generation result. */
  const observe = async (event: AiDocsGenerationEvent, identity: TIdentity): Promise<void> => {
    const tasks: Array<Promise<void>> = [];
    if (options.telemetryStore) tasks.push(options.telemetryStore.record(event));
    if (options.onGenerationEvent) tasks.push(Promise.resolve(options.onGenerationEvent(event, identity)));
    await Promise.allSettled(tasks);
  };

  return {
    configuration: options.configuration,
    ...(options.telemetryStore ? { telemetry: options.telemetryStore } : {}),
    /** Starts cross-instance synchronization and validates the active provider once. */
    async initialize() {
      if (initialized) return;
      initialized = true;
      await options.configuration.startSynchronization();
      const connected = await options.configuration.validateRuntimeConnection();
      await rebuild({ connectionValidated: connected });
    },
    dispose() {
      initialized = false;
      unsubscribe();
      options.configuration.dispose();
      assistant = undefined;
      activeGenerator = undefined;
    },
    async reload(connectionAlreadyValidated = false) {
      await rebuild({ connectionValidated: connectionAlreadyValidated });
    },
    /** Refreshes model context without rebuilding storage or configuration state. */
    async setDocuments(nextDocuments) {
      documents = [...nextDocuments];
      if (!activeGenerator) return;
      assistant = createDocsAssistant({
        generator: activeGenerator,
        documents,
        ...(options.policies ? { policies: options.policies } : {})
      });
    },
    /** Applies host privacy hooks around one complete assistant response. */
    async answer(input, identity) {
      await authorize(identity);
      if (!assistant) await rebuild({ connectionValidated: true });
      if (!assistant) throw unavailable();
      const prepared = options.transformRequest ? await options.transformRequest(input, identity) : input;
      const startedAt = Date.now();
      try {
        const response = await present(await assistant.answer(prepared), identity);
        await observe({
          outcome: "success",
          requestId: input.requestId,
          operation: "answer",
          model: response.metadata.model,
          durationMs: Date.now() - startedAt,
          occurredAt: new Date().toISOString(),
          ...(response.metadata.usage ? { usage: response.metadata.usage } : {})
        }, identity);
        return response;
      } catch (error) {
        await observe(createAiDocsFailureEvent({
          error,
          requestId: input.requestId,
          operation: "answer",
          model: activeGenerator?.modelId ?? "unavailable",
          durationMs: Date.now() - startedAt
        }), identity);
        await options.onGenerationError?.(error, "answer", identity);
        throw error;
      }
    },
    /** Applies the same policies to every progressive stream event. */
    async *stream(input, identity, signal) {
      await authorize(identity);
      if (!assistant) await rebuild({ connectionValidated: true });
      if (!assistant) throw unavailable();
      const prepared = options.transformRequest ? await options.transformRequest(input, identity) : input;
      const startedAt = Date.now();
      try {
        const generation = assistant.stream(prepared, signal ? { signal } : undefined);
        let completedResponse: AskDocumentationResponse | undefined;
        while (true) {
          const next = await generation.next();
          if (next.done) {
            const response = completedResponse ?? await present(next.value, identity);
            await observe({
              outcome: "success",
              requestId: input.requestId,
              operation: "stream",
              model: response.metadata.model,
              durationMs: Date.now() - startedAt,
              occurredAt: new Date().toISOString(),
              ...(response.metadata.usage ? { usage: response.metadata.usage } : {})
            }, identity);
            return response;
          }
          let event = next.value.type === "complete"
            ? { ...next.value, response: await present(next.value.response, identity) }
            : next.value;
          if (options.transformStreamEvent) event = await options.transformStreamEvent(event, identity);
          if (event.type === "complete") completedResponse = event.response;
          yield event;
        }
      } catch (error) {
        await observe(createAiDocsFailureEvent({
          error,
          requestId: input.requestId,
          operation: "stream",
          model: activeGenerator?.modelId ?? "unavailable",
          durationMs: Date.now() - startedAt
        }), identity);
        await options.onGenerationError?.(error, "stream", identity);
        throw error;
      }
    }
  };
}

function unavailable(): AiDocsManagementError {
  return new AiDocsManagementError(
    503,
    "not_configured",
    "AI assistant is not configured or connected"
  );
}
