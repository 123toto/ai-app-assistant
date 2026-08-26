import type {
  AiAppAssistantResponse,
  AiAppAssistantTransportEvent
} from "@123toto/ai-app-assistant-contracts";
import { capturePage } from "./capture.js";
import type { AiAppAssistantClient } from "./client.js";
import {
  createElementPickerSession,
  type ElementPickerSession
} from "./picker.js";

/** Browser behaviour shared by every UI framework connector. */
export interface AiAppAssistantControllerConfig {
  rootSelector?: string;
  redactSelectors?: string[];
  maxHtmlChars?: number;
  includeFormValues?: boolean;
  defaultQuestion?: string;
  /** Progressive responses are enabled by default. */
  streaming?: boolean;
  /** Maximum completed answers in one conversation. Defaults to three. */
  maxConversationTurns?: number;
  /** Defaults to the current pathname and query string. */
  pageKey?: () => string;
}

export type AiAppAssistantControllerState =
  | { status: "idle" }
  | {
    status: "loading";
    phase: "preparing" | "thinking" | "writing" | "finalizing";
    partialText: string;
    retry?: { attempt: number; maxRetries: number; delayMs: number };
  }
  | { status: "success"; response: AiAppAssistantResponse }
  | { status: "error"; error: Error; canRetry: boolean };

export type AiAppAssistantControllerMessage =
  | { id: string; role: "user"; text: string; selectedElementLabel?: string }
  | { id: string; role: "assistant"; response: AiAppAssistantResponse }
  | { id: string; role: "selection"; label: string };

export interface AiAppAssistantControllerSnapshot {
  state: AiAppAssistantControllerState;
  messages: readonly AiAppAssistantControllerMessage[];
  selecting: boolean;
  selectedElementLabel?: string;
  loading: boolean;
  maxConversationTurns: number;
  conversationTurns: number;
  conversationLimitReached: boolean;
}

export type AiAppAssistantControllerListener = (snapshot: AiAppAssistantControllerSnapshot) => void;

/**
 * Framework-neutral browser controller for capture, selection and conversation.
 * Angular, React, Vue and Web Components can all bind to the same snapshots.
 */
export class AiAppAssistantController {
  readonly config: Readonly<AiAppAssistantControllerConfig>;

  #state: AiAppAssistantControllerState = { status: "idle" };
  #messages: AiAppAssistantControllerMessage[] = [];
  #selectedElement: Element | undefined;
  #selecting = false;
  #maxConversationTurns: number;
  #picker: ElementPickerSession | undefined;
  #requestController: AbortController | undefined;
  #lastQuestion: string | undefined;
  #phaseTimers: Array<ReturnType<typeof setTimeout>> = [];
  #pageKey: string;
  readonly #listeners = new Set<AiAppAssistantControllerListener>();

  public constructor(config: AiAppAssistantControllerConfig, private readonly client: AiAppAssistantClient) {
    this.config = Object.freeze({ ...config });
    this.#maxConversationTurns = clampInteger(config.maxConversationTurns ?? 3, 1, 10);
    this.#pageKey = this.currentPageKey();
  }

  public get snapshot(): AiAppAssistantControllerSnapshot {
    const conversationTurns = this.#messages.filter((message) => message.role === "assistant").length;
    const selectedElementLabel = describeElement(this.#selectedElement);
    return {
      state: this.#state,
      messages: [...this.#messages],
      selecting: this.#selecting,
      ...(selectedElementLabel ? { selectedElementLabel } : {}),
      loading: this.#state.status === "loading",
      maxConversationTurns: this.#maxConversationTurns,
      conversationTurns,
      conversationLimitReached: conversationTurns >= this.#maxConversationTurns
    };
  }

  /** Subscribes to complete immutable snapshots and immediately emits the current one. */
  public subscribe(listener: AiAppAssistantControllerListener): () => void {
    this.#listeners.add(listener);
    listener(this.snapshot);
    return () => this.#listeners.delete(listener);
  }

  /** Captures the current page and sends one question to the configured backend. */
  public async ask(options: { question?: string; selectedElement?: Element } = {}): Promise<AiAppAssistantResponse> {
    this.syncPage();
    if (this.snapshot.conversationLimitReached) {
      throw new Error("Conversation limit reached. Start a new conversation.");
    }
    const question = options.question?.trim()
      || this.config.defaultQuestion
      || "Présente cette page et explique ses principales actions.";
    const selectedElement = options.selectedElement ?? this.#selectedElement;
    const conversation = conversationHistory(this.#messages, this.#maxConversationTurns);
    this.#lastQuestion = question;
    this.stop();
    const controller = new AbortController();
    this.#requestController = controller;
    this.#state = { status: "loading", phase: "preparing", partialText: "" };
    const selectedElementLabel = describeElement(selectedElement);
    this.#messages = [...this.#messages, {
      id: crypto.randomUUID(),
      role: "user",
      text: question,
      ...(selectedElementLabel ? { selectedElementLabel } : {})
    }];
    this.notify();

    try {
      const captured = this.capture(selectedElement);
      const input = {
        html: captured.html,
        htmlTruncated: captured.htmlTruncated,
        ...(captured.selectedElementHtml ? { selectedElementHtml: captured.selectedElementHtml } : {}),
        question,
        ...(conversation.length ? { conversation } : {})
      };
      const response = this.config.streaming === false
        ? await this.client.ask(input, { signal: controller.signal })
        : await this.client.stream(input, {
          signal: controller.signal,
          onEvent: (event) => this.applyStreamEvent(event)
        });
      this.#state = { status: "success", response };
      this.#messages = [...this.#messages, {
        id: crypto.randomUUID(), role: "assistant", response
      }];
      this.clearSelectedElement();
      this.notify();
      return response;
    } catch (error) {
      const normalized = normalizeAiAppAssistantError(error);
      if (normalized.name === "AbortError" && this.#messages.at(-1)?.role === "user") {
        this.#messages = this.#messages.slice(0, -1);
      }
      this.#state = normalized.name === "AbortError"
        ? { status: "idle" }
        : { status: "error", error: normalized, canRetry: true };
      this.notify();
      throw normalized;
    } finally {
      if (this.#requestController === controller) this.#requestController = undefined;
    }
  }

