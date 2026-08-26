import { describe, expect, it, vi } from "vitest";
import {
  createAiDocsConfigurationRepository,
  createMemoryAiDocsStore
} from "./configuration.js";
import { AiDocsConfigurationManager } from "./management.js";
import { createManagedAiDocsRuntime } from "./managed-runtime.js";
import type { AnswerGenerator } from "./types.js";
import { createMemoryAiDocsTelemetryStore } from "./telemetry.js";

describe("createManagedAiDocsRuntime", () => {
  it("initializes and automatically rebuilds after a connection change", async () => {
    const repository = createAiDocsConfigurationRepository({
      store: createMemoryAiDocsStore(),
      secretProtector: { protect: String, unprotect: String }
    });
    const configuration = new AiDocsConfigurationManager({
      repository,
      defaultConfiguration: {
        provider: "ollama",
        model: "qwen3",
        access: { mode: "all" }
      },
      testConnection: async ({ provider, model }) => ({
        success: true,
        model: `${provider}:${model}`,
        latencyMs: 1
      })
    });
    const createGenerator = vi.fn(({ model }: { model: string }) => generator(model));
    const runtime = createManagedAiDocsRuntime({ configuration, createGenerator });
    await runtime.initialize();

    const first = await runtime.answer(request("first"), { id: "user", label: "User" });
    expect(first.metadata.model).toBe("ollama:qwen3");

    await configuration.save({
      provider: "ollama",
      model: "llama3.2",
      access: { mode: "all" }
    }, { id: "admin", label: "Admin" });
    const second = await runtime.answer(request("second"), { id: "user", label: "User" });
    expect(second.metadata.model).toBe("ollama:llama3.2");
    expect(createGenerator).toHaveBeenCalledTimes(2);
    runtime.dispose();
  });

  it("recovers lazily after a temporary provider failure", async () => {
    vi.useFakeTimers();
    try {
      const repository = createAiDocsConfigurationRepository({
        store: createMemoryAiDocsStore(),
        secretProtector: { protect: String, unprotect: String }
      });
      let attempts = 0;
      const configuration = new AiDocsConfigurationManager({
        repository,
        defaultConfiguration: { provider: "ollama", model: "qwen3", access: { mode: "all" } },
        reconnectIntervalMs: 1_000,
        testConnection: async ({ provider, model }) => ++attempts === 1
          ? {
              success: false,
              model: `${provider}:${model}`,
              latencyMs: 1,
              error: { code: "TEMPORARY", message: "Unavailable", retryable: true }
            }
          : { success: true, model: `${provider}:${model}`, latencyMs: 1 }
      });
      const runtime = createManagedAiDocsRuntime({ configuration, createGenerator: ({ model }) => generator(model) });
      await runtime.initialize();
      await vi.advanceTimersByTimeAsync(1_001);

      const response = await runtime.answer(request("recovered"), { id: "user", label: "User" });
      expect(response.metadata.model).toBe("ollama:qwen3");
      expect(attempts).toBe(2);
      runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("records one safe event with token usage per completed request", async () => {
    const repository = createAiDocsConfigurationRepository({
      store: createMemoryAiDocsStore(),
      secretProtector: { protect: String, unprotect: String }
    });
    const configuration = new AiDocsConfigurationManager({
      repository,
      defaultConfiguration: { provider: "ollama", model: "qwen3", access: { mode: "all" } },
      testConnection: async () => ({ success: true, model: "ollama:qwen3", latencyMs: 1 })
    });
    const telemetryStore = createMemoryAiDocsTelemetryStore();
    const runtime = createManagedAiDocsRuntime({
      configuration,
      telemetryStore,
      createGenerator: ({ model }) => ({
        ...generator(model),
        async generate(bundle) {
          return {
            answer: { summary: "Useful answer", sections: [] },
            evidence: bundle.items.map(({ source, reference }) => ({ source, reference })),
            limitations: [],
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
          };
        }
      })
    });
    await runtime.initialize();
    await runtime.answer(request("usage"), { id: "private-user", label: "Private User" });

    expect(await telemetryStore.summary()).toMatchObject({
      requests: 1,
      succeeded: 1,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15
    });
    expect(JSON.stringify(await telemetryStore.summary())).not.toContain("private-user");
    runtime.dispose();
  });
});

function request(id: string) {
  return {
    protocolVersion: "3" as const,
    requestId: id,
    html: "<main>Example</main>",
    question: "Explain",
    locale: "en"
  };
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
