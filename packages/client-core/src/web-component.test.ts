// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { AiDocsAssistantElement, defineAiDocsAssistantElement } from "./web-component.js";

afterEach(() => { document.body.innerHTML = ""; });

describe("AiDocsAssistantElement", () => {
  it("registers a framework-independent custom element", () => {
    expect(customElements.get("ai-docs-assistant")).toBe(AiDocsAssistantElement);
    expect(defineAiDocsAssistantElement()).toBe(AiDocsAssistantElement);
  });

  it("renders the generic assistant from HTML attributes", () => {
    const element = document.createElement("ai-docs-assistant") as AiDocsAssistantElement;
    element.setAttribute("endpoint", "/api/ai-docs/ask");
    element.setAttribute("assistant-name", "Application assistant");
    document.body.append(element);

    element.shadowRoot?.querySelector<HTMLButtonElement>("[data-action='open']")?.click();

    expect(element.shadowRoot?.querySelector(".panel")?.textContent).toContain("Application assistant");
    expect(element.shadowRoot?.querySelector("textarea")).not.toBeNull();
  });
});
