import {
  aiAppAssistantConfigurationInputSchema,
  aiAppAssistantConnectionTestInputSchema,
  aiAppAssistantCredentialsSchema,
  aiAppAssistantRequestSchema
} from "@123toto/ai-app-assistant-contracts";
import { ZodError } from "zod";
import type { ManagedAiAppAssistantRuntime } from "./managed-runtime.js";
import {
  AiAppAssistantManagementError,
  type AiAppAssistantRuntimeIdentity
} from "./management.js";
import { normalizeAiSdkGenerationError } from "./ai-sdk.js";

export interface ManagedAiAppAssistantFetchHandlerOptions<
  TIdentity extends AiAppAssistantRuntimeIdentity,
  TNativeContext = undefined
> {
  runtime: ManagedAiAppAssistantRuntime<TIdentity>;
  /** Required by default so application endpoints fail closed. */
  resolveIdentity?: (request: Request, nativeContext: TNativeContext | undefined) => TIdentity | Promise<TIdentity>;
  /** Explicit opt-in for public prototypes. Never enable it on authenticated applications. */
  allowAnonymous?: boolean;
  /** Admin endpoints fail closed when this hook is omitted. */
  authorizeAdministration?: (identity: TIdentity, request: Request, nativeContext: TNativeContext | undefined) => Promise<void> | void;
  /** Optional application directory exposed to the generic settings UI. */
  listUsers?: (identity: TIdentity, nativeContext: TNativeContext | undefined) => Promise<Array<{ id: string; label: string }>>;
  /** Optional application roles exposed to the generic settings UI. */
  listRoles?: (identity: TIdentity, nativeContext: TNativeContext | undefined) => Promise<Array<{ id: string; label: string }>> | Array<{ id: string; label: string }>;
  maxBodyBytes?: number;
  onError?: (error: unknown, request: Request, nativeContext: TNativeContext | undefined) => Response | Promise<Response>;
}

export interface ManagedAiAppAssistantFetchHandlers<TNativeContext = undefined> {
  handle(request: Request, nativeContext?: TNativeContext): Promise<Response>;
}

/** Complete framework-neutral chat and administration API. */
export function createManagedAiAppAssistantFetchHandlers<
  TIdentity extends AiAppAssistantRuntimeIdentity,
  TNativeContext = undefined
