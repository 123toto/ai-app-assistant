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

  it("maps a selected provider, model and API key without provider-specific variables", () => {
    const defaults = createAiAppAssistantDeploymentDefaults({
      enabled: true,
      provider: "mistral",
      model: "mistral-large-latest",
      apiKey: " shared-key "
    });

    expect(defaults.configuration).toMatchObject({
      provider: "mistral",
      model: "mistral-large-latest",
      apiKey: "shared-key"
    });
    expect(defaults.resolveApiKey("mistral")).toBe("shared-key");
    expect(defaults.resolveApiKey("openai")).toBeUndefined();
  });

  it("requires a base URL for the local Ollama provider", () => {
    expect(() =>
      createAiAppAssistantDeploymentDefaults({
        enabled: true,
        provider: "ollama",
        model: "llama3.2"
      })
    ).toThrow("requires a base URL");

    expect(
      createAiAppAssistantDeploymentDefaults({
        enabled: true,
        provider: "ollama",
        model: "llama3.2",
        baseURL: "http://ollama:11434"
      }).configuration
    ).toMatchObject({
      provider: "ollama",
      model: "llama3.2",
      baseURL: "http://ollama:11434"
    });
  });

  it("preserves slashes inside a model identifier when the provider is explicit", () => {
    expect(
      createAiAppAssistantDeploymentDefaults({
        enabled: true,
        provider: "openai",
        model: "openai/gpt-oss-120b",
        apiKey: "key"
      }).configuration?.model
    ).toBe("openai/gpt-oss-120b");
  });

  it("rejects a provider that conflicts with a prefixed model", () => {
    expect(() =>
      createAiAppAssistantDeploymentDefaults({
        enabled: true,
        provider: "mistral",
        model: "openai:gpt-5"
      })
    ).toThrow("does not match");
  });
});
