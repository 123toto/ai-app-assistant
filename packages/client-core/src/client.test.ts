// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AiAppAssistantResponse,
  AiAppAssistantTransportEvent
} from "@123toto/ai-app-assistant-contracts";
import {
  AiAppAssistantHttpError,
  AiAppAssistantStreamError,
  createAiAppAssistantClient
} from "./client.js";

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.lang = "";
});

describe("createAiAppAssistantClient", () => {
  it("builds and validates the complete protocol request for a custom transport", async () => {
    document.documentElement.lang = "en-US";
    const signal = new AbortController().signal;
    const transport = vi.fn(async () => response());
    const client = createAiAppAssistantClient({ endpoint: "/ask", transport });

    await expect(client.ask({
      requestId: "request-1",
      html: "<main>Page</main>",
      htmlTruncated: true,
      selectedElementHtml: "<button>Save</button>",
      question: "How do I save?",
      conversation: [{ role: "user", content: "Previous question" }]
    }, { signal })).resolves.toEqual(response());

    expect(transport).toHaveBeenCalledWith({
      protocolVersion: "4",
      requestId: "request-1",
      html: "<main>Page</main>",
      htmlTruncated: true,
      selectedElementHtml: "<button>Save</button>",
      question: "How do I save?",
      conversation: [{ role: "user", content: "Previous question" }],
      locale: "en-US"
    }, { endpoint: "/ask", signal });
  });

  it("uses Fetch with asynchronous headers and exposes safe HTTP failure details", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(response()), { status: 200 }))
      .mockResolvedValueOnce(new Response("temporarily unavailable", { status: 503 }));
    const headers = vi.fn(async () => ({ authorization: "Bearer token" }));
    const client = createAiAppAssistantClient({ endpoint: "/ask", fetch, headers });

    await client.ask({ html: "<main>Page</main>", question: "Help", locale: "fr" });
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(fetch.mock.calls[0]?.[0]).toBe("/ask");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(init.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer token"
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      protocolVersion: "4",
      htmlTruncated: false,
      locale: "fr"
    });

    const failure = await client.ask({ html: "<main>Page</main>", question: "Help", locale: "fr" })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AiAppAssistantHttpError);
    expect(failure).toMatchObject({ status: 503, responseBody: "temporarily unavailable" });
    expect(headers).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed successful responses instead of trusting the transport", async () => {
    const client = createAiAppAssistantClient({
      endpoint: "/ask",
      transport: async () => ({ answer: "unvalidated" })
    });

    await expect(client.ask({ html: "<main>Page</main>", question: "Help", locale: "en" }))
      .rejects.toThrow();
  });

  it("validates progressive events, forwards them in order and returns the completion", async () => {
    const events: AiAppAssistantTransportEvent[] = [
      { type: "status", phase: "preparing" },
      { type: "partial", text: "Draft" },
      { type: "retry", attempt: 1, maxRetries: 2, delayMs: 10 },
      { type: "complete", response: response() }
    ];
    const streamTransport = vi.fn(async function* () {
      for (const event of events) yield event;
    });
    const onEvent = vi.fn();
    const signal = new AbortController().signal;
    const client = createAiAppAssistantClient({
      endpoint: "/ask",
      streamEndpoint: "/custom-stream",
      streamTransport
    });

    await expect(client.stream({
      requestId: "stream-1",
      html: "<main>Page</main>",
      question: "Help",
      locale: "en"
    }, { signal, onEvent })).resolves.toEqual(response());

    expect(streamTransport).toHaveBeenCalledWith(expect.objectContaining({ requestId: "stream-1" }), {
      endpoint: "/custom-stream",
      signal
    });
    expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "status", "partial", "retry", "complete"
    ]);
  });

  it("turns a streamed error event into a structured retryable error", async () => {
    const client = createAiAppAssistantClient({
      endpoint: "/ask",
      streamTransport: async function* () {
        yield {
          type: "error",
          message: "Provider overloaded",
          retryable: true,
          code: "provider_unavailable",
          requestId: "request-2"
        };
      }
    });

    const failure = await client.stream({ html: "<main>Page</main>", question: "Help", locale: "en" })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AiAppAssistantStreamError);
    expect(failure).toMatchObject({
      message: "Provider overloaded",
      retryable: true,
      code: "provider_unavailable",
      requestId: "request-2"
    });
  });

  it("parses chunked NDJSON including a final line without a newline", async () => {
    const encoder = new TextEncoder();
    const complete = JSON.stringify({ type: "complete", response: response() });
    const fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"type":"partial","text":"Hel'));
        controller.enqueue(encoder.encode('lo"}\n'));
        controller.enqueue(encoder.encode(complete.slice(0, 37)));
        controller.enqueue(encoder.encode(complete.slice(37)));
        controller.close();
      }
    }), { status: 200 }));
    const onEvent = vi.fn();
    const client = createAiAppAssistantClient({
      endpoint: "/ask",
      fetch,
      headers: () => ({ "x-client": "test" })
    });

    await expect(client.stream({ html: "<main>Page</main>", question: "Help", locale: "en" }, { onEvent }))
      .resolves.toEqual(response());
    expect(fetch.mock.calls[0]?.[0]).toBe("/ask/stream");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json", "x-client": "test" }
    });
    expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual(["partial", "complete"]);
  });

  it("fails explicitly when a stream has no body or no completion event", async () => {
    const withoutBody = createAiAppAssistantClient({
      endpoint: "/ask",
      fetch: async () => new Response(null, { status: 200 })
    });
    await expect(withoutBody.stream({ html: "<main>Page</main>", question: "Help", locale: "en" }))
      .rejects.toThrow("Streaming response has no body");

    const withoutCompletion = createAiAppAssistantClient({
      endpoint: "/ask",
      streamTransport: async function* () {
        yield { type: "status", phase: "preparing" };
      }
    });
    await expect(withoutCompletion.stream({ html: "<main>Page</main>", question: "Help", locale: "en" }))
      .rejects.toThrow("stream ended without a complete response");
  });

  it("requires either Fetch or a custom transport", () => {
    vi.stubGlobal("fetch", undefined);
    expect(() => createAiAppAssistantClient({ endpoint: "/ask" }))
      .toThrow("A fetch implementation is required");
  });
});

function response(): AiAppAssistantResponse {
  return {
    protocolVersion: "4",
    requestId: "response-1",
    answerability: "answered",
    answer: { summary: "Test answer", sections: [] },
    evidence: [],
    limitations: [],
    confidence: { level: "high", score: 0.9, reasons: ["Supported"] },
    metadata: { durationMs: 1, model: "test:model" }
  };
}
