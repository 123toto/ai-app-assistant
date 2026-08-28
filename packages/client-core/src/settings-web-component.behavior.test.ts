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
    expect(modelsButton(element).disabled).toBe(false);
    expect(modelsButton(element).title).toBe("");

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
    expect(list.hidden).toBe(true);
    model.click();
    expect(list.hidden).toBe(false);
    expect(element.shadowRoot?.querySelectorAll(".model-option")).toHaveLength(4);

    model.value = "large";
    model.dispatchEvent(new Event("input", { bubbles: true }));
    const visible = [...element.shadowRoot?.querySelectorAll<HTMLButtonElement>(".model-option:not([hidden])") ?? []];
    expect(visible.map((option) => option.dataset["value"])).toEqual(["mistral-large-latest"]);
    model.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    model.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(model.value).toBe("mistral-large-latest");
    expect(list.hidden).toBe(true);
  });

  it("fuzzy-matches ordered model characters across separators and words", async () => {
    const api = new StrictSettingsApi(connectedConfiguration());
    const element = await mount(api);
    const model = element.shadowRoot?.querySelector<HTMLInputElement>("[name=model]");
    if (!model) throw new Error("Model autocomplete missing");

    model.value = "M-I-S-M-E-D";
    model.dispatchEvent(new Event("input", { bubbles: true }));

    const visible = [...element.shadowRoot?.querySelectorAll<HTMLButtonElement>(".model-option:not([hidden])") ?? []];
    expect(visible.map((option) => option.dataset["value"])).toEqual(["mistral-medium-latest"]);

    model.value = "medmis";
    model.dispatchEvent(new Event("input", { bubbles: true }));
    expect(element.shadowRoot?.querySelectorAll(".model-option:not([hidden])")).toHaveLength(0);
    expect(element.shadowRoot?.querySelector<HTMLElement>(".model-empty")?.hidden).toBe(false);
  });

  it("opens model suggestions only from the input and closes them on any outside click", async () => {
    const api = new StrictSettingsApi(connectedConfiguration());
    const element = await mount(api);
    const root = element.shadowRoot;
    const model = root?.querySelector<HTMLInputElement>("[name=model]");
    const list = root?.querySelector<HTMLElement>(".model-options");
    const label = root?.querySelector<HTMLElement>('[data-validation-field="model"] .field-label');
    if (!model || !list || !label) throw new Error("Model autocomplete missing");

    model.click();
    expect(list.hidden).toBe(false);

    label.click();
    expect(list.hidden).toBe(true);

    model.click();
    expect(list.hidden).toBe(false);
    root?.querySelector<HTMLInputElement>("[name=baseURL]")?.click();
    expect(list.hidden).toBe(true);
  });

  it("places model refresh as a compact icon button beside the model input", async () => {
    const api = new StrictSettingsApi(unconfigured(true));
    const element = await mount(api);
    const refresh = modelsButton(element);
    const model = element.shadowRoot?.querySelector<HTMLInputElement>('[name="model"]');

    expect(refresh.classList).toContain("model-refresh");
    expect(refresh.getAttribute("aria-label")).toBe("Refresh models");
    expect(refresh.textContent?.trim()).toBe("");
    expect(refresh.querySelectorAll("svg path")).toHaveLength(4);
    expect(refresh.closest(".model-control")?.querySelector('[name="model"]')).toBe(model);
    expect(element.shadowRoot?.textContent).not.toContain("Load models");
  });

  it("visually distinguishes active connection actions without changing field content", async () => {
    const api = new StrictSettingsApi(unconfigured(true));
    const element = await mount(api);
    const styles = element.shadowRoot?.querySelector("style")?.textContent ?? "";

    expect(styles).toContain("fieldset button{align-self:end;min-height:38px;color:var(--ai-accent);background:var(--ai-surface)");
    expect(styles).toContain(".model-refresh{display:grid;flex:0 0 38px;width:38px;padding:0;color:var(--ai-text);font-weight:600");
    expect(styles).toContain(".connection-actions>button{min-width:180px;padding:7px 14px;color:var(--ai-text);font-weight:600");
    expect(styles).toContain(".connection-actions{align-items:center;justify-content:space-between");
    expect(styles).toContain(".test-success-icon{display:inline-grid;width:22px;height:22px;color:#fff");
    expect(styles).toContain("fieldset button:disabled{color:var(--ai-text-muted);font-weight:400");
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

  it("automatically refreshes models once a new API key has been entered", async () => {
    const api = new StrictSettingsApi(unconfigured(true));
    const element = await mount(api);
    select(element, "provider", "mistral");

    input(element, "apiKey", "draft");
    input(element, "apiKey", "draft-key");
    await waitForAutomaticModelRefresh();

    expect(api.count("POST", "/models")).toBe(1);
    expect(api.lastBody("POST", "/models")).toEqual({ provider: "mistral", apiKey: "draft-key" });
    expect(value(element, "apiKey")).toBe("draft-key");
    expect(modelsButton(element).disabled).toBe(false);
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
    expect(modelsButton(element).disabled).toBe(false);

    modelsButton(element).click();
    await settle();
    expect(api.count("POST", "/models")).toBe(2);
    expect(modelsButton(element).disabled).toBe(false);

    input(element, "model", "mistral-large-latest");
    expect(modelsButton(element).disabled).toBe(false);
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
    const modelError = element.shadowRoot?.querySelector<HTMLElement>(".error");
    expect(modelError?.textContent).toBe("Unable to load the model list.");
    expect(modelError?.closest("fieldset")?.classList).toContain("connection-settings");
    expect(element.shadowRoot?.querySelector(".modal > .error")).toBeNull();
    expect(api.count("POST", "/models")).toBe(1);
    expect(modelsButton(element).disabled).toBe(false);

    modelsButton(element).click();
    await settle();
    expect(api.count("POST", "/models")).toBe(2);
    expect(element.shadowRoot?.querySelector(".error")).toBeNull();
    expect(modelsButton(element).disabled).toBe(false);
  });

  it("keeps every unsaved connection value after a successful connection test", async () => {
    const api = new StrictSettingsApi(unconfigured(true));
    let releaseConnectionTest: (() => void) | undefined;
    api.connectionTestGate = new Promise<void>((resolve) => { releaseConnectionTest = resolve; });
    const element = await mount(api);
    fillConnection(element, { provider: "mistral", apiKey: "draft-key" });
    input(element, "model", "mistral-medium-latest");
    const apiKeyInput = element.shadowRoot?.querySelector<HTMLInputElement>('[name="apiKey"]');

    testButton(element).click();
    await settle();

    expect(element.shadowRoot?.querySelector('[name="apiKey"]')).toBe(apiKeyInput);
    expect(apiKeyInput?.disabled).toBe(false);
    expect(apiKeyInput?.value).toBe("draft-key");
    expect(testButton(element).disabled).toBe(true);
    expect(saveButton(element).disabled).toBe(true);

    releaseConnectionTest?.();
    await settle();

    expect(api.lastBody("POST", "/configuration/test")).toEqual({
      provider: "mistral",
      apiKey: "draft-key",
      model: "mistral-medium-latest"
    });
    expect(element.shadowRoot?.querySelector('[name="apiKey"]')).toBe(apiKeyInput);
    expect(value(element, "provider")).toBe("mistral");
    expect(value(element, "apiKey")).toBe("draft-key");
    expect(element.shadowRoot?.querySelector<HTMLInputElement>('[name="apiKey"]')?.getAttribute("value")).toBeNull();
    expect(value(element, "model")).toBe("mistral-medium-latest");
    expect(saveButton(element).disabled).toBe(false);
    expect(api.count("PUT", "/configuration")).toBe(0);
    const actions = element.shadowRoot?.querySelector(".connection-actions");
    const feedback = actions?.querySelector<HTMLElement>(".test.ok");
    expect(actions?.firstElementChild).toBe(testButton(element));
    expect(actions?.lastElementChild).toBe(feedback);
    expect(feedback?.textContent).toContain("Connection successful");
    expect(feedback?.querySelector(".test-success-icon")?.textContent).toBe("✓");
  });

  it("keeps every unsaved connection value after a failed connection test", async () => {
    const api = new StrictSettingsApi(unconfigured(true));
    api.connectionFailuresRemaining = 1;
    const element = await mount(api);
    fillConnection(element, { provider: "mistral", apiKey: "draft-key" });
    input(element, "model", "mistral-medium-latest");

    testButton(element).click();
    await settle();

    const connectionError = element.shadowRoot?.querySelector<HTMLElement>(".error");
    expect(connectionError?.textContent).toContain("status 502");
    expect(connectionError?.closest("fieldset")?.classList).toContain("connection-settings");
    expect(element.shadowRoot?.querySelector(".modal > .error")).toBeNull();
    expect(value(element, "provider")).toBe("mistral");
    expect(value(element, "apiKey")).toBe("draft-key");
    expect(value(element, "model")).toBe("mistral-medium-latest");
    expect(saveButton(element).disabled).toBe(false);
    expect(api.count("PUT", "/configuration")).toBe(0);
  });

  it("disables Save and outlines each missing connection field progressively", async () => {
    const api = new StrictSettingsApi(unconfigured(true));
    const element = await mount(api);

    expect(saveButton(element).disabled).toBe(true);
    expect(validationField(element, "provider").classList).toContain("validation-invalid");
    expect(validationField(element, "model").classList).toContain("validation-invalid");

    select(element, "provider", "mistral");
    expect(validationField(element, "provider").classList).not.toContain("validation-invalid");
    expect(validationField(element, "apiKey").classList).toContain("validation-invalid");
    expect(saveButton(element).disabled).toBe(true);

    input(element, "apiKey", "draft-key");
    expect(validationField(element, "apiKey").classList).not.toContain("validation-invalid");
    expect(saveButton(element).disabled).toBe(true);

    input(element, "model", "mistral-medium-latest");
    expect(validationField(element, "model").classList).not.toContain("validation-invalid");
    expect(saveButton(element).disabled).toBe(false);
  });

  it("reuses a stored key only for its configured provider", async () => {
    const api = new StrictSettingsApi(connectedConfiguration());
    const element = await mount(api);

    expect(saveButton(element).disabled).toBe(false);
    expect(validationField(element, "apiKey").classList).not.toContain("validation-invalid");

    select(element, "provider", "openai");
    expect(saveButton(element).disabled).toBe(true);
    expect(validationField(element, "apiKey").classList).toContain("validation-invalid");
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

  it("serializes every usage limit without asking the connection-test endpoint", async () => {
    const api = new StrictSettingsApi(connectedConfiguration());
    const element = await mount(api);
    input(element, "maxRequests", "42");
    input(element, "windowHours", "24");
    input(element, "maxConversationTurns", "7");

    element.shadowRoot?.querySelector<HTMLFormElement>("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();

    expect(api.count("PUT", "/configuration")).toBe(1);
    expect(api.count("POST", "/configuration/test")).toBe(0);
    expect(api.lastBody("PUT", "/configuration")).toMatchObject({
      provider: "mistral",
      model: "mistral-small-latest",
      quota: { maxRequests: 42, windowSeconds: 86_400 },
      maxConversationTurns: 7
    });
  });

  it("keeps host-managed gateway credentials and endpoint out of the settings modal", async () => {
    const api = new StrictSettingsApi({
      ...connectedConfiguration(),
      provider: "corporate-gateway" as never,
      model: "approved-model",
      apiKeyConfigured: false,
      apiKeyStorageAvailable: false,
      fieldSources: {
        ...connectedConfiguration().fieldSources,
        provider: "environment",
        model: "environment",
        apiKey: "none",
        baseURL: "none"
      }
    }, undefined, [{
      id: "corporate-gateway",
      label: "Corporate AI Gateway",
      requiresApiKey: false,
      supportsModelDiscovery: true,
      connectionManagement: "host"
    }]);
    const element = await mount(api);
    const root = element.shadowRoot;

    expect(root?.querySelector(".setup-notice")?.textContent).toContain("managed by the host application");
    expect(root?.querySelector(".managed-value")?.textContent).toBe("Corporate AI Gateway");
    expect(root?.querySelector("[name=apiKey]")).toBeNull();
    expect(root?.querySelector("[name=baseURL]")).toBeNull();
    expect(value(element, "provider")).toBe("corporate-gateway");
    expect(value(element, "model")).toBe("approved-model");
    expect(testButton(element).disabled).toBe(false);
    expect(saveButton(element).disabled).toBe(false);

    input(element, "maxRequests", "25");
    root?.querySelector<HTMLFormElement>("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();

    expect(api.lastBody("PUT", "/configuration")).toEqual(expect.objectContaining({
      provider: "corporate-gateway",
      model: "approved-model",
      quota: { maxRequests: 25, windowSeconds: 3_600 }
    }));
    expect(api.lastBody("PUT", "/configuration")).not.toHaveProperty("apiKey");
    expect(api.lastBody("PUT", "/configuration")).not.toHaveProperty("baseURL");
  });

  it("blocks saving outside every documented usage limit", async () => {
    const api = new StrictSettingsApi(connectedConfiguration());
    const element = await mount(api);
    const limits = [
      { name: "maxRequests", invalid: ["", "0", "10001"], valid: "20" },
      { name: "windowHours", invalid: ["", "0", "8761"], valid: "1" },
      { name: "maxConversationTurns", invalid: ["", "0", "11"], valid: "3" }
    ];

    for (const { name, invalid, valid } of limits) {
      for (const value of invalid) {
        input(element, name, value);
        const control = element.shadowRoot?.querySelector<HTMLInputElement>(`[name=${name}]`);
        expect(saveButton(element).disabled).toBe(true);
        expect(control?.closest("label")?.classList).toContain("validation-invalid");
        element.shadowRoot?.querySelector<HTMLFormElement>("form")
          ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await settle();
        expect(api.count("PUT", "/configuration")).toBe(0);
        input(element, name, valid);
        expect(saveButton(element).disabled).toBe(false);
      }
    }
    expect(api.count("PUT", "/configuration")).toBe(0);
  });

  it("requires at least one selected role or user for restricted access", async () => {
    const api = new StrictSettingsApi(connectedConfiguration(), {
      roles: [{ id: "consumer-admin", label: "Consumer administrator" }],
      users: [{ id: "consumer-user", label: "Consumer user" }]
    });
    const element = await mount(api);
    const root = element.shadowRoot;

    for (const mode of ["roles", "users"] as const) {
      root?.querySelector<HTMLButtonElement>(`[data-action="select-access"][data-value="${mode}"]`)?.click();
      const controlName = mode === "roles" ? "roleIds" : "userIds";
      const control = root?.querySelector<HTMLSelectElement>(`[name="${controlName}"]`);
      if (!control) throw new Error(`Missing ${mode} selector`);

      expect(control.required).toBe(true);
      expect(saveButton(element).disabled).toBe(true);
      expect(control.closest("label")?.classList).toContain("validation-invalid");
      root?.querySelector<HTMLFormElement>("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await settle();
      expect(api.count("PUT", "/configuration")).toBe(0);

      control.options[0]!.selected = true;
      control.dispatchEvent(new Event("change", { bubbles: true }));
      expect(saveButton(element).disabled).toBe(false);
      expect(control.closest("label")?.classList).not.toContain("validation-invalid");
    }

    expect(api.count("PUT", "/configuration")).toBe(0);
  });

  it("submits only the roles explicitly selected in the Usage section", async () => {
    const api = new StrictSettingsApi(connectedConfiguration(), {
      roles: [
        { id: "consumer-admin", label: "Consumer administrator" },
        { id: "consumer-reader", label: "Consumer reader" },
        { id: "consumer-editor", label: "Consumer editor" }
      ],
      users: []
    });
    const element = await mount(api);
    const root = element.shadowRoot;
    root?.querySelector<HTMLButtonElement>('[data-action="select-access"][data-value="roles"]')?.click();
    const roles = root?.querySelector<HTMLSelectElement>('[name="roleIds"]');
    if (!roles) throw new Error("Role selector missing");
    for (const option of roles.options) {
      const selected = ["consumer-admin", "consumer-editor"].includes(option.value);
      option.selected = selected;
      option.toggleAttribute("selected", selected);
    }
    expect([...roles.selectedOptions].map(({ value }) => value)).toEqual(["consumer-admin", "consumer-editor"]);
    useBrowserCompatibleMultipleFormData();
    roles.dispatchEvent(new Event("change", { bubbles: true }));

    root?.querySelector<HTMLFormElement>("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();

    expect(api.lastBody("PUT", "/configuration")).toMatchObject({
      access: { mode: "roles", roles: ["consumer-admin", "consumer-editor"] }
    });
    expect(JSON.stringify(api.lastBody("PUT", "/configuration"))).not.toContain("consumer-reader");
  });

  it("sends model delegation only when the current administrator may manage it", async () => {
    const allowedApi = new StrictSettingsApi(connectedConfiguration());
    const allowed = await mount(allowedApi);
    const policy = allowed.shadowRoot?.querySelector<HTMLInputElement>('[name="allowModelChangesByOthers"]');
    if (!policy) throw new Error("Model delegation control missing");
    policy.checked = true;
    policy.dispatchEvent(new Event("change", { bubbles: true }));
    allowed.shadowRoot?.querySelector<HTMLFormElement>("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(allowedApi.lastBody("PUT", "/configuration")).toMatchObject({ allowModelChangesByOthers: true });

    allowed.remove();
    const forbiddenApi = new StrictSettingsApi({ ...connectedConfiguration(), canManageModelPolicy: false });
    const forbidden = await mount(forbiddenApi);
    expect(forbidden.shadowRoot?.querySelector('[name="allowModelChangesByOthers"]')).toBeNull();
    input(forbidden, "maxRequests", "21");
    forbidden.shadowRoot?.querySelector<HTMLFormElement>("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(forbiddenApi.lastBody("PUT", "/configuration")).not.toHaveProperty("allowModelChangesByOthers");
  });

  it("places usage-only save errors inside the Usage section", async () => {
    const api = new StrictSettingsApi(connectedConfiguration());
    api.saveFailuresRemaining = 1;
    const element = await mount(api);
    input(element, "maxRequests", "42");

    element.shadowRoot?.querySelector<HTMLFormElement>("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();

    const error = element.shadowRoot?.querySelector<HTMLElement>(".error");
    expect(error?.closest("fieldset")?.classList).toContain("usage-settings");
    expect(element.shadowRoot?.querySelector(".modal > .error")).toBeNull();
  });

  it("keeps errors global when a save spans Connection and Usage", async () => {
    const api = new StrictSettingsApi(connectedConfiguration());
    api.saveFailuresRemaining = 1;
    const element = await mount(api);
    input(element, "model", "mistral-large-latest");
    input(element, "maxRequests", "42");

    element.shadowRoot?.querySelector<HTMLFormElement>("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();

    const error = element.shadowRoot?.querySelector<HTMLElement>(".modal > .error");
    expect(error?.textContent).toContain("status 500");
    expect(error?.closest("fieldset")).toBeNull();
  });

  it("shows an accessible revocation modal and cancels without calling the API", async () => {
    const api = new StrictSettingsApi({ ...connectedConfiguration(), canRevokeApiKey: true });
    const element = await mount(api);
    input(element, "model", "unsaved-model");

    const revoke = element.shadowRoot?.querySelector<HTMLButtonElement>("[data-action=revoke]");
    revoke?.click();

    const dialog = element.shadowRoot?.querySelector<HTMLElement>('.confirmation-modal[role="alertdialog"]');
    const cancel = dialog?.querySelector<HTMLButtonElement>('[data-action="cancel-revoke"]');
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.textContent).toContain("Revoke API key?");
    expect(dialog?.textContent).toContain("permanently removed");
    expect(element.shadowRoot?.querySelector(".modal")?.hasAttribute("inert")).toBe(true);
    expect(element.shadowRoot?.activeElement).toBe(cancel);
    expect(api.count("DELETE", "/configuration/api-key")).toBe(0);

    cancel?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    expect(element.shadowRoot?.activeElement).toBe(dialog?.querySelector('[data-action="confirm-revoke"]'));
    element.shadowRoot?.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(element.shadowRoot?.activeElement).toBe(cancel);

    cancel?.click();

    expect(element.shadowRoot?.querySelector(".confirmation-modal")).toBeNull();
    expect(element.shadowRoot?.querySelector(".modal")?.hasAttribute("inert")).toBe(false);
    expect(value(element, "model")).toBe("unsaved-model");
    expect(element.shadowRoot?.activeElement).toBe(element.shadowRoot?.querySelector("[data-action=revoke]"));
    expect(api.count("DELETE", "/configuration/api-key")).toBe(0);
  });

  it("revokes the API key only after explicit modal confirmation", async () => {
    const api = new StrictSettingsApi({ ...connectedConfiguration(), canRevokeApiKey: true });
    const element = await mount(api);
    const revoked = vi.fn();
    element.addEventListener("ai-app-assistant-key-revoked", revoked);

    element.shadowRoot?.querySelector<HTMLButtonElement>("[data-action=revoke]")?.click();
    expect(api.count("DELETE", "/configuration/api-key")).toBe(0);
    element.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="confirm-revoke"]')?.click();
    await settle();

    expect(element.shadowRoot?.querySelector(".confirmation-modal")).toBeNull();
    expect(api.count("DELETE", "/configuration/api-key")).toBe(1);
    expect(revoked).toHaveBeenCalledOnce();
  });

  it("preserves a host-provided revocation confirmation override", async () => {
    const api = new StrictSettingsApi({ ...connectedConfiguration(), canRevokeApiKey: true });
    const confirmRevoke = vi.fn(async () => true);
    const element = await mount(api, true, confirmRevoke);

    element.shadowRoot?.querySelector<HTMLButtonElement>("[data-action=revoke]")?.click();
    await settle();

    expect(confirmRevoke).toHaveBeenCalledOnce();
    expect(element.shadowRoot?.querySelector(".confirmation-modal")).toBeNull();
    expect(api.count("DELETE", "/configuration/api-key")).toBe(1);
  });

  it("dismisses the revocation modal with Escape", async () => {
    const api = new StrictSettingsApi({ ...connectedConfiguration(), canRevokeApiKey: true });
    const element = await mount(api);

    element.shadowRoot?.querySelector<HTMLButtonElement>("[data-action=revoke]")?.click();
    element.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="cancel-revoke"]')
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(element.shadowRoot?.querySelector(".confirmation-modal")).toBeNull();
    expect(api.count("DELETE", "/configuration/api-key")).toBe(0);
  });

  it("places API key revocation errors inside the Connection section", async () => {
    const api = new StrictSettingsApi({ ...connectedConfiguration(), canRevokeApiKey: true });
    api.revokeFailuresRemaining = 1;
    const element = await mount(api);

    element.shadowRoot?.querySelector<HTMLButtonElement>("[data-action=revoke]")?.click();
    element.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="confirm-revoke"]')?.click();
    await settle();

    const error = element.shadowRoot?.querySelector<HTMLElement>(".error");
    expect(error?.closest("fieldset")?.classList).toContain("connection-settings");
    expect(element.shadowRoot?.querySelector(".modal > .error")).toBeNull();
  });
});

class StrictSettingsApi {
  readonly calls: Array<{ method: string; path: string; body?: unknown }> = [];
  modelFailuresRemaining = 0;
  connectionFailuresRemaining = 0;
  saveFailuresRemaining = 0;
  revokeFailuresRemaining = 0;
  connectionTestGate: Promise<void> | undefined;

  public constructor(
    private configuration: ReturnType<typeof connectedConfiguration>,
    private readonly options: {
      roles: Array<{ id: string; label: string }>;
      users: Array<{ id: string; label: string }>;
    } = { roles: [], users: [] },
    private readonly providers: ReadonlyArray<{
      id: string;
      label: string;
      requiresApiKey: boolean;
      supportsModelDiscovery: boolean;
      connectionManagement?: "settings" | "host";
    }> = [
      { id: "mistral", label: "Mistral", requiresApiKey: true, supportsModelDiscovery: true },
      { id: "openai", label: "OpenAI", requiresApiKey: true, supportsModelDiscovery: true }
    ]
  ) {}

  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const method = (init.method ?? "GET").toUpperCase();
    const pathname = new URL(String(input), "http://settings.test").pathname;
    const path = pathname.replace(/^\/api\/ai-app-assistant/, "") || "/";
    const body = typeof init.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    this.calls.push({ method, path, ...(body === undefined ? {} : { body }) });

    if (method === "GET" && path === "/configuration") return json(this.configuration);
    if (method === "GET" && path === "/providers") return json(this.providers);
    if (method === "GET" && path === "/configuration/options") return json(this.options);
    if (method === "POST" && path === "/models") {
      if (this.modelFailuresRemaining > 0) {
        this.modelFailuresRemaining -= 1;
        return json({ message: "Provider unavailable" }, 502);
      }
      const provider = (body as { provider: string }).provider;
      if (provider === "corporate-gateway") return json([
        { id: "approved-model", provider, label: "Approved model" }
      ]);
      return json(provider === "mistral" ? [
        { id: "mistral-small-latest", provider },
        { id: "mistral-medium-latest", provider },
        { id: "mistral-large-latest", provider },
        { id: "codestral-latest", provider }
      ] : [{ id: "gpt-5-mini", provider }]);
    }
    if (method === "POST" && path === "/configuration/test") {
      await this.connectionTestGate;
      if (this.connectionFailuresRemaining > 0) {
        this.connectionFailuresRemaining -= 1;
        return json({ message: "Provider unavailable" }, 502);
      }
      const connection = body as { provider: string; model: string };
      return json({ success: true, model: `${connection.provider}:${connection.model}`, latencyMs: 2 });
    }
    if (method === "PUT" && path === "/configuration") {
      if (this.saveFailuresRemaining > 0) {
        this.saveFailuresRemaining -= 1;
        return json({ message: "Configuration unavailable" }, 500);
      }
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
    if (method === "DELETE" && path === "/configuration/api-key") {
      if (this.revokeFailuresRemaining > 0) {
        this.revokeFailuresRemaining -= 1;
        return json({ message: "Revocation unavailable" }, 500);
      }
      return json(this.configuration);
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

async function mount(
  api: StrictSettingsApi,
  open = true,
  confirmRevoke?: () => boolean | Promise<boolean>
): Promise<AiAppAssistantSettingsElement> {
  vi.stubGlobal("fetch", api.fetch);
  const element = document.createElement("ai-app-assistant-settings") as AiAppAssistantSettingsElement;
  if (confirmRevoke) element.configure({ endpoint: "/api/ai-app-assistant", confirmRevoke });
  else element.setAttribute("endpoint", "/api/ai-app-assistant");
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

function saveButton(element: AiAppAssistantSettingsElement): HTMLButtonElement {
  const button = element.shadowRoot?.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!button) throw new Error("Missing Save button");
  return button;
}

function validationField(element: AiAppAssistantSettingsElement, name: string): HTMLElement {
  const field = element.shadowRoot?.querySelector<HTMLElement>(`[data-validation-field="${name}"]`);
  if (!field) throw new Error(`Missing validation field: ${name}`);
  return field;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForAutomaticModelRefresh(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300));
  await settle();
}

function useBrowserCompatibleMultipleFormData(): void {
  const NativeFormData = FormData;
  vi.stubGlobal("FormData", class BrowserCompatibleFormData extends NativeFormData {
    public constructor(form?: HTMLFormElement) {
      super(form);
      if (!form) return;
      // happy-dom currently serializes only the first selected option, unlike browsers.
      for (const select of form.querySelectorAll<HTMLSelectElement>("select[multiple][name]")) {
        const alreadySerialized = this.getAll(select.name).map(String);
        for (const option of select.selectedOptions) {
          const existingIndex = alreadySerialized.indexOf(option.value);
          if (existingIndex >= 0) alreadySerialized.splice(existingIndex, 1);
          else this.append(select.name, option.value);
        }
      }
    }
  });
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
