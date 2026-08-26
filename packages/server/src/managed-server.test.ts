import { describe, expect, it } from "vitest";
import {
  createAiAppAssistantConfigurationRepository,
  createMemoryAiAppAssistantStore
} from "./configuration.js";
import { createManagedAiAppAssistantServer } from "./managed-server.js";
import type { AnswerGenerator, EvidenceBundle } from "./types.js";

describe("createManagedAiAppAssistantServer", () => {
  it("assembles the managed API and accepts documentation after bootstrap", async () => {
    let lastBundle: EvidenceBundle | undefined;
    const generator: AnswerGenerator = {
      modelId: "test:model",
      async generate(bundle) {
        lastBundle = bundle;
        return {
          answer: { summary: "Answer", sections: [] },
          evidence: bundle.items.map(({ source, reference }) => ({ source, reference })),
          limitations: []
        };
      }
    };
    const server = createManagedAiAppAssistantServer({
      configuration: {
        repository: createAiAppAssistantConfigurationRepository({
          store: createMemoryAiAppAssistantStore(),
          secretProtector: { protect: String, unprotect: String }
        }),
        defaultConfiguration: {
          provider: "ollama",
          model: "test",
          access: { mode: "all" }
        },
        testConnection: async () => ({ success: true, model: "ollama:test", latencyMs: 1 })
      },
      runtime: { createGenerator: () => generator },
      http: {
        resolveIdentity: () => ({ id: "user", label: "User" }),
        authorizeAdministration: () => undefined
      }
    });

    await server.setDocuments([{ id: "guide", title: "Guide", content: "Business guide" }]);
    await server.initialize();
    const response = await server.fetch.handle(new Request("http://local/ai-app-assistant/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        protocolVersion: "4",
        requestId: "request-1",
        html: "<main>Page</main>",
        question: "Explain",
        locale: "en"
      })
    }));

    expect(response.status).toBe(200);
    expect(lastBundle?.items.some((item) => item.reference === "document:guide")).toBe(true);
    server.dispose();
  });

  it("forwards the framework-native context to identity hooks", async () => {
    const server = createManagedAiAppAssistantServer<
      { id: string; label: string },
      { userId: string }
    >({
      configuration: {
        repository: createAiAppAssistantConfigurationRepository({
          store: createMemoryAiAppAssistantStore(),
          secretProtector: { protect: String, unprotect: String }
        }),
        defaultConfiguration: { provider: "ollama", model: "test", access: { mode: "all" } },
        testConnection: async () => ({ success: true, model: "ollama:test", latencyMs: 1 })
      },
      runtime: {
        createGenerator: () => ({
          modelId: "test:model",
          async generate() {
            return { answer: { summary: "Answer", sections: [] }, evidence: [], limitations: [] };
          }
        })
      },
      http: {
        resolveIdentity: (_request, native) => ({ id: native!.userId, label: "User" })
      }
    });
    await server.initialize();

    const response = await server.fetch.handle(
      new Request("http://local/ai-app-assistant/access"),
      { userId: "native-user" }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ available: true });
    server.dispose();
  });
});
