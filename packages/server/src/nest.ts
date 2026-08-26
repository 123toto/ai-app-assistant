import {
  All,
  Controller,
  Inject,
  Injectable,
  Module,
  Req,
  Res,
  type DynamicModule,
  type FactoryProvider,
  type ModuleMetadata,
  type Provider
} from "@nestjs/common";
import type { ManagedAiAppAssistantServer } from "./managed-server.js";

// Same metadata key used by @nestjs/swagger's ApiExcludeController decorator.
// Keeping it local avoids making Swagger a dependency of the optional Nest connector.
const OPENAPI_EXCLUDE_CONTROLLER_METADATA = "swagger/apiExcludeController";

/** Injection token exported so a host can update documents after Swagger bootstrap. */
export const MANAGED_AI_APP_ASSISTANT_SERVER = Symbol.for("@123toto/ai-app-assistant-server/managed");

export interface AiAppAssistantNestRequest {
  method?: string;
  originalUrl?: string;
  url?: string;
  protocol?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  on?(event: string, listener: () => void): unknown;
  off?(event: string, listener: () => void): unknown;
  [key: string]: unknown;
}

export interface AiAppAssistantNestResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  write(chunk: Uint8Array): boolean;
  end(chunk?: string): unknown;
  once?(event: string, listener: () => void): unknown;
  destroyed?: boolean;
}

export interface AiAppAssistantNestModuleOptions<
  TRequest extends AiAppAssistantNestRequest = AiAppAssistantNestRequest
> extends Pick<ModuleMetadata, "imports"> {
  /** Nest controller path. The application's global prefix is applied normally. */
  path?: string;
  inject?: FactoryProvider["inject"];
  // Nest factories intentionally accept host-defined constructor signatures.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useFactory: (...dependencies: any[]) =>
    | AiAppAssistantNestManagedServer<TRequest>
    | Promise<AiAppAssistantNestManagedServer<TRequest>>;
}

/** Structural server contract avoids leaking framework-internal types across package entry points. */
export type AiAppAssistantNestManagedServer<TRequest extends AiAppAssistantNestRequest = AiAppAssistantNestRequest> = Pick<
  ManagedAiAppAssistantServer<{ id: string; label: string }, TRequest>,
  "fetch" | "dispose"
>;

/**
 * Creates a dynamic Nest module with one catch-all controller owned by the
 * connector. Consumer applications declare no AI App Assistant endpoints or DTOs.
 */
export function createManagedAiAppAssistantNestModule<
  TRequest extends AiAppAssistantNestRequest = AiAppAssistantNestRequest
>(options: AiAppAssistantNestModuleOptions<TRequest>): DynamicModule {
  const route = options.path?.replace(/^\/+|\/+$/g, "") || "ai-app-assistant";

  class ManagedAiAppAssistantNestController {
    public constructor(
      readonly server: AiAppAssistantNestManagedServer<TRequest>
    ) {}

    public handle(request: TRequest, response: AiAppAssistantNestResponse): Promise<void> {
      return handleManagedAiAppAssistantNestRequest(this.server, request, response);
    }
  }

  Inject(MANAGED_AI_APP_ASSISTANT_SERVER)(ManagedAiAppAssistantNestController, undefined, 0);
  Req()(ManagedAiAppAssistantNestController.prototype, "handle", 0);
  Res()(ManagedAiAppAssistantNestController.prototype, "handle", 1);
  const descriptor = Object.getOwnPropertyDescriptor(ManagedAiAppAssistantNestController.prototype, "handle");
  if (descriptor) All(["", "*path"])(ManagedAiAppAssistantNestController.prototype, "handle", descriptor);
  // A catch-all Nest route is exposed as the non-standard HTTP verb `all` by
  // Swagger. Exclude this transport controller so it cannot invalidate the
  // consuming application's OpenAPI document.
  Reflect.defineMetadata(OPENAPI_EXCLUDE_CONTROLLER_METADATA, [true], ManagedAiAppAssistantNestController);
  Controller(route)(ManagedAiAppAssistantNestController);

  class ManagedAiAppAssistantNestModule {}
  class ManagedAiAppAssistantNestLifecycle {
    public constructor(readonly server: AiAppAssistantNestManagedServer<TRequest>) {}
    public onApplicationShutdown(): void {
      this.server.dispose();
    }
  }
  Inject(MANAGED_AI_APP_ASSISTANT_SERVER)(ManagedAiAppAssistantNestLifecycle, undefined, 0);
  Injectable()(ManagedAiAppAssistantNestLifecycle);
  const serverProvider: Provider = {
    provide: MANAGED_AI_APP_ASSISTANT_SERVER,
    inject: options.inject ?? [],
    useFactory: options.useFactory
  };
  Module({
    imports: options.imports ?? [],
    controllers: [ManagedAiAppAssistantNestController],
    providers: [serverProvider, ManagedAiAppAssistantNestLifecycle],
    exports: [MANAGED_AI_APP_ASSISTANT_SERVER]
  })(ManagedAiAppAssistantNestModule);

  return {
    module: ManagedAiAppAssistantNestModule,
    imports: options.imports ?? [],
    controllers: [ManagedAiAppAssistantNestController],
    providers: [serverProvider, ManagedAiAppAssistantNestLifecycle],
    exports: [MANAGED_AI_APP_ASSISTANT_SERVER]
  };
}

/** Adapts parsed Nest requests and streamed Fetch responses without Express coupling. */
export async function handleManagedAiAppAssistantNestRequest<
  TRequest extends AiAppAssistantNestRequest
>(
  server: AiAppAssistantNestManagedServer<TRequest>,
  request: TRequest,
  response: AiAppAssistantNestResponse
): Promise<void> {
  const abortController = new AbortController();
  const abort = (): void => abortController.abort(new DOMException("Client disconnected", "AbortError"));
  request.on?.("close", abort);
  try {
    const webRequest = toFetchRequest(request, abortController.signal);
    await writeFetchResponse(response, await server.fetch.handle(webRequest, request));
  } finally {
    request.off?.("close", abort);
  }
}

function toFetchRequest(request: AiAppAssistantNestRequest, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  const method = request.method?.toUpperCase() || "GET";
  const host = headers.get("host") || "localhost";
  const protocol = request.protocol || headers.get("x-forwarded-proto") || "http";
  const url = new URL(request.originalUrl || request.url || "/", `${protocol}://${host}`);
  const hasBody = method !== "GET" && method !== "HEAD" && request.body !== undefined;
  return new Request(url, {
    method,
    headers,
    signal,
    ...(hasBody ? { body: serializeBody(request.body, headers) } : {})
  });
}

function serializeBody(body: unknown, headers: Headers): string {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return JSON.stringify(body);
}

async function writeFetchResponse(response: AiAppAssistantNestResponse, result: Response): Promise<void> {
  response.statusCode = result.status;
  result.headers.forEach((value, name) => response.setHeader(name, value));
  if (!result.body) {
    response.end();
    return;
  }
  const reader = result.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!response.write(value) && response.once) {
        await new Promise<void>((resolve) => response.once!("drain", resolve));
      }
    }
    if (!response.destroyed) response.end();
  } finally {
    reader.releaseLock();
  }
}
