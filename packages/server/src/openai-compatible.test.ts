import { describe, expect, it, vi } from "vitest";
import { createOpenAiCompatibleGenerator } from "./openai-compatible.js";

const bundle = {
  question: "What does this page do?",
  locale: "en",
  items: [{
    source: "document" as const,
    reference: "document:application-guide",
    content: "The dashboard summarises assessment work.",
    relevance: 1
  }]
};

describe("createOpenAiCompatibleGenerator", () => {
  it("calls the configured endpoint and validates the structured answer", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            answer: { summary: "It summarises assessment work.", sections: [] },
            evidence: [{ source: "document", reference: "document:application-guide" }],
            limitations: []
          })
        }
      }]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const generator = createOpenAiCompatibleGenerator({
      endpoint: "https://llm.example.test/v1/chat/completions",
      model: "approved-model",
      apiKey: "test-secret",
      fetch: fetchMock
    });

    const result = await generator.generate(bundle);

    expect(result.answer.summary).toBe("It summarises assessment work.");
    expect(generator.modelId).toBe("openai-compatible:approved-model");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer test-secret");
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(request.model).toBe("approved-model");
    expect(request.response_format).toEqual({ type: "json_object" });
    expect(JSON.stringify(request)).toContain("document:application-guide");
    const messages = request.messages as Array<{ role: string; content: string }>;
    const prompt = messages.find((message) => message.role === "user")?.content ?? "";
    expect(prompt.indexOf("document:application-guide"))
      .toBeLessThan(prompt.indexOf(bundle.question));
  });

  it("accepts fenced JSON but still rejects an invalid answer contract", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "```json\n{\"answer\":{\"sections\":[]}}\n```" } }]
    }), { status: 200 }));
    const generator = createOpenAiCompatibleGenerator({
      endpoint: "http://localhost:11434/v1/chat/completions",
      model: "local-model",
      responseFormat: "prompt-only",
      fetch: fetchMock
    });

    await expect(generator.generate(bundle)).rejects.toThrow();
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).not.toHaveProperty("response_format");
  });

  it("does not expose a provider response body in HTTP errors", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("sensitive provider details", { status: 401 }));
    const generator = createOpenAiCompatibleGenerator({
      endpoint: "https://llm.example.test/v1/chat/completions",
      model: "approved-model",
      fetch: fetchMock
    });

    await expect(generator.generate(bundle)).rejects.toThrow("status 401");
    await expect(generator.generate(bundle)).rejects.not.toThrow("sensitive provider details");
  });
});