  /** Starts a cancellable DOM picker without sending a question. */
  public async selectElement(): Promise<Element> {
    this.cancelElementSelection();
    this.#selecting = true;
    this.notify();
    const picker = createElementPickerSession({
      excludeSelectors: ["[data-ai-app-assistant-ui]", ...(this.config.redactSelectors ?? [])]
    });
    this.#picker = picker;
    try {
      const element = await picker.result;
      this.#selectedElement = element;
      this.#messages = [...this.#messages, {
        id: crypto.randomUUID(),
        role: "selection",
        label: describeElement(element) ?? "Selected element"
      }];
      this.notify();
      return element;
    } finally {
      if (this.#picker === picker) this.#picker = undefined;
      this.#selecting = false;
      this.notify();
    }
  }

  /** Backward-compatible shortcut; prefer selection followed by a custom prompt. */
  public async selectAndAsk(question: string, options?: { signal?: AbortSignal }): Promise<AiAppAssistantResponse> {
    const picker = createElementPickerSession({
      ...(options?.signal ? { signal: options.signal } : {}),
      excludeSelectors: ["[data-ai-app-assistant-ui]", ...(this.config.redactSelectors ?? [])]
    });
    return this.ask({ question, selectedElement: await picker.result });
  }

  public cancelElementSelection(): void {
    this.#picker?.cancel();
    this.#picker = undefined;
    this.#selecting = false;
    this.notify();
  }

  /** Forgets the selected target but keeps the current conversation. */
  public clearSelectedElement(): void {
    this.#selectedElement = undefined;
    if (this.#messages.at(-1)?.role === "selection") {
      this.#messages = this.#messages.slice(0, -1);
    }
    this.notify();
  }

  /** Aborts only the active request; messages remain available for retry. */
  public stop(): void {
    this.clearPhaseTimers();
    this.#requestController?.abort(new DOMException("Request stopped.", "AbortError"));
    this.#requestController = undefined;
  }

  /** Replays the last question after automatic transport retries are exhausted. */
  public retry(): Promise<AiAppAssistantResponse> {
    if (!this.#lastQuestion) return Promise.reject(new Error("No request to retry."));
    if (this.#messages.at(-1)?.role === "user") this.#messages = this.#messages.slice(0, -1);
    return this.ask({ question: this.#lastQuestion });
  }

  /** Clears every conversation-scoped value, including DOM selection. */
  public newConversation(): void {
    this.clearPhaseTimers();
    this.stop();
    this.cancelElementSelection();
    this.#messages = [];
    this.#selectedElement = undefined;
    this.#lastQuestion = undefined;
    this.#state = { status: "idle" };
    this.notify();
  }

  /** Starts a fresh conversation when the host page key changes. */
  public syncPage(key = this.currentPageKey()): boolean {
    if (key === this.#pageKey) return false;
    this.#pageKey = key;
    this.newConversation();
    return true;
  }

  public reset(): void { this.newConversation(); }

  /** Updates the server-defined limit and prevents keeping an invalid session. */
  public setMaxConversationTurns(value: number): void {
    const previousLimit = this.#maxConversationTurns;
    const nextLimit = clampInteger(value, 1, 10);
    const currentTurns = this.snapshot.conversationTurns;
    if (nextLimit === previousLimit) return;
    this.#maxConversationTurns = nextLimit;
    if (nextLimit < previousLimit && currentTurns >= nextLimit) this.newConversation();
    else this.notify();
  }

  /** Centralizes safe DOM capture for every framework connector. */
  private capture(selectedElement?: Element) {
    const root = this.config.rootSelector
      ? document.querySelector(this.config.rootSelector) ?? document.body
      : document;
    return capturePage({
      root,
      ...(selectedElement ? { selectedElement } : {}),
      redactSelectors: ["[data-ai-app-assistant-ui]", ...(this.config.redactSelectors ?? [])],
      ...(this.config.maxHtmlChars ? { maxHtmlChars: this.config.maxHtmlChars } : {}),
      ...(this.config.includeFormValues !== undefined
        ? { includeFormValues: this.config.includeFormValues }
        : {})
    });
  }

  /** Translates transport events into stable UI phases and partial text. */
  private applyStreamEvent(event: AiAppAssistantTransportEvent): void {
    if (event.type === "status") {
      this.clearPhaseTimers();
      if (event.phase === "preparing") {
        this.#state = { status: "loading", phase: "preparing", partialText: "" };
      } else {
        this.#state = { status: "loading", phase: "thinking", partialText: "" };
        this.#phaseTimers.push(setTimeout(() => {
          if (this.#state.status === "loading" && this.#state.phase === "thinking") {
            this.#state = { ...this.#state, phase: "writing" };
            this.notify();
          }
        }, 3_000));
      }
    } else if (event.type === "partial") {
      const retry = this.#state.status === "loading" ? this.#state.retry : undefined;
      this.#state = {
        status: "loading", phase: "writing", partialText: event.text,
        ...(retry ? { retry } : {})
      };
    } else if (event.type === "retry") {
      this.#state = {
        status: "loading", phase: "thinking", partialText: "", retry: event
      };
    } else if (event.type === "complete") {
      this.clearPhaseTimers();
      this.#state = { status: "loading", phase: "finalizing", partialText: "" };
    }
    this.notify();
  }

  private clearPhaseTimers(): void {
    this.#phaseTimers.forEach((timer) => clearTimeout(timer));
    this.#phaseTimers = [];
  }

  private currentPageKey(): string {
    return this.config.pageKey?.() ?? `${location.pathname}${location.search}`;
  }

  private notify(): void {
    const snapshot = this.snapshot;
    this.#listeners.forEach((listener) => listener(snapshot));
  }
}

