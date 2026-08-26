import { describe, expect, it, vi } from "vitest";
import type { AskDocumentationResponse } from "@123toto/ai-app-assistant-contracts";
import type { DocsAssistant } from "./assistant.js";
import { AiDocsRequestError, createAiDocsFetchHandlers } from "./http.js";

const response: AskDocumentationResponse = {
  protocolVersion: "3",
  requestId: "request-1",
  answerability: "answered",
  answer: { summary: "Answer", sections: [] },
  evidence: [],
  limitations: [],
  confidence: { level: "high", score: 1, reasons: [] },
  metadata: { durationMs: 1, model: "fake:model" }
};

const validRequest = {
  protocolVersion: "3",
  requestId: "request-1",
  html: "<main>Page</main>",
  htmlTruncated: false,
  question: "What is this page?",
  locale: "en"
};

function assistant(): DocsAssistant {
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

function post(path = "/api/ai-docs/ask", body: unknown = validRequest): Request {
  return new Request(`https://app.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test" },
    body: JSON.stringify(body)
  });
}

describe("createAiDocsFetchHandlers", () => {
  it("runs framework-neutral context, authorization and privacy hooks", async () => {
    const authorize = vi.fn();
    const handlers = createAiDocsFetchHandlers({
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
    expect((await result.json() as AskDocumentationResponse).answer.summary).toBe("Sanitized answer");
  });

  it("returns safe protocol errors without a framework exception type", async () => {
    const handlers = createAiDocsFetchHandlers({ assistant: assistant() });

    const result = await handlers.ask(post("/api/ai-docs/ask", { question: "Missing page" }));

    expect(result.status).toBe(400);
    expect(await result.json()).toMatchObject({ error: "invalid_request" });
  });

  it("lets host authorization return an explicit HTTP error", async () => {
    const handlers = createAiDocsFetchHandlers({
      assistant: assistant(),
      authorize: () => { throw new AiDocsRequestError(403, "forbidden", "Access denied"); }
    });

    const result = await handlers.ask(post());

    expect(result.status).toBe(403);
    expect(await result.json()).toEqual({ error: "forbidden", message: "Access denied" });
  });

  it("rejects valid assistant requests when authentication was not configured", async () => {
    const handlers = createAiDocsFetchHandlers({ assistant: assistant() });
    const result = await handlers.ask(post());
    expect(result.status).toBe(401);
  });

  it("streams NDJSON through a standard Response", async () => {
    const handlers = createAiDocsFetchHandlers({
      assistant: assistant(),
      allowAnonymous: true,
      transformStreamEvent: (event) => event.type === "partial"
        ? { ...event, text: "Anonymous" }
        : event
    });

    const result = await handlers.handle(post("/api/ai-docs/ask/stream"));
    const events = (await result.text()).trim().split("\n").map((line) => JSON.parse(line) as unknown);

    expect(result.headers.get("content-type")).toContain("application/x-ndjson");
    expect(events).toHaveLength(3);
    expect(events[1]).toEqual({ type: "partial", text: "Anonymous" });
    expect(events[2]).toMatchObject({ type: "complete", response: { requestId: "request-1" } });
  });
});
