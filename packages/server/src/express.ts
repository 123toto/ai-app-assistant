import { AiDocsRequestError } from "./http.js";
import type { ManagedAiDocsServer } from "./managed-server.js";

/** Minimal Express request shape; importing Express types is intentionally unnecessary. */
export interface AiDocsExpressRequest {
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
export interface AiDocsExpressResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  write(chunk: Uint8Array): boolean;
  end(chunk?: string): unknown;
  once?(event: string, listener: () => void): unknown;
  destroyed?: boolean;
}

export type AiDocsExpressNext = (error?: unknown) => void;

export type AiDocsExpressManagedServer<
  TRequest extends AiDocsExpressRequest = AiDocsExpressRequest
> = Pick<ManagedAiDocsServer<{ id: string; label: string }, TRequest>, "fetch">;

export interface AiDocsExpressHandlerOptions {
  /** Origin used only when Express does not expose a Host header. */
  origin?: string;
  /** Maximum size accepted when no JSON body parser populated request.body. */
  maxBodyBytes?: number;
  /** Lets another Express handler process unknown routes below the mounted prefix. */
  fallthrough?: boolean;
}

export type AiDocsExpressHandler<TRequest extends AiDocsExpressRequest> = (
  request: TRequest,
  response: AiDocsExpressResponse,
  next?: AiDocsExpressNext
) => Promise<void>;

/**
 * Creates an Express-compatible handler for the complete managed API.
 *
 * @example
 * `app.use("/api/ai-docs", createManagedAiDocsExpressHandler(aiDocs));`
 */
export function createManagedAiDocsExpressHandler<
  TRequest extends AiDocsExpressRequest = AiDocsExpressRequest
>(
  server: AiDocsExpressManagedServer<TRequest>,
  options: AiDocsExpressHandlerOptions = {}
): AiDocsExpressHandler<TRequest> {
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
  request: AiDocsExpressRequest,
  signal: AbortSignal,
  options: AiDocsExpressHandlerOptions
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

async function readBody(request: AiDocsExpressRequest, maxBodyBytes: number): Promise<string | undefined> {
  if (!(Symbol.asyncIterator in request)) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<string | Uint8Array>) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk);
    size += bytes.byteLength;
    if (size > maxBodyBytes) {
      throw new AiDocsRequestError(413, "request_too_large", "Request body is too large");
    }
    chunks.push(bytes);
  }
  return chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined;
}

async function writeFetchResponse(response: AiDocsExpressResponse, result: Response): Promise<void> {
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

function writeConnectorError(response: AiDocsExpressResponse, error: unknown): void {
  const status = error instanceof AiDocsRequestError ? error.status : 500;
  const code = error instanceof AiDocsRequestError ? error.code : "assistant_error";
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify({ error: code }));
}
