import {
  PROTOCOL_VERSION,
  askDocumentationRequestSchema,
  generatedAnswerSchema,
  type AskDocumentationRequest,
  type AskDocumentationResponse
} from "@123toto/ai-app-assistant-contracts";
import { evaluateConfidence } from "./confidence.js";
import type {
  DocumentationSource,
  DocsAssistantOptions,
  EvidenceBundle,
  EvidenceItem
} from "./types.js";

const FALLBACK_CONTEXT_WINDOW_TOKENS = 128_000;
const FALLBACK_OUTPUT_TOKENS = 8_000;
const FALLBACK_CHARACTERS_PER_TOKEN = 2;

export type DocsAssistantStreamEvent =
  | { type: "status"; phase: "preparing" | "generating" }
  | { type: "partial"; text: string }
  | { type: "retry"; attempt: number; maxRetries: number; delayMs: number }
  | { type: "complete"; response: AskDocumentationResponse };

/** Stateful facade whose static documentation is prepared only once. */
export interface DocsAssistant {
  answer(
    request: AskDocumentationRequest,
    options?: { signal?: AbortSignal }
  ): Promise<AskDocumentationResponse>;
  /** Streams provider-neutral progress and always ends with a complete event. */
  stream(
    request: AskDocumentationRequest,
    options?: { signal?: AbortSignal }
  ): AsyncGenerator<DocsAssistantStreamEvent, AskDocumentationResponse>;
}

/**
 * Creates a provider-neutral documentation assistant.
 *
 * Documents are serialized, bounded and deduplicated during this call. Each
 * subsequent question only adds the current page HTML, an optional selected
 * element and the user's prompt. This keeps the public integration small and
 * lets provider-side prompt caching reuse the stable document prefix.
 */
export function createDocsAssistant(options: DocsAssistantOptions): DocsAssistant {
  const minimumEvidence = clampInteger(
    options.policies?.minimumEvidence ?? 1,
    1,
    100
  );
  const documents = prepareDocuments(options.documents ?? []);

  const prepare = (request: AskDocumentationRequest): {
    validated: AskDocumentationRequest;
    bundle: EvidenceBundle;
  } => {
    const validated = askDocumentationRequestSchema.parse(request);
    return { validated, bundle: prepareBundle(validated, documents, options) };
  };

  const finalize = (
    validated: AskDocumentationRequest,
    bundle: EvidenceBundle,
    generatedInput: unknown,
    startedAt: number
  ): AskDocumentationResponse => {
    const generated = generatedAnswerSchema.parse(generatedInput);
    const usage = readTokenUsage(generatedInput);
    const confidence = evaluateConfidence(bundle, generated, minimumEvidence);
    const allowedReferences = new Set(bundle.items.map((item) => item.reference));

    return {
      protocolVersion: PROTOCOL_VERSION,
      requestId: validated.requestId,
      answerability: generated.answerability,
      answer: generated.answer,
      evidence: generated.evidence.filter((item) => allowedReferences.has(item.reference)),
      limitations: generated.limitations,
      confidence,
      metadata: {
        durationMs: Math.round(performance.now() - startedAt),
        model: options.generator.modelId,
        ...(usage ? { usage } : {})
      }
    };
  };

  return {
    async answer(request, callOptions) {
      const startedAt = performance.now();
      const { validated, bundle } = prepare(request);

      if (bundle.items.length < minimumEvidence) {
        return insufficientResponse(
          validated.requestId,
          options.generator.modelId,
          performance.now() - startedAt
        );
      }

      const generated = await options.generator.generate(bundle, callOptions?.signal);
      return finalize(validated, bundle, generated, startedAt);
    },

    async *stream(request, callOptions) {
      const startedAt = performance.now();
      yield { type: "status", phase: "preparing" };
      const { validated, bundle } = prepare(request);

      if (bundle.items.length < minimumEvidence) {
        const response = insufficientResponse(
          validated.requestId,
          options.generator.modelId,
          performance.now() - startedAt
        );
        yield { type: "complete", response };
        return response;
      }

      yield { type: "status", phase: "generating" };
      if (!options.generator.stream) {
        const generated = await options.generator.generate(bundle, callOptions?.signal);
        const response = finalize(validated, bundle, generated, startedAt);
        yield { type: "complete", response };
        return response;
      }

      const generation = options.generator.stream(bundle, {
        ...(callOptions?.signal ? { signal: callOptions.signal } : {})
      });
      let generated: Awaited<ReturnType<typeof options.generator.generate>> | undefined;
      while (true) {
        const next = await generation.next();
        if (next.done) {
          generated = next.value;
          break;
        }
        yield next.value;
      }

      const response = finalize(validated, bundle, generated, startedAt);
      yield { type: "complete", response };
      return response;
    }
  };
}

