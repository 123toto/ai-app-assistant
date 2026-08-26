import type { AiAppAssistantResponse } from "@123toto/ai-app-assistant-contracts";
import { createAiAppAssistantClient, type AiAppAssistantClientOptions } from "./client.js";
import {
  AiAppAssistantController,
  normalizeAiAppAssistantError,
  type AiAppAssistantControllerConfig,
  type AiAppAssistantControllerSnapshot
} from "./controller.js";

export interface AiAppAssistantWebComponentConfig extends AiAppAssistantControllerConfig {
  endpoint: string;
  streamEndpoint?: string;
  headers?: AiAppAssistantClientOptions["headers"];
  assistantName?: string;
  launcherLabel?: string;
  subtitle?: string;
  mascot?: string;
}

// The subpath can be imported during SSR; the real base is selected only when
// the browser provides HTMLElement. Instances are created exclusively there.
const HTMLElementBase: typeof HTMLElement = typeof HTMLElement === "undefined"
  ? class {} as typeof HTMLElement
  : HTMLElement;

/**
 * Framework-independent assistant UI built on browser standards only.
 * Configure it with attributes or with `configure()` before/after connection.
 */
export class AiAppAssistantElement extends HTMLElementBase {
  static readonly observedAttributes = [
    "endpoint",
    "stream-endpoint",
    "assistant-name",
    "launcher-label",
    "subtitle",
    "mascot",
    "max-conversation-turns"
  ];

  readonly #root = this.attachShadow({ mode: "open" });
  #config: Partial<AiAppAssistantWebComponentConfig> = {};
  #controller: AiAppAssistantController | undefined;
  #unsubscribe: (() => void) | undefined;
  #snapshot: AiAppAssistantControllerSnapshot | undefined;
  #open = false;
  #question = "";

  public connectedCallback(): void {
    this.setAttribute("data-ai-app-assistant-ui", "");
    this.#root.addEventListener("click", this.onClick);
    this.#root.addEventListener("submit", this.onSubmit);
    this.#root.addEventListener("input", this.onInput);
    this.#root.addEventListener("keydown", this.onKeydown);
    this.initialize();
  }

  public disconnectedCallback(): void {
    this.#root.removeEventListener("click", this.onClick);
    this.#root.removeEventListener("submit", this.onSubmit);
    this.#root.removeEventListener("input", this.onInput);
    this.#root.removeEventListener("keydown", this.onKeydown);
    this.#unsubscribe?.();
    this.#controller?.stop();
    this.#controller?.cancelElementSelection();
  }

  public attributeChangedCallback(): void {
    if (this.isConnected) this.initialize();
  }

  /** Applies non-serializable options such as authorization headers. */
  public configure(config: AiAppAssistantWebComponentConfig): void {
    this.#config = { ...this.#config, ...config };
    if (this.isConnected) this.initialize();
  }

  public newConversation(): void {
    this.#question = "";
    this.#controller?.newConversation();
  }

