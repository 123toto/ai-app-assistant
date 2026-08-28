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

  it("routes managed access, answer, stream and credential-free configuration end to end", async () => {
    const runtime = await createRuntime();
    const identity = { id: "user-1", label: "User 1", roles: ["consumer-user"] };
    const handlers = createManagedAiAppAssistantFetchHandlers({
      runtime,
      resolveIdentity: () => identity,
      authorizeAdministration: () => undefined
    });

    const access = await handlers.handle(new Request("http://local/ai-app-assistant/access"));
    expect(access.status).toBe(200);
    await expect(access.json()).resolves.toEqual({ available: true, maxConversationTurns: 3 });

    const answer = await handlers.handle(post("/ai-app-assistant/ask"));
    expect(answer.status).toBe(200);
    await expect(answer.json()).resolves.toMatchObject({
      protocolVersion: "4",
      requestId: "managed-request",
      answer: { summary: "Answer" },
      metadata: { model: "ollama:qwen3" }
    });

    const stream = await handlers.handle(post("/ai-app-assistant/ask/stream"));
    expect(stream.headers.get("content-type")).toContain("application/x-ndjson");
    const events = (await stream.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.map(({ type }) => type)).toEqual(["status", "status", "complete"]);
    expect(events.at(-1)).toMatchObject({
      type: "complete",
      response: { requestId: "managed-request", answer: { summary: "Answer" } }
    });

    const configuration = await handlers.handle(new Request("http://local/ai-app-assistant/configuration"));
    expect(configuration.status).toBe(200);
    const configurationBody = await configuration.json();
    expect(configurationBody).toMatchObject({
      provider: "ollama",
      model: "qwen3",
      configured: true,
      apiKeyConfigured: false
    });
    expect(configurationBody).not.toHaveProperty("apiKey");
    runtime.dispose();
  });

  it("distinguishes authentication, administration, invalid input, body limits and unknown routes", async () => {
    const runtime = await createRuntime();
    const withoutAdmin = createManagedAiAppAssistantFetchHandlers({
      runtime,
      resolveIdentity: () => ({ id: "user-1", label: "User 1", roles: [] })
    });
    const forbidden = await withoutAdmin.handle(new Request("http://local/ai-app-assistant/configuration"));
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toMatchObject({ error: "forbidden" });

    const handlers = createManagedAiAppAssistantFetchHandlers({
      runtime,
      resolveIdentity: () => ({ id: "admin", label: "Admin", roles: ["admin"] }),
      authorizeAdministration: () => undefined,
      maxBodyBytes: 20
    });
    const invalid = await handlers.handle(new Request("http://local/ai-app-assistant/ask", {
      method: "POST", body: "not-json"
    }));
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: "invalid_request" });

    const oversized = await handlers.handle(new Request("http://local/ai-app-assistant/ask", {
      method: "POST",
      headers: { "content-length": "21" },
      body: "{}"
    }));
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({ error: "invalid_request" });

    const unknown = await handlers.handle(new Request("http://local/ai-app-assistant/unknown"));
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toMatchObject({ error: "not_found" });
    runtime.dispose();
  });
});

function post(path: string): Request {
  return new Request(`http://local${path}`, {
    method: "POST",
    body: JSON.stringify({
      protocolVersion: "4",
      requestId: "managed-request",
      html: "<main>Managed page</main>",
      htmlTruncated: false,
      question: "Explain this page",
      locale: "en"
    })
  });
}

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
