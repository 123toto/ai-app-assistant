import { describe, expect, it } from "vitest";
import { AiAppAssistantHttpError } from "./client.js";
import {
  isRetryableAiAppAssistantError,
  normalizeAiAppAssistantError
} from "./controller.js";

describe("normalizeAiAppAssistantError", () => {
  it("uses the current AI Assistant product name in HTTP failures", () => {
    const error = new AiAppAssistantHttpError(500, "");

    expect(error.message).toBe("AI Assistant request failed with status 500.");
    expect(error.message.toLowerCase()).not.toContain("docs");
  });

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

  it("does not retry quota, authorization or configuration failures", () => {
    for (const [status, error] of [
      [429, "quota_reached"],
      [403, "forbidden"],
      [503, "not_configured"]
    ] as const) {
      expect(isRetryableAiAppAssistantError(new AiAppAssistantHttpError(
        status,
        JSON.stringify({ error, message: "Unavailable" })
      ))).toBe(false);
    }
  });

  it("keeps retry available for transient provider and transport failures", () => {
    expect(isRetryableAiAppAssistantError({ retryable: true })).toBe(true);
    expect(isRetryableAiAppAssistantError(new AiAppAssistantHttpError(
      502,
      JSON.stringify({ error: "assistant_error" })
    ))).toBe(true);
  });
});
