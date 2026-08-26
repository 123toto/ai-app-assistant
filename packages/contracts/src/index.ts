import { z } from "zod";

/** Wire protocol version shared by the browser client and the backend. */
export const PROTOCOL_VERSION = "4" as const;

/** Providers supported by the optional managed runtime and settings UI. */
export const aiAppAssistantProviderSchema = z.enum([
  "anthropic",
  "google",
  "mistral",
  "ollama",
  "openai"
]);

export const aiAppAssistantAccessRuleSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }),
  z.object({ mode: z.literal("roles"), roles: z.array(z.string().min(1)).min(1) }),
  z.object({ mode: z.literal("users"), userIds: z.array(z.string().min(1)).min(1) })
]);

/** Safe configuration payload shared by every administration UI. */
export const aiAppAssistantConfigurationInputSchema = z.object({
  provider: aiAppAssistantProviderSchema,
  model: z.string().trim().min(1),
  apiKey: z.string().trim().min(1).optional(),
  baseURL: z.string().url().optional(),
  access: aiAppAssistantAccessRuleSchema,
  quota: z.object({
    maxRequests: z.number().int().min(1).max(10_000),
    windowSeconds: z.number().int().min(60).max(31_536_000)
  }).optional(),
  maxConversationTurns: z.number().int().min(1).max(10).default(3),
  allowModelChangesByOthers: z.boolean().optional()
});

export const aiAppAssistantCredentialsSchema = aiAppAssistantConfigurationInputSchema.pick({
  provider: true,
  apiKey: true,
  baseURL: true
});

export const aiAppAssistantConnectionTestInputSchema = aiAppAssistantCredentialsSchema.extend({
  model: z.string().trim().min(1)
});

export const aiAppAssistantConfigurationActorSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1)
});

export const aiAppAssistantConfigurationAuditEntrySchema = z.object({
  id: z.string().min(1),
  actor: aiAppAssistantConfigurationActorSchema,
  changedAt: z.string().datetime(),
  changes: z.array(z.object({
    field: z.enum(["provider", "apiKey", "model", "access", "quota", "conversation", "modelChangePolicy"]),
    from: z.string().optional(),
    to: z.string().optional()
  }))
});

export const aiAppAssistantRuntimeConnectionSchema = z.object({
  status: z.enum(["connected", "disconnected", "not-configured", "unchecked"]),
  checkedAt: z.string().datetime().optional(),
  model: z.string().optional()
});

const aiAppAssistantConfigurationFieldSourceSchema = z.enum(["environment", "override", "default", "none"]);

/** Credential-free configuration response validated by every settings client. */
export const aiAppAssistantManagedConfigurationViewSchema = z.object({
  provider: aiAppAssistantProviderSchema.nullable(),
  model: z.string(),
  baseURL: z.string().url().optional(),
  access: aiAppAssistantAccessRuleSchema,
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
    keyCreatedBy: aiAppAssistantConfigurationActorSchema.optional(),
    keyCreatedAt: z.string().datetime().optional(),
    modelUpdatedBy: aiAppAssistantConfigurationActorSchema.optional(),
    modelUpdatedAt: z.string().datetime().optional(),
    allowModelChangesByOthers: z.boolean(),
    history: z.array(aiAppAssistantConfigurationAuditEntrySchema)
  }).optional(),
  allowModelChangesByOthers: z.boolean(),
  canChangeModel: z.boolean(),
  canManageCredentials: z.boolean(),
  canManageModelPolicy: z.boolean(),
  canRevokeApiKey: z.boolean(),
  fieldSources: z.object({
    provider: aiAppAssistantConfigurationFieldSourceSchema,
    model: aiAppAssistantConfigurationFieldSourceSchema,
    apiKey: aiAppAssistantConfigurationFieldSourceSchema,
    baseURL: aiAppAssistantConfigurationFieldSourceSchema,
    access: aiAppAssistantConfigurationFieldSourceSchema,
    quota: aiAppAssistantConfigurationFieldSourceSchema,
    conversation: aiAppAssistantConfigurationFieldSourceSchema
  }),
  connection: aiAppAssistantRuntimeConnectionSchema
});

