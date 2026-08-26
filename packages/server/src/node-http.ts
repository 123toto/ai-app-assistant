import type { IncomingMessage, ServerResponse } from "node:http";
import { AiDocsRequestError } from "./http.js";

export interface AiDocsNodeHttpAdapterOptions {
  /** Used when the incoming request does not expose an absolute URL. */
  origin?: string;
  /** Protects the adapter before constructing a Fetch API Request. */
  maxBodyBytes?: number;
}

export type AiDocsNodeHttpListener = (
  request: IncomingMessage,
  response: ServerResponse
) => Promise<void>;

/** Minimal shape implemented by both basic and managed Fetch handlers. */
export interface AiDocsNodeHttpHandler {
  handle(request: Request): Promise<Response>;
}

/**
 * Bridges Node's native HTTP objects to the framework-neutral Fetch handlers.
 * Express, Nest-on-Express and Fastify can expose their raw request/response.
 */
export function createAiDocsNodeHttpListener(
  handlers: AiDocsNodeHttpHandler,
  options: AiDocsNodeHttpAdapterOptions = {}
): AiDocsNodeHttpListener {
  return async (request, response) => {
    try {
      const webRequest = await toRequest(request, options);
      const handle = handlers.handle as (
        webRequest: Request,
        nativeRequest?: IncomingMessage
      ) => Promise<Response>;
      await writeResponse(response, await handle(webRequest, request));
    } catch (error) {
      const status = error instanceof AiDocsRequestError ? error.status : 500;
      const code = error instanceof AiDocsRequestError ? error.code : "assistant_error";
      response.statusCode = status;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ error: code }));
    }
  };
}

async function toRequest(
  request: IncomingMessage,
  options: AiDocsNodeHttpAdapterOptions
): Promise<Request> {
  const origin = options.origin ?? "http://localhost";
  const url = new URL(request.url ?? "/", origin);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  const method = request.method ?? "GET";
  const body = method === "GET" || method === "HEAD"
    ? undefined
    : await readBody(request, options.maxBodyBytes ?? 8_600_000);
  return new Request(url, {
    method,
    headers,
    ...(body ? { body } : {})
  });
}

async function readBody(request: IncomingMessage, maxBodyBytes: number): Promise<string | undefined> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk);
    size += bytes.byteLength;
    if (size > maxBodyBytes) {
      throw new AiDocsRequestError(413, "request_too_large", "Request body is too large");
    }
    chunks.push(bytes);
  }
  return chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined;
}

async function writeResponse(response: ServerResponse, webResponse: Response): Promise<void> {
  response.statusCode = webResponse.status;
  webResponse.headers.forEach((value, name) => response.setHeader(name, value));
  if (!webResponse.body) {
    response.end();
    return;
  }
  const reader = webResponse.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!response.write(value)) await new Promise<void>((resolve) => response.once("drain", resolve));
    }
    response.end();
  } finally {
    reader.releaseLock();
  }
}