  /** Recreates the shared controller when attributes or runtime options change. */
  private initialize(): void {
    const config = this.resolveConfig();
    if (!config.endpoint) {
      this.#snapshot = undefined;
      this.render("Missing ai-app-assistant endpoint.");
      return;
    }
    this.#unsubscribe?.();
    this.#controller?.stop();
    const client = createAiAppAssistantClient({
      endpoint: config.endpoint,
      ...(config.streamEndpoint ? { streamEndpoint: config.streamEndpoint } : {}),
      ...(config.headers ? { headers: config.headers } : {})
    });
    this.#controller = new AiAppAssistantController(config, client);
    this.#unsubscribe = this.#controller.subscribe((snapshot) => {
      this.#snapshot = snapshot;
      this.render();
      this.dispatchEvent(new CustomEvent("ai-app-assistant-state-change", {
        detail: snapshot,
        bubbles: true,
        composed: true
      }));
    });
  }

  private resolveConfig(): AiAppAssistantWebComponentConfig {
    const endpoint = this.#config.endpoint ?? this.getAttribute("endpoint") ?? "";
    const streamEndpoint = this.#config.streamEndpoint ?? this.getAttribute("stream-endpoint") ?? undefined;
    const turnsValue = this.#config.maxConversationTurns
      ?? numberAttribute(this.getAttribute("max-conversation-turns"));
    return {
      ...this.#config,
      endpoint,
      ...(streamEndpoint ? { streamEndpoint } : {}),
      ...(turnsValue ? { maxConversationTurns: turnsValue } : {}),
      assistantName: this.#config.assistantName ?? this.getAttribute("assistant-name") ?? "AI assistant",
      launcherLabel: this.#config.launcherLabel ?? this.getAttribute("launcher-label") ?? "Ask AI",
      subtitle: this.#config.subtitle ?? this.getAttribute("subtitle") ?? "Help about this page",
      mascot: this.#config.mascot ?? this.getAttribute("mascot") ?? "✦"
    };
  }

  private render(configurationError?: string): void {
    const config = this.resolveConfig();
    const labels = this.ownerDocument.documentElement.lang.toLowerCase().startsWith("fr")
      ? FRENCH_LABELS
      : ENGLISH_LABELS;
    const snapshot = this.#snapshot;
    this.#root.innerHTML = `<style>${STYLES}</style>
      ${!this.#open ? `<button class="launcher" data-action="open" aria-label="${escapeHtml(config.launcherLabel ?? labels.open)}"><span>${escapeHtml(config.mascot ?? "✦")}</span><b>${escapeHtml(config.launcherLabel ?? labels.open)}</b></button>` : ""}
      ${snapshot?.selecting ? `<div class="picker-hud" role="status">${labels.selection}<button data-action="cancel-selection">${labels.cancel}</button></div>` : ""}
      ${this.#open ? `<aside class="panel" aria-label="${escapeHtml(config.assistantName ?? "AI assistant")}">
        <header><span class="avatar">${escapeHtml(config.mascot ?? "✦")}</span><div><strong>${escapeHtml(config.assistantName ?? "AI assistant")}</strong><small>${escapeHtml(config.subtitle ?? "")}</small></div><nav><button data-action="new" title="${labels.newConversation}">↻</button><button data-action="close" title="${labels.close}">—</button></nav></header>
        <main class="conversation">${configurationError ? `<div class="error">${escapeHtml(configurationError)}</div>` : this.renderConversation(snapshot, labels)}</main>
        ${configurationError ? "" : this.renderComposer(snapshot, labels)}
      </aside>` : ""}`;
    queueMicrotask(() => this.scrollToLatestQuestion());
  }

  private renderConversation(snapshot: AiAppAssistantControllerSnapshot | undefined, labels: Labels): string {
    if (!snapshot) return "";
    const messages = snapshot.messages.map((message) => {
      if (message.role === "selection") {
        return `<article class="selection"><small>${labels.elementSelected}</small><strong>${escapeHtml(message.label)}</strong></article>`;
      }
      if (message.role === "user") {
        return `<article class="message user" data-message-id="${message.id}"><p>${escapeHtml(message.text)}</p></article>`;
      }
      return renderResponse(message.response);
    }).join("");
    const state = snapshot.state;
    const progress = state.status === "loading"
      ? `<article class="message assistant"><div class="progress"><i></i><i></i><i></i><span>${labels[state.phase]}</span></div>${state.partialText ? `<p>${escapeHtml(state.partialText)}</p>` : ""}</article>`
      : "";
    const error = state.status === "error"
      ? `<div class="error"><strong>${labels.error}</strong><span>${escapeHtml(state.error.message)}</span><button data-action="retry">${labels.retry}</button></div>`
      : "";
    return messages || progress || error
      ? `${messages}${progress}${error}`
      : `<div class="welcome"><strong>${labels.welcome}</strong><p>${labels.welcomeBody}</p></div>`;
  }

  private renderComposer(snapshot: AiAppAssistantControllerSnapshot | undefined, labels: Labels): string {
    const disabled = snapshot?.loading || snapshot?.conversationLimitReached;
    return `<form class="composer">
      ${snapshot?.conversationLimitReached ? `<div class="limit"><span>${labels.limit}</span><button type="button" data-action="new">${labels.newConversation}</button></div>` : ""}
      ${snapshot?.selectedElementLabel ? `<div class="chip"><span>◎ ${escapeHtml(snapshot.selectedElementLabel)}</span><button type="button" data-action="clear-selection">×</button></div>` : ""}
      <textarea maxlength="4000" rows="2" placeholder="${labels.placeholder}" ${disabled ? "disabled" : ""}>${escapeHtml(this.#question)}</textarea>
      <div class="actions"><button type="button" data-action="select" ${disabled ? "disabled" : ""}>◎ ${labels.select}</button>${snapshot?.loading
        ? `<button type="button" class="send" data-action="stop" aria-label="${labels.stop}">■</button>`
        : `<button type="submit" class="send" ${snapshot?.conversationLimitReached ? "disabled" : ""} aria-label="${labels.send}">➤</button>`}</div>
    </form>`;
  }

  private readonly onClick = (event: Event): void => {
    const target = (event.target as Element | null)?.closest<HTMLElement>("[data-action]");
    if (!target) return;
    const action = target.dataset["action"];
    if (action === "open") {
      this.#open = true;
      if (this.#controller?.syncPage()) this.#question = "";
      this.render();
    }
    else if (action === "close") { this.#open = false; this.render(); }
    else if (action === "new") this.newConversation();
    else if (action === "stop") this.#controller?.stop();
    else if (action === "retry") void this.retry();
    else if (action === "select") void this.selectElement();
    else if (action === "cancel-selection") { this.#controller?.cancelElementSelection(); this.#open = true; this.render(); }
    else if (action === "clear-selection") this.#controller?.clearSelectedElement();
  };

  private readonly onSubmit = (event: Event): void => {
    event.preventDefault();
    void this.ask();
  };

  private readonly onInput = (event: Event): void => {
    if (event.target instanceof HTMLTextAreaElement) this.#question = event.target.value;
  };

  private readonly onKeydown = (event: Event): void => {
    if (event instanceof KeyboardEvent && event.target instanceof HTMLTextAreaElement
      && event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void this.ask();
    }
  };

  private async ask(): Promise<void> {
    if (!this.#controller || this.#snapshot?.conversationLimitReached) return;
    const question = this.#question.trim();
    this.#question = "";
    try {
      const response = await this.#controller.ask(question ? { question } : {});
      this.dispatchEvent(new CustomEvent("ai-app-assistant-answer", {
        detail: response, bubbles: true, composed: true
      }));
    } catch (error) {
      const normalized = normalizeAiAppAssistantError(error);
      if (normalized.name !== "AbortError") this.dispatchEvent(new CustomEvent("ai-app-assistant-error", {
        detail: normalized, bubbles: true, composed: true
      }));
    }
  }

  private async retry(): Promise<void> {
    try { await this.#controller?.retry(); } catch { /* Controller state is rendered. */ }
  }

  private async selectElement(): Promise<void> {
    if (!this.#controller) return;
    this.#open = false;
    this.render();
    try { await this.#controller.selectElement(); }
    catch (error) { if (normalizeAiAppAssistantError(error).name !== "AbortError") throw error; }
    finally { this.#open = true; this.render(); }
  }

  private scrollToLatestQuestion(): void {
    // Keep the last question and the beginning of its answer visible together.
    const conversation = this.#root.querySelector<HTMLElement>(".conversation");
    const questions = this.#root.querySelectorAll<HTMLElement>("[data-message-id]");
    const latest = questions.item(questions.length - 1);
    if (!conversation || !latest) return;
    conversation.scrollTop = Math.max(0, latest.offsetTop - conversation.offsetTop - 6);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ai-app-assistant": AiAppAssistantElement;
  }
}

/** Registers `<ai-app-assistant>` once and returns its constructor. */
export function defineAiAppAssistantElement(tagName = "ai-app-assistant"): typeof AiAppAssistantElement {
  if (!customElements.get(tagName)) customElements.define(tagName, AiAppAssistantElement);
  return AiAppAssistantElement;
}

function renderResponse(response: AiAppAssistantResponse): string {
  const title = response.answer.title ? `<h3>${escapeHtml(response.answer.title)}</h3>` : "";
  const sections = response.answer.sections.map((section) =>
    `<section><h4>${escapeHtml(section.heading)}</h4><p>${escapeHtml(section.content)}</p></section>`
  ).join("");
  const steps = response.answer.steps?.length
    ? `<ol>${response.answer.steps.map((step) => `<li><strong>${escapeHtml(step.label)}</strong> ${escapeHtml(step.description)}</li>`).join("")}</ol>`
    : "";
  const warnings = (response.answer.warnings ?? []).map((warning) => `<p class="warning">⚠ ${escapeHtml(warning)}</p>`).join("");
  return `<article class="message assistant">${title}<p>${escapeHtml(response.answer.summary)}</p>${sections}${steps}${warnings}<footer><i class="confidence ${response.confidence.level}"></i>${Math.round(response.confidence.score * 100)}%</footer></article>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;"
  })[character] ?? character);
}

function numberAttribute(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

interface Labels {
  open: string;
  close: string;
  selection: string;
  cancel: string;
  newConversation: string;
  elementSelected: string;
  welcome: string;
  welcomeBody: string;
  error: string;
  retry: string;
  placeholder: string;
  select: string;
  stop: string;
  send: string;
  limit: string;
  preparing: string;
  thinking: string;
  writing: string;
  finalizing: string;
}

const ENGLISH_LABELS: Labels = {
  open: "Ask AI", close: "Minimize", selection: "Select an element on the page", cancel: "Cancel",
  newConversation: "New conversation", elementSelected: "Selected element", welcome: "How can I help?",
  welcomeBody: "Ask about this page or select a specific element.", error: "The answer could not be generated.",
  retry: "Retry", placeholder: "Ask your question…", select: "Select element", stop: "Stop generating",
  send: "Send", limit: "Question limit reached. Start a new conversation to continue.",
  preparing: "Reading the page…", thinking: "Thinking…", writing: "Writing the answer…", finalizing: "Checking the answer…"
};

const FRENCH_LABELS: Labels = {
  open: "Demander à l’IA", close: "Réduire", selection: "Choisissez un élément dans la page", cancel: "Annuler",
  newConversation: "Nouvelle conversation", elementSelected: "Élément sélectionné", welcome: "Comment puis-je vous aider ?",
  welcomeBody: "Interrogez cette page ou sélectionnez un élément précis.", error: "La réponse n’a pas pu être générée.",
  retry: "Réessayer", placeholder: "Posez votre question…", select: "Sélectionner un élément", stop: "Arrêter",
  send: "Envoyer", limit: "Limite de questions atteinte. Démarrez une nouvelle conversation pour continuer.",
  preparing: "Lecture de la page…", thinking: "Réflexion…", writing: "Rédaction…", finalizing: "Vérification…"
};

const STYLES = `
  :host{--ai-accent:#14745b;--ai-surface:#fff;--ai-muted:#f4f7f6;--ai-text:#1f2925;--ai-border:#d8e0dc;position:fixed;right:20px;bottom:20px;z-index:9000;font:14px/1.45 system-ui,sans-serif;color:var(--ai-text)}
  button,textarea{font:inherit}.launcher{display:flex;align-items:center;gap:0;width:50px;height:50px;padding:0;overflow:hidden;color:#fff;background:var(--ai-accent);border:0;border-radius:999px;box-shadow:0 8px 25px #0003,0 0 20px color-mix(in srgb,var(--ai-accent) 45%,transparent);cursor:pointer;transition:width .2s}.launcher:hover{width:132px}.launcher span{display:grid;flex:0 0 50px;place-items:center;font-size:20px}.launcher b{white-space:nowrap}
  .panel{display:flex;flex-direction:column;width:min(380px,calc(100vw - 24px));height:min(580px,calc(100vh - 28px));overflow:hidden;background:var(--ai-surface);border:1px solid var(--ai-border);border-radius:16px;box-shadow:0 18px 55px #0003}.panel>header{display:flex;align-items:center;gap:9px;padding:12px;color:#fff;background:linear-gradient(135deg,var(--ai-accent),color-mix(in srgb,var(--ai-accent) 65%,#000))}.avatar{display:grid;width:32px;height:32px;place-items:center;background:#ffffff20;border-radius:50%}.panel header div{display:flex;flex:1;flex-direction:column}.panel header small{opacity:.8}.panel nav{display:flex}.panel nav button{color:inherit;background:none;border:0;cursor:pointer}
  .conversation{flex:1;padding:12px;overflow:auto;background:var(--ai-muted)}.welcome,.message,.selection,.error{margin-bottom:10px;padding:11px;background:var(--ai-surface);border:1px solid var(--ai-border);border-radius:12px}.welcome p,.message p{margin:4px 0}.user{max-width:82%;margin-left:auto;color:#fff;background:var(--ai-accent);border-color:transparent}.assistant h3{margin:0 0 9px;padding-bottom:7px;font-size:15px;border-bottom:1px solid var(--ai-border)}.assistant section{margin-top:12px}.assistant h4{margin:0 0 4px;font-size:13px}.assistant footer{display:flex;align-items:center;gap:6px;margin-top:10px;padding-top:8px;color:#66736d;border-top:1px solid var(--ai-border);font-size:11px}.confidence{width:8px;height:8px;background:#888;border-radius:50%}.confidence.high{background:#238636}.confidence.medium{background:#d29922}.confidence.low{background:#da3633}.selection{display:flex;flex-direction:column;color:#3646a0;background:#eef0ff}.error{display:flex;flex-direction:column;gap:7px;color:#a43737;background:#fff1f0;border-color:#efb4af}.error button{align-self:flex-start;color:#fff;background:#a43737;border:0;border-radius:7px;padding:6px 9px}.progress{display:flex;align-items:center;gap:5px}.progress i{width:5px;height:5px;background:var(--ai-accent);border-radius:50%;animation:wave 1s infinite}.progress i:nth-child(2){animation-delay:.14s}.progress i:nth-child(3){animation-delay:.28s}
  .composer{padding:10px;background:var(--ai-surface);border-top:1px solid var(--ai-border)}textarea{box-sizing:border-box;width:100%;padding:9px;resize:none;color:var(--ai-text);background:var(--ai-muted);border:1px solid var(--ai-border);border-radius:10px}.actions{display:flex;justify-content:space-between;margin-top:7px}.actions button,.limit button{padding:6px 9px;color:var(--ai-accent);background:var(--ai-surface);border:1px solid var(--ai-border);border-radius:8px}.actions .send{color:#fff;background:var(--ai-accent);border-color:transparent;border-radius:50%}.chip,.limit{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:7px;padding:7px 8px;background:var(--ai-muted);border:1px solid var(--ai-border);border-radius:9px;font-size:12px}.chip button{background:none;border:0}.picker-hud{position:fixed;right:20px;bottom:20px;display:flex;align-items:center;gap:8px;padding:10px 12px;color:#fff;background:#17231f;border-radius:10px;box-shadow:0 8px 25px #0003}.picker-hud button{color:inherit;background:none;border:1px solid #ffffff55;border-radius:6px}
  @media(prefers-color-scheme:dark){:host{--ai-surface:#1d2321;--ai-muted:#151a18;--ai-text:#edf2ef;--ai-border:#39443f}.error{background:#3c2020}}
  @keyframes wave{0%,60%,100%{opacity:.35;transform:translateY(0)}30%{opacity:1;transform:translateY(-4px)}}
`;

// Importing the browser-only subpath is enough for the zero-configuration use case.
if (typeof customElements !== "undefined") defineAiAppAssistantElement();
