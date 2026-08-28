import { describe, expect, it } from "vitest";
import {
  aiAppAssistantConfigurationInputSchema,
  aiAppAssistantManagedConfigurationViewSchema,
  aiAppAssistantRequestSchema,
  aiAppAssistantResponseSchema,
  aiAppAssistantTransportEventSchema
} from "./index.js";

const validConfiguration = {
  provider: "mistral" as const,
  model: "mistral-small-latest",
  access: { mode: "all" as const }
};

describe("AI Assistant usage configuration contract", () => {
  it("accepts the documented inclusive usage boundaries", () => {
    expect(aiAppAssistantConfigurationInputSchema.safeParse({
      ...validConfiguration,
      quota: { maxRequests: 1, windowSeconds: 60 },
      maxConversationTurns: 1
    }).success).toBe(true);
    expect(aiAppAssistantConfigurationInputSchema.safeParse({
      ...validConfiguration,
      quota: { maxRequests: 10_000, windowSeconds: 31_536_000 },
      maxConversationTurns: 10
    }).success).toBe(true);
  });

  it.each([
    ["zero questions per period", { quota: { maxRequests: 0, windowSeconds: 60 } }],
    ["too many questions per period", { quota: { maxRequests: 10_001, windowSeconds: 60 } }],
    ["a period shorter than one minute", { quota: { maxRequests: 1, windowSeconds: 59 } }],
    ["a period longer than one year", { quota: { maxRequests: 1, windowSeconds: 31_536_001 } }],
    ["zero conversation turns", { maxConversationTurns: 0 }],
    ["more than ten conversation turns", { maxConversationTurns: 11 }],
    ["an empty role selection", { access: { mode: "roles", roles: [] } }],
    ["an empty user selection", { access: { mode: "users", userIds: [] } }]
  ])("rejects %s", (_description, invalidUsage) => {
    expect(aiAppAssistantConfigurationInputSchema.safeParse({
      ...validConfiguration,
      ...invalidUsage
    }).success).toBe(false);
  });

  it("defaults the conversation limit without weakening the submitted access rule", () => {
    const parsed = aiAppAssistantConfigurationInputSchema.parse({
      ...validConfiguration,
      access: { mode: "roles", roles: ["consumer-admin"] }
    });

    expect(parsed.maxConversationTurns).toBe(3);
    expect(parsed.access).toEqual({ mode: "roles", roles: ["consumer-admin"] });
  });
});

describe("AI Assistant wire protocol contracts", () => {
  it("applies request defaults while enforcing protocol and history boundaries", () => {
    const parsed = aiAppAssistantRequestSchema.parse({
      protocolVersion: "4",
      requestId: "request-1",
      html: "<main>Page</main>",
      question: "Help"
    });
    expect(parsed).toMatchObject({ htmlTruncated: false, locale: "fr" });

    expect(aiAppAssistantRequestSchema.safeParse({ ...parsed, protocolVersion: "3" }).success).toBe(false);
    expect(aiAppAssistantRequestSchema.safeParse({
      ...parsed,
      conversation: Array.from({ length: 21 }, () => ({ role: "user", content: "Previous" }))
    }).success).toBe(false);
    expect(aiAppAssistantRequestSchema.safeParse({ ...parsed, question: "x".repeat(4_001) }).success).toBe(false);
  });

  it("validates complete responses including confidence and token accounting", () => {
    const valid = response();
    expect(aiAppAssistantResponseSchema.parse(valid)).toEqual(valid);
    expect(aiAppAssistantResponseSchema.safeParse({
      ...valid,
      confidence: { ...valid.confidence, score: 1.01 }
    }).success).toBe(false);
    expect(aiAppAssistantResponseSchema.safeParse({
      ...valid,
      metadata: { ...valid.metadata, usage: { totalTokens: -1 } }
    }).success).toBe(false);
  });

  it("accepts every progressive event shape and rejects malformed retry metadata", () => {
    const events = [
      { type: "status", phase: "preparing" },
      { type: "partial", text: "Draft" },
      { type: "retry", attempt: 1, maxRetries: 2, delayMs: 0 },
      { type: "error", message: "Unavailable", retryable: true, code: "provider_unavailable" },
      { type: "complete", response: response() }
    ];
    for (const event of events) expect(aiAppAssistantTransportEventSchema.safeParse(event).success).toBe(true);
    expect(aiAppAssistantTransportEventSchema.safeParse({
      type: "retry", attempt: 0, maxRetries: 2, delayMs: -1
    }).success).toBe(false);
  });

  it("keeps managed configuration responses credential-free", () => {
    const parsed = aiAppAssistantManagedConfigurationViewSchema.parse({
      provider: "mistral",
      model: "mistral-small-latest",
      access: { mode: "all" },
      maxConversationTurns: 3,
      apiKeyConfigured: true,
      apiKeyStorageAvailable: true,
      configured: true,
      source: "stored",
      allowModelChangesByOthers: false,
      canChangeModel: true,
      canManageCredentials: true,
      canManageModelPolicy: true,
      canRevokeApiKey: true,
      fieldSources: {
        provider: "override", model: "override", apiKey: "override", baseURL: "none",
        access: "default", quota: "default", conversation: "default"
      },
      connection: { status: "connected" },
      apiKey: "must-not-cross-the-contract"
    });

    expect(parsed).not.toHaveProperty("apiKey");
    expect(parsed.apiKeyConfigured).toBe(true);
  });
});

function response() {
  return {
    protocolVersion: "4" as const,
    requestId: "response-1",
    answerability: "answered" as const,
    answer: { summary: "Answer", sections: [] },
    evidence: [{ source: "page-html" as const, reference: "page-html" }],
    limitations: [],
    confidence: { level: "high" as const, score: 0.9, reasons: ["Supported"] },
    metadata: {
      durationMs: 2,
      model: "test:model",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
    }
  };
}
