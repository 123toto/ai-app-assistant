import type {
  AiAppAssistantAccessRule,
  AiAppAssistantConfigurationInput,
  AiAppAssistantManagedConfigurationView,
  AiAppAssistantProvider
} from "@123toto/ai-app-assistant-contracts";
import {
  AiAppAssistantSettingsController,
  createAiAppAssistantSettingsClient,
  type AiAppAssistantSettingsClient,
  type AiAppAssistantSettingsClientOptions,
  type AiAppAssistantSettingsSnapshot
} from "./settings.js";

export interface AiAppAssistantSettingsElementConfig {
  endpoint: string;
  /** Lets framework connectors reuse their authenticated HTTP transport. */
  client?: AiAppAssistantSettingsClient;
  headers?: AiAppAssistantSettingsClientOptions["headers"];
  title?: string;
  confirmRevoke?: () => boolean | Promise<boolean>;
  theme?: Partial<AiAppAssistantSettingsTheme>;
}

export interface AiAppAssistantSettingsTheme {
  accent: string;
  surface: string;
  surfaceMuted: string;
  text: string;
  textMuted: string;
  border: string;
  danger: string;
}

interface AiAppAssistantSettingsDraft {
  provider: string;
  apiKey: string;
  model: string;
  baseURL: string;
  accessMode: AiAppAssistantAccessRule["mode"];
  roleIds: string[];
  userIds: string[];
  maxRequests: number;
  windowHours: number;
  maxConversationTurns: number;
  allowModelChangesByOthers: boolean;
}

const HTMLElementBase: typeof HTMLElement = typeof HTMLElement === "undefined"
  ? class {} as typeof HTMLElement
  : HTMLElement;

/** Optional framework-independent settings screen for the managed server API. */
export class AiAppAssistantSettingsElement extends HTMLElementBase {
  static readonly observedAttributes = ["endpoint", "open", "title"];

  readonly #root = this.attachShadow({ mode: "open" });
  #config: Partial<AiAppAssistantSettingsElementConfig> = {};
  #controller: AiAppAssistantSettingsController | undefined;
  #unsubscribe: (() => void) | undefined;
  #snapshot: AiAppAssistantSettingsSnapshot | undefined;
  #initializedEndpoint = "";
  #configurationIdentity: AiAppAssistantManagedConfigurationView | undefined;
  #draft: AiAppAssistantSettingsDraft | undefined;
  #hasOpened = false;

  public connectedCallback(): void {
    this.setAttribute("data-ai-app-assistant-ui", "");
    this.applyTheme();
    this.#root.addEventListener("click", this.onClick);
    this.#root.addEventListener("submit", this.onSubmit);
    this.#root.addEventListener("change", this.onChange);
    void this.initialize();
  }

  public disconnectedCallback(): void {
    this.#root.removeEventListener("click", this.onClick);
    this.#root.removeEventListener("submit", this.onSubmit);
    this.#root.removeEventListener("change", this.onChange);
    this.#unsubscribe?.();
  }

  public attributeChangedCallback(): void {
    if (this.isConnected) void this.initialize();
  }

  /** Supplies dynamic authorization headers without coupling to a framework. */
  public configure(config: AiAppAssistantSettingsElementConfig): void {
    this.#config = { ...this.#config, ...config };
    this.applyTheme();
    if (this.isConnected) void this.initialize(true);
  }

  public show(): void {
    const refresh = this.#hasOpened;
    this.#hasOpened = true;
    this.setAttribute("open", "");
    // Administration data may have changed since the previous opening.
    if (refresh) void this.initialize(true);
  }
  public close(): void { this.removeAttribute("open"); }