export function describeAiAppAssistantElement(element?: Element): string | undefined {
  return describeElement(element);
}

export function normalizeAiAppAssistantError(error: unknown): Error {
  if (error instanceof Error && error.name === "AbortError") return error;
  const payload = error && typeof error === "object" && "error" in error
    ? (error as { error?: unknown }).error
    : undefined;
  const responseBody = error && typeof error === "object" && "responseBody" in error
    ? (error as { responseBody?: unknown }).responseBody
    : undefined;
  const message = extractErrorMessage(payload)
    ?? extractErrorMessage(responseBody)
    ?? (error instanceof Error && error.message !== "[object Object]" ? error.message : undefined);
  return new Error(message ?? "The assistant request failed. Please try again.");
}

/** Reads common HTTP envelopes without dumping technical JSON into the chat. */
function extractErrorMessage(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed === "[object Object]") return undefined;
    if ((trimmed.startsWith("{") || trimmed.startsWith("["))) {
      try { return extractErrorMessage(JSON.parse(trimmed) as unknown, depth + 1); }
      catch { return trimmed.slice(0, 500); }
    }
    return trimmed.slice(0, 500);
  }
  if (typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const field of ["message", "error", "detail", "details"]) {
    const message = extractErrorMessage(record[field], depth + 1);
    if (message) return message;
  }
  return undefined;
}

function describeElement(element?: Element): string | undefined {
  if (!element) return undefined;
  const text = element.textContent?.replace(/\s+/g, " ").trim();
  const label = element.getAttribute("aria-label") || element.getAttribute("title") || text;
  return label ? label.slice(0, 80) : element.tagName.toLowerCase();
}

function conversationHistory(messages: AiAppAssistantControllerMessage[], maxTurns: number) {
  return messages.filter((message) => message.role !== "selection").slice(-(maxTurns * 2)).map((message) => ({
    role: message.role,
    content: message.role === "user"
      ? message.text.slice(0, 8_000)
      : renderResponseForHistory(message.response).slice(0, 8_000)
  }));
}

function renderResponseForHistory(response: AiAppAssistantResponse): string {
  return [
    response.answer.title,
    response.answer.summary,
    ...response.answer.sections.flatMap((section) => [section.heading, section.content]),
    ...(response.answer.steps ?? []).flatMap((step) => [step.label, step.description]),
    ...(response.answer.warnings ?? []),
    ...response.limitations
  ].filter((part): part is string => Boolean(part)).join("\n");
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}
