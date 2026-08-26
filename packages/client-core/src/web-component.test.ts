// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { AiAppAssistantElement, defineAiAppAssistantElement } from "./web-component.js";

afterEach(() => { document.body.innerHTML = ""; });

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
});
