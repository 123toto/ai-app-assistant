import { z } from "zod";

/** Wire protocol version shared by the browser client and the backend. */
export const PROTOCOL_VERSION = "3" as const;

/** Providers supported by the optional managed runtime and settings UI. */
export const aiDocsProviderSchema = z.enum([
  "anthropic",
  "google",
  "mistral",
  "ollama",
  "openai"
]);

export const aiDocsAccessRuleSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }),
  z.object({ mode: z.literal("roles"), roles: z.array(z.string().min(1)).min(1) }),
  z.object({ mode: z.literal("users"), userIds: z.array(z.string().min(1)).min(1) })
]);

/** Safe configuration payload shared by every administration UI. */
export const aiDocsConfigurationInputSchema = z.object({
  provider: aiDocsProviderSchema,
  model: z.string().trim().min(1),
  apiKey: z.string().trim().min(1).optional(),
  baseURL: z.string().url().optional(),
  access: aiDocsAccessRuleSchema,
  quota: z.object({
    maxRequests: z.number().int().min(1).max(10_000),
    windowSeconds: z.number().int().min(60).max(31_536_000)
  }).optional(),
  maxConversationTurns: z.number().int().min(1).max(10).default(3),
  allowModelChangesByOthers: z.boolean().optional()
});

export const aiDocsCredentialsSchema = aiDocsConfigurationInputSchema.pick({
  provider: true,
  apiKey: true,
  baseURL: true
});

export const aiDocsConnectionTestInputSchema = aiDocsCredentialsSchema.extend({
  model: z.string().trim().min(1)
});

export const aiDocsConfigurationActorSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1)
});

export const aiDocsConfigurationAuditEntrySchema = z.object({
  id: z.string().min(1),
  actor: aiDocsConfigurationActorSchema,
  changedAt: z.string().datetime(),
  changes: z.array(z.object({
    field: z.enum(["provider", "apiKey", "model", "access", "quota", "conversation", "modelChangePolicy"]),
    from: z.string().optional(),
    to: z.string().optional()
  }))
});

export const aiDocsRuntimeConnectionSchema = z.object({
  status: z.enum(["connected", "disconnected", "not-configured", "unchecked"]),
  checkedAt: z.string().datetime().optional(),
  model: z.string().optional()
});

const aiDocsConfigurationFieldSourceSchema = z.enum(["environment", "override", "default", "none"]);

/** Credential-free configuration response validated by every settings client. */
export const aiDocsManagedConfigurationViewSchema = z.object({
  provider: aiDocsProviderSchema.nullable(),
  model: z.string(),
  baseURL: z.string().url().optional(),
  access: aiDocsAccessRuleSchema,
  quota: z.object({
    maxRequests: z.number().int().positive(),
    windowSeconds: z.number().int().positive()
  }).optional(),
  maxConversationTurns: z.number().int().min(1).max(10),
  apiKeyConfigured: z.boolean(),
  apiKeyStorageAvailable: z.boolean(),
  configured: z.boolean(),
  source: z.enum(["environment", "stored"]),
  administration: z.object({
    keyCreatedBy: aiDocsConfigurationActorSchema.optional(),
    keyCreatedAt: z.string().datetime().optional(),
    modelUpdatedBy: aiDocsConfigurationActorSchema.optional(),
    modelUpdatedAt: z.string().datetime().optional(),
    allowModelChangesByOthers: z.boolean(),
    history: z.array(aiDocsConfigurationAuditEntrySchema)
  }).optional(),
  allowModelChangesByOthers: z.boolean(),
  canChangeModel: z.boolean(),
  canManageCredentials: z.boolean(),
  canManageModelPolicy: z.boolean(),
  canRevokeApiKey: z.boolean(),
  fieldSources: z.object({
    provider: aiDocsConfigurationFieldSourceSchema,
    model: aiDocsConfigurationFieldSourceSchema,
    apiKey: aiDocsConfigurationFieldSourceSchema,
    baseURL: aiDocsConfigurationFieldSourceSchema,
    access: aiDocsConfigurationFieldSourceSchema,
    quota: aiDocsConfigurationFieldSourceSchema,
    conversation: aiDocsConfigurationFieldSourceSchema
  }),
  connection: aiDocsRuntimeConnectionSchema
});

export const aiDocsConnectionResultSchema = z.discriminatedUnion("success", [
  z.object({
    success: z.literal(true),
    model: z.string(),
    latencyMs: z.number().nonnegative()
  }),
  z.object({
    success: z.literal(false),
    model: z.string(),
    latencyMs: z.number().nonnegative(),
    error: z.object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
      providerStatus: z.number().int().optional()
    })
  })
]);

export const aiDocsProviderInfoSchema = z.object({
  id: aiDocsProviderSchema,
  label: z.string(),
  requiresApiKey: z.boolean(),
  supportsModelDiscovery: z.boolean()
});

export const aiDocsModelInfoSchema = z.object({
  id: z.string().min(1),
  provider: aiDocsProviderSchema,
  label: z.string().optional(),
  createdAt: z.string().optional()
});

export const aiDocsConfigurationOptionsSchema = z.object({
  roles: z.array(z.object({ id: z.string().min(1), label: z.string() })),
  users: z.array(z.object({ id: z.string().min(1), label: z.string() }))
});

export const aiDocsConfigurationSaveResultSchema = z.object({
  saved: z.boolean(),
  connection: aiDocsConnectionResultSchema,
  configuration: aiDocsManagedConfigurationViewSchema.optional()
});

