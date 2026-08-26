import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AiSdkConfigurationError,
  AiSdkGenerationError,
  createAiSdkGenerator,
  isRetryableProviderError,
  testAiSdkConnection
} from "./ai-sdk.js";

const mocks = vi.hoisted(() => ({
  anthropicFactory: vi.fn(),
  generateText: vi.fn(),
  googleFactory: vi.fn(),
  mistralFactory: vi.fn(),
  openAiFactory: vi.fn(),
  streamText: vi.fn()
}));

vi.mock("ai", () => ({
  generateText: mocks.generateText,
  streamText: mocks.streamText,
  Output: { object: vi.fn(() => "structured-output") }
}));
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(() => mocks.anthropicFactory)
}));
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: vi.fn(() => mocks.googleFactory)
}));
vi.mock("@ai-sdk/mistral", () => ({
  createMistral: vi.fn(() => mocks.mistralFactory)
}));
vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn(() => mocks.openAiFactory)
}));

const generatedAnswer = {
  answerability: "answered" as const,
  answer: { summary: "A supported answer.", sections: [] },
  evidence: [{ source: "page-html" as const, reference: "page-html" }],
  limitations: []
};

describe("createAiSdkGenerator", () => {
  beforeEach(() => {
    delete process.env.MISTRAL_API_KEY;
    mocks.generateText.mockReset();
    mocks.generateText.mockResolvedValue({
      output: generatedAnswer,
      totalUsage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 }
    });
    mocks.anthropicFactory.mockReset();
    mocks.googleFactory.mockReset();
    mocks.mistralFactory.mockReset();
    mocks.openAiFactory.mockReset();
    mocks.streamText.mockReset();
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.MISTRAL_API_KEY;
  });

  it("resolves a Mistral string with only the native API key", async () => {
    const mistralModel = { provider: "mistral", modelId: "mistral-small-latest" };
    mocks.mistralFactory.mockReturnValue(mistralModel);
    const generator = createAiSdkGenerator({
      model: "mistral:mistral-small-latest",
      apiKey: "mistral-secret",
      timeoutMs: 45_000
    });

    await generator.generate({
      question: "What does this page do?",
      locale: "en",
      items: []
    });

    expect(mocks.mistralFactory).toHaveBeenCalledWith("mistral-small-latest");
    expect(generator.modelId).toBe("ai-sdk:mistral:mistral-small-latest");
    expect(generator.capabilities?.contextWindowTokens).toBe(256_000);
    expect(generator.capabilities?.estimatedCharactersPerToken).toBe(0.75);
    expect(mocks.generateText).toHaveBeenCalledWith(expect.objectContaining({
      model: mistralModel,
      maxOutputTokens: 1_200
    }));
    const call = mocks.generateText.mock.calls[0]?.[0];
    expect(call?.timeout).toBeGreaterThan(0);
    expect(call?.timeout).toBeLessThanOrEqual(45_000);
    expect(call?.system).toContain("N'invente jamais la signification d'un acronyme");
    expect(call?.system).toContain("n'utilise jamais un ton affirmatif pour une déduction incertaine");
    expect(call?.system).toContain("Respecte le format et le nombre d'éléments demandés");
    expect(call?.system).toContain("Une règle métier explicitement écrite");
    expect(call?.system).toContain("absence de données métier dynamiques");
    expect(call?.system).toContain("n'utilise ni Markdown");
  });

  it("bounds retries with one total generation deadline", async () => {
    vi.useFakeTimers();
    try {
      mocks.mistralFactory.mockReturnValue({ provider: "mistral", modelId: "small" });
      mocks.generateText.mockImplementation(({ abortSignal }: { abortSignal: AbortSignal }) =>
        new Promise((_resolve, reject) => abortSignal.addEventListener("abort", () => reject(abortSignal.reason))));
      const generator = createAiSdkGenerator({
        model: "mistral:small",
        apiKey: "secret",
        timeoutMs: 1_000,
        maxRetries: 5,
        retryBaseDelayMs: 0
      });

      const generation = generator.generate({ question: "Question", locale: "en", items: [] });
      const expectedFailure = expect(generation).rejects.toMatchObject({ code: "TIMEOUT", attempts: 1 });
      await vi.advanceTimersByTimeAsync(1_001);
      await expectedFailure;
      expect(mocks.generateText).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("detects the larger GPT-5.6 Sol context without provider-specific setup", () => {
    mocks.openAiFactory.mockReturnValue({ provider: "openai", modelId: "gpt-5.6-sol" });
    const generator = createAiSdkGenerator({ model: "openai:gpt-5.6-sol", apiKey: "openai-secret" });
    expect(generator.capabilities).toMatchObject({
      contextWindowTokens: 1_050_000,
      maxOutputTokens: 128_000
    });
  });

  it("retries a transient generation failure five times after the initial call", async () => {
    mocks.mistralFactory.mockReturnValue({ provider: "mistral", modelId: "small" });
    const transient = Object.assign(new Error("temporary"), { isRetryable: true });
    mocks.generateText
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce({ output: generatedAnswer });
    const generator = createAiSdkGenerator({
      model: "mistral:small",
      apiKey: "secret",
      retryBaseDelayMs: 0
    });

    await expect(generator.generate({ question: "Question", locale: "en", items: [] }))
      .resolves.toEqual(generatedAnswer);
    expect(mocks.generateText).toHaveBeenCalledTimes(6);
  });

  it("does not retry non-transient provider errors", async () => {
    mocks.mistralFactory.mockReturnValue({ provider: "mistral", modelId: "small" });
    mocks.generateText.mockRejectedValue(Object.assign(new Error("bad key"), {
      statusCode: 401,
      isRetryable: false
    }));
    const generator = createAiSdkGenerator({
      model: "mistral:small",
      apiKey: "secret",
      retryBaseDelayMs: 0
    });

    const failure = generator.generate({ question: "Question", locale: "en", items: [] });
    await expect(failure).rejects.toThrow("[AUTHENTICATION]");
    await expect(failure).rejects.toBeInstanceOf(AiSdkGenerationError);
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
  });

  it("reports context overflow without retrying the same oversized prompt", async () => {
    mocks.mistralFactory.mockReturnValue({ provider: "mistral", modelId: "small" });
    mocks.generateText.mockRejectedValue(Object.assign(
      new Error("Prompt 397215 > 262144 maximum context length"),
      { statusCode: 400 }
    ));
    const generator = createAiSdkGenerator({
      model: "mistral:small",
      apiKey: "secret",
      retryBaseDelayMs: 0
    });

    await expect(generator.generate({ question: "Question", locale: "en", items: [] }))
      .rejects.toMatchObject({
        name: "AiSdkGenerationError",
        code: "CONTEXT_LIMIT",
        attempts: 1,
        retryable: false,
        providerStatus: 400
      });
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
  });

  it("retries malformed structured output returned by a provider", async () => {
    mocks.mistralFactory.mockReturnValue({ provider: "mistral", modelId: "small" });
    mocks.generateText
      .mockRejectedValueOnce(Object.assign(new Error("invalid object"), {
        name: "AI_NoObjectGeneratedError"
      }))
      .mockResolvedValueOnce({ output: generatedAnswer });
    const generator = createAiSdkGenerator({
      model: "mistral:small",
      apiKey: "secret",
      retryBaseDelayMs: 0
    });

    await expect(generator.generate({ question: "Question", locale: "en", items: [] }))
      .resolves.toMatchObject(generatedAnswer);
    expect(mocks.generateText).toHaveBeenCalledTimes(2);
  });

  it("retries a structured answer whose summary ends mid-sentence", async () => {
    mocks.mistralFactory.mockReturnValue({ provider: "mistral", modelId: "small" });
    mocks.generateText
      .mockResolvedValueOnce({
        output: {
          ...generatedAnswer,
          answer: { summary: "The dashboard highlights items based on their status and", sections: [] }
        }
      })
      .mockResolvedValueOnce({ output: generatedAnswer });
    const generator = createAiSdkGenerator({
      model: "mistral:small",
      apiKey: "secret",
      retryBaseDelayMs: 0
    });

    await expect(generator.generate({ question: "Question", locale: "en", items: [] }))
      .resolves.toMatchObject(generatedAnswer);
    expect(mocks.generateText).toHaveBeenCalledTimes(2);
  });

  it("degrades an invented acronym expansion to a safe limitation", async () => {
    mocks.mistralFactory.mockReturnValue({ provider: "mistral", modelId: "small" });
    mocks.generateText
      .mockResolvedValueOnce({
        output: {
          ...generatedAnswer,
          answer: {
            summary: "This does not meet the criteria for mobility (M) or very high mobility (vM).",
            sections: [{
              heading: "Limitation",
              content: "The acronym M/vM is not explicitly defined in the evidence."
            }]
          }
        }
      });
    const generator = createAiSdkGenerator({
      model: "mistral:small",
      apiKey: "secret",
      retryBaseDelayMs: 0
    });

    await expect(generator.generate({ question: "Question", locale: "en", items: [] }))
      .resolves.toMatchObject({
        answerability: "partial",
        answer: { summary: expect.stringContaining("M/vM is not explicitly defined") }
      });
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
  });

  it("degrades a contradictory label interpretation without wasting retries", async () => {
    mocks.mistralFactory.mockReturnValue({ provider: "mistral", modelId: "small" });
    mocks.generateText
      .mockResolvedValueOnce({
        output: {
          ...generatedAnswer,
          answer: {
            summary: "The label 'Not M/vM' indicates that the item is not being mobile or very mobile.",
            sections: [{
              heading: "Limitation",
              content: "The acronym M/vM is not explicitly defined in the provided evidence."
            }]
          }
        }
      });
    const generator = createAiSdkGenerator({
      model: "mistral:small",
      apiKey: "secret",
      retryBaseDelayMs: 0
    });

    await expect(generator.generate({ question: "Question", locale: "en", items: [] }))
      .resolves.toMatchObject({
        answerability: "partial",
        answer: { summary: expect.stringContaining("M/vM is not explicitly defined") }
      });
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
  });

  it("finds a retryable structured-output failure through wrapped causes", () => {
    const error = Object.assign(new Error("wrapped"), {
      cause: Object.assign(new Error("schema"), { name: "ZodError" })
    });

    expect(isRetryableProviderError(error)).toBe(true);
  });

  it("streams partial text and exposes retry progress before completing", async () => {
    mocks.mistralFactory.mockReturnValue({ provider: "mistral", modelId: "small" });
    const transient = Object.assign(new Error("temporary"), { isRetryable: true });
    mocks.streamText
      .mockReturnValueOnce({
        partialOutputStream: (async function* () { throw transient; })(),
        output: Promise.resolve(generatedAnswer),
        totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })
      })
      .mockReturnValueOnce({
        partialOutputStream: (async function* () {
          yield { answer: { summary: "A partial answer" } };
        })(),
        output: Promise.resolve(generatedAnswer),
        totalUsage: Promise.resolve({ inputTokens: 200, outputTokens: 50, totalTokens: 250 })
      });
    const generator = createAiSdkGenerator({
      model: "mistral:small",
      apiKey: "secret",
      retryBaseDelayMs: 0
    });
    const stream = generator.stream!({ question: "Question", locale: "en", items: [] });

    await expect(stream.next()).resolves.toMatchObject({
      value: { type: "retry", attempt: 1, maxRetries: 5 }, done: false
    });
    await expect(stream.next()).resolves.toEqual({
      value: { type: "partial", text: "A partial answer" }, done: false
    });
    await expect(stream.next()).resolves.toEqual({
      value: {
        ...generatedAnswer,
        usage: { inputTokens: 200, outputTokens: 50, totalTokens: 250 }
      },
      done: true
    });
  });

  it("reads only the selected provider environment variable", () => {
    process.env.ANTHROPIC_API_KEY = "anthropic-secret";
    const anthropicModel = { provider: "anthropic", modelId: "claude-sonnet" };
    mocks.anthropicFactory.mockReturnValue(anthropicModel);

    const generator = createAiSdkGenerator({
      model: "anthropic/claude-sonnet"
    });

    expect(mocks.anthropicFactory).toHaveBeenCalledWith("claude-sonnet");
    expect(generator.modelId).toBe("ai-sdk:anthropic:claude-sonnet");
  });

  it("fails before a request when the selected provider key is missing", () => {
    expect(() => createAiSdkGenerator({
      model: "mistral:mistral-small-latest"
    })).toThrowError(AiSdkConfigurationError);
  });

  it("accepts an injected provider model and infers its metadata", () => {
    const model = {
      specificationVersion: "v3",
      provider: "custom-provider",
      modelId: "custom-model"
    } as Parameters<typeof createAiSdkGenerator>[0]["model"];

    const generator = createAiSdkGenerator({ model });

    expect(generator.modelId).toBe("ai-sdk:custom-provider:custom-model");
  });

  it("tests a model with one minimal structured-output request", async () => {
    mocks.mistralFactory.mockReturnValue({ provider: "mistral", modelId: "small" });
    mocks.generateText.mockResolvedValueOnce({ output: { status: "ok" } });

    await expect(testAiSdkConnection({
      model: "mistral:small",
      apiKey: "secret"
    })).resolves.toMatchObject({
      success: true,
      model: "mistral:small"
    });
    expect(mocks.generateText).toHaveBeenLastCalledWith(expect.objectContaining({
      maxRetries: 0,
      maxOutputTokens: 32
    }));
  });

  it("returns a safe connection failure instead of throwing", async () => {
    mocks.mistralFactory.mockReturnValue({ provider: "mistral", modelId: "small" });
    mocks.generateText.mockRejectedValueOnce(Object.assign(new Error("bad key"), {
      statusCode: 401,
      isRetryable: false
    }));

    await expect(testAiSdkConnection({
      model: "mistral:small",
      apiKey: "secret"
    })).resolves.toMatchObject({
      success: false,
      error: { code: "AUTHENTICATION", retryable: false, providerStatus: 401 }
    });
  });
});
