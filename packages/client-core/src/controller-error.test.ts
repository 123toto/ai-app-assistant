import { describe, expect, it } from "vitest";
import { AiAppAssistantHttpError } from "./client.js";
import { normalizeAiAppAssistantError } from "./controller.js";

describe("normalizeAiAppAssistantError", () => {
  it("extracts a useful message from nested HTTP JSON", () => {
    const error = new AiAppAssistantHttpError(500, JSON.stringify({
      error: { message: "Provider temporarily unavailable" }
    }));
    expect(normalizeAiAppAssistantError(error).message).toBe("Provider temporarily unavailable");
  });

  it("never displays an object coercion and preserves cancellation", () => {
    expect(normalizeAiAppAssistantError({ error: { message: {} } }).message)
      .toBe("The assistant request failed. Please try again.");
    const cancelled = new DOMException("Stopped", "AbortError");
    expect(normalizeAiAppAssistantError(cancelled)).toBe(cancelled);
  });
});
