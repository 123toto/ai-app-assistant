// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiAppAssistantSettingsElement } from "./settings-web-component.js";

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("AI assistant settings user journeys", () => {
  it("loads models once for a connected configuration and refreshes them on a later reopening", async () => {
    const api = new StrictSettingsApi(connectedConfiguration());
    const element = await mount(api, false);

    expect(api.count("POST", "/models")).toBe(1);
    expect(api.lastBody("POST", "/models")).toEqual({ provider: "mistral" });
    element.show();
    expect(modelsButton(element).disabled).toBe(true);
    expect(modelsButton(element).title).toBe("Models are already loaded");

    element.close();
    element.show();
    await settle();
    expect(api.count("POST", "/models")).toBe(2);
  });

  it("provides a scrollable keyboard autocomplete instead of the native datalist", async () => {
    const api = new StrictSettingsApi(connectedConfiguration());
    const element = await mount(api);
    const model = element.shadowRoot?.querySelector<HTMLInputElement>("[name=model]");
    const list = element.shadowRoot?.querySelector<HTMLElement>(".model-options");
    if (!model || !list) throw new Error("Model autocomplete missing");

    expect(element.shadowRoot?.querySelector("datalist")).toBeNull();
    model.focus();
    expect(list.hidden).toBe(false);
    expect(element.shadowRoot?.querySelectorAll(".model-option")).toHaveLength(3);

    model.value = "large";
    model.dispatchEvent(new Event("input", { bubbles: true }));
    const visible = [...element.shadowRoot?.querySelectorAll<HTMLButtonElement>(".model-option:not([hidden])") ?? []];
    expect(visible.map((option) => option.dataset["value"])).toEqual(["mistral-large-latest"]);
    model.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    model.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(model.value).toBe("mistral-large-latest");
    expect(list.hidden).toBe(true);
  });

  it("uses a custom non-searchable dropdown for providers", async () => {
    const api = new StrictSettingsApi(unconfigured(true));
    const element = await mount(api);
    const root = element.shadowRoot;
    const trigger = root?.querySelector<HTMLButtonElement>('[data-dropdown="provider"] .dropdown-trigger');
    const list = root?.querySelector<HTMLElement>('[data-dropdown="provider"] .dropdown-options');
    const input = root?.querySelector<HTMLInputElement>("[name=provider]");
    if (!trigger || !list || !input) throw new Error("Provider dropdown missing");

    expect(root?.querySelector("select[name=provider]")).toBeNull();
    expect(root?.querySelector("input[role=combobox][name=provider]")).toBeNull();
    trigger.click();
    expect(list.hidden).toBe(false);
    expect(root?.querySelectorAll('[data-dropdown="provider"] .dropdown-option')).toHaveLength(2);

    root?.querySelector<HTMLButtonElement>('[data-action="select-provider"][data-value="openai"]')?.click();
    expect(input.value).toBe("openai");
    expect(trigger.textContent).toContain("OpenAI");
    expect(list.hidden).toBe(true);
  });

  it("uses a custom non-searchable dropdown for access rules", async () => {
    const api = new StrictSettingsApi(connectedConfiguration());
    const element = await mount(api);
    const root = element.shadowRoot;
    const trigger = root?.querySelector<HTMLButtonElement>('[data-dropdown="access"] .dropdown-trigger');
    const list = root?.querySelector<HTMLElement>('[data-dropdown="access"] .dropdown-options');
    const input = root?.querySelector<HTMLInputElement>("[name=accessMode]");
    if (!trigger || !list || !input) throw new Error("Access dropdown missing");

    expect(root?.querySelector("select[name=accessMode]")).toBeNull();
    expect(root?.querySelector("input[role=combobox][name=accessMode]")).toBeNull();
    trigger.click();
    expect(list.hidden).toBe(false);
    expect(root?.querySelectorAll('[data-dropdown="access"] .dropdown-option')).toHaveLength(3);

    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(root?.activeElement?.textContent).toBe("Selected roles");
    root?.querySelector<HTMLButtonElement>('[data-action="select-access"][data-value="roles"]')?.click();
    expect(input.value).toBe("roles");
    expect(trigger.textContent).toContain("Selected roles");
    expect(root?.querySelector<HTMLElement>('[data-access-values="roles"]')?.hidden).toBe(false);
    expect(root?.querySelector<HTMLElement>('[data-access-values="users"]')?.hidden).toBe(true);
    expect(list.hidden).toBe(true);
  });

  it("never calls model or connection endpoints while required fields are missing", async () => {
    const api = new StrictSettingsApi(unconfigured(false));
    const element = await mount(api);

    expect(modelsButton(element).disabled).toBe(true);
    expect(testButton(element).disabled).toBe(true);
    modelsButton(element).click();
    testButton(element).click();
    await settle();

    expect(api.count("POST", "/models")).toBe(0);
    expect(api.count("POST", "/configuration/test")).toBe(0);
    expect(api.count("PUT", "/configuration")).toBe(0);
  });

  it("enables calls progressively and invalidates only model-discovery inputs", async () => {
    const api = new StrictSettingsApi(unconfigured(true));
    const element = await mount(api);
    fillConnection(element, { provider: "mistral", apiKey: "draft-key" });

    expect(modelsButton(element).disabled).toBe(false);
    expect(testButton(element).disabled).toBe(true);
    input(element, "model", "mistral-small-latest");
    expect(testButton(element).disabled).toBe(false);

    modelsButton(element).click();
    await settle();
    expect(api.count("POST", "/models")).toBe(1);
    expect(modelsButton(element).disabled).toBe(true);

    input(element, "model", "mistral-large-latest");
    expect(modelsButton(element).disabled).toBe(true);
    input(element, "baseURL", "https://proxy.example.test");
    expect(modelsButton(element).disabled).toBe(false);
  });

  it("keeps a failed model load inside the modal and allows a useful retry", async () => {
    const api = new StrictSettingsApi(unconfigured(true));
    api.modelFailuresRemaining = 1;
    const element = await mount(api);
    fillConnection(element, { provider: "mistral", apiKey: "draft-key" });

    modelsButton(element).click();
    await settle();
    expect(element.shadowRoot?.querySelector(".error")?.textContent).toContain("status 502");
    expect(api.count("POST", "/models")).toBe(1);
    expect(modelsButton(element).disabled).toBe(false);

    modelsButton(element).click();
    await settle();
    expect(api.count("POST", "/models")).toBe(2);
    expect(element.shadowRoot?.querySelector(".error")).toBeNull();
    expect(modelsButton(element).disabled).toBe(true);
  });

  it("discards unsaved values on Cancel and never saves them", async () => {
    const api = new StrictSettingsApi(connectedConfiguration());
    const element = await mount(api);
    input(element, "model", "unsaved-model");

    element.shadowRoot?.querySelector<HTMLButtonElement>(".footer-actions [data-action=close]")?.click();
    expect(element.hasAttribute("open")).toBe(false);
    expect(api.count("PUT", "/configuration")).toBe(0);

    element.show();
    expect(value(element, "model")).toBe("mistral-small-latest");
  });

  it("saves auxiliary settings without asking the connection-test endpoint", async () => {
    const api = new StrictSettingsApi(connectedConfiguration());
    const element = await mount(api);
    input(element, "maxRequests", "42");

    element.shadowRoot?.querySelector<HTMLFormElement>("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();

    expect(api.count("PUT", "/configuration")).toBe(1);
    expect(api.count("POST", "/configuration/test")).toBe(0);
    expect(api.lastBody("PUT", "/configuration")).toMatchObject({
      provider: "mistral",
      model: "mistral-small-latest",
      quota: { maxRequests: 42, windowSeconds: 3_600 }
    });
  });
});

class StrictSettingsApi {
  readonly calls: Array<{ method: string; path: string; body?: unknown }> = [];
  modelFailuresRemaining = 0;

  public constructor(private configuration: ReturnType<typeof connectedConfiguration>) {}

  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const method = (init.method ?? "GET").toUpperCase();
    const pathname = new URL(String(input), "http://settings.test").pathname;
    const path = pathname.replace(/^\/api\/ai-app-assistant/, "") || "/";
    const body = typeof init.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    this.calls.push({ method, path, ...(body === undefined ? {} : { body }) });

    if (method === "GET" && path === "/configuration") return json(this.configuration);
    if (method === "GET" && path === "/providers") return json([
      { id: "mistral", label: "Mistral", requiresApiKey: true, supportsModelDiscovery: true },
      { id: "openai", label: "OpenAI", requiresApiKey: true, supportsModelDiscovery: true }
    ]);
    if (method === "GET" && path === "/configuration/options") return json({ roles: [], users: [] });
    if (method === "POST" && path === "/models") {
      if (this.modelFailuresRemaining > 0) {
        this.modelFailuresRemaining -= 1;
        return json({ message: "Provider unavailable" }, 502);
      }
      const provider = (body as { provider: "mistral" | "openai" }).provider;
      return json(provider === "mistral" ? [
        { id: "mistral-small-latest", provider },
        { id: "mistral-large-latest", provider },
        { id: "codestral-latest", provider }
      ] : [{ id: "gpt-5-mini", provider }]);
    }
    if (method === "POST" && path === "/configuration/test") {
      const connection = body as { provider: string; model: string };
      return json({ success: true, model: `${connection.provider}:${connection.model}`, latencyMs: 2 });
    }
    if (method === "PUT" && path === "/configuration") {
      const update = body as { provider: "mistral"; model: string; quota?: { maxRequests: number; windowSeconds: number } };
      this.configuration = {
        ...this.configuration,
        provider: update.provider,
        model: update.model,
        ...(update.quota ? { quota: update.quota } : {})
      };
      return json({
        saved: true,
        connection: { success: true, model: `${update.provider}:${update.model}`, latencyMs: 2 },
        configuration: this.configuration
      });
    }
    throw new Error(`Unexpected settings request: ${method} ${path}`);
  };

  count(method: string, path: string): number {
    return this.calls.filter((call) => call.method === method && call.path === path).length;
  }

  lastBody(method: string, path: string): unknown {
    return this.calls.filter((call) => call.method === method && call.path === path).at(-1)?.body;
  }
}

