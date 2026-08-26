import { describe, expect, it } from "vitest";
import { createAiAppAssistantDeploymentDefaults } from "./deployment-defaults.js";

describe("createAiAppAssistantDeploymentDefaults", () => {
  it("parses aliases and exposes only the active provider key", () => {
    const defaults = createAiAppAssistantDeploymentDefaults({
      enabled: true,
      model: "gemini:gemini-2.5-flash",
      apiKeys: { google: " google-key ", mistral: "mistral-key" },
      quota: { maxRequests: 20, windowSeconds: 3_600 }
    });

    expect(defaults.configuration).toMatchObject({
      provider: "google",
      model: "gemini-2.5-flash",
      apiKey: "google-key",
      connectionSource: "environment"
    });
    expect(defaults.resolveApiKey("mistral")).toBe("mistral-key");
  });

  it("returns no configuration when disabled", () => {
    expect(createAiAppAssistantDeploymentDefaults({ enabled: false }).configuration).toBeUndefined();
  });
});