/** Small response used by managed clients to decide whether the launcher is visible. */
export const aiDocsAccessViewSchema = z.object({
  available: z.boolean(),
  maxConversationTurns: z.number().int().min(1).max(10)
});

/** Short bounded history automatically maintained by chatbot clients. */
export const conversationMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(8_000)
});

/** Minimal request sent by any frontend integration. */
export const askDocumentationRequestSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.string().min(1).max(200),
  html: z.string().min(1).max(8_000_000),
  htmlTruncated: z.boolean().default(false),
  /** Exact fragment selected by the user; no custom DOM attribute is required. */
  selectedElementHtml: z.string().min(1).max(500_000).optional(),
  question: z.string().min(1).max(4_000),
  /** Up to ten user/assistant pairs; clients choose a lower visible limit. */
  conversation: z.array(conversationMessageSchema).max(20).optional(),
  locale: z.string().max(50).default("fr")
});

/** Sources that can reach the model in the simplified pipeline. */
export const evidenceSchema = z.object({
  source: z.enum(["page-html", "selected-element", "document"]),
  reference: z.string(),
  excerpt: z.string().optional()
});

export const documentationAnswerContentSchema = z.object({
  title: z.string().optional(),
  summary: z.string(),
  sections: z.array(z.object({
    heading: z.string(),
    content: z.string()
  })).default([]),
  steps: z.array(z.object({
    label: z.string(),
    description: z.string()
  })).optional(),
  warnings: z.array(z.string()).optional()
});

/** Provider-independent answer expected from an injected generator. */
export const generatedAnswerSchema = z.object({
  /** Whether the exact user request is supported by the supplied evidence. */
  answerability: z.enum(["answered", "partial", "not-answerable"]).default("answered"),
  answer: documentationAnswerContentSchema,
  evidence: z.array(evidenceSchema).default([]),
  limitations: z.array(z.string()).default([])
});

/** Token consumption reported by the active model provider. */
export const tokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional()
});

export const askDocumentationResponseSchema = generatedAnswerSchema.extend({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.string(),
  confidence: z.object({
    level: z.enum(["high", "medium", "low", "insufficient"]),
    score: z.number().min(0).max(1),
    reasons: z.array(z.string())
  }),
  metadata: z.object({
    durationMs: z.number().nonnegative(),
    model: z.string(),
    /** Present when the provider exposes usage for the completed request. */
    usage: tokenUsageSchema.optional()
  })
});

/** NDJSON events emitted by the optional progressive endpoint. */
export const askDocumentationStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status"), phase: z.enum(["preparing", "generating"]) }),
  z.object({ type: z.literal("partial"), text: z.string() }),
  z.object({
    type: z.literal("retry"),
    attempt: z.number().int().min(1),
    maxRetries: z.number().int().min(1),
    delayMs: z.number().int().nonnegative()
  }),
  z.object({
    type: z.literal("error"),
    message: z.string(),
    retryable: z.boolean(),
    /** Safe diagnostic fields; no provider response body is exposed. */
    code: z.string().optional(),
    requestId: z.string().optional()
  }),
  z.object({ type: z.literal("complete"), response: askDocumentationResponseSchema })
]);

export type EvidenceSource = z.infer<typeof evidenceSchema>["source"];
export type AiDocsProvider = z.infer<typeof aiDocsProviderSchema>;
export type AiDocsAccessRule = z.infer<typeof aiDocsAccessRuleSchema>;
export type AiDocsConfigurationInput = z.infer<typeof aiDocsConfigurationInputSchema>;
export type AiDocsCredentials = z.infer<typeof aiDocsCredentialsSchema>;
export type AiDocsConnectionTestInput = z.infer<typeof aiDocsConnectionTestInputSchema>;
export type AiDocsConfigurationFieldSource = "environment" | "override" | "default" | "none";
export type AiDocsRuntimeConnectionStatus = "connected" | "disconnected" | "not-configured" | "unchecked";

export type AiDocsConfigurationActor = z.infer<typeof aiDocsConfigurationActorSchema>;
export type AiDocsConfigurationAuditEntry = z.infer<typeof aiDocsConfigurationAuditEntrySchema>;
export type AiDocsConfigurationAdministration = NonNullable<
  z.infer<typeof aiDocsManagedConfigurationViewSchema>["administration"]
>;
export type AiDocsRuntimeConnection = z.infer<typeof aiDocsRuntimeConnectionSchema>;
/** Credential-free view returned by the managed administration endpoints. */
export type AiDocsManagedConfigurationView = z.infer<typeof aiDocsManagedConfigurationViewSchema>;

export type AiDocsConnectionResult = z.infer<typeof aiDocsConnectionResultSchema>;

export type AiDocsProviderInfoContract = z.infer<typeof aiDocsProviderInfoSchema>;
export type AiDocsModelInfoContract = z.infer<typeof aiDocsModelInfoSchema>;

/** Optional directory values exposed by a host application to the settings UI. */
export type AiDocsConfigurationOptions = z.infer<typeof aiDocsConfigurationOptionsSchema>;
export type AiDocsAccessView = z.infer<typeof aiDocsAccessViewSchema>;
export type AskDocumentationRequest = z.infer<typeof askDocumentationRequestSchema>;
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;
// Custom generators may omit the defaulted field; parsed responses always
// contain it through `AskDocumentationResponse`.
export type GeneratedAnswer = z.input<typeof generatedAnswerSchema>;
export type TokenUsage = z.infer<typeof tokenUsageSchema>;
export type AskDocumentationResponse = z.infer<typeof askDocumentationResponseSchema>;
export type AskDocumentationStreamEvent = z.infer<typeof askDocumentationStreamEventSchema>;
