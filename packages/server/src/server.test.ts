import { describe, expect, it, vi } from "vitest";
import type { AiAppAssistantRequest } from "@123toto/ai-app-assistant-contracts";
import type { AnswerGenerator } from "./types.js";
import { createAiAppAssistantServer } from "./server.js";

describe("createAiAppAssistantServer", () => {
  it("assembles documents, policies, HTTP hooks and a custom generator into one server", async () => {
    const generate = vi.fn(async () => ({
      answer: { summary: "Use the documented workflow.", sections: [] },
      evidence: [{ source: "document" as const, reference: "document:guide" }],
      limitations: []
    }));
    const generator: AnswerGenerator = { modelId: "custom:test", generate };
    const resolveContext = vi.fn(() => ({ userId: "user-1" }));
    const authorize = vi.fn();
    const server = createAiAppAssistantServer({
      generator,
      documents: [{ id: "guide", title: "Guide", content: "Documented workflow" }],
      policies: { minimumEvidence: 1 },
      http: { resolveContext, authorize }
    });

    const result = await server.fetch.handle(new Request("https://app.example/assistant/ask", {
      method: "POST",
      body: JSON.stringify(request())
    }));

    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toMatchObject({
      protocolVersion: "4",
      requestId: "request-1",
      answer: { summary: "Use the documented workflow." },
      evidence: [{ source: "document", reference: "document:guide" }],
      metadata: { model: "custom:test" }
    });
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      items: expect.arrayContaining([
        expect.objectContaining({ source: "document", reference: "document:guide" }),
        expect.objectContaining({ source: "page-html", reference: "page-html" })
      ])
    }), expect.anything());
    expect(resolveContext).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledWith({ userId: "user-1" }, expect.any(Request));
    expect(Object.isFrozen(server.options)).toBe(true);
    expect(server.options.generator).toBe(generator);
  });

  it("keeps authentication closed by default and honours explicit anonymous mode", async () => {
    const generator: AnswerGenerator = {
      modelId: "custom:test",
      generate: async () => ({
        answer: { summary: "Answer", sections: [] },
        evidence: [],
        limitations: []
      })
    };
    const secure = createAiAppAssistantServer({ generator });
    const publicPrototype = createAiAppAssistantServer({ generator, http: { allowAnonymous: true } });

    const secureResponse = await secure.fetch.ask(postRequest());
    const publicResponse = await publicPrototype.fetch.ask(postRequest());

    expect(secureResponse.status).toBe(401);
    await expect(secureResponse.json()).resolves.toMatchObject({ error: "unauthorized" });
    expect(publicResponse.status).toBe(200);
  });

  it("requires a model when no custom generator is supplied", () => {
    expect(() => createAiAppAssistantServer({}))
      .toThrow("requires either generator or model");
    expect(() => createAiAppAssistantServer({ model: "   " }))
      .toThrow("requires either generator or model");
  });

  it("accepts the provider:model shortcut without contacting the provider at construction", () => {
    const server = createAiAppAssistantServer({
      model: "mistral:mistral-small-latest",
      apiKey: "test-only-key",
      timeoutMs: 1_000,
      maxRetries: 0,
      http: { allowAnonymous: true }
    });

    expect(server.assistant).toMatchObject({
      answer: expect.any(Function),
      stream: expect.any(Function)
    });
    expect(server.options).toMatchObject({
      model: "mistral:mistral-small-latest",
      timeoutMs: 1_000,
      maxRetries: 0
    });
  });

  it("always gives an injected generator precedence over an invalid model shortcut", async () => {
    const generator: AnswerGenerator = {
      modelId: "custom:preferred",
      generate: async () => ({
        answer: { summary: "Custom generator", sections: [] },
        evidence: [],
        limitations: []
      })
    };
    const server = createAiAppAssistantServer({
      generator,
      model: "not-a-supported-provider:model",
      http: { allowAnonymous: true }
    });

    const response = await server.fetch.ask(postRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      answer: { summary: "Custom generator" },
      metadata: { model: "custom:preferred" }
    });
  });
});

function postRequest(): Request {
  return new Request("https://app.example/assistant/ask", {
    method: "POST",
    body: JSON.stringify(request())
  });
}

function request(): AiAppAssistantRequest {
  return {
    protocolVersion: "4",
    requestId: "request-1",
    html: "<main>Current page</main>",
    htmlTruncated: false,
    question: "How does this work?",
    locale: "en"
  };
}
