import { describe, expect, expectTypeOf, it } from "vitest";
import * as client from "./index.js";
import type {
  AiAppAssistantClient,
  AiAppAssistantControllerSnapshot,
  AiAppAssistantSettingsClient,
  CaptureResult
} from "./index.js";

describe("client public entry point", () => {
  it("keeps every framework-neutral runtime primitive exported from the package root", () => {
    expect(client).toMatchObject({
      createAiAppAssistantClient: expect.any(Function),
      AiAppAssistantHttpError: expect.any(Function),
      capturePage: expect.any(Function),
      createElementPickerSession: expect.any(Function),
      pickElement: expect.any(Function),
      AiAppAssistantController: expect.any(Function),
      describeAiAppAssistantElement: expect.any(Function),
      normalizeAiAppAssistantError: expect.any(Function),
      AiAppAssistantSettingsController: expect.any(Function),
      createAiAppAssistantSettingsClient: expect.any(Function)
    });
  });

  it("keeps the public client, controller, settings and capture types usable", () => {
    expectTypeOf<AiAppAssistantClient["ask"]>().toBeFunction();
    expectTypeOf<AiAppAssistantControllerSnapshot["messages"]>().toBeArray();
    expectTypeOf<AiAppAssistantSettingsClient["save"]>().toBeFunction();
    expectTypeOf<CaptureResult>().toHaveProperty("html").toBeString();
  });
});
