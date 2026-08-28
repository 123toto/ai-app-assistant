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
    expect(element.shadowRoot?.querySelector("form")?.getAttribute("data-setup-state")).toBe("ready");
    expect(element.shadowRoot?.querySelector(".setup-notice")).toBeNull();
    expect(element.shadowRoot?.querySelector<HTMLButtonElement>("[data-action=models]")?.disabled).toBe(false);
    expect(element.shadowRoot?.querySelector<HTMLButtonElement>("[data-action=models]")?.title).toBe("");
    expect(element.shadowRoot?.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
    expect(element.shadowRoot?.querySelector('[data-validation-field="apiKey"]')?.classList).not.toContain("validation-invalid");
  });

  it("closes without saving from the Cancel button", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const value = url.endsWith("/configuration")
        ? configuration()
        : url.endsWith("/providers")
          ? [{ id: "ollama", label: "Ollama", requiresApiKey: false, supportsModelDiscovery: true }]
          : url.endsWith("/models")
            ? [{ id: "qwen3", provider: "ollama" }]
            : { roles: [], users: [] };
      return new Response(JSON.stringify(value), { status: 200 });
    }));
    const element = document.createElement("ai-app-assistant-settings") as AiAppAssistantSettingsElement;
    element.setAttribute("endpoint", "/api/ai-app-assistant");
    element.setAttribute("open", "");
    document.body.append(element);
    await tick();

    element.shadowRoot?.querySelector<HTMLButtonElement>(".footer-actions [data-action=close]")?.click();
    expect(element.hasAttribute("open")).toBe(false);
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
    apiKey.dispatchEvent(new Event("input", { bubbles: true }));
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

  it("locks every setting when neither secure storage nor a default connection is available", async () => {
    const { element, fetch } = await renderSettings({
      ...configuration(),
      provider: null,
      model: "",
      apiKeyConfigured: false,
      apiKeyStorageAvailable: false,
      configured: false,
      connection: { status: "not-configured" },
      fieldSources: {
        ...configuration().fieldSources,
        provider: "none",
        model: "none",
        apiKey: "none"
      }
    });

    expect(element.shadowRoot?.querySelector("form")?.getAttribute("data-setup-state")).toBe("missing-all");
    expect(element.shadowRoot?.querySelector(".setup-notice")?.textContent).toContain("encryption key and a default connection are missing");
    expect(element.shadowRoot?.querySelector(".setup-notice")?.closest("fieldset")?.classList).toContain("connection-settings");
    expect([...element.shadowRoot?.querySelectorAll<HTMLFieldSetElement>("fieldset") ?? []]
      .every((fieldset) => fieldset.disabled)).toBe(true);
    expect(element.shadowRoot?.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled).toBe(true);
    expect(fetch.mock.calls.some(([input]) => String(input).endsWith("/models"))).toBe(false);
  });

  it("keeps non-secret settings available with only the default connection", async () => {
    const { element, fetch } = await renderSettings({
      ...configuration(),
      provider: "mistral",
      model: "mistral-small-latest",
      apiKeyConfigured: true,
      apiKeyStorageAvailable: false,
      configured: true,
      fieldSources: {
        ...configuration().fieldSources,
        provider: "environment",
        model: "environment",
        apiKey: "environment"
      }
    });

    expect(element.shadowRoot?.querySelector("form")?.getAttribute("data-setup-state")).toBe("default-only");
    expect(element.shadowRoot?.querySelector(".setup-notice")?.textContent).toContain("default connection is active");
    expect(element.shadowRoot?.querySelector(".setup-notice")?.closest("fieldset")?.classList).toContain("connection-settings");
    expect(element.shadowRoot?.querySelector<HTMLSelectElement>("[name=provider]")?.disabled).toBe(true);
    expect(element.shadowRoot?.querySelector<HTMLInputElement>("[name=apiKey]")?.disabled).toBe(true);
    expect(element.shadowRoot?.querySelector<HTMLInputElement>("[name=model]")?.disabled).toBe(false);
    expect(element.shadowRoot?.querySelectorAll<HTMLFieldSetElement>("fieldset")[1]?.disabled).toBe(false);
    expect(element.shadowRoot?.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled).toBe(false);
    expect(fetch.mock.calls.some(([input]) => String(input).endsWith("/models"))).toBe(true);
  });

  it("allows connection setup when secure storage exists without a default connection", async () => {
    const { element, fetch } = await renderSettings({
      ...configuration(),
      provider: null,
      model: "",
      apiKeyConfigured: false,
      apiKeyStorageAvailable: true,
      configured: false,
      connection: { status: "not-configured" },
      fieldSources: {
        ...configuration().fieldSources,
        provider: "none",
        model: "none",
        apiKey: "none"
      }
    });

    expect(element.shadowRoot?.querySelector("form")?.getAttribute("data-setup-state")).toBe("storage-only");
    const setupNotice = element.shadowRoot?.querySelector(".setup-notice");
    expect(setupNotice?.textContent).toBe("Secure storage is ready, but no connection is configured. Configure a connection to activate the assistant.");
    expect(setupNotice?.closest("fieldset")?.classList).toContain("connection-settings");
    expect(setupNotice?.parentElement).not.toBe(element.shadowRoot?.querySelector("form"));
    expect(setupNotice?.textContent).not.toMatch(/provider|API key|model/i);
    expect(element.shadowRoot?.querySelector<HTMLSelectElement>("[name=provider]")?.disabled).toBe(false);
    expect(element.shadowRoot?.querySelector<HTMLInputElement>("[name=apiKey]")?.disabled).toBe(false);
    expect(element.shadowRoot?.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled).toBe(true);
    expect(element.shadowRoot?.querySelector('[data-validation-field="provider"]')?.classList).toContain("validation-invalid");
    expect(element.shadowRoot?.querySelector('[data-validation-field="model"]')?.classList).toContain("validation-invalid");
    expect(fetch.mock.calls.some(([input]) => String(input).endsWith("/models"))).toBe(false);
  });

  it("enables model discovery and connection testing only when their inputs are usable", async () => {
    const { element, fetch } = await renderSettings({
      ...configuration(),
      provider: null,
      model: "",
      apiKeyConfigured: false,
      configured: false,
      connection: { status: "not-configured" },
      fieldSources: {
        ...configuration().fieldSources,
        provider: "none",
        model: "none",
        apiKey: "none"
      }
    });
    const provider = element.shadowRoot?.querySelector<HTMLSelectElement>("[name=provider]");
    const apiKey = element.shadowRoot?.querySelector<HTMLInputElement>("[name=apiKey]");
    const model = element.shadowRoot?.querySelector<HTMLInputElement>("[name=model]");
    const loadModels = element.shadowRoot?.querySelector<HTMLButtonElement>("[data-action=models]");
    const testConnection = element.shadowRoot?.querySelector<HTMLButtonElement>("[data-action=test]");
    if (!provider || !apiKey || !model || !loadModels || !testConnection) throw new Error("Settings controls missing");

    expect(loadModels.disabled).toBe(true);
    expect(testConnection.disabled).toBe(true);
    provider.value = "mistral";
    provider.dispatchEvent(new Event("change", { bubbles: true }));
    expect(loadModels.disabled).toBe(true);
    expect(loadModels.title).toContain("API key");

    apiKey.value = "draft-secret";
    apiKey.dispatchEvent(new Event("input", { bubbles: true }));
    expect(loadModels.disabled).toBe(false);
    expect(testConnection.disabled).toBe(true);
    model.value = "mistral-small-latest";
    model.dispatchEvent(new Event("input", { bubbles: true }));
    expect(testConnection.disabled).toBe(false);

    loadModels.click();
    await tick();
    expect(fetch.mock.calls.some(([input]) => String(input).endsWith("/models"))).toBe(true);
    const loadedButton = element.shadowRoot?.querySelector<HTMLButtonElement>("[data-action=models]");
    const currentModel = element.shadowRoot?.querySelector<HTMLInputElement>("[name=model]");
    if (!loadedButton || !currentModel) throw new Error("Updated model controls missing");
    expect(loadedButton.disabled).toBe(false);
    expect(loadedButton.title).toBe("");

    currentModel.value = "another-model";
    currentModel.dispatchEvent(new Event("input", { bubbles: true }));
    expect(loadedButton.disabled).toBe(false);
    const baseURL = element.shadowRoot?.querySelector<HTMLInputElement>("[name=baseURL]");
    if (!baseURL) throw new Error("Base URL input missing");
    baseURL.value = "https://proxy.example.test";
    baseURL.dispatchEvent(new Event("input", { bubbles: true }));
    expect(loadedButton.disabled).toBe(false);
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

async function renderSettings(configurationValue: ReturnType<typeof configuration>) {
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const value = url.endsWith("/configuration")
      ? configurationValue
      : url.endsWith("/providers")
        ? [{ id: "mistral", label: "Mistral", requiresApiKey: true, supportsModelDiscovery: true }]
        : url.endsWith("/models")
          ? [{ id: "mistral-small-latest", provider: "mistral" }]
          : { roles: [], users: [] };
    return new Response(JSON.stringify(value), { status: 200 });
  });
  vi.stubGlobal("fetch", fetch);
  const element = document.createElement("ai-app-assistant-settings") as AiAppAssistantSettingsElement;
  element.setAttribute("endpoint", "/api/ai-app-assistant");
  element.setAttribute("open", "");
  document.body.append(element);
  await tick();
  return { element, fetch };
}

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
    apiKeyStorageAvailable: true,
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