  /** Rebuilds transport only when needed, then reloads the safe admin snapshot. */
  private async initialize(force = false): Promise<void> {
    const endpoint = this.#config.endpoint ?? this.getAttribute("endpoint") ?? "";
    if (!endpoint) {
      this.#root.innerHTML = `<style>${STYLES}</style><p class="error">Missing AI App Assistant endpoint.</p>`;
      return;
    }
    if (!force && endpoint === this.#initializedEndpoint && this.#controller) {
      this.render();
      return;
    }
    this.#initializedEndpoint = endpoint;
    this.#unsubscribe?.();
    this.#controller = new AiAppAssistantSettingsController(this.#config.client ?? createAiAppAssistantSettingsClient({
      endpoint,
      ...(this.#config.headers ? { headers: this.#config.headers } : {})
    }));
    this.#unsubscribe = this.#controller.subscribe((snapshot) => {
      this.#snapshot = snapshot;
      this.render();
    });
    try {
      const snapshot = await this.#controller.initialize();
      const configuration = snapshot.configuration;
      const provider = snapshot.providers.find((candidate) => candidate.id === configuration?.provider);
      if (configuration?.provider && provider?.supportsModelDiscovery
        && (!provider.requiresApiKey || configuration.apiKeyConfigured)) {
        await this.#controller.loadModels({
          provider: configuration.provider,
          ...(configuration.baseURL ? { baseURL: configuration.baseURL } : {})
        });
      }
    } catch { /* Rendered by the controller. */ }
  }

  private render(): void {
    this.captureDraft();
    if (!this.hasAttribute("open")) {
      this.#root.innerHTML = `<style>${STYLES}</style>`;
      return;
    }
    const snapshot = this.#snapshot;
    const configuration = snapshot?.configuration;
    if (configuration && configuration !== this.#configurationIdentity) {
      this.#configurationIdentity = configuration;
      this.#draft = draftFrom(configuration);
    }
    const busy = snapshot ? !["idle", "ready", "error"].includes(snapshot.status) : true;
    const connectionStatus = configuration?.connection.status;
    const connectionBadge = connectionStatus === "disabled"
      ? "<b class=disconnected>Disabled</b>"
      : !configuration || snapshot?.status === "loading" || connectionStatus === "unchecked"
      ? "<b class=checking>Checking…</b>"
      : connectionStatus === "connected"
        ? "<b class=connected>Connected</b>"
        : "<b class=disconnected>Not connected</b>";
    const manual = configuration && (["provider", "model", "apiKey", "baseURL"] as const)
      .some((field) => configuration.fieldSources[field] === "override");
    this.#root.innerHTML = `<style>${STYLES}</style><div class="backdrop" data-action="close"></div>
      <section class="modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(this.resolvedTitle)}">
        <header><div><h2>${escapeHtml(this.resolvedTitle)}</h2><span class="badges">${manual ? "<b class=manual>Manual</b>" : configuration?.configured ? "<b class=auto>Auto</b>" : ""}${connectionBadge}</span></div><button data-action="close" aria-label="Close">×</button></header>
        ${snapshot?.error ? `<p class="error">${escapeHtml(snapshot.error.message)}</p>` : ""}
        ${configuration ? this.renderForm(snapshot, configuration, busy) : `<div class="loading">Loading…</div>`}
      </section>`;
  }

  private renderForm(
    snapshot: AiAppAssistantSettingsSnapshot,
    configuration: AiAppAssistantManagedConfigurationView,
    busy: boolean
  ): string {
    const draft = this.#draft ?? draftFrom(configuration);
    const providerOptions = snapshot.providers.map((provider) =>
      `<option value="${provider.id}" ${provider.id === draft.provider ? "selected" : ""}>${escapeHtml(provider.label)}</option>`
    ).join("");
    const modelOptions = snapshot.models.map((model) => `<option value="${escapeHtml(model.id)}"></option>`).join("");
    const credentialsDisabled = !configuration.canManageCredentials;
    const modelDisabled = !configuration.canChangeModel;
    const roleOptions = includeSelectedChoices(snapshot.options.roles, draft.roleIds);
    const userOptions = includeSelectedChoices(snapshot.options.users, draft.userIds);
    const history = configuration.administration?.history.slice().reverse().map((entry) =>
      `<li><strong>${escapeHtml(entry.actor.label)}</strong><time>${escapeHtml(new Date(entry.changedAt).toLocaleString())}</time><span>${entry.changes.map(describeAuditChange).map(escapeHtml).join(" · ")}</span></li>`
    ).join("") ?? "";
    return `<form>
      <fieldset ${busy ? "disabled" : ""}><legend>Connection</legend>
        <label>Provider<select name="provider" required ${credentialsDisabled ? "disabled" : ""}><option value="">Select…</option>${providerOptions}</select></label>
        <label>API key<input name="apiKey" type="password" autocomplete="new-password" value="${escapeHtml(draft.apiKey)}" placeholder="${configuration.apiKeyConfigured ? "Already provided — enter a new key to replace it" : "Enter API key"}" ${credentialsDisabled ? "disabled" : ""}></label>
        <label>Model<input name="model" required list="ai-app-assistant-models" value="${escapeHtml(draft.model)}" autocomplete="off" ${modelDisabled ? "disabled" : ""}><datalist id="ai-app-assistant-models">${modelOptions}</datalist></label>
        <label>Base URL (optional)<input name="baseURL" type="url" value="${escapeHtml(draft.baseURL)}" placeholder="https://…" ${credentialsDisabled ? "disabled" : ""}></label>
        <button type="button" data-action="models" ${modelDisabled ? "disabled" : ""}>Load models</button>
        <button type="button" data-action="test" ${credentialsDisabled && modelDisabled ? "disabled" : ""}>Test connection</button>
        ${snapshot.connectionTest ? `<small class="test ${snapshot.connectionTest.success ? "ok" : "ko"}">${snapshot.connectionTest.success ? "Connection successful" : escapeHtml(snapshot.connectionTest.error.message)}</small>` : ""}
      </fieldset>
      <fieldset ${busy ? "disabled" : ""}><legend>Usage</legend>
        <label>Who can use it?<select name="accessMode" ${snapshot.optionsAvailable ? "" : "disabled"}><option value="all" ${draft.accessMode === "all" ? "selected" : ""}>Everyone</option><option value="roles" ${draft.accessMode === "roles" ? "selected" : ""}>Selected roles</option><option value="users" ${draft.accessMode === "users" ? "selected" : ""}>Selected users</option></select></label>
        <label data-access-values="roles" ${draft.accessMode === "roles" ? "" : "hidden"}>Allowed roles<select name="roleIds" multiple ${snapshot.optionsAvailable ? "" : "disabled"}>${roleOptions.map((choice) => `<option value="${escapeHtml(choice.id)}" ${draft.roleIds.includes(choice.id) ? "selected" : ""}>${escapeHtml(choice.label)}</option>`).join("")}</select></label>
        <label data-access-values="users" ${draft.accessMode === "users" ? "" : "hidden"}>Allowed users<select name="userIds" multiple ${snapshot.optionsAvailable ? "" : "disabled"}>${userOptions.map((choice) => `<option value="${escapeHtml(choice.id)}" ${draft.userIds.includes(choice.id) ? "selected" : ""}>${escapeHtml(choice.label)}</option>`).join("")}</select></label>
        ${snapshot.optionsAvailable ? "" : "<small class=hint>Access rules are managed by the host application.</small>"}
        <div class="row"><label>Questions / period<input name="maxRequests" type="number" min="1" max="10000" value="${draft.maxRequests}"></label><label>Period (hours)<input name="windowHours" type="number" min="1" max="8760" value="${draft.windowHours}"></label></div>
        <label>Questions / conversation<input name="maxConversationTurns" type="number" min="1" max="10" value="${draft.maxConversationTurns}"></label>
        ${configuration.canManageModelPolicy ? `<label class="check"><input name="allowModelChangesByOthers" type="checkbox" ${draft.allowModelChangesByOthers ? "checked" : ""}>Allow other administrators to change the model</label>` : ""}
      </fieldset>
      ${history ? `<details><summary>Change history</summary><ol class="history">${history}</ol></details>` : ""}
      <footer>${configuration.canRevokeApiKey ? `<button type="button" class="danger" data-action="revoke">Revoke API key</button>` : "<span></span>"}<button type="submit" class="primary" ${busy ? "disabled" : ""}>Save</button></footer>
    </form>`;
  }

  private get resolvedTitle(): string {
    return this.#config.title ?? this.getAttribute("title") ?? "AI assistant settings";
  }

  private readonly onClick = (event: Event): void => {
    const action = (event.target as Element | null)?.closest<HTMLElement>("[data-action]")?.dataset["action"];
    if (action === "close") this.close();
    else if (action === "models") void this.loadModels();
    else if (action === "test") void this.testConnection();
    else if (action === "revoke") void this.revoke();
  };

  private readonly onSubmit = (event: Event): void => {
    event.preventDefault();
    void this.save();
  };

  private readonly onChange = (event: Event): void => {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement) || select.name !== "accessMode") return;
    for (const element of this.#root.querySelectorAll<HTMLElement>("[data-access-values]")) {
      element.hidden = element.dataset["accessValues"] !== select.value;
    }
  };

  private form(): HTMLFormElement | null { return this.#root.querySelector("form"); }

  /** Keeps unsaved values across controller status renders. */
  private captureDraft(): void {
    const form = this.form();
    if (!form || !this.#draft) return;
    const data = new FormData(form);
    this.#draft = {
      provider: valueOrDisabled(form, data, "provider", this.#draft.provider),
      apiKey: valueOrDisabled(form, data, "apiKey", this.#draft.apiKey),
      model: valueOrDisabled(form, data, "model", this.#draft.model),
      baseURL: valueOrDisabled(form, data, "baseURL", this.#draft.baseURL),
      accessMode: valueOrDisabled(form, data, "accessMode", this.#draft.accessMode) as AiAppAssistantAccessRule["mode"],
      roleIds: data.has("roleIds") ? data.getAll("roleIds").map(String) : this.#draft.roleIds,
      userIds: data.has("userIds") ? data.getAll("userIds").map(String) : this.#draft.userIds,
      maxRequests: Number(data.get("maxRequests") ?? this.#draft.maxRequests),
      windowHours: Number(data.get("windowHours") ?? this.#draft.windowHours),
      maxConversationTurns: Number(data.get("maxConversationTurns") ?? this.#draft.maxConversationTurns),
      allowModelChangesByOthers: form.elements.namedItem("allowModelChangesByOthers")
        ? data.get("allowModelChangesByOthers") === "on"
        : this.#draft.allowModelChangesByOthers
    };
  }

  private connectionInput() {
    const form = this.form();
    const provider = formValue(form, "provider") as AiAppAssistantProvider;
    const model = formValue(form, "model");
    const apiKey = formValue(form, "apiKey");
    const baseURL = formValue(form, "baseURL");
    // Omitting an empty key lets the backend reuse the protected stored key.
    return { provider, model, ...(apiKey ? { apiKey } : {}), ...(baseURL ? { baseURL } : {}) };
  }

  private async loadModels(): Promise<void> {
    try {
      const { model: _model, ...credentials } = this.connectionInput();
      await this.#controller?.loadModels(credentials);
    } catch { /* Rendered by controller. */ }
  }

  private async testConnection(): Promise<void> {
    try { await this.#controller?.test(this.connectionInput()); } catch { /* Rendered by controller. */ }
  }

  private async save(): Promise<void> {
    const form = this.form();
    if (!form?.reportValidity()) return;
    const data = new FormData(form);
    const connection = this.connectionInput();
    const accessMode = String(data.get("accessMode"));
    const access: AiAppAssistantAccessRule = !this.#snapshot?.optionsAvailable && this.#snapshot?.configuration
      ? this.#snapshot.configuration.access
      : accessMode === "roles"
        ? { mode: "roles", roles: data.getAll("roleIds").map(String) }
        : accessMode === "users"
          ? { mode: "users", userIds: data.getAll("userIds").map(String) }
          : { mode: "all" };
    const input: AiAppAssistantConfigurationInput = {
      ...connection,
      access,
      quota: {
        maxRequests: Number(data.get("maxRequests")),
        windowSeconds: Number(data.get("windowHours")) * 3_600
      },
      maxConversationTurns: Number(data.get("maxConversationTurns")),
      ...(this.#snapshot?.configuration?.canManageModelPolicy
        ? { allowModelChangesByOthers: data.get("allowModelChangesByOthers") === "on" }
        : {})
    };
    // The server reuses a recent successful test and skips provider validation
    // entirely when only access, quotas or conversation limits changed.
    try {
      const saved = await this.#controller?.save(input);
      if (saved) this.dispatchEvent(new CustomEvent("ai-app-assistant-settings-saved", { bubbles: true, composed: true }));
    } catch { /* Rendered by controller. */ }
  }

  private async revoke(): Promise<void> {
    const confirmed = await (this.#config.confirmRevoke?.() ??
      (typeof globalThis.confirm === "function"
        ? globalThis.confirm("Revoke the current API key?")
        : false));
    if (!confirmed) return;
    try {
      await this.#controller?.revokeApiKey();
      this.dispatchEvent(new CustomEvent("ai-app-assistant-key-revoked", { bubbles: true, composed: true }));
    } catch { /* Rendered by controller. */ }
  }

  private applyTheme(): void {
    const theme = this.#config.theme;
    if (!theme) return;
    // Variables on the custom-element host remain visible inside Shadow DOM.
    const properties: Record<keyof AiAppAssistantSettingsTheme, string> = {
      accent: "--ai-accent",
      surface: "--ai-surface",
      surfaceMuted: "--ai-muted",
      text: "--ai-text",
      textMuted: "--ai-text-muted",
      border: "--ai-border",
      danger: "--ai-danger"
    };
    for (const [key, property] of Object.entries(properties) as Array<[keyof AiAppAssistantSettingsTheme, string]>) {
      const value = theme[key];
      if (value) this.style.setProperty(property, value);
    }
  }
}

function draftFrom(configuration: AiAppAssistantManagedConfigurationView): AiAppAssistantSettingsDraft {
  return {
    provider: configuration.provider ?? "",
    apiKey: "",
    model: configuration.model,
    baseURL: configuration.baseURL ?? "",
    accessMode: configuration.access.mode,
    roleIds: configuration.access.mode === "roles" ? [...configuration.access.roles] : [],
    userIds: configuration.access.mode === "users" ? [...configuration.access.userIds] : [],
    maxRequests: configuration.quota?.maxRequests ?? 20,
    windowHours: Math.max(1, Math.round((configuration.quota?.windowSeconds ?? 3_600) / 3_600)),
    maxConversationTurns: configuration.maxConversationTurns,
    allowModelChangesByOthers: configuration.allowModelChangesByOthers
  };
}

function valueOrDisabled(
  form: HTMLFormElement,
  data: FormData,
  name: string,
  fallback: string
): string {
  return form.elements.namedItem(name) && !data.has(name) ? fallback : String(data.get(name) ?? fallback).trim();
}

function formValue(form: HTMLFormElement | null, name: string): string {
  const control = form?.elements.namedItem(name);
  return control && "value" in control ? String(control.value).trim() : "";
}

function includeSelectedChoices(
  choices: Array<{ id: string; label: string }>,
  selected: string[]
): Array<{ id: string; label: string }> {
  const known = new Set(choices.map(({ id }) => id));
  return [...choices, ...selected.filter((id) => !known.has(id)).map((id) => ({ id, label: id }))];
}

function describeAuditChange(change: {
  field: "provider" | "apiKey" | "model" | "access" | "quota" | "conversation" | "modelChangePolicy";
  from?: string | undefined;
  to?: string | undefined;
}): string {
  if (change.field === "provider") return change.from
    ? `Provider: ${change.from} → ${change.to ?? ""}`
    : `Provider set to ${change.to ?? ""}`;
  if (change.field === "model") return change.from
    ? `Model: ${change.from} → ${change.to ?? ""}`
    : `Model set to ${change.to ?? ""}`;
  if (change.field === "apiKey") return change.to === "revoked"
    ? "API key revoked"
    : change.to === "replaced" ? "API key replaced" : "API key added";
  if (change.field === "access") return "Access rules changed";
  if (change.field === "quota") return "Quota changed";
  if (change.field === "conversation") return `Questions per conversation: ${change.from ?? ""} → ${change.to ?? ""}`;
  return change.to === "true"
    ? "Model changes enabled for other administrators"
    : "Model changes restricted to the key owner";
}

declare global {
  interface HTMLElementTagNameMap { "ai-app-assistant-settings": AiAppAssistantSettingsElement; }
}

export function defineAiAppAssistantSettingsElement(tagName = "ai-app-assistant-settings"): typeof AiAppAssistantSettingsElement {
  if (!customElements.get(tagName)) customElements.define(tagName, AiAppAssistantSettingsElement);
  return AiAppAssistantSettingsElement;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;"
  })[character] ?? character);
}

const STYLES = `
  :host{--ai-accent:#14745b;--ai-surface:#fff;--ai-muted:#f5f7f6;--ai-text:#1d2522;--ai-text-muted:#66716c;--ai-border:#d8e0dc;--ai-danger:#a52b2b;font:14px/1.4 system-ui,sans-serif;color:var(--ai-text)}*{box-sizing:border-box}[hidden]{display:none!important}.backdrop{position:fixed;inset:0;z-index:9100;background:#0007}.modal{position:fixed;top:50%;left:50%;z-index:9101;width:min(650px,calc(100vw - 24px));max-height:calc(100vh - 36px);overflow:auto;transform:translate(-50%,-50%);background:var(--ai-surface);border:1px solid var(--ai-border);border-radius:16px;box-shadow:0 24px 80px #0005}.modal>header{position:sticky;top:0;z-index:1;display:flex;align-items:flex-start;justify-content:space-between;padding:18px;background:var(--ai-surface);border-bottom:1px solid var(--ai-border)}h2{margin:0 0 6px;font-size:20px}button,input,select{font:inherit}.modal>header button{font-size:24px;color:var(--ai-text);background:none;border:0;cursor:pointer}.badges{display:flex;gap:6px}.badges b{padding:2px 7px;border-radius:99px;font-size:11px}.manual{color:#6335a6;background:#eee4ff}.auto{color:#176278;background:#ddf4fa}.connected{color:#196c36;background:#daf5e3}.disconnected{color:#9b2f2f;background:#ffe0df}form{padding:18px}fieldset{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:0 0 16px;padding:14px;border:1px solid var(--ai-border);border-radius:12px}legend{padding:0 6px;font-weight:700}label{display:flex;flex-direction:column;gap:5px}input,select{width:100%;min-height:38px;padding:7px 9px;color:var(--ai-text);background:var(--ai-muted);border:1px solid var(--ai-border);border-radius:8px}.check{grid-column:1/-1;flex-direction:row;align-items:center}.check input{width:auto}.row{display:grid;grid-template-columns:1fr 1fr;gap:10px}fieldset button{align-self:end;min-height:38px;color:var(--ai-accent);background:var(--ai-surface);border:1px solid var(--ai-border);border-radius:8px}.test{grid-column:1/-1}.ok{color:#196c36}.ko,.error{color:var(--ai-danger)}.error{margin:14px 18px 0;padding:10px;background:color-mix(in srgb,var(--ai-danger) 10%,var(--ai-surface));border-radius:8px}.loading{padding:30px}.history{max-height:160px;margin:10px 0;overflow:auto}.history li{display:grid;grid-template-columns:1fr auto;gap:2px 10px;padding:7px 0;border-bottom:1px solid var(--ai-border)}.history span{grid-column:1/-1;color:var(--ai-text-muted);font-size:12px}form>footer{display:flex;justify-content:space-between;margin-top:18px}.primary,.danger{padding:9px 14px;border-radius:8px}.primary{color:#fff;background:var(--ai-accent);border:0}.danger{color:var(--ai-danger);background:transparent;border:1px solid color-mix(in srgb,var(--ai-danger) 55%,var(--ai-border))}@media(max-width:580px){fieldset{grid-template-columns:1fr}}@media(prefers-color-scheme:dark){:host{--ai-surface:#1d2321;--ai-muted:#151a18;--ai-text:#edf2ef;--ai-text-muted:#aab5b0;--ai-border:#39443f}}
  .checking{color:var(--ai-text-muted);background:var(--ai-muted)}
`;

if (typeof customElements !== "undefined") defineAiAppAssistantSettingsElement();
