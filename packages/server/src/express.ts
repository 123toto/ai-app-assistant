import { AiAppAssistantRequestError } from "./http.js";
import type { ManagedAiAppAssistantServer } from "./managed-server.js";

/** Minimal Express request shape; importing Express types is intentionally unnecessary. */
export interface AiAppAssistantExpressRequest {
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

/** Minimal Express response shape used by the connector. */
export interface AiAppAssistantExpressResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  write(chunk: Uint8Array): boolean;
  end(chunk?: string): unknown;
  once?(event: string, listener: () => void): unknown;
  destroyed?: boolean;
}

export type AiAppAssistantExpressNext = (error?: unknown) => void;

export type AiAppAssistantExpressManagedServer<
  TRequest extends AiAppAssistantExpressRequest = AiAppAssistantExpressRequest
> = Pick<ManagedAiAppAssistantServer<{ id: string; label: string }, TRequest>, "fetch">;

export interface AiAppAssistantExpressHandlerOptions {
  /** Origin used only when Express does not expose a Host header. */
  origin?: string;
  /** Maximum size accepted when no JSON body parser populated request.body. */
  maxBodyBytes?: number;
  /** Lets another Express handler process unknown routes below the mounted prefix. */
  fallthrough?: boolean;
}

export type AiAppAssistantExpressHandler<TRequest extends AiAppAssistantExpressRequest> = (
  request: TRequest,
  response: AiAppAssistantExpressResponse,
  next?: AiAppAssistantExpressNext
) => Promise<void>;

/**
 * Creates an Express-compatible handler for the complete managed API.
 *
 * @example
 * `app.use("/api/ai-app-assistant", createManagedAiAppAssistantExpressHandler(aiAppAssistant));`
 */
export function createManagedAiAppAssistantExpressHandler<
  TRequest extends AiAppAssistantExpressRequest = AiAppAssistantExpressRequest
>(
  server: AiAppAssistantExpressManagedServer<TRequest>,
  options: AiAppAssistantExpressHandlerOptions = {}
): AiAppAssistantExpressHandler<TRequest> {
  return async (request, response, next) => {
    const abortController = new AbortController();
    const abort = (): void => abortController.abort(new DOMException("Client disconnected", "AbortError"));
    request.on?.("close", abort);
    try {
      const webRequest = await toFetchRequest(request, abortController.signal, options);
      const result = await server.fetch.handle(webRequest, request);
      if (options.fallthrough && result.status === 404 && next) {
        next();
        return;
      }
      await writeFetchResponse(response, result);
    } catch (error) {
      if (next) {
        next(error);
        return;
      }
      writeConnectorError(response, error);
    } finally {
      request.off?.("close", abort);
    }
  };
}

async function toFetchRequest(
  request: AiAppAssistantExpressRequest,
  signal: AbortSignal,
  options: AiAppAssistantExpressHandlerOptions
): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  const method = request.method?.toUpperCase() || "GET";
  const host = headers.get("host");
  const protocol = request.protocol || headers.get("x-forwarded-proto") || "http";
  const origin = options.origin ?? `${protocol}://${host || "localhost"}`;
  // originalUrl preserves the mount prefix stripped from request.url by Express.
  const url = new URL(request.originalUrl || request.url || "/", origin);
  const body = method === "GET" || method === "HEAD"
    ? undefined
    : request.body !== undefined
      ? serializeBody(request.body, headers)
      : await readBody(request, options.maxBodyBytes ?? 8_600_000);
  return new Request(url, {
    method,
    headers,
    signal,
    ...(body !== undefined ? { body } : {})
  });
}

function serializeBody(body: unknown, headers: Headers): string {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return JSON.stringify(body) ?? "null";
}

async function readBody(request: AiAppAssistantExpressRequest, maxBodyBytes: number): Promise<string | undefined> {
  if (!(Symbol.asyncIterator in request)) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<string | Uint8Array>) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk);
    size += bytes.byteLength;
    if (size > maxBodyBytes) {
      throw new AiAppAssistantRequestError(413, "request_too_large", "Request body is too large");
    }
    chunks.push(bytes);
  }
  return chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined;
}

async function writeFetchResponse(response: AiAppAssistantExpressResponse, result: Response): Promise<void> {
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

function writeConnectorError(response: AiAppAssistantExpressResponse, error: unknown): void {
  const status = error instanceof AiAppAssistantRequestError ? error.status : 500;
  const code = error instanceof AiAppAssistantRequestError ? error.code : "assistant_error";
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify({ error: code }));
}
