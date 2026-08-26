// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiAppAssistantSettingsElement } from "./settings-web-component.js";

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("AiAppAssistantSettingsElement", () => {
  it("renders a complete optional settings screen from the standard API", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const value = url.endsWith("/configuration")
        ? configuration()
        : url.endsWith("/providers")
          ? [{ id: "ollama", label: "Ollama", requiresApiKey: false, supportsModelDiscovery: true }]
          : url.endsWith("/models")
            ? [{ id: "qwen3", provider: "ollama" }]
          : { roles: [], users: [] };
      return new Response(JSON.stringify(value), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);
    const element = document.createElement("ai-app-assistant-settings") as AiAppAssistantSettingsElement;
    element.setAttribute("endpoint", "/api/ai-app-assistant");
    element.setAttribute("open", "");
    document.body.append(element);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(element.shadowRoot?.querySelector(".modal")?.textContent).toContain("AI assistant settings");
    expect(element.shadowRoot?.querySelector(".connected")?.textContent).toBe("Connected");
    expect(element.shadowRoot?.querySelector("form")).not.toBeNull();
    expect(element.shadowRoot?.querySelector<HTMLElement>("[data-access-values=roles]")?.hidden).toBe(true);
    expect(fetch.mock.calls.some(([input]) => String(input).endsWith("/models"))).toBe(true);
  });

  it("preserves unsaved credentials while models are loading", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const value = url.endsWith("/configuration")
        ? configuration()
        : url.endsWith("/providers")
          ? [{ id: "mistral", label: "Mistral", requiresApiKey: true, supportsModelDiscovery: true }]
          : url.endsWith("/models")
            ? [{ id: "mistral-small-latest", provider: "mistral" }]
            : { roles: [], users: [] };
      return new Response(JSON.stringify(value), { status: 200 });
    }));
    const element = document.createElement("ai-app-assistant-settings") as AiAppAssistantSettingsElement;
    element.setAttribute("endpoint", "/api/ai-app-assistant");
    element.setAttribute("open", "");
    document.body.append(element);
    await tick();

    const provider = element.shadowRoot?.querySelector<HTMLSelectElement>("[name=provider]");
    const apiKey = element.shadowRoot?.querySelector<HTMLInputElement>("[name=apiKey]");
    const model = element.shadowRoot?.querySelector<HTMLInputElement>("[name=model]");
    if (!provider || !apiKey || !model) throw new Error("Settings form was not rendered");
    provider.value = "mistral";
    apiKey.value = "unsaved-secret";
    model.value = "mistral-small-latest";
    element.shadowRoot?.querySelector<HTMLButtonElement>("[data-action=models]")?.click();
    await tick();

    expect(element.shadowRoot?.querySelector<HTMLInputElement>("[name=apiKey]")?.value).toBe("unsaved-secret");
    expect(element.shadowRoot?.querySelector<HTMLInputElement>("[name=model]")?.value).toBe("mistral-small-latest");
  });

  it("uses field sources for badges and disables forbidden credential controls", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const value = url.endsWith("/configuration")
        ? {
            ...configuration(),
            source: "stored",
            canChangeModel: false,
            canManageCredentials: false,
            canManageModelPolicy: false
          }
        : url.endsWith("/providers")
          ? [{ id: "ollama", label: "Ollama", requiresApiKey: false, supportsModelDiscovery: true }]
          : { roles: [], users: [] };
      return new Response(JSON.stringify(value), { status: 200 });
    }));
    const element = document.createElement("ai-app-assistant-settings") as AiAppAssistantSettingsElement;
    element.setAttribute("endpoint", "/api/ai-app-assistant");
    element.setAttribute("open", "");
    document.body.append(element);
    await tick();

    expect(element.shadowRoot?.querySelector(".auto")?.textContent).toBe("Auto");
    expect(element.shadowRoot?.querySelector<HTMLSelectElement>("[name=provider]")?.disabled).toBe(true);
    expect(element.shadowRoot?.querySelector<HTMLInputElement>("[name=model]")?.disabled).toBe(true);
    expect(element.shadowRoot?.querySelector("[name=allowModelChangesByOthers]")).toBeNull();
  });

  it("shows a neutral state while the provider connection is still being checked", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const value = url.endsWith("/configuration")
        ? { ...configuration(), connection: { status: "unchecked" } }
        : url.endsWith("/providers")
          ? [{ id: "ollama", label: "Ollama", requiresApiKey: false, supportsModelDiscovery: false }]
          : { roles: [], users: [] };
      return new Response(JSON.stringify(value), { status: 200 });
    }));
    const element = document.createElement("ai-app-assistant-settings") as AiAppAssistantSettingsElement;
    element.setAttribute("endpoint", "/api/ai-app-assistant");
    element.setAttribute("open", "");
    document.body.append(element);
    await tick();

    expect(element.shadowRoot?.querySelector(".checking")?.textContent).toBe("Checking…");
    expect(element.shadowRoot?.querySelector(".disconnected")).toBeNull();
  });
});

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function configuration() {
  return {
    provider: "ollama",
    model: "qwen3",
    access: { mode: "all" },
    maxConversationTurns: 3,
    apiKeyConfigured: false,
    apiKeyStorageAvailable: false,
    configured: true,
    source: "environment",
    allowModelChangesByOthers: false,
    canChangeModel: true,
    canManageCredentials: true,
    canManageModelPolicy: true,
    canRevokeApiKey: false,
    fieldSources: {
      provider: "environment", model: "environment", apiKey: "none", baseURL: "none",
      access: "default", quota: "default", conversation: "default"
    },
    connection: { status: "connected" }
  };
}
