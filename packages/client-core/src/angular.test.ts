// @vitest-environment happy-dom
import "@angular/compiler";
import { afterEach, describe, expect, it, vi } from "vitest";
import { provideHttpClient, withInterceptors, withNoXsrfProtection } from "@angular/common/http";
import { HttpTestingController, provideHttpClientTesting } from "@angular/common/http/testing";
import { createEnvironmentInjector, DOCUMENT, PendingTasks } from "@angular/core";
import type { AiAppAssistantResponse } from "@123toto/ai-app-assistant-contracts";
import {
  AiAppAssistantService,
  AiAppAssistantSettingsService,
  provideAiAppAssistant
} from "./angular.js";
import type { AiAppAssistantClient } from "./client.js";
import type { AiAppAssistantSettingsClient } from "./settings.js";

afterEach(() => {
  document.body.innerHTML = "";
});

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

describe("Angular host integration", () => {
  it("routes assistant requests through Angular HttpClient and its interceptors", async () => {
    document.body.innerHTML = "<main>Angular host page</main>";
    const parent = createEnvironmentInjector([]);
    const injector = createEnvironmentInjector([
      provideHttpClient(
        withNoXsrfProtection(),
        withInterceptors([
          (request, next) => next(request.clone({ setHeaders: { authorization: "Bearer angular" } }))
        ])
      ),
      provideHttpClientTesting(),
      { provide: PendingTasks, useValue: { add: () => () => undefined } },
      { provide: DOCUMENT, useValue: document },
      provideAiAppAssistant({ endpoint: "/assistant/ask", streaming: false })
    ], parent);
    const service = injector.get(AiAppAssistantService);
    const http = injector.get(HttpTestingController);

    const pending = service.ask({ question: "Explain Angular integration" });
    await Promise.resolve();
    const request = http.expectOne("/assistant/ask");
    expect(request.request.method).toBe("POST");
    expect(request.request.headers.get("authorization")).toBe("Bearer angular");
    expect(request.request.body).toMatchObject({
      protocolVersion: "4",
      question: "Explain Angular integration"
    });
    request.flush(response);

    await expect(pending).resolves.toEqual(response);
    expect(service.messages().map(({ role }) => role)).toEqual(["user", "assistant"]);
    http.verify();
    injector.destroy();
    parent.destroy();
  });

  it("opens one generic settings element and refreshes managed access after changes", async () => {
    const refreshAccess = vi.fn(async () => ({ available: true, maxConversationTurns: 3 }));
    const client = settingsClient();
    const settings = new AiAppAssistantSettingsService({
      endpoint: "/ask",
      managedEndpoint: "/assistant",
      settings: { title: "Host assistant settings" }
    }, client, { refreshAccess } as unknown as AiAppAssistantService);

    settings.open();
    settings.open();
    await settle();

    const elements = document.querySelectorAll("ai-app-assistant-settings");
    expect(elements).toHaveLength(1);
    const element = elements[0] as HTMLElement;
    expect(element.hasAttribute("open")).toBe(true);
    expect(element.shadowRoot?.querySelector(".modal")?.textContent).toContain("Host assistant settings");

    element.dispatchEvent(new CustomEvent("ai-app-assistant-settings-saved"));
    await settle();
    expect(element.hasAttribute("open")).toBe(false);
    expect(refreshAccess).toHaveBeenCalledTimes(1);
  });

  it("fails explicitly when settings are opened without a managed endpoint", () => {
    const settings = new AiAppAssistantSettingsService({ endpoint: "/ask" }, undefined,
      { refreshAccess: vi.fn() } as unknown as AiAppAssistantService);

    expect(() => settings.open()).toThrow("Set managedEndpoint");
    expect(document.querySelector("ai-app-assistant-settings")).toBeNull();
  });

  it("fails closed when managed access cannot be resolved", async () => {
    const assistantClient: AiAppAssistantClient = {
      ask: vi.fn(async () => response),
      stream: vi.fn(async () => response)
    };
    const managedClient = settingsClient({
      getAccess: vi.fn(async () => { throw new Error("Unauthorized"); })
    });
    const service = new AiAppAssistantService({
      endpoint: "/ask",
      managedEndpoint: "/assistant",
      streaming: false
    }, assistantClient, managedClient);

    await expect(service.refreshAccess()).resolves.toBeUndefined();
    expect(service.available()).toBe(false);
  });
});

function settingsClient(overrides: Partial<AiAppAssistantSettingsClient> = {}): AiAppAssistantSettingsClient {
  const configuration = {
    provider: "ollama" as const,
    model: "qwen3",
    access: { mode: "all" as const },
    maxConversationTurns: 3,
    apiKeyConfigured: false,
    apiKeyStorageAvailable: true,
    configured: true,
    source: "environment" as const,
    allowModelChangesByOthers: false,
    canChangeModel: true,
    canManageCredentials: true,
    canManageModelPolicy: true,
    canRevokeApiKey: false,
    fieldSources: {
      provider: "environment" as const,
      model: "environment" as const,
      apiKey: "none" as const,
      baseURL: "none" as const,
      access: "default" as const,
      quota: "default" as const,
      conversation: "default" as const
    },
    connection: { status: "connected" as const }
  };
  return {
    getAccess: async () => ({ available: true, maxConversationTurns: 3 }),
    getConfiguration: async () => configuration,
    getOptions: async () => ({ roles: [], users: [] }),
    listProviders: async () => [{
      id: "ollama", label: "Ollama", requiresApiKey: false, supportsModelDiscovery: false
    }],
    listModels: async () => [],
    testConnection: async () => ({ success: true, model: "ollama:qwen3", latencyMs: 1 }),
    save: async () => ({
      saved: true,
      connection: { success: true, model: "ollama:qwen3", latencyMs: 1 },
      configuration
    }),
    revokeApiKey: async () => configuration,
    ...overrides
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
