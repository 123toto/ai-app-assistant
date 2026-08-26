import type { TokenUsage } from "@123toto/ai-app-assistant-contracts";
import {
  AiSdkGenerationError,
  normalizeAiSdkGenerationError,
  type AiSdkFailureCode
} from "./ai-sdk.js";

export type AiAppAssistantGenerationOperation = "answer" | "stream";

interface AiAppAssistantGenerationEventBase {
  requestId: string;
  operation: AiAppAssistantGenerationOperation;
  model: string;
  durationMs: number;
  occurredAt: string;
}

/** Safe operational event. It deliberately excludes prompts, HTML, users and credentials. */
export type AiAppAssistantGenerationEvent =
  | (AiAppAssistantGenerationEventBase & {
      outcome: "success";
      usage?: TokenUsage;
    })
  | (AiAppAssistantGenerationEventBase & {
      outcome: "failure";
      error: {
        code: AiSdkFailureCode;
        message: string;
        retryable: boolean;
        attempts: number;
        providerStatus?: number;
      };
    });

export interface AiAppAssistantTelemetrySummary {
  requests: number;
  succeeded: number;
  failed: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  failuresByCode: Partial<Record<AiSdkFailureCode, number>>;
}

export type AiAppAssistantRecentFailure = Extract<AiAppAssistantGenerationEvent, { outcome: "failure" }>;

/** Persistence contract used by the managed server and reusable by any host. */
export interface AiAppAssistantTelemetryStore {
  record(event: AiAppAssistantGenerationEvent): Promise<void>;
  summary(): Promise<AiAppAssistantTelemetrySummary>;
  recentFailures(limit?: number): Promise<AiAppAssistantRecentFailure[]>;
}

/** Single-process telemetry intended for tests and local development. */
export function createMemoryAiAppAssistantTelemetryStore(options?: {
  recentFailureLimit?: number;
}): AiAppAssistantTelemetryStore {
  const recentFailureLimit = normalizeLimit(options?.recentFailureLimit, 100);
  const aggregate = emptySummary();
  const failures: AiAppAssistantRecentFailure[] = [];
  return {
    async record(event) {
      aggregate.requests += 1;
      aggregate.durationMs += Math.max(0, Math.round(event.durationMs));
      if (event.outcome === "success") {
        aggregate.succeeded += 1;
        addUsage(aggregate, event.usage);
      } else {
        aggregate.failed += 1;
        aggregate.failuresByCode[event.error.code] =
          (aggregate.failuresByCode[event.error.code] ?? 0) + 1;
        failures.push(event);
        if (failures.length > recentFailureLimit) failures.splice(0, failures.length - recentFailureLimit);
      }
    },
    async summary() {
      return { ...aggregate, failuresByCode: { ...aggregate.failuresByCode } };
    },
    async recentFailures(limit = 20) {
      return failures.slice(-normalizeLimit(limit, 20)).reverse();
    }
  };
}

