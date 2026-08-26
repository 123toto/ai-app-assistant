import { describe, expect, it } from "vitest";
import { AiDocsHttpError } from "./client.js";
import { normalizeAiDocsError } from "./controller.js";

describe("normalizeAiDocsError", () => {
  it("extracts a useful message from nested HTTP JSON", () => {
    const error = new AiDocsHttpError(500, JSON.stringify({
      error: { message: "Provider temporarily unavailable" }
    }));
    expect(normalizeAiDocsError(error).message).toBe("Provider temporarily unavailable");
  });

  it("never displays an object coercion and preserves cancellation", () => {
    expect(normalizeAiDocsError({ error: { message: {} } }).message)
      .toBe("The assistant request failed. Please try again.");
    const cancelled = new DOMException("Stopped", "AbortError");
    expect(normalizeAiDocsError(cancelled)).toBe(cancelled);
  });
});