async function mount(api: StrictSettingsApi, open = true): Promise<AiAppAssistantSettingsElement> {
  vi.stubGlobal("fetch", api.fetch);
  const element = document.createElement("ai-app-assistant-settings") as AiAppAssistantSettingsElement;
  element.setAttribute("endpoint", "/api/ai-app-assistant");
  if (open) element.setAttribute("open", "");
  document.body.append(element);
  await settle();
  return element;
}

function fillConnection(
  element: AiAppAssistantSettingsElement,
  values: { provider: string; apiKey: string }
): void {
  select(element, "provider", values.provider);
  input(element, "apiKey", values.apiKey);
}

function input(element: AiAppAssistantSettingsElement, name: string, nextValue: string): void {
  const control = element.shadowRoot?.querySelector<HTMLInputElement>(`[name=${name}]`);
  if (!control) throw new Error(`Missing input: ${name}`);
  control.value = nextValue;
  control.dispatchEvent(new Event("input", { bubbles: true }));
}

function select(element: AiAppAssistantSettingsElement, name: string, nextValue: string): void {
  const control = element.shadowRoot?.querySelector<HTMLSelectElement>(`[name=${name}]`);
  if (!control) throw new Error(`Missing select: ${name}`);
  control.value = nextValue;
  control.dispatchEvent(new Event("change", { bubbles: true }));
}