>(
  options: ManagedAiAppAssistantFetchHandlerOptions<TIdentity, TNativeContext>
): ManagedAiAppAssistantFetchHandlers<TNativeContext> {
  // Identity and administration hooks deliberately fail closed. Public
  // prototypes must opt in explicitly through allowAnonymous.
  const identity = async (request: Request, nativeContext: TNativeContext | undefined): Promise<TIdentity> => {
    if (options.resolveIdentity) return options.resolveIdentity(request, nativeContext);
    if (options.allowAnonymous) {
      return { id: "anonymous", label: "Anonymous", roles: [] } as unknown as TIdentity;
    }
    throw new AiAppAssistantManagementError(401, "unauthorized", "Authentication is required");
  };
  const admin = async (request: Request, resolved: TIdentity, nativeContext: TNativeContext | undefined): Promise<void> => {
    if (!options.authorizeAdministration) {
      throw new AiAppAssistantManagementError(403, "forbidden", "Administration access is not configured");
    }
    await options.authorizeAdministration(resolved, request, nativeContext);
  };

  return {
    async handle(request, nativeContext) {
      try {
        const url = new URL(request.url);
        const path = url.pathname.replace(/\/+$/, "");
        const currentIdentity = await identity(request, nativeContext);

        // Chat routes require a valid user; all routes below them additionally
        // pass through the administration hook.
        if (request.method === "GET" && path.endsWith("/access")) {
          return json(await options.runtime.configuration.getAccess(currentIdentity));
        }
        if (request.method === "POST" && path.endsWith("/ask/stream")) {
          const input = aiAppAssistantRequestSchema.parse(await readJson(request, options.maxBodyBytes));
          const generation = options.runtime.stream(input, currentIdentity, request.signal);
          const first = await generation.next();
          return streamResponse(generation, first, input.requestId);
        }
        if (request.method === "POST" && path.endsWith("/ask")) {
          const input = aiAppAssistantRequestSchema.parse(await readJson(request, options.maxBodyBytes));
          return json(await options.runtime.answer(input, currentIdentity));
        }

        await admin(request, currentIdentity, nativeContext);
        if (request.method === "GET" && path.endsWith("/telemetry/failures")) {
          const limit = Number(url.searchParams.get("limit") ?? 20);
          return json(await options.runtime.telemetry?.recentFailures(limit) ?? []);
        }
        if (request.method === "GET" && path.endsWith("/telemetry")) {
          return json(await options.runtime.telemetry?.summary() ?? {
            requests: 0,
            succeeded: 0,
            failed: 0,
            durationMs: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            failuresByCode: {}
          });
        }
        if (request.method === "GET" && path.endsWith("/configuration")) {
          return json(await options.runtime.configuration.getView(currentIdentity));
        }
        if (request.method === "GET" && path.endsWith("/providers")) {
          return json(options.runtime.configuration.listProviders());
        }
        if (request.method === "GET" && path.endsWith("/configuration/options")) {
          const [roles, users] = await Promise.all([
            Promise.resolve(options.listRoles?.(currentIdentity, nativeContext) ?? []),
            options.listUsers?.(currentIdentity, nativeContext) ?? Promise.resolve([])
          ]);
          return json({ roles, users });
        }
        if (request.method === "POST" && path.endsWith("/models")) {
          const input = aiAppAssistantCredentialsSchema.parse(await readJson(request, options.maxBodyBytes));
          return json(await options.runtime.configuration.listModels(input));
        }
        if (request.method === "POST" && path.endsWith("/configuration/test")) {
          const input = aiAppAssistantConnectionTestInputSchema.parse(await readJson(request, options.maxBodyBytes));
          return json(await options.runtime.configuration.testConnection(input));
        }
        if (request.method === "PUT" && path.endsWith("/configuration")) {
          const input = aiAppAssistantConfigurationInputSchema.parse(await readJson(request, options.maxBodyBytes));
          const { reloadRequired: _reloadRequired, ...result } = await options.runtime.configuration.save(input, currentIdentity);
          return json(result);
        }
        if (request.method === "DELETE" && path.endsWith("/configuration/api-key")) {
          return json(await options.runtime.configuration.revokeApiKey(currentIdentity));
        }
        return json({ error: "not_found", message: "AI App Assistant endpoint not found" }, 404);
      } catch (error) {
        if (options.onError) return options.onError(error, request, nativeContext);
        return mapError(error);
      }
    }
  };
}

/** Reads and limits both declared and actual body size before validation. */
async function readJson(request: Request, maxBodyBytes = 8_600_000): Promise<unknown> {
  const declaredSize = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > maxBodyBytes) {
    throw new AiAppAssistantManagementError(413, "invalid_request", "Request body is too large");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBodyBytes) {
    throw new AiAppAssistantManagementError(413, "invalid_request", "Request body is too large");
  }
  return JSON.parse(text) as unknown;
}

/** Converts async assistant events to one JSON object per line. */
function streamResponse<T>(
  generation: AsyncGenerator<T>,
  first: IteratorResult<T>,
  requestId: string
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        if (!first.done) controller.enqueue(encoder.encode(`${JSON.stringify(first.value)}\n`));
        while (true) {
          const next = await generation.next();
          if (next.done) break;
          controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
        }
      } catch (error) {
        const failure = normalizeAiSdkGenerationError(error, 1);
        controller.enqueue(encoder.encode(`${JSON.stringify({
          type: "error",
          message: error instanceof AiAppAssistantManagementError
            ? error.message
            : "The assistant response could not be generated.",
          retryable: error instanceof AiAppAssistantManagementError ? false : failure.retryable,
          ...(error instanceof AiAppAssistantManagementError ? {} : {
            code: failure.code,
            requestId
          })
        })}\n`));
      } finally {
        controller.close();
      }
    }
  });
  return new Response(body, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/x-ndjson; charset=utf-8",
      "x-content-type-options": "nosniff"
    }
  });
}

function mapError(error: unknown): Response {
  if (error instanceof AiAppAssistantManagementError) {
    return json({ error: error.code, message: error.message, ...error.details }, error.status);
  }
  if (error instanceof ZodError || error instanceof SyntaxError) {
    return json({ error: "invalid_request", message: "The assistant request is invalid." }, 400);
  }
  return json({ error: "assistant_error", message: "The assistant response could not be generated." }, 500);
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff"
    }
  });
}
