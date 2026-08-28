import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createAiAppAssistantNodeHttpListener } from "./node-http.js";

describe("createAiAppAssistantNodeHttpListener", () => {
  it("converts a native request and writes status, headers and streamed response bytes", async () => {
    const nativeRequest = request({
      method: "POST",
      url: "/assistant/ask?source=test",
      headers: { "content-type": "application/json", "x-request-id": "native-1" },
      chunks: ['{"question":"Help"}']
    });
    let received: Request | undefined;
    let forwardedNative: IncomingMessage | undefined;
    const handler = {
      handle: vi.fn(async (webRequest: Request, original?: IncomingMessage) => {
        received = webRequest;
        forwardedNative = original;
        const encoder = new TextEncoder();
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("first"));
            controller.enqueue(encoder.encode("-second"));
            controller.close();
          }
        }), {
          status: 202,
          headers: { "content-type": "text/plain", "x-result": "ok" }
        });
      })
    };
    const nativeResponse = new TestResponse({ backpressureOnce: true });
    const listener = createAiAppAssistantNodeHttpListener(handler, {
      origin: "https://application.example"
    });

    await listener(nativeRequest, nativeResponse as unknown as ServerResponse);

    expect(received?.url).toBe("https://application.example/assistant/ask?source=test");
    expect(received?.method).toBe("POST");
    expect(received?.headers.get("x-request-id")).toBe("native-1");
    await expect(received?.text()).resolves.toBe('{"question":"Help"}');
    expect(forwardedNative).toBe(nativeRequest);
    expect(nativeResponse.statusCode).toBe(202);
    expect(nativeResponse.headers.get("content-type")).toBe("text/plain");
    expect(nativeResponse.headers.get("x-result")).toBe("ok");
    expect(nativeResponse.body()).toBe("first-second");
    expect(nativeResponse.ended).toBe(true);
  });

  it("rejects an oversized native body before invoking the Fetch handler", async () => {
    const handler = { handle: vi.fn(async () => new Response("unused")) };
    const nativeResponse = new TestResponse();
    const listener = createAiAppAssistantNodeHttpListener(handler, { maxBodyBytes: 4 });

    await listener(request({ method: "POST", url: "/ask", chunks: ["123", "45"] }),
      nativeResponse as unknown as ServerResponse);

    expect(handler.handle).not.toHaveBeenCalled();
    expect(nativeResponse.statusCode).toBe(413);
    expect(nativeResponse.headers.get("content-type")).toContain("application/json");
    expect(JSON.parse(nativeResponse.body())).toEqual({ error: "request_too_large" });
  });

  it("maps unexpected adapter failures to a generic response without leaking details", async () => {
    const handler = {
      handle: vi.fn(async () => { throw new Error("database password must stay private"); })
    };
    const nativeResponse = new TestResponse();
    const listener = createAiAppAssistantNodeHttpListener(handler);

    await listener(request({ method: "GET", url: "/ask" }), nativeResponse as unknown as ServerResponse);

    expect(nativeResponse.statusCode).toBe(500);
    expect(JSON.parse(nativeResponse.body())).toEqual({ error: "assistant_error" });
    expect(nativeResponse.body()).not.toContain("password");
  });

  it("does not attach a body to GET or HEAD requests and supports empty responses", async () => {
    const seenBodies: Array<ReadableStream<Uint8Array> | null> = [];
    const handler = {
      handle: vi.fn(async (webRequest: Request) => {
        seenBodies.push(webRequest.body);
        return new Response(null, { status: 204 });
      })
    };
    const listener = createAiAppAssistantNodeHttpListener(handler);

    for (const method of ["GET", "HEAD"]) {
      const nativeResponse = new TestResponse();
      await listener(request({ method, url: "/access" }), nativeResponse as unknown as ServerResponse);
      expect(nativeResponse.statusCode).toBe(204);
      expect(nativeResponse.body()).toBe("");
      expect(nativeResponse.ended).toBe(true);
    }
    expect(seenBodies).toEqual([null, null]);
  });
});

function request(input: {
  method: string;
  url: string;
  headers?: IncomingMessage["headers"];
  chunks?: string[];
}): IncomingMessage {
  const stream = Readable.from(input.chunks ?? []);
  Object.assign(stream, {
    method: input.method,
    url: input.url,
    headers: input.headers ?? {}
  });
  return stream as IncomingMessage;
}

class TestResponse extends EventEmitter {
  public statusCode = 200;
  public ended = false;
  public readonly headers = new Map<string, string | number | readonly string[]>();
  readonly #chunks: Buffer[] = [];
  #backpressureOnce: boolean;

  public constructor(options: { backpressureOnce?: boolean } = {}) {
    super();
    this.#backpressureOnce = options.backpressureOnce ?? false;
  }

  public setHeader(name: string, value: string | number | readonly string[]): this {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  public write(chunk: Uint8Array): boolean {
    this.#chunks.push(Buffer.from(chunk));
    if (!this.#backpressureOnce) return true;
    this.#backpressureOnce = false;
    queueMicrotask(() => this.emit("drain"));
    return false;
  }

  public end(chunk?: string | Uint8Array): this {
    if (chunk !== undefined) this.#chunks.push(Buffer.from(chunk));
    this.ended = true;
    return this;
  }

  public body(): string {
    return Buffer.concat(this.#chunks).toString("utf8");
  }
}
