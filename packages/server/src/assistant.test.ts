import { describe, expect, it, vi } from "vitest";
import { createAiAppAssistant } from "./assistant.js";
import type { AnswerGenerator, EvidenceBundle } from "./types.js";

function request(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: "4" as const,
    requestId: "request-1",
    html: "<html><body><h1>Order 42</h1><button>Approve</button></body></html>",
    htmlTruncated: false,
    question: "What can I do here?",
    locale: "en",
    ...overrides
  };
}

describe("createAiAppAssistant", () => {
  it("prepares static documents once and reuses them across questions", async () => {
    let serializations = 0;
    const openapi = {
      toJSON() {
        serializations += 1;
        return { openapi: "3.1.0", info: { title: "Orders API" } };
      }
    };
    const bundles: EvidenceBundle[] = [];
    const assistant = createAiAppAssistant({
      generator: capturingGenerator(bundles),
      documents: [
        { id: "app-guide", title: "Application guide", content: "# Orders" },
        { id: "api", title: "API documentation", content: openapi }
      ]
    });

    expect(serializations).toBe(1);
    await assistant.answer(request());
    await assistant.answer(request({ requestId: "request-2", question: "Can I approve it?" }));

    expect(serializations).toBe(1);
    expect(bundles).toHaveLength(2);
    expect(bundles[0]?.items.map((item) => item.source)).toEqual([
      "page-html",
      "document",
      "document"
    ]);
    expect(bundles[0]?.items[1]).toStrictEqual(bundles[1]?.items[1]);
  });

  it("passes only HTML, an optional selected fragment, the question and documents", async () => {
    const bundles: EvidenceBundle[] = [];
    const assistant = createAiAppAssistant({
      generator: capturingGenerator(bundles),
      documents: [{ id: "guide", title: "Guide", content: "Approvals are final." }]
    });

    const result = await assistant.answer(request({
      selectedElementHtml: "<button>Approve</button>",
      question: "What does this button do?"
    }));

    expect(bundles[0]).toMatchObject({
      question: "What does this button do?",
      locale: "en"
    });
    expect(bundles[0]?.items.map((item) => item.source)).toEqual([
      "selected-element",
      "page-html",
      "document"
    ]);
    expect(result.metadata.model).toBe("fake:test");
  });

  it("passes a bounded conversation history for follow-up questions", async () => {
    const bundles: EvidenceBundle[] = [];
    const assistant = createAiAppAssistant({ generator: capturingGenerator(bundles) });

    await assistant.answer(request({
      question: "And what does that status mean?",
      conversation: [
        { role: "user", content: "Explain this item." },
        { role: "assistant", content: "It is marked TO REVIEW." }
      ]
    }));

    expect(bundles[0]?.conversation).toEqual([
      { role: "user", content: "Explain this item." },
      { role: "assistant", content: "It is marked TO REVIEW." }
    ]);
  });

  it("bounds large inputs by default for zero-configuration provider calls", async () => {
    const bundles: EvidenceBundle[] = [];
    const assistant = createAiAppAssistant({
      generator: capturingGenerator(bundles),
      documents: [{ id: "large-guide", title: "Large guide", content: "d".repeat(300_000) }]
    });

    await assistant.answer({
      protocolVersion: "4",
      requestId: "request-large-input",
      question: "Explain this page",
      locale: "en",
      html: `<main>${"p".repeat(200_000)}</main>`,
      selectedElementHtml: `<section>${"s".repeat(40_000)}</section>`
    });

    const bundle = bundles[0];
    expect(bundle).toBeDefined();
    expect(bundle!.items.find((item) => item.source === "page-html")!.content.length)
      .toBeLessThan(101_000);
    expect(bundle!.items.find((item) => item.source === "selected-element")!.content.length)
      .toBeLessThan(23_000);
    expect(bundle!.items.find((item) => item.source === "document")!.content.length)
      .toBeLessThan(121_000);
  });

  it("uses a larger evidence budget when the selected model supports it", async () => {
    const smallBundles: EvidenceBundle[] = [];
    const largeBundles: EvidenceBundle[] = [];
    const content = "d".repeat(900_000);
    const small = capturingGenerator(smallBundles);
    const large = capturingGenerator(largeBundles, {
      contextWindowTokens: 1_050_000,
      maxOutputTokens: 128_000,
      estimatedCharactersPerToken: 2
    });

    await createAiAppAssistant({ generator: small, documents: [{ id: "doc", title: "Doc", content }] })
      .answer(request());
    await createAiAppAssistant({ generator: large, documents: [{ id: "doc", title: "Doc", content }] })
      .answer(request());

    const smallDocument = smallBundles[0]!.items.find((item) => item.source === "document")!;
    const largeDocument = largeBundles[0]!.items.find((item) => item.source === "document")!;
    expect(largeDocument.content.length).toBeGreaterThan(smallDocument.content.length * 3);
  });

  it("drops evidence references invented by the model", async () => {
    const assistant = createAiAppAssistant({
      generator: {
        modelId: "fake:hallucination",
        async generate() {
          return {
            answer: { summary: "Summary", sections: [] },
            evidence: [
              { source: "document", reference: "document:not-provided" },
              { source: "page-html", reference: "page-html" }
            ],
            limitations: []
          };
        }
      }
    });

    const result = await assistant.answer(request());
    expect(result.evidence).toEqual([
      { source: "page-html", reference: "page-html" }
    ]);
  });

  it("exposes provider token usage in response metadata", async () => {
    const assistant = createAiAppAssistant({
      generator: {
        modelId: "fake:usage",
        async generate() {
          return {
            answer: { summary: "Summary", sections: [] },
            evidence: [{ source: "page-html", reference: "page-html" }],
            limitations: [],
            usage: { inputTokens: 1_200, outputTokens: 180, totalTokens: 1_380 }
          };
        }
      }
    });

    const result = await assistant.answer(request());
    expect(result.metadata.usage).toEqual({
      inputTokens: 1_200,
      outputTokens: 180,
      totalTokens: 1_380
    });
  });

  it("returns a safe insufficient answer without calling the provider when evidence is below policy", async () => {
    const generate = vi.fn();
    const assistant = createAiAppAssistant({
      generator: { modelId: "fake:no-evidence", generate },
      policies: { minimumEvidence: 2 }
    });

    const result = await assistant.answer(request());

    expect(generate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      answerability: "not-answerable",
      confidence: { level: "insufficient", score: 0 },
      metadata: { model: "fake:no-evidence" }
    });
    expect(result.limitations).not.toHaveLength(0);
  });

  it("forwards provider stream progress and always finishes with a validated completion", async () => {
    const assistant = createAiAppAssistant({
      generator: {
        modelId: "fake:stream",
        async generate() { throw new Error("The streaming path must be used"); },
        async *stream(bundle) {
          yield { type: "partial" as const, text: "Draft answer" };
          yield { type: "retry" as const, attempt: 1, maxRetries: 2, delayMs: 5 };
          return {
            answer: { summary: "Final answer", sections: [] },
            evidence: bundle.items.map(({ source, reference }) => ({ source, reference })),
            limitations: []
          };
        }
      }
    });
    const generation = assistant.stream(request());
    const events: unknown[] = [];
    let returned;
    while (true) {
      const next = await generation.next();
      if (next.done) { returned = next.value; break; }
      events.push(next.value);
    }

    expect(events.map((event) => (event as { type: string }).type)).toEqual([
      "status", "status", "partial", "retry", "complete"
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "complete",
      response: { answer: { summary: "Final answer" }, metadata: { model: "fake:stream" } }
    });
    expect(returned).toMatchObject({ requestId: "request-1", answer: { summary: "Final answer" } });
  });
});

function capturingGenerator(
  bundles: EvidenceBundle[],
  capabilities?: AnswerGenerator["capabilities"]
): AnswerGenerator {
  return {
    modelId: "fake:test",
    ...(capabilities ? { capabilities } : {}),
    async generate(bundle) {
      bundles.push(bundle);
      return {
        answer: { summary: "This page displays an order.", sections: [] },
        evidence: bundle.items.map(({ source, reference }) => ({ source, reference })),
        limitations: []
      };
    }
  };
}
