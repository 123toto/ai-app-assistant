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
  /** Overrides the built-in revocation confirmation dialog when provided. */
  confirmRevoke?: () => boolean | Promise<boolean>;
  theme?: Partial<AiAppAssistantSettingsTheme>;
}

export interface AiAppAssistantSettingsTheme {
  accent: string;
  accentContrast: string;
  header: string;
  headerText: string;
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

const ACCESS_MODE_OPTIONS: ReadonlyArray<{
  value: AiAppAssistantAccessRule["mode"];
  label: string;
}> = [
  { value: "all", label: "Everyone" },
  { value: "roles", label: "Selected roles" },
  { value: "users", label: "Selected users" }
];

const MODEL_REFRESH_DEBOUNCE_MS = 250;

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
  #activeModelOption = -1;
  #preserveDraftOnConfigurationRefresh = false;
  #modelRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  #revokeDialogOpen = false;

  public connectedCallback(): void {
    this.setAttribute("data-ai-app-assistant-ui", "");
    this.applyTheme();
    this.#root.addEventListener("click", this.onClick);
    this.#root.addEventListener("submit", this.onSubmit);
    this.#root.addEventListener("change", this.onChange);
    this.#root.addEventListener("input", this.onInput);
    this.#root.addEventListener("focusout", this.onFocusOut);
    this.#root.addEventListener("keydown", this.onKeyDown);
    void this.initialize();
  }

