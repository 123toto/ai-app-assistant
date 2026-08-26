import {
  askDocumentationRequestSchema,
  type AskDocumentationRequest,
  type AskDocumentationResponse
} from "@123toto/ai-app-assistant-contracts";
import { ZodError } from "zod";
import type { DocsAssistant, DocsAssistantStreamEvent } from "./assistant.js";

export interface AiDocsFetchHandlerOptions<TContext = undefined> {
  assistant: DocsAssistant;
  /** Resolves framework-specific authentication into an application context. */
  resolveContext?: (request: Request) => Promise<TContext> | TContext;
  /** Optional application authorization executed before assistant work. */
  authorize?: (context: TContext, request: Request) => Promise<void> | void;
  /** Explicit opt-in for public prototypes without authentication hooks. */
  allowAnonymous?: boolean;
  /** Optional privacy/input policy applied after protocol validation. */
  transformRequest?: (
    input: AskDocumentationRequest,
    context: TContext
  ) => Promise<AskDocumentationRequest> | AskDocumentationRequest;
  /** Optional privacy/output policy applied before serialization. */
  transformResponse?: (
    response: AskDocumentationResponse,
    context: TContext
  ) => Promise<AskDocumentationResponse> | AskDocumentationResponse;
  /** Applies privacy rules to progressive text before it leaves the backend. */
  transformStreamEvent?: (
    event: DocsAssistantStreamEvent,
    context: TContext
  ) => Promise<DocsAssistantStreamEvent> | DocsAssistantStreamEvent;
  /** Maximum HTTP request size. Defaults slightly above the protocol limit. */
  maxBodyBytes?: number;
  /** Maps application errors without coupling the library to one framework. */
  onError?: (error: unknown, request: Request) => Promise<Response> | Response;
}

export interface AiDocsFetchHandlers {
  ask(request: Request): Promise<Response>;
  stream(request: Request): Promise<Response>;
  /** Dispatches to `stream` when the pathname ends in `/stream`, otherwise to `ask`. */
  handle(request: Request): Promise<Response>;
}

/** Explicit safe HTTP error that host authorization hooks can throw. */
export class AiDocsRequestError extends Error {
  public constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "AiDocsRequestError";
  }
}

/**
 * Creates Fetch API handlers usable by standards-based runtimes and thin
 * Express, Fastify, Nest, Next.js, Hono, Bun or serverless adapters.
 */
export function createAiDocsFetchHandlers<TContext = undefined>(
  options: AiDocsFetchHandlerOptions<TContext>
): AiDocsFetchHandlers {
  const prepare = async (request: Request): Promise<{
    input: AskDocumentationRequest;
    context: TContext;
  }> => {
    assertPost(request);
    const raw = await readJson(request, options.maxBodyBytes ?? 8_600_000);
    const validated = askDocumentationRequestSchema.parse(raw);
    if (!options.resolveContext && !options.authorize && !options.allowAnonymous) {
      throw new AiDocsRequestError(401, "unauthorized", "Authentication is required");
    }
    const context = options.resolveContext
      ? await options.resolveContext(request)
      : undefined as TContext;
    await options.authorize?.(context, request);
    const input = options.transformRequest
      ? await options.transformRequest(validated, context)
      : validated;
    return { input: askDocumentationRequestSchema.parse(input), context };
  };

  const present = async (
    response: AskDocumentationResponse,
    context: TContext
  ): Promise<AskDocumentationResponse> => options.transformResponse
    ? options.transformResponse(response, context)
    : response;

  const ask = async (request: Request): Promise<Response> => {
    try {
      const { input, context } = await prepare(request);
      return jsonResponse(await present(await options.assistant.answer(input, {
        signal: request.signal
      }), context));
    } catch (error) {
      return mapError(error, request, options.onError);
    }
  };

  const stream = async (request: Request): Promise<Response> => {
    try {
      const { input, context } = await prepare(request);
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            const generation = options.assistant.stream(input, { signal: request.signal });
            while (true) {
              const next = await generation.next();
              if (next.done) break;
              let event = next.value.type === "complete"
                ? { ...next.value, response: await present(next.value.response, context) }
                : next.value;
              if (options.transformStreamEvent) {
                event = await options.transformStreamEvent(event, context);
              }
              controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
            }
          } catch {
            controller.enqueue(encoder.encode(`${JSON.stringify({
              type: "error",
              message: "The assistant response could not be generated.",
              retryable: false
            })}\n`));
          } finally {
            controller.close();
          }
        }
      });
      return new Response(body, {
        status: 200,
        headers: {
          "cache-control": "no-store",
          "content-type": "application/x-ndjson; charset=utf-8",
          "x-content-type-options": "nosniff"
        }
      });
    } catch (error) {
      return mapError(error, request, options.onError);
    }
  };

  return {
    ask,
    stream,
    handle: (request) => new URL(request.url).pathname.endsWith("/stream")
      ? stream(request)
      : ask(request)
  };
}

function assertPost(request: Request): void {
  if (request.method !== "POST") {
    throw new AiDocsRequestError(405, "method_not_allowed", "Only POST is supported");
  }
}

async function readJson(request: Request, maxBodyBytes: number): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    throw new AiDocsRequestError(413, "request_too_large", "Request body is too large");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBodyBytes) {
    throw new AiDocsRequestError(413, "request_too_large", "Request body is too large");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AiDocsRequestError(400, "invalid_json", "Request body must be valid JSON");
  }
}

async function mapError(
  error: unknown,
  request: Request,
  customMapper?: AiDocsFetchHandlerOptions<unknown>["onError"]
): Promise<Response> {
  if (customMapper) return customMapper(error, request);
  if (error instanceof AiDocsRequestError) {
    return jsonResponse({ error: error.code, message: error.message }, error.status);
  }
  if (error instanceof ZodError) {
    return jsonResponse({ error: "invalid_request", message: "The assistant request is invalid." }, 400);
  }
  return jsonResponse({
    error: "assistant_error",
    message: "The assistant response could not be generated."
  }, 500);
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff"
    }
  });
}
