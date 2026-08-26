import { describe, expect, it } from "vitest";

describe("web component server-side import", () => {
  it("does not require browser globals while the module is evaluated", async () => {
    const module = await import("./web-component.js");

    expect(module.AiDocsAssistantElement).toBeTypeOf("function");
  });
});
