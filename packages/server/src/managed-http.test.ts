import { describe, expect, it } from "vitest";
import {
  createAiAppAssistantConfigurationRepository,
  createMemoryAiAppAssistantStore
} from "./configuration.js";
import { createManagedAiAppAssistantFetchHandlers } from "./managed-http.js";
import { AiAppAssistantConfigurationManager } from "./management.js";
import { createManagedAiAppAssistantRuntime } from "./managed-runtime.js";
import { createMemoryAiAppAssistantTelemetryStore } from "./telemetry.js";

describe("createManagedAiAppAssistantFetchHandlers", () => {
  it("fails closed for administration and exposes portable endpoints when authorized", async () => {
    const runtime = await createRuntime();
    const closed = createManagedAiAppAssistantFetchHandlers({ runtime });
    const denied = await closed.handle(new Request("http://local/ai-app-assistant/providers"));
    expect(denied.status).toBe(401);

    const handlers = createManagedAiAppAssistantFetchHandlers({
      runtime,
      resolveIdentity: () => ({ id: "admin", label: "Admin", roles: ["admin"] }),
      authorizeAdministration: () => undefined,
      listRoles: () => [{ id: "admin", label: "Administrator" }]
    });
    const providers = await handlers.handle(new Request("http://local/ai-app-assistant/providers"));
    expect(providers.status).toBe(200);
    expect((await providers.json()) as unknown[]).not.toHaveLength(0);
    const options = await handlers.handle(new Request("http://local/ai-app-assistant/configuration/options"));
    expect(await options.json()).toEqual({
      roles: [{ id: "admin", label: "Administrator" }],
      users: []
    });
    const telemetry = await handlers.handle(new Request("http://local/ai-app-assistant/telemetry"));
    expect(await telemetry.json()).toMatchObject({ requests: 0, succeeded: 0, failed: 0 });
    runtime.dispose();
  });
});

async function createRuntime() {
  const repository = createAiAppAssistantConfigurationRepository({
    store: createMemoryAiAppAssistantStore(),
    secretProtector: { protect: String, unprotect: String }
  });
  const configuration = new AiAppAssistantConfigurationManager({
    repository,
    defaultConfiguration: {
      provider: "ollama",
      model: "qwen3",
      access: { mode: "all" }
    },
    testConnection: async () => ({ success: true, model: "ollama:qwen3", latencyMs: 1 })
  });
  const runtime = createManagedAiAppAssistantRuntime({
    configuration,
    telemetryStore: createMemoryAiAppAssistantTelemetryStore(),
    createGenerator: ({ model }) => ({
      modelId: model,
      async generate() {
        return {
          answer: { summary: "Answer", sections: [] },
          evidence: [],
          limitations: []
        };
      }
    })
  });
  await runtime.initialize();
  return runtime;
}
