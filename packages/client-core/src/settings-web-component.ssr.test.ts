import { describe, expect, it, vi } from "vitest";

describe("settings web component SSR import", () => {
  it("does not require browser globals while importing", async () => {
    vi.stubGlobal("HTMLElement", undefined);
    vi.stubGlobal("customElements", undefined);
    try {
      const module = await import("./settings-web-component.js");
      expect(module.AiDocsSettingsElement).toBeTypeOf("function");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
