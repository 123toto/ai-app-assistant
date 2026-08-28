// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiAppAssistantResponse } from "@123toto/ai-app-assistant-contracts";
import { AiAppAssistantElement, defineAiAppAssistantElement } from "./web-component.js";

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("AiAppAssistantElement", () => {
  it("registers a framework-independent custom element", () => {
    expect(customElements.get("ai-app-assistant")).toBe(AiAppAssistantElement);
    expect(defineAiAppAssistantElement()).toBe(AiAppAssistantElement);
  });

  it("renders the generic assistant from HTML attributes", () => {
    const element = document.createElement("ai-app-assistant") as AiAppAssistantElement;
    element.setAttribute("endpoint", "/api/ai-app-assistant/ask");
    element.setAttribute("assistant-name", "Application assistant");
    document.body.append(element);

    element.shadowRoot?.querySelector<HTMLButtonElement>("[data-action='open']")?.click();

    expect(element.shadowRoot?.querySelector(".panel")?.textContent).toContain("Application assistant");
    expect(element.shadowRoot?.querySelector("textarea")).not.toBeNull();
  });

  it("submits a captured page through the configured transport and emits the validated answer", async () => {
    document.body.innerHTML = "<main><h1>Assessment</h1><p data-sensitive>Private value</p></main>";
    const fetch = vi.fn(async () => new Response(JSON.stringify(response()), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const element = document.createElement("ai-app-assistant") as AiAppAssistantElement;
    element.configure({
      endpoint: "/api/ai-app-assistant/ask",
      streaming: false,
      redactSelectors: ["[data-sensitive]"],
      headers: async () => ({ authorization: "Bearer host-token" })
    });
    const answers: AiAppAssistantResponse[] = [];
    const states: string[] = [];
    element.addEventListener("ai-app-assistant-answer", (event) => {
      answers.push((event as CustomEvent<AiAppAssistantResponse>).detail);
    });
    element.addEventListener("ai-app-assistant-state-change", (event) => {
      states.push((event as CustomEvent<{ state: { status: string } }>).detail.state.status);
    });
    document.body.append(element);
    element.shadowRoot?.querySelector<HTMLButtonElement>("[data-action=open]")?.click();
    const textarea = element.shadowRoot?.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Assistant composer missing");
    textarea.value = "Explain this assessment";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));

    element.shadowRoot?.querySelector<HTMLFormElement>("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/ai-app-assistant/ask");
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer host-token"
    });
    const request = JSON.parse(String(init.body));
    expect(request.question).toBe("Explain this assessment");
    expect(request.html).toContain("Assessment");
    expect(request.html).not.toContain("Private value");
    expect(answers).toEqual([response()]);
    expect(states).toContain("loading");
    expect(states).toContain("success");
    expect(element.shadowRoot?.querySelector(".assistant")?.textContent).toContain("Safe answer");
  });

  it("renders host and assistant text as content instead of executable HTML", async () => {
    const unsafe = '<img src=x onerror="globalThis.compromised=true">';
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      ...response(),
      answer: { summary: unsafe, sections: [] }
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const element = document.createElement("ai-app-assistant") as AiAppAssistantElement;
    element.configure({ endpoint: "/ask", streaming: false, assistantName: unsafe });
    document.body.append(element);
    element.shadowRoot?.querySelector<HTMLButtonElement>("[data-action=open]")?.click();
    expect(element.shadowRoot?.querySelector("header img")).toBeNull();
    expect(element.shadowRoot?.querySelector("header")?.textContent).toContain(unsafe);

    element.shadowRoot?.querySelector<HTMLFormElement>("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();

    expect(element.shadowRoot?.querySelector(".assistant img")).toBeNull();
    expect(element.shadowRoot?.querySelector(".assistant")?.textContent).toContain(unsafe);
    expect((globalThis as typeof globalThis & { compromised?: boolean }).compromised).toBeUndefined();
  });
});

function response(): AiAppAssistantResponse {
  return {
    protocolVersion: "4",
    requestId: "response-1",
    answerability: "answered",
    answer: { summary: "Safe answer", sections: [] },
    evidence: [],
    limitations: [],
    confidence: { level: "high", score: 0.9, reasons: ["Supported"] },
    metadata: { durationMs: 1, model: "test:model" }
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