export const aiAppAssistantConnectionResultSchema = z.discriminatedUnion("success", [
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

export const aiAppAssistantProviderInfoSchema = z.object({
  id: aiAppAssistantProviderSchema,
  label: z.string(),
  requiresApiKey: z.boolean(),
  supportsModelDiscovery: z.boolean()
});

export const aiAppAssistantModelInfoSchema = z.object({
  id: z.string().min(1),
  provider: aiAppAssistantProviderSchema,
  label: z.string().optional(),
  createdAt: z.string().optional()
});

export const aiAppAssistantConfigurationOptionsSchema = z.object({
  roles: z.array(z.object({ id: z.string().min(1), label: z.string() })),
  users: z.array(z.object({ id: z.string().min(1), label: z.string() }))
});

export const aiAppAssistantConfigurationSaveResultSchema = z.object({
  saved: z.boolean(),
  connection: aiAppAssistantConnectionResultSchema,
  configuration: aiAppAssistantManagedConfigurationViewSchema.optional()
});

/** Small response used by managed clients to decide whether the launcher is visible. */
export const aiAppAssistantAccessViewSchema = z.object({
  available: z.boolean(),
  maxConversationTurns: z.number().int().min(1).max(10)
});

/** Short bounded history automatically maintained by chatbot clients. */
export const conversationMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(8_000)
});

/** Minimal request sent by any frontend integration. */
export const aiAppAssistantRequestSchema = z.object({
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

export const aiAppAssistantResponseSchema = generatedAnswerSchema.extend({
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
export const aiAppAssistantTransportEventSchema = z.discriminatedUnion("type", [
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
  z.object({ type: z.literal("complete"), response: aiAppAssistantResponseSchema })
]);

export type EvidenceSource = z.infer<typeof evidenceSchema>["source"];
export type AiAppAssistantProvider = z.infer<typeof aiAppAssistantProviderSchema>;
export type AiAppAssistantAccessRule = z.infer<typeof aiAppAssistantAccessRuleSchema>;
export type AiAppAssistantConfigurationInput = z.infer<typeof aiAppAssistantConfigurationInputSchema>;
export type AiAppAssistantCredentials = z.infer<typeof aiAppAssistantCredentialsSchema>;
export type AiAppAssistantConnectionTestInput = z.infer<typeof aiAppAssistantConnectionTestInputSchema>;
export type AiAppAssistantConfigurationFieldSource = "environment" | "override" | "default" | "none";
export type AiAppAssistantRuntimeConnectionStatus = "connected" | "disconnected" | "not-configured" | "unchecked";

export type AiAppAssistantConfigurationActor = z.infer<typeof aiAppAssistantConfigurationActorSchema>;
export type AiAppAssistantConfigurationAuditEntry = z.infer<typeof aiAppAssistantConfigurationAuditEntrySchema>;
export type AiAppAssistantConfigurationAdministration = NonNullable<
  z.infer<typeof aiAppAssistantManagedConfigurationViewSchema>["administration"]
>;
export type AiAppAssistantRuntimeConnection = z.infer<typeof aiAppAssistantRuntimeConnectionSchema>;
/** Credential-free view returned by the managed administration endpoints. */
export type AiAppAssistantManagedConfigurationView = z.infer<typeof aiAppAssistantManagedConfigurationViewSchema>;

export type AiAppAssistantConnectionResult = z.infer<typeof aiAppAssistantConnectionResultSchema>;

export type AiAppAssistantProviderInfoContract = z.infer<typeof aiAppAssistantProviderInfoSchema>;
export type AiAppAssistantModelInfoContract = z.infer<typeof aiAppAssistantModelInfoSchema>;

/** Optional directory values exposed by a host application to the settings UI. */
export type AiAppAssistantConfigurationOptions = z.infer<typeof aiAppAssistantConfigurationOptionsSchema>;
export type AiAppAssistantAccessView = z.infer<typeof aiAppAssistantAccessViewSchema>;
export type AiAppAssistantRequest = z.infer<typeof aiAppAssistantRequestSchema>;
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;
// Custom generators may omit the defaulted field; parsed responses always
// contain it through `AiAppAssistantResponse`.
export type GeneratedAnswer = z.input<typeof generatedAnswerSchema>;
export type TokenUsage = z.infer<typeof tokenUsageSchema>;
export type AiAppAssistantResponse = z.infer<typeof aiAppAssistantResponseSchema>;
export type AiAppAssistantTransportEvent = z.infer<typeof aiAppAssistantTransportEventSchema>;