function value(element: AiAppAssistantSettingsElement, name: string): string {
  return element.shadowRoot?.querySelector<HTMLInputElement>(`[name=${name}]`)?.value ?? "";
}

function modelsButton(element: AiAppAssistantSettingsElement): HTMLButtonElement {
  const button = element.shadowRoot?.querySelector<HTMLButtonElement>("[data-action=models]");
  if (!button) throw new Error("Missing Load models button");
  return button;
}

function testButton(element: AiAppAssistantSettingsElement): HTMLButtonElement {
  const button = element.shadowRoot?.querySelector<HTMLButtonElement>("[data-action=test]");
  if (!button) throw new Error("Missing Test connection button");
  return button;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function connectedConfiguration() {
  return {
    provider: "mistral" as const,
    model: "mistral-small-latest",
    access: { mode: "all" as const },
    quota: { maxRequests: 20, windowSeconds: 3_600 },
    maxConversationTurns: 3,
    apiKeyConfigured: true,
    apiKeyStorageAvailable: true,
    configured: true,
    source: "environment" as const,
    allowModelChangesByOthers: false,
    canChangeModel: true,
    canManageCredentials: true,
    canManageModelPolicy: true,
    canRevokeApiKey: false,
    fieldSources: {
      provider: "environment" as const,
      model: "environment" as const,
      apiKey: "environment" as const,
      baseURL: "none" as const,
      access: "default" as const,
      quota: "environment" as const,
      conversation: "default" as const
    },
    connection: { status: "connected" as const }
  };
}

function unconfigured(storageAvailable: boolean): ReturnType<typeof connectedConfiguration> {
  return {
    ...connectedConfiguration(),
    provider: null as never,
    model: "",
    apiKeyConfigured: false,
    apiKeyStorageAvailable: storageAvailable,
    configured: false,
    fieldSources: {
      ...connectedConfiguration().fieldSources,
      provider: "none",
      model: "none",
      apiKey: "none"
    },
    connection: { status: "not-configured" as never }
  };
}
