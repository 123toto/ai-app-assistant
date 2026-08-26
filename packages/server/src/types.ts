import type { ConversationMessage, EvidenceSource, GeneratedAnswer, TokenUsage } from "@123toto/ai-app-assistant-contracts";

/** Minimal OpenAPI shape used by the optional documentation audit command. */
export interface OpenApiDocument {
  openapi: string;
  info?: {
    title?: string;
    description?: string;
  };
  paths?: Record<string, unknown>;
  components?: {
    schemas?: Record<string, unknown>;
  };
}

/** Minimal operation shape used by the optional documentation audit command. */
export interface OpenApiOperation {
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: unknown;
  responses?: unknown;
  requestBody?: unknown;
}

/**
 * A trusted document made available to the model for every question.
 *
 * `content` accepts JSON-compatible objects so an OpenAPI document can be
 * supplied directly, without a dedicated integration or preprocessing step.
 */
export interface DocumentationSource {
  id: string;
  title: string;
  content: string | object;
  mediaType?: string;
}

/** One bounded piece of information that may support the generated answer. */
export interface EvidenceItem {
  source: EvidenceSource;
  reference: string;
  content: string;
  relevance: number;
}

/** Input passed to an LLM adapter after local validation and preparation. */
export interface EvidenceBundle {
  question: string;
  locale: string;
  /** Recent turns used only to resolve follow-up questions. */
  conversation?: ConversationMessage[];
  items: EvidenceItem[];
}

/** Context limits used to size evidence before it reaches a provider. */
export interface ModelCapabilities {
  /** Total input and output window advertised by the selected model. */
  contextWindowTokens: number;
  /** Tokens kept available for the structured answer. */
  maxOutputTokens: number;
  /** Conservative tokenizer-independent estimate used for HTML and JSON. */
  estimatedCharactersPerToken: number;
}

/** Observable progress produced while a provider builds a structured answer. */
export type GenerationProgress =
  | { type: "partial"; text: string }
  | { type: "retry"; attempt: number; maxRetries: number; delayMs: number };

export interface GenerationOptions {
  signal?: AbortSignal;
}

/** Generated content plus optional provider accounting data. */
export type GenerationResult = GeneratedAnswer & { usage?: TokenUsage };

/** Provider-neutral contract implemented by an LLM adapter. */
export interface AnswerGenerator {
  readonly modelId: string;
  /** Optional limits let the assistant adapt automatically to another model. */
  readonly capabilities?: ModelCapabilities;
  generate(input: EvidenceBundle, signal?: AbortSignal): Promise<GenerationResult>;
  /** Optional progressive path. The non-streaming `generate` method remains supported. */
  stream?(
    input: EvidenceBundle,
    options?: GenerationOptions
  ): AsyncGenerator<GenerationProgress, GenerationResult>;
}

/** Configuration shared by all calls made through an assistant instance. */
export interface AiAppAssistantOptions {
  generator: AnswerGenerator;
  /**
   * Application documentation loaded and serialized once when the assistant is
   * created. Markdown, OpenAPI JSON, wiki exports and similar text are all valid.
   */
  documents?: DocumentationSource[];
  policies?: {
    minimumEvidence?: number;
    /** Maximum characters kept from the selected DOM element. */
    maxSelectedElementEvidenceChars?: number;
    /** Maximum characters kept from the complete rendered page. */
    maxHtmlEvidenceChars?: number;
    /** Maximum characters kept from one configured document. */
    maxDocumentEvidenceChars?: number;
    /** Maximum characters shared by all configured documents. */
    maxDocumentTotalChars?: number;
  };
}
