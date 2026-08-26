import { describe, expect, it } from "vitest";
import {
  createAiDocsConfigurationRepository,
  createMemoryAiDocsStore
} from "./configuration.js";
import { createManagedAiDocsFetchHandlers } from "./managed-http.js";
import { AiDocsConfigurationManager } from "./management.js";
import { createManagedAiDocsRuntime } from "./managed-runtime.js";
import { createMemoryAiDocsTelemetryStore } from "./telemetry.js";

describe("createManagedAiDocsFetchHandlers", () => {
  it("fails closed for administration and exposes portable endpoints when authorized", async () => {
    const runtime = await createRuntime();
    const closed = createManagedAiDocsFetchHandlers({ runtime });
    const denied = await closed.handle(new Request("http://local/ai-docs/providers"));
    expect(denied.status).toBe(401);

    const handlers = createManagedAiDocsFetchHandlers({
      runtime,
      resolveIdentity: () => ({ id: "admin", label: "Admin", roles: ["admin"] }),
      authorizeAdministration: () => undefined,
      listRoles: () => [{ id: "admin", label: "Administrator" }]
    });
    const providers = await handlers.handle(new Request("http://local/ai-docs/providers"));
    expect(providers.status).toBe(200);
    expect((await providers.json()) as unknown[]).not.toHaveLength(0);
    const options = await handlers.handle(new Request("http://local/ai-docs/configuration/options"));
    expect(await options.json()).toEqual({
      roles: [{ id: "admin", label: "Administrator" }],
      users: []
    });
    const telemetry = await handlers.handle(new Request("http://local/ai-docs/telemetry"));
    expect(await telemetry.json()).toMatchObject({ requests: 0, succeeded: 0, failed: 0 });
    runtime.dispose();
  });
});

async function createRuntime() {
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
    testConnection: async () => ({ success: true, model: "ollama:qwen3", latencyMs: 1 })
  });
  const runtime = createManagedAiDocsRuntime({
    configuration,
    telemetryStore: createMemoryAiDocsTelemetryStore(),
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
