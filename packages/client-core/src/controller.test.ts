// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiAppAssistantResponse } from "@123toto/ai-app-assistant-contracts";
import type { AiAppAssistantClient } from "./client.js";
import {
  AiAppAssistantController,
  describeAiAppAssistantElement
} from "./controller.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  window.history.replaceState({}, "", "/");
});

describe("AiAppAssistantController", () => {
  it("emits an immutable initial snapshot and stops notifying after unsubscribe", () => {
    const controller = createController(client());
    const listener = vi.fn();

    const unsubscribe = controller.subscribe(listener);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      state: { status: "idle" },
      messages: [],
      maxConversationTurns: 3,
      conversationTurns: 0,
      conversationLimitReached: false
    }));
    expect(Object.isFrozen(controller.config)).toBe(true);

    unsubscribe();
    controller.newConversation();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("captures only the configured page root and removes assistant and host-sensitive content", async () => {
    document.body.innerHTML = `
      <main id="content"><h1>Assessment</h1><p class="secret">Hidden</p><button title="Save changes">Save</button></main>
      <aside data-ai-app-assistant-ui>Assistant internals</aside>
      <footer>Outside root</footer>`;
    const selected = document.querySelector("button");
    const ask = vi.fn(async () => response());
    const controller = createController({ ask, stream: vi.fn() as never }, {
      rootSelector: "#content",
      redactSelectors: [".secret"],
      includeFormValues: false,
      streaming: false
    });

    await controller.ask({ question: "  Explain saving  ", selectedElement: selected ?? undefined });

    const input = ask.mock.calls[0]?.[0];
    expect(input.question).toBe("Explain saving");
    expect(input.html).toContain("Assessment");
    expect(input.html).not.toContain("Hidden");
    expect(input.html).not.toContain("Outside root");
    expect(input.html).not.toContain("Assistant internals");
    expect(input.selectedElementHtml).toContain("Save");
    expect(controller.snapshot.messages).toHaveLength(2);
    expect(controller.snapshot.conversationTurns).toBe(1);
    expect(controller.snapshot.selectedElementLabel).toBeUndefined();
  });

  it("sends bounded prior turns and blocks requests at the configured limit", async () => {
    document.body.innerHTML = "<main>Page evidence</main>";
    const ask = vi.fn(async () => response());
    const controller = createController({ ask, stream: vi.fn() as never }, {
      streaming: false,
      maxConversationTurns: 2
    });

    await controller.ask({ question: "First" });
    await controller.ask({ question: "Second" });

    expect(ask.mock.calls[0]?.[0].conversation).toBeUndefined();
    expect(ask.mock.calls[1]?.[0].conversation).toEqual([
      { role: "user", content: "First" },
      { role: "assistant", content: "Test answer" }
    ]);
    expect(controller.snapshot.conversationLimitReached).toBe(true);
    await expect(controller.ask({ question: "Third" }))
      .rejects.toThrow("Conversation limit reached");
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("translates streaming progress, retry and completion into stable UI states", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = "<main>Page evidence</main>";
    let finish: ((value: AiAppAssistantResponse) => void) | undefined;
    let onEvent: Parameters<AiAppAssistantClient["stream"]>[1] extends { onEvent?: infer T } ? T : never;
    const stream = vi.fn((_input, options) => {
      onEvent = options?.onEvent;
      onEvent?.({ type: "status", phase: "generating" });
      return new Promise<AiAppAssistantResponse>((resolve) => { finish = resolve; });
    });
    const controller = createController({ ask: vi.fn() as never, stream });
    const snapshots: string[] = [];
    controller.subscribe(({ state }) => {
      if (state.status === "loading") snapshots.push(`${state.phase}:${state.partialText}`);
    });

    const pending = controller.ask({ question: "Stream this" });
    expect(controller.snapshot.state).toMatchObject({ status: "loading", phase: "thinking" });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(controller.snapshot.state).toMatchObject({ status: "loading", phase: "writing" });

    onEvent?.({ type: "retry", attempt: 1, maxRetries: 2, delayMs: 25 });
    expect(controller.snapshot.state).toMatchObject({
      status: "loading",
      phase: "thinking",
      retry: { attempt: 1, maxRetries: 2, delayMs: 25 }
    });
    onEvent?.({ type: "partial", text: "Partial answer" });
    expect(controller.snapshot.state).toMatchObject({
      status: "loading", phase: "writing", partialText: "Partial answer"
    });
    onEvent?.({ type: "complete", response: response() });
    expect(controller.snapshot.state).toMatchObject({ status: "loading", phase: "finalizing" });

    finish?.(response());
    await expect(pending).resolves.toEqual(response());
    expect(controller.snapshot.state).toMatchObject({ status: "success" });
    expect(snapshots).toContain("thinking:");
    expect(snapshots).toContain("writing:Partial answer");
  });

  it("aborts an active request without consuming a conversation turn", async () => {
    document.body.innerHTML = "<main>Page evidence</main>";
    const ask = vi.fn((_input, options) => new Promise<AiAppAssistantResponse>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
    }));
    const controller = createController({ ask, stream: vi.fn() as never }, { streaming: false });

    const pending = controller.ask({ question: "Stop me" });
    controller.stop();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(controller.snapshot.state).toEqual({ status: "idle" });
    expect(controller.snapshot.messages).toEqual([]);
    expect(controller.snapshot.conversationTurns).toBe(0);
  });

  it("retries the last failed question without duplicating its user message", async () => {
    document.body.innerHTML = "<main>Page evidence</main>";
    const failure = Object.assign(new Error("Unavailable"), { status: 503 });
    const ask = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(response());
    const controller = createController({ ask, stream: vi.fn() as never }, { streaming: false });

    await expect(controller.ask({ question: "Retry me" })).rejects.toThrow("Unavailable");
    expect(controller.snapshot.state).toMatchObject({ status: "error", canRetry: true });
    expect(controller.snapshot.messages.filter(({ role }) => role === "user")).toHaveLength(1);

    await expect(controller.retry()).resolves.toEqual(response());
    expect(ask).toHaveBeenCalledTimes(2);
    expect(controller.snapshot.messages.filter(({ role }) => role === "user")).toHaveLength(1);
    expect(controller.snapshot.messages.filter(({ role }) => role === "assistant")).toHaveLength(1);
  });

  it("resets page-scoped state and clamps runtime conversation limits", async () => {
    document.body.innerHTML = "<main>Page evidence</main>";
    const controller = createController(client(), { streaming: false, maxConversationTurns: 99 });
    expect(controller.snapshot.maxConversationTurns).toBe(10);

    await controller.ask({ question: "Existing question" });
    controller.setMaxConversationTurns(0);
    expect(controller.snapshot.maxConversationTurns).toBe(1);
    expect(controller.snapshot.messages).toEqual([]);

    expect(controller.syncPage("/next?page=1")).toBe(true);
    expect(controller.syncPage("/next?page=1")).toBe(false);
    await expect(controller.retry()).rejects.toThrow("No request to retry");
  });

  it("describes selected elements from accessible metadata before visible text", () => {
    const button = document.createElement("button");
    button.setAttribute("aria-label", "Accessible action");
    button.textContent = "Visible action";
    expect(describeAiAppAssistantElement(button)).toBe("Accessible action");

    const empty = document.createElement("section");
    expect(describeAiAppAssistantElement(empty)).toBe("section");
    expect(describeAiAppAssistantElement()).toBeUndefined();
  });
});

function createController(
  assistantClient: AiAppAssistantClient,
  config: ConstructorParameters<typeof AiAppAssistantController>[0] = {}
): AiAppAssistantController {
  return new AiAppAssistantController(config, assistantClient);
}

function client(): AiAppAssistantClient {
  return {
    ask: vi.fn(async () => response()),
    stream: vi.fn(async () => response())
  };
}

function response(): AiAppAssistantResponse {
  return {
    protocolVersion: "4",
    requestId: "response-1",
    answerability: "answered",
    answer: { summary: "Test answer", sections: [] },
    evidence: [],
    limitations: [],
    confidence: { level: "high", score: 0.9, reasons: ["Supported"] },
    metadata: { durationMs: 1, model: "test:model" }
  };
}
