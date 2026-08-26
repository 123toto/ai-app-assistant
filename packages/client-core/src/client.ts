import {
  PROTOCOL_VERSION,
  askDocumentationResponseSchema,
  askDocumentationStreamEventSchema,
  type AskDocumentationRequest,
  type AskDocumentationResponse,
  type AskDocumentationStreamEvent
} from "@123toto/ai-app-assistant-contracts";

export interface AiDocsClientOptions {
  endpoint: string;
  fetch?: typeof globalThis.fetch;
  headers?: () => HeadersInit | Promise<HeadersInit>;
  transport?: AiDocsTransport;
  streamEndpoint?: string;
  streamTransport?: AiDocsStreamTransport;
}

export type AiDocsTransport = (
  request: AskDocumentationRequest,
  options: { endpoint: string; signal?: AbortSignal }
) => Promise<unknown>;

export type AiDocsStreamTransport = (
  request: AskDocumentationRequest,
  options: { endpoint: string; signal?: AbortSignal }
) => AsyncIterable<unknown>;

export interface AskInput {
  html: string;
  htmlTruncated?: boolean;
  selectedElementHtml?: string;
  question: string;
  conversation?: Array<{ role: "user" | "assistant"; content: string }>;
  locale?: string;
  requestId?: string;
}

export interface AiDocsClient {
  ask(input: AskInput, options?: { signal?: AbortSignal }): Promise<AskDocumentationResponse>;
  stream(
    input: AskInput,
    options?: {
      signal?: AbortSignal;
      onEvent?: (event: AskDocumentationStreamEvent) => void;
    }
  ): Promise<AskDocumentationResponse>;
}

/** Creates a small validated HTTP client with no framework dependency. */
export function createAiDocsClient(options: AiDocsClientOptions): AiDocsClient {
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  if (!options.transport && !fetchImplementation) {
    throw new Error("A fetch implementation is required.");
  }

  return {
    async ask(input, callOptions) {
      const request: AskDocumentationRequest = {
        protocolVersion: PROTOCOL_VERSION,
        requestId: input.requestId ?? crypto.randomUUID(),
        html: input.html,
        htmlTruncated: input.htmlTruncated ?? false,
        ...(input.selectedElementHtml
          ? { selectedElementHtml: input.selectedElementHtml }
          : {}),
        question: input.question,
        ...(input.conversation?.length ? { conversation: input.conversation } : {}),
        locale: input.locale ?? document.documentElement.lang ?? "fr"
      };

      if (options.transport) {
        return askDocumentationResponseSchema.parse(
          await options.transport(request, {
            endpoint: options.endpoint,
            ...(callOptions?.signal ? { signal: callOptions.signal } : {})
          })
        );
      }

      const customHeaders = await options.headers?.();
      const response = await fetchImplementation!(options.endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          ...customHeaders
        },
        body: JSON.stringify(request),
        ...(callOptions?.signal ? { signal: callOptions.signal } : {})
      });

      if (!response.ok) {
        throw new AiDocsHttpError(response.status, await response.text());
      }

      return askDocumentationResponseSchema.parse(await response.json());
    },

    async stream(input, callOptions) {
      const request = createRequest(input);
      const endpoint = options.streamEndpoint ?? `${options.endpoint}/stream`;
      const events = options.streamTransport
        ? options.streamTransport(request, {
          endpoint,
          ...(callOptions?.signal ? { signal: callOptions.signal } : {})
        })
        : streamWithFetch(fetchImplementation!, endpoint, request, options, callOptions?.signal);
      let response: AskDocumentationResponse | undefined;

      for await (const rawEvent of events) {
        const event = askDocumentationStreamEventSchema.parse(rawEvent);
        callOptions?.onEvent?.(event);
        if (event.type === "error") throw new Error(event.message);
        if (event.type === "complete") response = event.response;
      }

      if (!response) throw new Error("AI docs stream ended without a complete response.");
      return response;
    }
  };
}

function createRequest(input: AskInput): AskDocumentationRequest {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: input.requestId ?? crypto.randomUUID(),
    html: input.html,
    htmlTruncated: input.htmlTruncated ?? false,
    ...(input.selectedElementHtml ? { selectedElementHtml: input.selectedElementHtml } : {}),
    question: input.question,
    ...(input.conversation?.length ? { conversation: input.conversation } : {}),
    locale: input.locale ?? document.documentElement.lang ?? "fr"
  };
}

async function* streamWithFetch(
  fetchImplementation: typeof globalThis.fetch,
  endpoint: string,
  request: AskDocumentationRequest,
  options: AiDocsClientOptions,
  signal?: AbortSignal
): AsyncGenerator<unknown> {
  const customHeaders = await options.headers?.();
  const response = await fetchImplementation(endpoint, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...customHeaders },
    body: JSON.stringify(request),
    ...(signal ? { signal } : {})
  });
  if (!response.ok) throw new AiDocsHttpError(response.status, await response.text());
  if (!response.body) throw new Error("Streaming response has no body.");

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) yield JSON.parse(line);
    }
    if (buffer.trim()) yield JSON.parse(buffer);
  } finally {
    reader.releaseLock();
  }
}

export class AiDocsHttpError extends Error {
  constructor(
    readonly status: number,
    readonly responseBody: string
  ) {
    super(`AI docs request failed with status ${status}.`);
    this.name = "AiDocsHttpError";
  }
}
