import { describe, expect, it, vi } from "vitest";
import {
  createManagedAiDocsExpressHandler,
  type AiDocsExpressManagedServer,
  type AiDocsExpressRequest,
  type AiDocsExpressResponse
} from "./express.js";

describe("Express connector", () => {
  it("forwards parsed JSON, the original mounted URL and the native request", async () => {
    const handle = vi.fn(async (request: Request, native?: AiDocsExpressRequest) =>
      new Response(JSON.stringify({ path: new URL(request.url).pathname, user: native?.user }), {
        headers: { "content-type": "application/json" }
      })
    );
    const server = { fetch: { handle } } as unknown as AiDocsExpressManagedServer;
    const chunks: Uint8Array[] = [];
    const response: AiDocsExpressResponse = {
      statusCode: 0,
      setHeader: vi.fn(),
      write(chunk) { chunks.push(chunk); return true; },
      end: vi.fn()
    };
    const request: AiDocsExpressRequest = {
      method: "POST",
      originalUrl: "/api/ai-docs/ask",
      url: "/ask",
      protocol: "https",
      headers: { host: "app.example", "content-type": "application/json" },
      body: { question: "Explain" },
      user: { id: "user-1" }
    };

    await createManagedAiDocsExpressHandler(server)(request, response);

    const webRequest = handle.mock.calls[0]?.[0] as Request;
    expect(await webRequest.json()).toEqual({ question: "Explain" });
    expect(new URL(webRequest.url).pathname).toBe("/api/ai-docs/ask");
    expect(new TextDecoder().decode(Buffer.concat(chunks))).toContain("user-1");
    expect(response.statusCode).toBe(200);
  });

  it("can pass unknown routes to the next Express handler", async () => {
    const server = {
      fetch: { handle: vi.fn(async () => new Response(null, { status: 404 })) }
    } as unknown as AiDocsExpressManagedServer;
    const next = vi.fn();
    const response = {
      statusCode: 0,
      setHeader: vi.fn(),
      write: vi.fn(() => true),
      end: vi.fn()
    } satisfies AiDocsExpressResponse;

    await createManagedAiDocsExpressHandler(server, { fallthrough: true })(
      { method: "GET", url: "/unknown", headers: {} },
      response,
      next
    );

    expect(next).toHaveBeenCalledWith();
    expect(response.end).not.toHaveBeenCalled();
  });
});
