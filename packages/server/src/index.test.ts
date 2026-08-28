import { describe, expect, expectTypeOf, it } from "vitest";
import * as server from "./index.js";
import type {
  AnswerGenerator,
  AiAppAssistantOptions,
  DocumentationSource,
  EvidenceBundle,
  ModelCapabilities
} from "./index.js";

describe("server public entry point", () => {
  it("keeps the documented runtime factories available from the package root", () => {
    expect(server).toMatchObject({
      createAiAppAssistant: expect.any(Function),
      createAiAppAssistantFetchHandlers: expect.any(Function),
      createAiAppAssistantNodeHttpListener: expect.any(Function),
      createAiAppAssistantServer: expect.any(Function),
      createManagedAiAppAssistantRuntime: expect.any(Function),
      createManagedAiAppAssistantServer: expect.any(Function),
      createManagedAiAppAssistantFetchHandlers: expect.any(Function),
      AiAppAssistantConfigurationManager: expect.any(Function),
      createAiSdkGenerator: expect.any(Function),
      listAiProviders: expect.any(Function),
      createAiAppAssistantConfigurationRepository: expect.any(Function),
      createMemoryAiAppAssistantQuotaStore: expect.any(Function),
      createMemoryAiAppAssistantTelemetryStore: expect.any(Function)
    });
  });

  it("keeps the provider-neutral extension types usable from the package root", () => {
    expectTypeOf<AnswerGenerator["generate"]>().toBeFunction();
    expectTypeOf<AiAppAssistantOptions>().toHaveProperty("generator");
    expectTypeOf<DocumentationSource>().toHaveProperty("content");
    expectTypeOf<EvidenceBundle["items"]>().toBeArray();
    expectTypeOf<ModelCapabilities["contextWindowTokens"]>().toBeNumber();
  });
});