  public disconnectedCallback(): void {
    this.clearScheduledModelRefresh();
    this.#root.removeEventListener("click", this.onClick);
    this.#root.removeEventListener("submit", this.onSubmit);
    this.#root.removeEventListener("change", this.onChange);
    this.#root.removeEventListener("input", this.onInput);
    this.#root.removeEventListener("focusout", this.onFocusOut);
    this.#root.removeEventListener("keydown", this.onKeyDown);
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
  /** Dismisses the modal and restores the last server-confirmed values. */
  public close(): void {
    this.clearScheduledModelRefresh();
    this.#revokeDialogOpen = false;
    // Removing the attribute renders once and captures the current form, so the
    // confirmed snapshot must replace that draft only after the close render.
    this.removeAttribute("open");
    this.#draft = this.#snapshot?.configuration ? draftFrom(this.#snapshot.configuration) : undefined;
  }

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
    this.#revokeDialogOpen = false;
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
      if (configuration?.provider && configuration.connection.status === "connected"
        && provider?.supportsModelDiscovery) {
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
      this.#revokeDialogOpen = false;
      this.#root.innerHTML = `<style>${STYLES}</style>`;
      return;
    }
    const snapshot = this.#snapshot;
    const configuration = snapshot?.configuration;
    if (snapshot && configuration && this.#preserveDraftOnConfigurationRefresh && this.form()) {
      this.#configurationIdentity = configuration;
      this.renderConnectionTestState(snapshot, configuration);
      return;
    }
    if (configuration && configuration !== this.#configurationIdentity) {
      this.#configurationIdentity = configuration;
      if (!this.#preserveDraftOnConfigurationRefresh) this.#draft = draftFrom(configuration);
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
      <section class="modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(this.resolvedTitle)}" ${this.#revokeDialogOpen ? 'inert aria-hidden="true"' : ""}>
        <header><h2>${escapeHtml(this.resolvedTitle)}</h2><div class="header-actions"><span class="badges">${manual ? "<b class=manual>Manual</b>" : configuration?.configured ? "<b class=auto>Auto</b>" : ""}${connectionBadge}</span><button data-action="close" aria-label="Close">×</button></div></header>
        ${snapshot?.error && snapshot.errorScope === "global" ? `<p class="error">${escapeHtml(snapshot.error.message)}</p>` : ""}
        ${configuration ? this.renderForm(snapshot, configuration, busy) : `<div class="loading">Loading…</div>`}
      </section>${this.#revokeDialogOpen ? this.renderRevokeConfirmation() : ""}`;
    this.restoreSensitiveDraft();
    this.refreshConnectionActions();
  }

  /** Updates transient connection-test feedback without recreating password controls. */
  private renderConnectionTestState(
    snapshot: AiAppAssistantSettingsSnapshot,
    configuration: AiAppAssistantManagedConfigurationView
  ): void {
    const busy = !["idle", "ready", "error"].includes(snapshot.status);
    const settingsLocked = !configuration.apiKeyStorageAvailable && !configuration.configured;
    for (const fieldset of this.#root.querySelectorAll<HTMLFieldSetElement>("fieldset")) {
      // Disabling a fieldset can make browsers clear password inputs. Keep the
      // draft controls mounted and usable; action buttons are locked below.
      fieldset.disabled = settingsLocked;
    }
    this.form()?.setAttribute("aria-busy", String(busy));
    const modal = this.#root.querySelector(".modal");
    let error = this.#root.querySelector<HTMLElement>(".modal > .error, .connection-settings > .connection-error, .usage-settings > .usage-error");
    if (snapshot.error) {
      if (!error) {
        error = document.createElement("p");
      }
      const section = snapshot.errorScope === "connection"
        ? this.#root.querySelector<HTMLElement>(".connection-settings")
        : snapshot.errorScope === "usage"
          ? this.#root.querySelector<HTMLElement>(".usage-settings")
          : null;
      error.className = snapshot.errorScope === "connection"
        ? "error connection-error"
        : snapshot.errorScope === "usage"
          ? "error usage-error"
          : "error";
      if (section) section.querySelector("legend")?.insertAdjacentElement("afterend", error);
      else modal?.insertBefore(error, this.form());
      error.textContent = snapshot.error.message;
    } else {
      error?.remove();
    }
    let feedback = this.#root.querySelector<HTMLElement>(".test");
    if (snapshot.connectionTest) {
      if (!feedback) {
        feedback = document.createElement("small");
        this.#root.querySelector("[data-action=test]")?.insertAdjacentElement("afterend", feedback);
      }
      feedback.className = `test ${snapshot.connectionTest.success ? "ok" : "ko"}`;
      if (snapshot.connectionTest.success) {
        feedback.innerHTML = '<span class="test-success-icon" aria-hidden="true">✓</span><span>Connection successful</span>';
      } else {
        feedback.textContent = snapshot.connectionTest.error.message;
      }
    }
    const connectionStatus = configuration.connection.status;
    const connectionBadge = connectionStatus === "disabled"
      ? "<b class=disconnected>Disabled</b>"
      : snapshot.status === "loading" || connectionStatus === "unchecked"
        ? "<b class=checking>Checking…</b>"
        : connectionStatus === "connected"
          ? "<b class=connected>Connected</b>"
          : "<b class=disconnected>Not connected</b>";
    const manual = (["provider", "model", "apiKey", "baseURL"] as const)
      .some((field) => configuration.fieldSources[field] === "override");
    const badges = this.#root.querySelector<HTMLElement>(".badges");
    if (badges) badges.innerHTML = `${manual ? "<b class=manual>Manual</b>" : configuration.configured ? "<b class=auto>Auto</b>" : ""}${connectionBadge}`;
    this.refreshConnectionActions();
  }

  private renderForm(
    snapshot: AiAppAssistantSettingsSnapshot,
    configuration: AiAppAssistantManagedConfigurationView,
    busy: boolean
  ): string {
    const draft = this.#draft ?? draftFrom(configuration);
    const selectedProviderLabel = snapshot.providers.find(({ id }) => id === draft.provider)?.label ?? "Select…";
    const providerOptions = snapshot.providers.map((provider) =>
      `<button type="button" class="dropdown-option ${provider.id === draft.provider ? "active" : ""}" role="option" aria-selected="${provider.id === draft.provider}" data-action="select-provider" data-value="${escapeHtml(provider.id)}">${escapeHtml(provider.label)}</button>`
    ).join("");
    const modelOptions = snapshot.models.map((model, index) => `<button type="button" id="ai-app-assistant-model-option-${index}" class="model-option" role="option" data-action="select-model" data-value="${escapeHtml(model.id)}">${escapeHtml(model.label ?? model.id)}</button>`).join("");
    const selectedAccessLabel = ACCESS_MODE_OPTIONS.find(({ value }) => value === draft.accessMode)?.label ?? "Everyone";
    const accessModeOptions = ACCESS_MODE_OPTIONS.map(({ value, label }) =>
      `<button type="button" class="dropdown-option ${value === draft.accessMode ? "active" : ""}" role="option" aria-selected="${value === draft.accessMode}" data-action="select-access" data-value="${value}">${label}</button>`
    ).join("");
    const secureStorageAvailable = configuration.apiKeyStorageAvailable;
    const settingsLocked = !secureStorageAvailable && !configuration.configured;
    const defaultConnectionOnly = !secureStorageAvailable && configuration.configured;
    const storageOnly = secureStorageAvailable && !configuration.configured;
    const credentialsDisabled = !configuration.canManageCredentials || !secureStorageAvailable;
    const modelDisabled = !configuration.canChangeModel;
    const formDisabled = busy || settingsLocked;
    const actions = connectionActions(snapshot, configuration, draft, busy);
    const setupState = settingsLocked ? "missing-all" : defaultConnectionOnly ? "default-only" : storageOnly ? "storage-only" : "ready";
    const setupNotice = settingsLocked
      ? '<p class="setup-notice warning" role="alert">A secure encryption key and a default connection are missing. The assistant settings are unavailable until an administrator completes the setup.</p>'
      : defaultConnectionOnly
        ? '<p class="setup-notice info">The default connection is active. A secure encryption key is required only to add or replace the API key from this screen.</p>'
        : storageOnly
          ? '<p class="setup-notice warning" role="alert">Secure storage is ready, but no connection is configured. Configure a connection to activate the assistant.</p>'
          : "";
    const connectionError = snapshot.error && snapshot.errorScope === "connection"
      ? `<p class="error connection-error">${escapeHtml(snapshot.error.message)}</p>`
      : "";
    const usageError = snapshot.error && snapshot.errorScope === "usage"
      ? `<p class="error usage-error">${escapeHtml(snapshot.error.message)}</p>`
      : "";
    const roleOptions = includeSelectedChoices(snapshot.options.roles, draft.roleIds);
    const userOptions = includeSelectedChoices(snapshot.options.users, draft.userIds);
    const history = configuration.administration?.history.slice().reverse().map((entry) =>
      `<li><strong>${escapeHtml(entry.actor.label)}</strong><time>${escapeHtml(new Date(entry.changedAt).toLocaleString())}</time><span>${entry.changes.map(describeAuditChange).map(escapeHtml).join(" · ")}</span></li>`
    ).join("") ?? "";
    return `<form class="${settingsLocked ? "settings-locked" : ""}" aria-disabled="${settingsLocked}" data-setup-state="${setupState}" novalidate>
      <fieldset class="connection-settings" ${formDisabled ? "disabled" : ""}><legend>Connection</legend>
        ${setupNotice}
        ${connectionError}
        <div class="field" data-validation-field="provider"><span class="field-label">Provider</span><div class="simple-dropdown" data-dropdown="provider"><input class="dropdown-value" name="provider" value="${escapeHtml(draft.provider)}" aria-hidden="true" tabindex="-1" ${credentialsDisabled ? "disabled" : ""}><button type="button" class="dropdown-trigger" data-action="toggle-provider" aria-haspopup="listbox" aria-expanded="false" aria-controls="ai-app-assistant-provider-options" ${credentialsDisabled ? "disabled" : ""}><span data-dropdown-label>${escapeHtml(selectedProviderLabel)}</span><span class="dropdown-chevron" aria-hidden="true">⌄</span></button><div id="ai-app-assistant-provider-options" class="dropdown-options" role="listbox" hidden>${providerOptions}</div></div></div>
        <label data-validation-field="apiKey">API key<input name="apiKey" type="password" autocomplete="new-password" placeholder="${configuration.apiKeyConfigured ? "Already provided — enter a new key to replace it" : "Enter API key"}" ${credentialsDisabled ? "disabled" : ""}></label>
        <div class="field" data-validation-field="model"><span id="ai-app-assistant-model-label" class="field-label">Model</span><div class="model-control"><div class="model-combobox"><input name="model" value="${escapeHtml(draft.model)}" autocomplete="off" role="combobox" aria-labelledby="ai-app-assistant-model-label" aria-autocomplete="list" aria-expanded="false" aria-controls="ai-app-assistant-model-options" ${modelDisabled ? "disabled" : ""}><div id="ai-app-assistant-model-options" class="model-options" role="listbox" hidden>${modelOptions}<div class="model-empty" hidden>No matching models</div></div></div><button type="button" class="model-refresh" data-action="models" aria-label="Refresh models" ${actions.canLoadModels ? "" : "disabled"} ${actions.loadModelsHint ? `title="${escapeHtml(actions.loadModelsHint)}"` : ""}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M21 12a9 9 0 0 0-15.2-6.5L3 8"></path><path d="M3 3v5h5"></path><path d="M3 12a9 9 0 0 0 15.2 6.5L21 16"></path><path d="M16 16h5v5"></path></svg></button></div></div>
        <label>Base URL (optional)<input name="baseURL" type="url" value="${escapeHtml(draft.baseURL)}" placeholder="https://…" ${credentialsDisabled ? "disabled" : ""}></label>
        <div class="connection-actions"><button type="button" data-action="test" ${actions.canTestConnection ? "" : "disabled"} ${actions.testConnectionHint ? `title="${escapeHtml(actions.testConnectionHint)}"` : ""}>Test connection</button>${snapshot.connectionTest ? `<small class="test ${snapshot.connectionTest.success ? "ok" : "ko"}">${snapshot.connectionTest.success ? '<span class="test-success-icon" aria-hidden="true">✓</span><span>Connection successful</span>' : escapeHtml(snapshot.connectionTest.error.message)}</small>` : ""}</div>
      </fieldset>
      <fieldset class="usage-settings" ${formDisabled ? "disabled" : ""}><legend>Usage</legend>
        ${usageError}
        <div class="field"><span class="field-label">Who can use it?</span><div class="simple-dropdown" data-dropdown="access"><input type="hidden" name="accessMode" value="${draft.accessMode}"><button type="button" class="dropdown-trigger" data-action="toggle-access" aria-haspopup="listbox" aria-expanded="false" aria-controls="ai-app-assistant-access-options" ${snapshot.optionsAvailable ? "" : "disabled"}><span data-dropdown-label>${selectedAccessLabel}</span><span class="dropdown-chevron" aria-hidden="true">⌄</span></button><div id="ai-app-assistant-access-options" class="dropdown-options" role="listbox" hidden>${accessModeOptions}</div></div></div>
        <label data-access-values="roles" ${draft.accessMode === "roles" ? "" : "hidden"}>Allowed roles<select name="roleIds" multiple ${snapshot.optionsAvailable ? "" : "disabled"} ${snapshot.optionsAvailable && draft.accessMode === "roles" ? "required" : ""}>${roleOptions.map((choice) => `<option value="${escapeHtml(choice.id)}" ${draft.roleIds.includes(choice.id) ? "selected" : ""}>${escapeHtml(choice.label)}</option>`).join("")}</select></label>
        <label data-access-values="users" ${draft.accessMode === "users" ? "" : "hidden"}>Allowed users<select name="userIds" multiple ${snapshot.optionsAvailable ? "" : "disabled"} ${snapshot.optionsAvailable && draft.accessMode === "users" ? "required" : ""}>${userOptions.map((choice) => `<option value="${escapeHtml(choice.id)}" ${draft.userIds.includes(choice.id) ? "selected" : ""}>${escapeHtml(choice.label)}</option>`).join("")}</select></label>
        ${snapshot.optionsAvailable ? "" : "<small class=hint>Access rules are managed by the host application.</small>"}
        <div class="row"><label>Questions / period<input name="maxRequests" type="number" min="1" max="10000" value="${draft.maxRequests}" required></label><label>Period (hours)<input name="windowHours" type="number" min="1" max="8760" value="${draft.windowHours}" required></label></div>
        <label>Questions / conversation<input name="maxConversationTurns" type="number" min="1" max="10" value="${draft.maxConversationTurns}" required></label>
        ${configuration.canManageModelPolicy ? `<label class="check"><input name="allowModelChangesByOthers" type="checkbox" ${draft.allowModelChangesByOthers ? "checked" : ""}>Allow other administrators to change the model</label>` : ""}
      </fieldset>
      ${history ? `<details><summary>Change history</summary><ol class="history">${history}</ol></details>` : ""}
      <footer><div>${configuration.canRevokeApiKey ? `<button type="button" class="danger" data-action="revoke" ${settingsLocked ? "disabled" : ""}>Revoke API key</button>` : ""}</div><div class="footer-actions"><button type="button" class="secondary" data-action="close">Cancel</button><button type="submit" class="primary" disabled>Save</button></div></footer>
    </form>`;
  }

  private renderRevokeConfirmation(): string {
    return `<div class="confirmation-backdrop" data-action="cancel-revoke"></div>
      <section class="confirmation-modal" role="alertdialog" aria-modal="true" aria-labelledby="ai-app-assistant-revoke-title" aria-describedby="ai-app-assistant-revoke-description">
        <div class="confirmation-icon" aria-hidden="true">!</div>
        <h3 id="ai-app-assistant-revoke-title">Revoke API key?</h3>
        <p id="ai-app-assistant-revoke-description">The stored API key will be permanently removed. The assistant may stop working until a new key is configured.</p>
        <div class="confirmation-actions"><button type="button" class="secondary" data-action="cancel-revoke">Cancel</button><button type="button" class="danger" data-action="confirm-revoke">Revoke API key</button></div>
      </section>`;
  }

  private get resolvedTitle(): string {
    return this.#config.title ?? this.getAttribute("title") ?? "AI assistant settings";
  }

  private readonly onClick = (event: Event): void => {
    const target = event.target as Element | null;
    const actionElement = target?.closest<HTMLElement>("[data-action]");
    const action = actionElement?.dataset["action"];
    if (action === "select-model") {
      this.closeSimpleDropdowns();
      this.selectModel(actionElement?.dataset["value"] ?? "");
      return;
    }
    if (action === "toggle-provider" || action === "toggle-access") {
      const name = action === "toggle-provider" ? "provider" : "access";
      this.closeModelOptions();
      this.toggleSimpleDropdown(name);
      return;
    }
    if (action === "select-provider") {
      this.selectProvider(actionElement?.dataset["value"] ?? "");
      return;
    }
    if (action === "select-access") {
      this.selectAccessMode(actionElement?.dataset["value"] ?? "");
      return;
    }
    if (action === "revoke") {
      void this.requestRevoke();
      return;
    }
    if (action === "cancel-revoke") {
      this.closeRevokeConfirmation();
      return;
    }
    if (action === "confirm-revoke") {
      void this.confirmRevoke();
      return;
    }
    const modelInput = target instanceof HTMLInputElement && target.name === "model" ? target : null;
    if (modelInput) this.updateModelOptions(true, "");
    else if (!target?.closest(".model-combobox")) this.closeModelOptions();
    if (!target?.closest(".simple-dropdown")) this.closeSimpleDropdowns();
    if (action === "close") this.close();
    else if (action === "models") void this.loadModels();
    else if (action === "test") void this.testConnection();
  };

  private readonly onSubmit = (event: Event): void => {
    event.preventDefault();
    void this.save();
  };

  private readonly onChange = (): void => {
    this.refreshConnectionActions();
  };

  private readonly onInput = (event: Event): void => {
    const input = event.target;
    if (input instanceof HTMLInputElement && input.name === "model") {
      this.updateModelOptions(true, input.value);
    }
    this.refreshConnectionActions();
    if (input instanceof HTMLInputElement && input.name === "apiKey") {
      this.scheduleModelRefresh();
    }
  };

  private readonly onFocusOut = (event: Event): void => {
    const focusEvent = event as FocusEvent;
    const combobox = (event.target as Element | null)?.closest(".model-combobox");
    if (combobox && (!(focusEvent.relatedTarget instanceof Node) || !combobox.contains(focusEvent.relatedTarget))) {
      this.closeModelOptions();
    }
    const dropdown = (event.target as Element | null)?.closest<HTMLElement>(".simple-dropdown");
    if (dropdown && (!(focusEvent.relatedTarget instanceof Node) || !dropdown.contains(focusEvent.relatedTarget))) {
      this.closeSimpleDropdown(dropdown.dataset["dropdown"] ?? "");
    }
  };

  private readonly onKeyDown = (event: Event): void => {
    const keyboardEvent = event as KeyboardEvent;
    if (this.#revokeDialogOpen && keyboardEvent.key === "Escape") {
      this.closeRevokeConfirmation();
      keyboardEvent.preventDefault();
      keyboardEvent.stopPropagation();
      return;
    }
    if (this.#revokeDialogOpen && keyboardEvent.key === "Tab") {
      const buttons = [...this.#root.querySelectorAll<HTMLButtonElement>(".confirmation-modal button")];
      const current = buttons.indexOf(this.#root.activeElement as HTMLButtonElement);
      const next = keyboardEvent.shiftKey
        ? (current <= 0 ? buttons.length - 1 : current - 1)
        : (current < 0 || current === buttons.length - 1 ? 0 : current + 1);
      buttons[next]?.focus();
      keyboardEvent.preventDefault();
      return;
    }
    const input = event.target;
    if (input instanceof Element && this.handleSimpleDropdownKeyDown(keyboardEvent, input)) return;
    if (!(input instanceof HTMLInputElement) || input.name !== "model") return;
    if (keyboardEvent.key === "Escape") {
      this.closeModelOptions();
      keyboardEvent.preventDefault();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Enter"].includes(keyboardEvent.key)) return;
    const options = this.visibleModelOptions();
    if (keyboardEvent.key === "Enter") {
      const selected = options[this.#activeModelOption];
      if (selected) this.selectModel(selected.dataset["value"] ?? "");
      keyboardEvent.preventDefault();
      return;
    }
    if (this.modelOptionsList()?.hidden) this.updateModelOptions(true, input.value);
    const visible = this.visibleModelOptions();
    if (!visible.length) return;
    const direction = keyboardEvent.key === "ArrowDown" ? 1 : -1;
    this.#activeModelOption = (this.#activeModelOption + direction + visible.length) % visible.length;
    this.highlightActiveModelOption(visible);
    event.preventDefault();
  };

  private handleSimpleDropdownKeyDown(event: KeyboardEvent, target: Element): boolean {
    const dropdown = target.closest<HTMLElement>(".simple-dropdown");
    const name = dropdown?.dataset["dropdown"];
    if (!dropdown || !name) return false;
    if (event.key === "Escape") {
      this.closeSimpleDropdown(name);
      this.simpleDropdownTrigger(name)?.focus();
      event.preventDefault();
      return true;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return false;
    const options = [...dropdown.querySelectorAll<HTMLButtonElement>(".dropdown-option")];
    if (!options.length) return true;
    this.openSimpleDropdown(name);
    const focusedIndex = options.indexOf(target as HTMLButtonElement);
    const selectedIndex = options.findIndex((option) => option.getAttribute("aria-selected") === "true");
    const currentIndex = focusedIndex >= 0 ? focusedIndex : selectedIndex;
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? options.length - 1
        : event.key === "ArrowDown"
          ? (currentIndex + 1 + options.length) % options.length
          : (currentIndex - 1 + options.length) % options.length;
    options[nextIndex]?.focus();
    event.preventDefault();
    return true;
  }

  private modelOptionsList(): HTMLElement | null {
    return this.#root.querySelector(".model-options");
  }

  private visibleModelOptions(): HTMLButtonElement[] {
    return [...this.#root.querySelectorAll<HTMLButtonElement>(".model-option:not([hidden])")];
  }

  private updateModelOptions(show: boolean, query: string): void {
    const list = this.modelOptionsList();
    const input = this.#root.querySelector<HTMLInputElement>("[name=model]");
    if (!list || !input) return;
    const normalizedQuery = normalizeModelSearch(query);
    let visibleCount = 0;
    for (const option of this.#root.querySelectorAll<HTMLButtonElement>(".model-option")) {
      const matches = fuzzySubsequenceMatch(option.dataset["value"] ?? "", normalizedQuery)
        || fuzzySubsequenceMatch(option.textContent ?? "", normalizedQuery);
      option.hidden = !matches;
      option.classList.remove("active");
      option.setAttribute("aria-selected", "false");
      if (matches) visibleCount += 1;
    }
    const empty = list.querySelector<HTMLElement>(".model-empty");
    if (empty) empty.hidden = visibleCount > 0;
    list.hidden = !show || !this.#snapshot?.models.length;
    input.setAttribute("aria-expanded", String(!list.hidden));
    input.removeAttribute("aria-activedescendant");
    this.#activeModelOption = -1;
  }

  private closeModelOptions(): void {
    const list = this.modelOptionsList();
    const input = this.#root.querySelector<HTMLInputElement>("[name=model]");
    if (list) list.hidden = true;
    input?.setAttribute("aria-expanded", "false");
    input?.removeAttribute("aria-activedescendant");
    this.#activeModelOption = -1;
  }

  private selectModel(value: string): void {
    const input = this.#root.querySelector<HTMLInputElement>("[name=model]");
    if (!input || !value) return;
    input.value = value;
    this.closeModelOptions();
    input.focus();
    this.refreshConnectionActions();
  }

  private highlightActiveModelOption(options: HTMLButtonElement[]): void {
    options.forEach((option, index) => {
      const active = index === this.#activeModelOption;
      option.classList.toggle("active", active);
      option.setAttribute("aria-selected", String(active));
    });
    const active = options[this.#activeModelOption];
    const input = this.#root.querySelector<HTMLInputElement>("[name=model]");
    if (active) {
      input?.setAttribute("aria-activedescendant", active.id);
      active.scrollIntoView?.({ block: "nearest" });
    }
  }

  private simpleDropdown(name: string): HTMLElement | null {
    return this.#root.querySelector(`.simple-dropdown[data-dropdown="${name}"]`);
  }

  private simpleDropdownTrigger(name: string): HTMLButtonElement | null {
    return this.simpleDropdown(name)?.querySelector(".dropdown-trigger") ?? null;
  }

  private openSimpleDropdown(name: string): void {
    const dropdown = this.simpleDropdown(name);
    const trigger = this.simpleDropdownTrigger(name);
    const list = dropdown?.querySelector<HTMLElement>(".dropdown-options");
    if (!list || !trigger || trigger.disabled) return;
    this.closeSimpleDropdowns(name);
    list.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
  }

  private toggleSimpleDropdown(name: string): void {
    const list = this.simpleDropdown(name)?.querySelector<HTMLElement>(".dropdown-options");
    if (!list) return;
    if (list.hidden) this.openSimpleDropdown(name);
    else this.closeSimpleDropdown(name);
  }

  private closeSimpleDropdown(name: string): void {
    const dropdown = this.simpleDropdown(name);
    const list = dropdown?.querySelector<HTMLElement>(".dropdown-options");
    if (list) list.hidden = true;
    dropdown?.querySelector(".dropdown-trigger")?.setAttribute("aria-expanded", "false");
  }

  private closeSimpleDropdowns(except = ""): void {
    for (const dropdown of this.#root.querySelectorAll<HTMLElement>(".simple-dropdown")) {
      const name = dropdown.dataset["dropdown"] ?? "";
      if (name !== except) this.closeSimpleDropdown(name);
    }
  }

  private updateSimpleDropdown(name: string, value: string, label: string): void {
    const dropdown = this.simpleDropdown(name);
    const input = dropdown?.querySelector<HTMLInputElement>("[name]");
    const trigger = this.simpleDropdownTrigger(name);
    if (!dropdown || !input || !trigger) return;
    input.value = value;
    const labelElement = trigger.querySelector<HTMLElement>("[data-dropdown-label]");
    if (labelElement) labelElement.textContent = label;
    for (const option of dropdown.querySelectorAll<HTMLButtonElement>(".dropdown-option")) {
      const selected = option.dataset["value"] === value;
      option.classList.toggle("active", selected);
      option.setAttribute("aria-selected", String(selected));
    }
    this.closeSimpleDropdown(name);
    trigger.focus();
  }

  private selectProvider(value: string): void {
    const provider = this.#snapshot?.providers.find(({ id }) => id === value);
    if (!provider) return;
    this.updateSimpleDropdown("provider", provider.id, provider.label);
    this.refreshConnectionActions();
    this.scheduleModelRefresh();
  }

  private selectAccessMode(value: string): void {
    const accessMode = ACCESS_MODE_OPTIONS.find((option) => option.value === value);
    if (!accessMode) return;
    this.updateSimpleDropdown("access", accessMode.value, accessMode.label);
    for (const element of this.#root.querySelectorAll<HTMLElement>("[data-access-values]")) {
      const selected = element.dataset["accessValues"] === accessMode.value;
      element.hidden = !selected;
      const control = element.querySelector<HTMLSelectElement>("select");
      if (control) control.required = selected && Boolean(this.#snapshot?.optionsAvailable);
    }
    this.refreshConnectionActions();
  }

  private form(): HTMLFormElement | null { return this.#root.querySelector("form"); }

  /** Restores the secret as an input property without serializing it into Shadow DOM markup. */
  private restoreSensitiveDraft(): void {
    const apiKey = this.#root.querySelector<HTMLInputElement>('[name="apiKey"]');
    if (apiKey && this.#draft?.apiKey) apiKey.value = this.#draft.apiKey;
  }

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
    this.clearScheduledModelRefresh();
    if (!this.currentConnectionActions().canLoadModels) return;
    try {
      const { model: _model, ...credentials } = this.connectionInput();
      await this.#controller?.loadModels(credentials);
    } catch { /* Rendered by controller. */ }
  }

  private scheduleModelRefresh(): void {
    this.clearScheduledModelRefresh();
    if (!this.currentConnectionActions().canLoadModels) return;
    this.#modelRefreshTimer = setTimeout(() => {
      this.#modelRefreshTimer = undefined;
      void this.loadModels();
    }, MODEL_REFRESH_DEBOUNCE_MS);
  }

  private clearScheduledModelRefresh(): void {
    if (this.#modelRefreshTimer === undefined) return;
    clearTimeout(this.#modelRefreshTimer);
    this.#modelRefreshTimer = undefined;
  }

  private async testConnection(): Promise<void> {
    if (!this.currentConnectionActions().canTestConnection) return;
    this.captureDraft();
    this.#preserveDraftOnConfigurationRefresh = true;
    try { await this.#controller?.test(this.connectionInput()); } catch { /* Rendered by controller. */ }
    finally { this.#preserveDraftOnConfigurationRefresh = false; }
  }

  private currentConnectionActions(): ReturnType<typeof connectionActions> {
    const snapshot = this.#snapshot;
    const configuration = snapshot?.configuration;
    const form = this.form();
    if (!snapshot || !configuration || !form || !this.#draft) return unavailableConnectionActions();
    const draft = {
      ...this.#draft,
      provider: formValue(form, "provider"),
      apiKey: formValue(form, "apiKey"),
      model: formValue(form, "model"),
      baseURL: formValue(form, "baseURL")
    };
    const busy = !["idle", "ready", "error"].includes(snapshot.status);
    return connectionActions(snapshot, configuration, draft, busy);
  }

  private refreshConnectionActions(): void {
    const actions = this.currentConnectionActions();
    const loadModels = this.#root.querySelector<HTMLButtonElement>("[data-action=models]");
    const testConnection = this.#root.querySelector<HTMLButtonElement>("[data-action=test]");
    if (loadModels) {
      loadModels.disabled = !actions.canLoadModels;
      loadModels.title = actions.loadModelsHint;
    }
    if (testConnection) {
      testConnection.disabled = !actions.canTestConnection;
      testConnection.title = actions.testConnectionHint;
    }
    this.refreshFormValidity();
  }

  private refreshFormValidity(): boolean {
    const form = this.form();
    const snapshot = this.#snapshot;
    const configuration = snapshot?.configuration;
    if (!form || !snapshot || !configuration) return false;
    const connection = connectionFieldValidity(snapshot, configuration, {
      provider: formValue(form, "provider"),
      apiKey: formValue(form, "apiKey"),
      model: formValue(form, "model")
    });
    for (const name of ["provider", "apiKey", "model"] as const) {
      const field = this.#root.querySelector<HTMLElement>(`[data-validation-field="${name}"]`);
      const invalid = connection.invalidFields.has(name);
      field?.classList.toggle("validation-invalid", invalid);
      const control = name === "provider"
        ? field?.querySelector<HTMLButtonElement>(".dropdown-trigger")
        : field?.querySelector<HTMLInputElement>(`[name="${name}"]`);
      control?.setAttribute("aria-invalid", String(invalid));
    }
    let nativeFieldsValid = true;
    for (const control of form.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input,select")) {
      if (["provider", "apiKey", "model"].includes(control.name) || control.disabled) continue;
      const valid = control.validity.valid;
      nativeFieldsValid = nativeFieldsValid && valid;
      control.closest("label")?.classList.toggle("validation-invalid", !valid);
      control.setAttribute("aria-invalid", String(!valid));
    }
    const busy = !["idle", "ready", "error"].includes(snapshot.status);
    const settingsLocked = !configuration.apiKeyStorageAvailable && !configuration.configured;
    const valid = connection.valid && nativeFieldsValid && !busy && !settingsLocked;
    const save = this.#root.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (save) save.disabled = !valid;
    return valid;
  }

  private async save(): Promise<void> {
    const form = this.form();
    if (!form || !this.refreshFormValidity()) return;
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

  private async requestRevoke(): Promise<void> {
    if (this.#config.confirmRevoke) {
      if (await this.#config.confirmRevoke()) await this.performRevoke();
      return;
    }
    this.#revokeDialogOpen = true;
    this.render();
    this.#root.querySelector<HTMLButtonElement>('button[data-action="cancel-revoke"]')?.focus();
  }

  private closeRevokeConfirmation(): void {
    if (!this.#revokeDialogOpen) return;
    this.#revokeDialogOpen = false;
    this.render();
    this.#root.querySelector<HTMLButtonElement>('[data-action="revoke"]')?.focus();
  }

  private async confirmRevoke(): Promise<void> {
    if (!this.#revokeDialogOpen) return;
    this.#revokeDialogOpen = false;
    this.render();
    await this.performRevoke();
  }

  private async performRevoke(): Promise<void> {
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
      accentContrast: "--ai-accent-contrast",
      header: "--ai-header",
      headerText: "--ai-header-text",
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

function connectionActions(
  snapshot: AiAppAssistantSettingsSnapshot,
  configuration: AiAppAssistantManagedConfigurationView,
  draft: Pick<AiAppAssistantSettingsDraft, "provider" | "apiKey" | "model">,
  busy: boolean
): {
  canLoadModels: boolean;
  canTestConnection: boolean;
  loadModelsHint: string;
  testConnectionHint: string;
} {
  if (busy || (!configuration.apiKeyStorageAvailable && !configuration.configured)) {
    return unavailableConnectionActions();
  }
  const provider = snapshot.providers.find((candidate) => candidate.id === draft.provider);
  if (!provider) {
    return {
      canLoadModels: false,
      canTestConnection: false,
      loadModelsHint: "Select a provider first",
      testConnectionHint: "Select a provider first"
    };
  }
  const reusesConfiguredKey = configuration.apiKeyConfigured && configuration.provider === provider.id;
  const hasCredentials = !provider.requiresApiKey || Boolean(draft.apiKey.trim()) || reusesConfiguredKey;
  if (!hasCredentials) {
    return {
      canLoadModels: false,
      canTestConnection: false,
      loadModelsHint: "Enter an API key first",
      testConnectionHint: "Enter an API key first"
    };
  }
  const discoveryAvailable = provider.supportsModelDiscovery && configuration.canChangeModel;
  const canLoadModels = discoveryAvailable;
  return {
    canLoadModels,
    canTestConnection: Boolean(draft.model.trim()),
    loadModelsHint: canLoadModels ? "" : provider.supportsModelDiscovery
        ? "You cannot change the model"
        : "Model discovery is not available for this provider",
    testConnectionHint: draft.model.trim() ? "" : "Enter or select a model first"
  };
}

function connectionFieldValidity(
  snapshot: AiAppAssistantSettingsSnapshot,
  configuration: AiAppAssistantManagedConfigurationView,
  draft: Pick<AiAppAssistantSettingsDraft, "provider" | "apiKey" | "model">
): { valid: boolean; invalidFields: Set<"provider" | "apiKey" | "model"> } {
  const invalidFields = new Set<"provider" | "apiKey" | "model">();
  const provider = snapshot.providers.find((candidate) => candidate.id === draft.provider);
  if (!provider) invalidFields.add("provider");
  if (!draft.model.trim()) invalidFields.add("model");
  if (provider?.requiresApiKey) {
    const reusesConfiguredKey = configuration.apiKeyConfigured && configuration.provider === provider.id;
    if (!draft.apiKey.trim() && !reusesConfiguredKey) invalidFields.add("apiKey");
  }
  return { valid: invalidFields.size === 0, invalidFields };
}

function unavailableConnectionActions() {
  return {
    canLoadModels: false,
    canTestConnection: false,
    loadModelsHint: "Complete the required connection settings first",
    testConnectionHint: "Complete the required connection settings first"
  };
}

function normalizeModelSearch(value: string): string {
  return value.normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/\p{M}/gu, "")
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

function fuzzySubsequenceMatch(value: string, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  const candidate = normalizeModelSearch(value);
  let queryIndex = 0;
  for (const character of candidate) {
    if (character === normalizedQuery[queryIndex]) queryIndex += 1;
    if (queryIndex === normalizedQuery.length) return true;
  }
  return false;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;"
  })[character] ?? character);
}

const STYLES = `
  :host{--ai-accent:#14745b;--ai-surface:#fff;--ai-muted:#f5f7f6;--ai-text:#1d2522;--ai-text-muted:#66716c;--ai-border:#d8e0dc;--ai-danger:#a52b2b;font:14px/1.4 system-ui,sans-serif;color:var(--ai-text)}*{box-sizing:border-box}[hidden]{display:none!important}.backdrop{position:fixed;inset:0;z-index:9100;background:#0007}.modal{position:fixed;top:50%;left:50%;z-index:9101;width:min(720px,calc(100vw - 24px));max-height:calc(100vh - 36px);overflow:auto;transform:translate(-50%,-50%);background:var(--ai-surface);border:1px solid var(--ai-border);border-radius:16px;box-shadow:0 24px 80px #0005}.modal>header{position:sticky;top:0;z-index:1;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px;background:var(--ai-surface);border-bottom:1px solid var(--ai-border)}h2{margin:0;font-size:20px}.header-actions{display:flex;align-items:center;gap:12px}button,input,select{font:inherit}.modal>header button{font-size:24px;color:var(--ai-text);background:none;border:0;cursor:pointer}.badges{display:flex;gap:6px}.badges b{padding:2px 7px;border-radius:99px;font-size:11px}.manual{color:#6335a6;background:#eee4ff}.auto{color:#176278;background:#ddf4fa}.connected{color:#196c36;background:#daf5e3}.disconnected{color:#9b2f2f;background:#ffe0df}form{padding:18px}fieldset{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:0 0 16px;padding:14px;border:1px solid var(--ai-border);border-radius:12px}legend{padding:0 6px;font-weight:700}label{display:flex;flex-direction:column;gap:5px}input,select{width:100%;min-height:38px;padding:7px 9px;color:var(--ai-text);background:var(--ai-muted);border:1px solid var(--ai-border);border-radius:8px}.check{grid-column:1/-1;flex-direction:row;align-items:center}.check input{width:auto}.row{display:grid;grid-template-columns:1fr 1fr;gap:10px}fieldset button{align-self:end;min-height:38px;color:var(--ai-accent);background:var(--ai-surface);border:1px solid var(--ai-border);border-radius:8px}.model-control{display:flex;align-items:flex-start;gap:8px}.model-combobox{position:relative;flex:1;min-width:0}.model-refresh{display:grid;flex:0 0 38px;width:38px;padding:0;color:var(--ai-text);font-weight:600;background:color-mix(in srgb,var(--ai-accent) 6%,var(--ai-surface));border-color:color-mix(in srgb,var(--ai-accent) 42%,var(--ai-border));place-items:center;cursor:pointer}.model-refresh svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.connection-actions{grid-column:1/-1;display:flex;justify-content:flex-end}.connection-actions>button{min-width:180px;padding:7px 14px;color:var(--ai-text);font-weight:600;background:color-mix(in srgb,var(--ai-accent) 6%,var(--ai-surface));border-color:color-mix(in srgb,var(--ai-accent) 42%,var(--ai-border))}.model-options{position:absolute;z-index:4;top:calc(100% + 5px);left:0;right:0;max-height:220px;padding:6px;overflow-y:auto;color:var(--ai-text);background:var(--ai-surface);border:1px solid var(--ai-border);border-radius:12px;box-shadow:0 12px 30px #0003}.model-options .model-option{display:block;width:100%;min-height:34px;padding:7px 9px;color:var(--ai-text);background:transparent;border:0;border-radius:8px;text-align:left;cursor:pointer}.model-options .model-option:hover,.model-options .model-option.active{color:var(--ai-text);background:var(--ai-muted)}.model-empty{padding:9px;color:var(--ai-text-muted);font-size:12px;text-align:center}.test{grid-column:1/-1}.ok{color:#196c36}.ko,.error{color:var(--ai-danger)}.error{margin:14px 18px 0;padding:10px;background:color-mix(in srgb,var(--ai-danger) 10%,var(--ai-surface));border-radius:8px}.loading{padding:30px}.history{max-height:160px;margin:10px 0;overflow:auto}.history li{display:grid;grid-template-columns:1fr auto;gap:2px 10px;padding:7px 0;border-bottom:1px solid var(--ai-border)}.history span{grid-column:1/-1;color:var(--ai-text-muted);font-size:12px}form>footer{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:18px}.footer-actions{display:flex;gap:8px}.primary,.secondary,.danger{padding:9px 14px;border-radius:8px}.primary{color:#fff;background:var(--ai-accent);border:0}.secondary{color:var(--ai-text);background:var(--ai-surface);border:1px solid var(--ai-border)}.danger{color:var(--ai-danger);background:transparent;border:1px solid color-mix(in srgb,var(--ai-danger) 55%,var(--ai-border))}button:disabled{opacity:.42;cursor:not-allowed;filter:saturate(.2);box-shadow:none}fieldset button:disabled{color:var(--ai-text-muted);font-weight:400;background:var(--ai-muted);border-color:var(--ai-border)}@media(max-width:580px){fieldset{grid-template-columns:1fr}.connection-actions{grid-column:1}.connection-actions>button{width:100%}}@media(prefers-color-scheme:dark){:host{--ai-surface:#1d2321;--ai-muted:#151a18;--ai-text:#edf2ef;--ai-text-muted:#aab5b0;--ai-border:#39443f}}
  .setup-notice{grid-column:1/-1;margin:0;padding:11px 12px;color:var(--ai-text);border-radius:9px}.setup-notice.warning{background:color-mix(in srgb,#e0a000 14%,var(--ai-surface));border:1px solid color-mix(in srgb,#e0a000 45%,var(--ai-border))}.setup-notice.info{background:color-mix(in srgb,var(--ai-accent) 10%,var(--ai-surface));border:1px solid color-mix(in srgb,var(--ai-accent) 35%,var(--ai-border))}.connection-error,.usage-error{grid-column:1/-1;margin:0}.settings-locked fieldset,.settings-locked footer{opacity:.55}
  .connection-actions{align-items:center;justify-content:space-between;gap:16px}.test{display:inline-flex;align-items:center;justify-content:flex-end;gap:8px}.test-success-icon{display:inline-grid;width:22px;height:22px;color:#fff;font-size:14px;font-weight:700;background:#198754;border-radius:50%;place-items:center}@media(max-width:580px){.connection-actions{align-items:stretch;flex-direction:column}.test{justify-content:flex-start}}
  .checking{color:var(--ai-text-muted);background:var(--ai-muted)}
  :host{--ai-accent-contrast:#fff;--ai-header:linear-gradient(135deg,var(--ai-accent),color-mix(in srgb,var(--ai-accent) 70%,#000));--ai-header-text:var(--ai-accent-contrast)}
  .modal{border:0}
  .modal>header{color:var(--ai-header-text);background:var(--ai-header);border-bottom-color:transparent}.modal>header button{color:inherit}
  .field{display:flex;flex-direction:column;gap:5px}.simple-dropdown{position:relative}.dropdown-value{position:absolute!important;width:1px!important;height:1px!important;min-height:0!important;padding:0!important;overflow:hidden;opacity:0;pointer-events:none}
  .dropdown-trigger{display:flex;align-items:center;justify-content:space-between;width:100%;padding:7px 10px;color:var(--ai-text);background:var(--ai-muted);text-align:left;cursor:pointer}.dropdown-chevron{margin-left:12px;color:var(--ai-text-muted);font-size:16px;line-height:1}
  .dropdown-options{position:absolute;z-index:4;top:calc(100% + 5px);left:0;right:0;max-height:220px;padding:6px;overflow-y:auto;color:var(--ai-text);background:var(--ai-surface);border:1px solid var(--ai-border);border-radius:12px;box-shadow:0 12px 30px #0003}
  .dropdown-options .dropdown-option{display:block;width:100%;min-height:34px;padding:7px 9px;color:var(--ai-text);background:transparent;border:0;border-radius:8px;text-align:left;cursor:pointer}.dropdown-options .dropdown-option:hover,.dropdown-options .dropdown-option:focus-visible,.dropdown-options .dropdown-option.active{color:var(--ai-text);background:var(--ai-muted)}
  .validation-invalid>input,.validation-invalid>select,.validation-invalid .model-combobox>input,.validation-invalid .dropdown-trigger{border-color:var(--ai-danger);box-shadow:0 0 0 1px var(--ai-danger)}
  .confirmation-backdrop{position:fixed;inset:0;z-index:9200;background:#0009}.confirmation-modal{position:fixed;top:50%;left:50%;z-index:9201;width:min(440px,calc(100vw - 32px));padding:24px;transform:translate(-50%,-50%);color:var(--ai-text);background:var(--ai-surface);border:1px solid var(--ai-border);border-radius:16px;box-shadow:0 24px 80px #0007;text-align:center}.confirmation-icon{display:grid;width:44px;height:44px;margin:0 auto 14px;color:var(--ai-danger);font-size:24px;font-weight:800;background:color-mix(in srgb,var(--ai-danger) 12%,var(--ai-surface));border:1px solid color-mix(in srgb,var(--ai-danger) 42%,var(--ai-border));border-radius:50%;place-items:center}.confirmation-modal h3{margin:0 0 8px;font-size:19px}.confirmation-modal p{margin:0;color:var(--ai-text-muted)}.confirmation-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:22px}.confirmation-actions button{min-width:120px;cursor:pointer}.confirmation-actions .danger{color:#fff;background:var(--ai-danger);border-color:var(--ai-danger)}@media(max-width:480px){.confirmation-actions{flex-direction:column-reverse}.confirmation-actions button{width:100%}}
`;

if (typeof customElements !== "undefined") defineAiAppAssistantSettingsElement();
