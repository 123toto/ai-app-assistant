import { describe, expect, it, vi } from "vitest";
import {
  createAiAppAssistantConfigurationRepository,
  createMemoryAiAppAssistantStore
} from "./configuration.js";
import type { AiAppAssistantInferenceAdapter } from "./inference-adapter.js";
import { AiAppAssistantConfigurationManager } from "./management.js";
import { createManagedAiAppAssistantRuntime } from "./managed-runtime.js";
import type { AnswerGenerator } from "./types.js";

const actor = { id: "user", label: "User" };

describe("custom inference adapters", () => {
  it("uses a host-owned gateway without a public provider API key", async () => {
    const createGenerator = vi.fn(({ model }: { model: string }) => generator(`corporate-gateway:${model}`));
    const testConnection = vi.fn(async ({ model }: { model: string }) => ({
      success: true as const,
      model: `private:${model}`,
      latencyMs: 2
    }));
    const adapter: AiAppAssistantInferenceAdapter = {
      id: "corporate-gateway",
      label: "Corporate AI Gateway",
      createGenerator,
      testConnection
    };
    const manager = createManager(adapter);

    expect(manager.listProviders()).toEqual([{
      id: "corporate-gateway",
      label: "Corporate AI Gateway",
      requiresApiKey: false,
      supportsModelDiscovery: false,
      connectionManagement: "host"
    }]);
    await expect(manager.testConnection({
      provider: "mistral",
      model: "mistral-small-latest"
    })).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    await expect(manager.validateRuntimeConnection()).resolves.toBe(true);
    await expect(manager.canUse(actor)).resolves.toBe(true);
    await expect(manager.getView(actor)).resolves.toMatchObject({
      provider: "corporate-gateway",
      model: "approved-model",
      apiKeyConfigured: false,
      configured: true,
      connection: { status: "connected", model: "corporate-gateway:approved-model" }
    });

    const runtime = createManagedAiAppAssistantRuntime({ configuration: manager });
    await runtime.reload(true);
    const response = await runtime.answer(request(), actor);
    expect(response.metadata.model).toBe("corporate-gateway:approved-model");
    expect(testConnection).toHaveBeenCalledOnce();
    expect(createGenerator).toHaveBeenCalledWith({ model: "approved-model" });
    runtime.dispose();
  });

  it("performs a real structured generation probe when the adapter omits testConnection", async () => {
    const generate = vi.fn(async () => ({
      answer: { summary: "Connection available", sections: [] },
      evidence: [{ source: "document" as const, reference: "connection-test" }],
      limitations: []
    }));
    const adapter: AiAppAssistantInferenceAdapter = {
      id: "private-runtime",
      label: "Private runtime",
      createGenerator: () => ({ modelId: "private-runtime:approved-model", generate })
    };
    const manager = createManager(adapter, "private-runtime");

    await expect(manager.validateRuntimeConnection()).resolves.toBe(true);
    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]?.[0]).toMatchObject({
      question: expect.any(String),
      items: [{ source: "document", reference: "connection-test" }]
    });
  });

  it("normalizes optional model discovery under the registered adapter id", async () => {
    const adapter: AiAppAssistantInferenceAdapter = {
      id: "corporate-gateway",
      label: "Corporate AI Gateway",
      createGenerator: () => generator("corporate-gateway:approved-model"),
      listModels: vi.fn(async () => [{ id: "approved-model", label: "Approved model" }])
    };
    const manager = createManager(adapter);

    expect(manager.listProviders()[0]?.supportsModelDiscovery).toBe(true);
    await expect(manager.listModels({ provider: adapter.id })).resolves.toEqual([{
      id: "approved-model",
      provider: adapter.id,
      label: "Approved model"
    }]);
  });

  it("never resolves or probes a custom adapter while globally disabled", async () => {
    const adapter: AiAppAssistantInferenceAdapter = {
      id: "corporate-gateway",
      label: "Corporate AI Gateway",
      createGenerator: vi.fn(() => generator("corporate-gateway:approved-model")),
      testConnection: vi.fn(async () => ({
        success: true as const,
        model: "corporate-gateway:approved-model",
        latencyMs: 1
      }))
    };
    const manager = createManager(adapter, adapter.id, false);

    await expect(manager.validateRuntimeConnection()).resolves.toBe(false);
    await expect(manager.canUse(actor)).resolves.toBe(false);
    expect(adapter.createGenerator).not.toHaveBeenCalled();
    expect(adapter.testConnection).not.toHaveBeenCalled();
  });

  it("rejects unknown and duplicate provider identifiers", async () => {
    const manager = createManager({
      id: "corporate-gateway",
      label: "Corporate AI Gateway",
      createGenerator: () => generator("corporate-gateway:model")
    });
    await expect(manager.save({
      provider: "missing-adapter",
      model: "model",
      access: { mode: "all" }
    }, actor)).rejects.toMatchObject({ status: 400, code: "invalid_request" });

    expect(() => createManager({
      id: "openai",
      label: "Unsafe override",
      createGenerator: () => generator("openai:model")
    })).toThrow("already registered");
  });
});

function createManager(
  adapter: AiAppAssistantInferenceAdapter,
  provider = adapter.id,
  enabled = true
): AiAppAssistantConfigurationManager {
  return new AiAppAssistantConfigurationManager({
    repository: createAiAppAssistantConfigurationRepository({
      store: createMemoryAiAppAssistantStore(),
      secretProtector: { protect: String, unprotect: String }
    }),
    enabled,
    inferenceAdapters: [adapter],
    defaultConfiguration: {
      provider,
      model: "approved-model",
      access: { mode: "all" }
    },
    includeBuiltInProviders: false
  });
}

function generator(modelId: string): AnswerGenerator {
  return {
    modelId,
    async generate(bundle) {
      return {
        answer: { summary: "Useful answer", sections: [] },
        evidence: bundle.items.map(({ source, reference }) => ({ source, reference })),
        limitations: []
      };
    }
  };
}

function request() {
  return {
    protocolVersion: "4" as const,
    requestId: "custom-adapter-request",
    html: "<main>Example</main>",
    question: "Explain",
    locale: "en"
  };
}