/** Keeps accounting optional so custom generators do not need to implement it. */
function readTokenUsage(input: unknown): {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
} | undefined {
  if (!input || typeof input !== "object" || !("usage" in input)) return undefined;
  const usage = (input as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return undefined;
  const raw = usage as Record<string, unknown>;
  const normalized = {
    ...(isTokenCount(raw.inputTokens) ? { inputTokens: raw.inputTokens } : {}),
    ...(isTokenCount(raw.outputTokens) ? { outputTokens: raw.outputTokens } : {}),
    ...(isTokenCount(raw.totalTokens) ? { totalTokens: raw.totalTokens } : {})
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

interface PreparedDocument {
  id: string;
  content: string;
}

/** Serializes static sources once; bounding is model-aware and happens per bundle. */
function prepareDocuments(sources: DocumentationSource[]): readonly PreparedDocument[] {
  const seen = new Set<string>();
  const documents: PreparedDocument[] = [];

  for (const source of sources) {
    const id = source.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const serialized = serializeDocumentationContent(source.content);
    if (!serialized) continue;
    const content = [
      `Document: ${source.title}`,
      source.mediaType ? `Media type: ${source.mediaType}` : undefined,
      serialized
    ].filter(Boolean).join("\n");
    documents.push({ id, content });
  }

  return Object.freeze(documents.map((item) => Object.freeze(item)));
}

function prepareBundle(
  request: AskDocumentationRequest,
  documents: readonly PreparedDocument[],
  options: DocsAssistantOptions
): EvidenceBundle {
  const capabilities = options.generator.capabilities;
  const contextWindow = capabilities?.contextWindowTokens ?? FALLBACK_CONTEXT_WINDOW_TOKENS;
  const outputReserve = Math.min(
    capabilities?.maxOutputTokens ?? FALLBACK_OUTPUT_TOKENS,
    Math.floor(contextWindow * 0.25)
  );
  const safetyReserve = Math.max(4_000, Math.floor(contextWindow * 0.08));
  const inputTokens = Math.max(8_000, contextWindow - outputReserve - safetyReserve);
  const totalChars = Math.floor(
    inputTokens * (capabilities?.estimatedCharactersPerToken ?? FALLBACK_CHARACTERS_PER_TOKEN)
  );
  const selectedLimit = resolveLimit(
    options.policies?.maxSelectedElementEvidenceChars,
    Math.min(100_000, Math.max(20_000, Math.floor(totalChars * 0.1)))
  );
  const htmlLimit = resolveLimit(
    options.policies?.maxHtmlEvidenceChars,
    Math.max(40_000, Math.floor(totalChars * 0.4))
  );
  const documentTotalLimit = resolveLimit(
    options.policies?.maxDocumentTotalChars,
    Math.max(40_000, totalChars - selectedLimit - htmlLimit)
  );
  const documentLimit = resolveLimit(
    options.policies?.maxDocumentEvidenceChars,
    documentTotalLimit
  );
  const items: EvidenceItem[] = [];

  if (request.selectedElementHtml) {
    items.push({
      source: "selected-element",
      reference: "selected-element",
      content: boundEvidence(
        request.selectedElementHtml,
        selectedLimit,
        "AI_DOCS_SELECTED_ELEMENT_TRUNCATED"
      ),
      relevance: 1
    });
  }

  items.push({
    source: "page-html",
    reference: "page-html",
    content: boundHtml(request.html, htmlLimit, request.htmlTruncated),
    relevance: 0.98
  });

  let remainingDocuments = documentTotalLimit;
  for (const document of documents) {
    if (remainingDocuments <= 0) break;
    const limit = Math.min(documentLimit, remainingDocuments);
    const content = boundEvidence(document.content, limit, "AI_DOCS_DOCUMENT_TRUNCATED");
    remainingDocuments -= content.length;
    items.push({
      source: "document",
      reference: `document:${document.id}`,
      content,
      relevance: 0.88
    });
  }

  return {
    question: request.question,
    locale: request.locale,
    ...(request.conversation?.length ? { conversation: request.conversation } : {}),
    items
  };
}

function serializeDocumentationContent(
  content: DocumentationSource["content"]
): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content);
  } catch {
    return "";
  }
}

function boundHtml(
  content: string,
  maxChars: number | undefined,
  alreadyTruncated: boolean
): string {
  const limit = optionalBound(maxChars, 1_000, 8_000_000);
  return alreadyTruncated
    ? `${content.slice(0, limit)}\n<!-- AI_DOCS_HTML_TRUNCATED -->`
    : boundEvidence(content, limit, "AI_DOCS_HTML_TRUNCATED");
}

/** Truncates one evidence item while making the loss explicit to the model. */
function boundEvidence(content: string, limit: number, marker: string): string {
  if (content.length <= limit) return content;
  const markerText = `\n<!-- ${marker} -->\n`;
  const available = Math.max(0, limit - markerText.length);
  const headLength = Math.ceil(available * 0.7);
  return `${content.slice(0, headLength)}${markerText}${content.slice(-(available - headLength))}`;
}

function optionalBound(
  value: number | undefined,
  minimum: number,
  maximum: number
): number {
  return value === undefined
    ? Number.POSITIVE_INFINITY
    : clampInteger(value, minimum, maximum);
}

function resolveLimit(override: number | undefined, calculated: number): number {
  return optionalBound(override ?? calculated, 1_000, 16_000_000);
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function insufficientResponse(
  requestId: string,
  model: string,
  durationMs: number
): AskDocumentationResponse {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    answerability: "not-answerable",
    answer: {
      summary: "Les informations disponibles ne permettent pas de répondre de façon fiable.",
      sections: []
    },
    evidence: [],
    limitations: ["Aucune preuve exploitable n’a été fournie."],
    confidence: {
      level: "insufficient",
      score: 0,
      reasons: ["Le seuil minimal de preuves n’est pas atteint."]
    },
    metadata: {
      durationMs: Math.round(durationMs),
      model
    }
  };
}
