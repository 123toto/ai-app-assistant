import { describe, expect, it, vi } from "vitest";
import type { AiAppAssistantResponse } from "@123toto/ai-app-assistant-contracts";
import type { AiAppAssistant } from "./assistant.js";
import { AiAppAssistantRequestError, createAiAppAssistantFetchHandlers } from "./http.js";

const response: AiAppAssistantResponse = {
  protocolVersion: "4",
  requestId: "request-1",
  answerability: "answered",
  answer: { summary: "Answer", sections: [] },
  evidence: [],
  limitations: [],
  confidence: { level: "high", score: 1, reasons: [] },
  metadata: { durationMs: 1, model: "fake:model" }
};

const validRequest = {
  protocolVersion: "4",
  requestId: "request-1",
  html: "<main>Page</main>",
  htmlTruncated: false,
  question: "What is this page?",
  locale: "en"
};

function assistant(): AiAppAssistant {
  return {
    answer: vi.fn().mockResolvedValue(response),
    async *stream() {
      yield { type: "status" as const, phase: "preparing" as const };
      yield { type: "partial" as const, text: "Raw name" };
      yield { type: "complete" as const, response };
      return response;
    }
  };
}

function post(path = "/api/ai-app-assistant/ask", body: unknown = validRequest): Request {
  return new Request(`https://app.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test" },
    body: JSON.stringify(body)
  });
}

describe("createAiAppAssistantFetchHandlers", () => {
  it("runs framework-neutral context, authorization and privacy hooks", async () => {
    const authorize = vi.fn();
    const handlers = createAiAppAssistantFetchHandlers({
      assistant: assistant(),
      resolveContext: (request) => ({ token: request.headers.get("authorization") }),
      authorize,
      transformResponse: (result) => ({
        ...result,
        answer: { ...result.answer, summary: "Sanitized answer" }
      })
    });

    const result = await handlers.ask(post());

    expect(result.status).toBe(200);
    expect(authorize).toHaveBeenCalledWith({ token: "Bearer test" }, expect.any(Request));
    expect((await result.json() as AiAppAssistantResponse).answer.summary).toBe("Sanitized answer");
  });

  it("returns safe protocol errors without a framework exception type", async () => {
    const handlers = createAiAppAssistantFetchHandlers({ assistant: assistant() });

    const result = await handlers.ask(post("/api/ai-app-assistant/ask", { question: "Missing page" }));

    expect(result.status).toBe(400);
    expect(await result.json()).toMatchObject({ error: "invalid_request" });
  });

  it("lets host authorization return an explicit HTTP error", async () => {
    const handlers = createAiAppAssistantFetchHandlers({
      assistant: assistant(),
      authorize: () => { throw new AiAppAssistantRequestError(403, "forbidden", "Access denied"); }
    });

    const result = await handlers.ask(post());

    expect(result.status).toBe(403);
    expect(await result.json()).toEqual({ error: "forbidden", message: "Access denied" });
  });

  it("rejects valid assistant requests when authentication was not configured", async () => {
    const handlers = createAiAppAssistantFetchHandlers({ assistant: assistant() });
    const result = await handlers.ask(post());
    expect(result.status).toBe(401);
  });

  it("streams NDJSON through a standard Response", async () => {
    const handlers = createAiAppAssistantFetchHandlers({
      assistant: assistant(),
      allowAnonymous: true,
      transformStreamEvent: (event) => event.type === "partial"
        ? { ...event, text: "Anonymous" }
        : event
    });

    const result = await handlers.handle(post("/api/ai-app-assistant/ask/stream"));
    const events = (await result.text()).trim().split("\n").map((line) => JSON.parse(line) as unknown);

    expect(result.headers.get("content-type")).toContain("application/x-ndjson");
    expect(events).toHaveLength(3);
    expect(events[1]).toEqual({ type: "partial", text: "Anonymous" });
    expect(events[2]).toMatchObject({ type: "complete", response: { requestId: "request-1" } });
  });

  it("rejects unsupported methods, invalid JSON and oversized bodies before assistant work", async () => {
    const instance = assistant();
    const handlers = createAiAppAssistantFetchHandlers({ assistant: instance, allowAnonymous: true, maxBodyBytes: 20 });

    const method = await handlers.ask(new Request("https://app.example/ask", { method: "GET" }));
    const invalidJson = await handlers.ask(new Request("https://app.example/ask", {
      method: "POST", body: "not-json"
    }));
    const oversized = await handlers.ask(new Request("https://app.example/ask", {
      method: "POST",
      headers: { "content-length": "21" },
      body: "{}"
    }));

    expect(method.status).toBe(405);
    expect(await method.json()).toMatchObject({ error: "method_not_allowed" });
    expect(invalidJson.status).toBe(400);
    expect(await invalidJson.json()).toMatchObject({ error: "invalid_json" });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ error: "request_too_large" });
    expect(instance.answer).not.toHaveBeenCalled();
  });

  it("lets the host safely map unexpected errors with the original request", async () => {
    const onError = vi.fn((_error, request: Request) => new Response(JSON.stringify({
      error: "host_error",
      path: new URL(request.url).pathname
    }), { status: 418 }));
    const failing = assistant();
    failing.answer = vi.fn(async () => { throw new Error("internal detail"); });
    const handlers = createAiAppAssistantFetchHandlers({
      assistant: failing,
      allowAnonymous: true,
      onError
    });

    const result = await handlers.ask(post());

    expect(result.status).toBe(418);
    expect(await result.json()).toEqual({ error: "host_error", path: "/api/ai-app-assistant/ask" });
    expect(onError).toHaveBeenCalledWith(expect.any(Error), expect.any(Request));
  });

  it("emits one safe terminal event when progressive generation fails", async () => {
    const failing: AiAppAssistant = {
      answer: vi.fn(),
      async *stream() {
        yield { type: "status" as const, phase: "preparing" as const };
        throw new Error("provider response containing a secret");
      }
    };
    const handlers = createAiAppAssistantFetchHandlers({ assistant: failing, allowAnonymous: true });

    const result = await handlers.stream(post("/api/ai-app-assistant/ask/stream"));
    const events = (await result.text()).trim().split("\n").map((line) => JSON.parse(line));

    expect(events).toEqual([
      { type: "status", phase: "preparing" },
      {
        type: "error",
        message: "The assistant response could not be generated.",
        retryable: false
      }
    ]);
    expect(JSON.stringify(events)).not.toContain("secret");
  });
});
