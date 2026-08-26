import { describe, expect, it, vi } from "vitest";
import {
  createManagedAiAppAssistantExpressHandler,
  type AiAppAssistantExpressManagedServer,
  type AiAppAssistantExpressRequest,
  type AiAppAssistantExpressResponse
} from "./express.js";

describe("Express connector", () => {
  it("forwards parsed JSON, the original mounted URL and the native request", async () => {
    const handle = vi.fn(async (request: Request, native?: AiAppAssistantExpressRequest) =>
      new Response(JSON.stringify({ path: new URL(request.url).pathname, user: native?.user }), {
        headers: { "content-type": "application/json" }
      })
    );
    const server = { fetch: { handle } } as unknown as AiAppAssistantExpressManagedServer;
    const chunks: Uint8Array[] = [];
    const response: AiAppAssistantExpressResponse = {
      statusCode: 0,
      setHeader: vi.fn(),
      write(chunk) { chunks.push(chunk); return true; },
      end: vi.fn()
    };
    const request: AiAppAssistantExpressRequest = {
      method: "POST",
      originalUrl: "/api/ai-app-assistant/ask",
      url: "/ask",
      protocol: "https",
      headers: { host: "app.example", "content-type": "application/json" },
      body: { question: "Explain" },
      user: { id: "user-1" }
    };

    await createManagedAiAppAssistantExpressHandler(server)(request, response);

    const webRequest = handle.mock.calls[0]?.[0] as Request;
    expect(await webRequest.json()).toEqual({ question: "Explain" });
    expect(new URL(webRequest.url).pathname).toBe("/api/ai-app-assistant/ask");
    expect(new TextDecoder().decode(Buffer.concat(chunks))).toContain("user-1");
    expect(response.statusCode).toBe(200);
  });

  it("can pass unknown routes to the next Express handler", async () => {
    const server = {
      fetch: { handle: vi.fn(async () => new Response(null, { status: 404 })) }
    } as unknown as AiAppAssistantExpressManagedServer;
    const next = vi.fn();
    const response = {
      statusCode: 0,
      setHeader: vi.fn(),
      write: vi.fn(() => true),
      end: vi.fn()
    } satisfies AiAppAssistantExpressResponse;

    await createManagedAiAppAssistantExpressHandler(server, { fallthrough: true })(
      { method: "GET", url: "/unknown", headers: {} },
      response,
      next
    );

    expect(next).toHaveBeenCalledWith();
    expect(response.end).not.toHaveBeenCalled();
  });
});
