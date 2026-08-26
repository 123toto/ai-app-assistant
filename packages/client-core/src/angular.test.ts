// @vitest-environment happy-dom
import "@angular/compiler";
import { describe, expect, it, vi } from "vitest";
import type { AiAppAssistantResponse } from "@123toto/ai-app-assistant-contracts";
import { AiAppAssistantService } from "./angular.js";
import type { AiAppAssistantClient } from "./client.js";
import type { AiAppAssistantSettingsClient } from "./settings.js";

const response: AiAppAssistantResponse = {
  protocolVersion: "4",
  requestId: "test-request",
  answerability: "answered",
  answer: { summary: "Test answer", sections: [] },
  evidence: [],
  limitations: [],
  confidence: { level: "high", score: 1, reasons: [] },
  metadata: { durationMs: 1, model: "test" }
};

function createService(maxConversationTurns: number) {
  document.body.innerHTML = "<main>Test page</main>";
  const client: AiAppAssistantClient = {
    ask: vi.fn().mockResolvedValue(response),
    stream: vi.fn().mockResolvedValue(response)
  };
  return new AiAppAssistantService({
    endpoint: "/ask",
    streaming: false,
    maxConversationTurns
  }, client);
}

function createFailingService(maxConversationTurns: number) {
  document.body.innerHTML = "<main>Test page</main>";
  const client: AiAppAssistantClient = {
    ask: vi.fn().mockRejectedValue(new Error("Quota reached")),
    stream: vi.fn().mockRejectedValue(new Error("Quota reached"))
  };
  return new AiAppAssistantService({
    endpoint: "/ask",
    streaming: false,
    maxConversationTurns
  }, client);
}

describe("AiAppAssistantService conversation limit", () => {
  it("allows one question when the configured limit is one", async () => {
    const service = createService(1);

    await service.ask({ question: "First question" });

    expect(service.conversationTurns()).toBe(1);
    expect(service.conversationLimitReached()).toBe(true);
    await expect(service.ask({ question: "Second question" }))
      .rejects.toThrow("Conversation limit reached");
  });

  it("starts a fresh conversation when a lower runtime limit is already exhausted", async () => {
    const service = createService(3);
    await service.ask({ question: "Previous question" });

    service.setMaxConversationTurns(1);

    expect(service.conversationTurns()).toBe(0);
    expect(service.conversationLimitReached()).toBe(false);
    await expect(service.ask({ question: "First question with the new limit" }))
      .resolves.toEqual(response);
  });

  it("does not consume a conversation question when generation fails", async () => {
    const service = createFailingService(1);

    await expect(service.ask({ question: "Failed question" }))
      .rejects.toThrow("Quota reached");

    expect(service.conversationTurns()).toBe(0);
    expect(service.conversationLimitReached()).toBe(false);
  });

  it("reports a page change so every UI connector can clear its draft", () => {
    const service = createService(3);

    expect(service.syncPage("/another-page")).toBe(true);
    expect(service.syncPage("/another-page")).toBe(false);
  });

  it("uses managed access to control visibility and the conversation limit", async () => {
    const client: AiAppAssistantClient = {
      ask: vi.fn().mockResolvedValue(response),
      stream: vi.fn().mockResolvedValue(response)
    };
    const settingsClient = {
      getAccess: vi.fn().mockResolvedValue({ available: true, maxConversationTurns: 1 })
    } as unknown as AiAppAssistantSettingsClient;
    const service = new AiAppAssistantService({
      endpoint: "/api/ai-app-assistant/ask",
      managedEndpoint: "/api/ai-app-assistant",
      streaming: false
    }, client, settingsClient);

    await service.refreshAccess();

    expect(service.available()).toBe(true);
    expect(service.maxConversationTurns()).toBe(1);
  });
});
