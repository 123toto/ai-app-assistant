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
import type { ManagedAiDocsServer } from "./managed-server.js";

/** Injection token exported so a host can update documents after Swagger bootstrap. */
export const MANAGED_AI_DOCS_SERVER = Symbol.for("@123toto/ai-app-assistant-server/managed");

export interface AiDocsNestRequest {
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

export interface AiDocsNestResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  write(chunk: Uint8Array): boolean;
  end(chunk?: string): unknown;
  once?(event: string, listener: () => void): unknown;
  destroyed?: boolean;
}

export interface AiDocsNestModuleOptions<
  TRequest extends AiDocsNestRequest = AiDocsNestRequest
> extends Pick<ModuleMetadata, "imports"> {
  /** Nest controller path. The application's global prefix is applied normally. */
  path?: string;
  inject?: FactoryProvider["inject"];
  // Nest factories intentionally accept host-defined constructor signatures.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useFactory: (...dependencies: any[]) =>
    | AiDocsNestManagedServer<TRequest>
    | Promise<AiDocsNestManagedServer<TRequest>>;
}

/** Structural server contract avoids leaking framework-internal types across package entry points. */
export type AiDocsNestManagedServer<TRequest extends AiDocsNestRequest = AiDocsNestRequest> = Pick<
  ManagedAiDocsServer<{ id: string; label: string }, TRequest>,
  "fetch" | "dispose"
>;

/**
 * Creates a dynamic Nest module with one catch-all controller owned by the
 * connector. Consumer applications declare no AI Docs endpoints or DTOs.
 */
export function createManagedAiDocsNestModule<
  TRequest extends AiDocsNestRequest = AiDocsNestRequest
>(options: AiDocsNestModuleOptions<TRequest>): DynamicModule {
  const route = options.path?.replace(/^\/+|\/+$/g, "") || "ai-docs";

  class ManagedAiDocsNestController {
    public constructor(
      readonly server: AiDocsNestManagedServer<TRequest>
    ) {}

    public handle(request: TRequest, response: AiDocsNestResponse): Promise<void> {
      return handleManagedAiDocsNestRequest(this.server, request, response);
    }
  }

  Inject(MANAGED_AI_DOCS_SERVER)(ManagedAiDocsNestController, undefined, 0);
  Req()(ManagedAiDocsNestController.prototype, "handle", 0);
  Res()(ManagedAiDocsNestController.prototype, "handle", 1);
  const descriptor = Object.getOwnPropertyDescriptor(ManagedAiDocsNestController.prototype, "handle");
  if (descriptor) All(["", "*path"])(ManagedAiDocsNestController.prototype, "handle", descriptor);
  Controller(route)(ManagedAiDocsNestController);

  class ManagedAiDocsNestModule {}
  class ManagedAiDocsNestLifecycle {
    public constructor(readonly server: AiDocsNestManagedServer<TRequest>) {}
    public onApplicationShutdown(): void {
      this.server.dispose();
    }
  }
  Inject(MANAGED_AI_DOCS_SERVER)(ManagedAiDocsNestLifecycle, undefined, 0);
  Injectable()(ManagedAiDocsNestLifecycle);
  const serverProvider: Provider = {
    provide: MANAGED_AI_DOCS_SERVER,
    inject: options.inject ?? [],
    useFactory: options.useFactory
  };
  Module({
    imports: options.imports ?? [],
    controllers: [ManagedAiDocsNestController],
    providers: [serverProvider, ManagedAiDocsNestLifecycle],
    exports: [MANAGED_AI_DOCS_SERVER]
  })(ManagedAiDocsNestModule);

  return {
    module: ManagedAiDocsNestModule,
    imports: options.imports ?? [],
    controllers: [ManagedAiDocsNestController],
    providers: [serverProvider, ManagedAiDocsNestLifecycle],
    exports: [MANAGED_AI_DOCS_SERVER]
  };
}

/** Adapts parsed Nest requests and streamed Fetch responses without Express coupling. */
export async function handleManagedAiDocsNestRequest<
  TRequest extends AiDocsNestRequest
>(
  server: AiDocsNestManagedServer<TRequest>,
  request: TRequest,
  response: AiDocsNestResponse
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

function toFetchRequest(request: AiDocsNestRequest, signal: AbortSignal): Request {
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

async function writeFetchResponse(response: AiDocsNestResponse, result: Response): Promise<void> {
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