/** Minimal Redis shape; compatible with ioredis without adding it as a dependency. */
export interface AiAppAssistantRedisTelemetryClient {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

/**
 * Shared Redis telemetry. One Lua call atomically updates counters and keeps a
 * bounded failure list, so several application instances can safely share it.
 */
export function createRedisAiAppAssistantTelemetryStore(
  client: AiAppAssistantRedisTelemetryClient,
  options?: { prefix?: string; recentFailureLimit?: number }
): AiAppAssistantTelemetryStore {
  const prefix = options?.prefix ?? "ai-app-assistant:telemetry:";
  const summaryKey = `${prefix}summary`;
  const failuresKey = `${prefix}failures`;
  const recentFailureLimit = normalizeLimit(options?.recentFailureLimit, 100);
  return {
    async record(event) {
      const usage = event.outcome === "success" ? event.usage : undefined;
      await client.eval(
        REDIS_RECORD_SCRIPT,
        2,
        summaryKey,
        failuresKey,
        event.outcome,
        Math.max(0, Math.round(event.durationMs)),
        usage?.inputTokens ?? 0,
        usage?.outputTokens ?? 0,
        usage?.totalTokens ?? 0,
        event.outcome === "failure" ? event.error.code : "",
        event.outcome === "failure" ? JSON.stringify(event) : "",
        recentFailureLimit
      );
    },
    async summary() {
      const raw = await client.eval("return redis.call('HGETALL', KEYS[1])", 1, summaryKey);
      const values = redisPairs(raw);
      const failuresByCode: Partial<Record<AiSdkFailureCode, number>> = {};
      for (const [key, value] of Object.entries(values)) {
        if (!key.startsWith("failure:")) continue;
        failuresByCode[key.slice("failure:".length) as AiSdkFailureCode] = finiteNumber(value);
      }
      return {
        requests: finiteNumber(values["requests"]),
        succeeded: finiteNumber(values["succeeded"]),
        failed: finiteNumber(values["failed"]),
        durationMs: finiteNumber(values["durationMs"]),
        inputTokens: finiteNumber(values["inputTokens"]),
        outputTokens: finiteNumber(values["outputTokens"]),
        totalTokens: finiteNumber(values["totalTokens"]),
        failuresByCode
      };
    },
    async recentFailures(limit = 20) {
      const raw = await client.eval(
        "return redis.call('LRANGE', KEYS[1], 0, tonumber(ARGV[1]) - 1)",
        1,
        failuresKey,
        normalizeLimit(limit, 20)
      );
      const values = Array.isArray(raw) ? raw.map(String) : [];
      return values.flatMap((value) => {
        try {
          const parsed = JSON.parse(value) as AiAppAssistantRecentFailure;
          return parsed?.outcome === "failure" ? [parsed] : [];
        } catch {
          return [];
        }
      });
    }
  };
}

/** Converts any generator error to the same safe public diagnostic. */
export function createAiAppAssistantFailureEvent(input: {
  error: unknown;
  requestId: string;
  operation: AiAppAssistantGenerationOperation;
  model: string;
  durationMs: number;
}): AiAppAssistantRecentFailure {
  const failure = input.error instanceof AiSdkGenerationError
    ? input.error
    : normalizeAiSdkGenerationError(input.error, 1);
  return {
    outcome: "failure",
    requestId: input.requestId.slice(0, 200),
    operation: input.operation,
    model: input.model,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    occurredAt: new Date().toISOString(),
    error: {
      code: failure.code,
      message: failure.message,
      retryable: failure.retryable,
      attempts: failure.attempts,
      ...(failure.providerStatus !== undefined ? { providerStatus: failure.providerStatus } : {})
    }
  };
}

const REDIS_RECORD_SCRIPT = [
  "redis.call('HINCRBY', KEYS[1], 'requests', 1)",
  "redis.call('HINCRBY', KEYS[1], 'durationMs', ARGV[2])",
  "if ARGV[1] == 'success' then",
  "  redis.call('HINCRBY', KEYS[1], 'succeeded', 1)",
  "  redis.call('HINCRBY', KEYS[1], 'inputTokens', ARGV[3])",
  "  redis.call('HINCRBY', KEYS[1], 'outputTokens', ARGV[4])",
  "  redis.call('HINCRBY', KEYS[1], 'totalTokens', ARGV[5])",
  "else",
  "  redis.call('HINCRBY', KEYS[1], 'failed', 1)",
  "  redis.call('HINCRBY', KEYS[1], 'failure:' .. ARGV[6], 1)",
  "  redis.call('LPUSH', KEYS[2], ARGV[7])",
  "  redis.call('LTRIM', KEYS[2], 0, tonumber(ARGV[8]) - 1)",
  "end",
  "return 1"
].join("\n");

function emptySummary(): AiAppAssistantTelemetrySummary {
  return {
    requests: 0,
    succeeded: 0,
    failed: 0,
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    failuresByCode: {}
  };
}

function addUsage(summary: AiAppAssistantTelemetrySummary, usage?: TokenUsage): void {
  summary.inputTokens += usage?.inputTokens ?? 0;
  summary.outputTokens += usage?.outputTokens ?? 0;
  summary.totalTokens += usage?.totalTokens ?? 0;
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  return Math.min(1_000, Math.max(1, Math.round(value ?? fallback)));
}

function finiteNumber(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function redisPairs(value: unknown): Record<string, string> {
  if (!Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (let index = 0; index + 1 < value.length; index += 2) {
    result[String(value[index])] = String(value[index + 1]);
  }
  return result;
}
