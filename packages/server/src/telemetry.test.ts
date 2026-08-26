import { describe, expect, it } from "vitest";
import {
  createAiAppAssistantFailureEvent,
  createMemoryAiAppAssistantTelemetryStore,
  createRedisAiAppAssistantTelemetryStore,
  type AiAppAssistantRedisTelemetryClient
} from "./telemetry.js";

describe("AI App Assistant telemetry", () => {
  it("aggregates usage without retaining prompts or users", async () => {
    const store = createMemoryAiAppAssistantTelemetryStore();
    await store.record({
      outcome: "success",
      requestId: "request-1",
      operation: "stream",
      model: "mistral:large",
      durationMs: 120,
      occurredAt: new Date().toISOString(),
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 }
    });
    await store.record(createAiAppAssistantFailureEvent({
      error: Object.assign(new Error("service unavailable"), { statusCode: 503 }),
      requestId: "request-2",
      operation: "answer",
      model: "mistral:large",
      durationMs: 80
    }));

    expect(await store.summary()).toEqual({
      requests: 2,
      succeeded: 1,
      failed: 1,
      durationMs: 200,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      failuresByCode: { PROVIDER_UNAVAILABLE: 1 }
    });
    expect(JSON.stringify(await store.recentFailures())).not.toMatch(/prompt|html|user/i);
  });

  it("persists aggregate and bounded failures through the Redis adapter", async () => {
    const client = new FakeRedisTelemetryClient();
    const first = createRedisAiAppAssistantTelemetryStore(client, { recentFailureLimit: 1 });
    await first.record(createAiAppAssistantFailureEvent({
      error: Object.assign(new Error("rate limited"), { statusCode: 429 }),
      requestId: "one",
      operation: "stream",
      model: "mistral:large",
      durationMs: 10
    }));
    await first.record(createAiAppAssistantFailureEvent({
      error: Object.assign(new Error("offline"), { code: "ECONNRESET" }),
      requestId: "two",
      operation: "stream",
      model: "mistral:large",
      durationMs: 20
    }));

    const afterRestart = createRedisAiAppAssistantTelemetryStore(client, { recentFailureLimit: 1 });
    expect(await afterRestart.summary()).toMatchObject({ requests: 2, failed: 2, durationMs: 30 });
    expect((await afterRestart.recentFailures(20)).map(({ requestId }) => requestId)).toEqual(["two"]);
  });
});

class FakeRedisTelemetryClient implements AiAppAssistantRedisTelemetryClient {
  readonly hashes = new Map<string, Record<string, number>>();
  readonly lists = new Map<string, string[]>();

  async eval(script: string, _numberOfKeys: number, ...args: Array<string | number>): Promise<unknown> {
    const key = String(args[0]);
    if (script.includes("HGETALL")) {
      return Object.entries(this.hashes.get(key) ?? {}).flatMap(([field, value]) => [field, String(value)]);
    }
    if (script.includes("LRANGE")) {
      return (this.lists.get(key) ?? []).slice(0, Number(args[1]));
    }
    const failuresKey = String(args[1]);
    const values = args.slice(2).map(String);
    const hash = this.hashes.get(key) ?? {};
    hash["requests"] = (hash["requests"] ?? 0) + 1;
    hash["durationMs"] = (hash["durationMs"] ?? 0) + Number(values[1]);
    if (values[0] === "success") {
      hash["succeeded"] = (hash["succeeded"] ?? 0) + 1;
      hash["inputTokens"] = (hash["inputTokens"] ?? 0) + Number(values[2]);
      hash["outputTokens"] = (hash["outputTokens"] ?? 0) + Number(values[3]);
      hash["totalTokens"] = (hash["totalTokens"] ?? 0) + Number(values[4]);
    } else {
      hash["failed"] = (hash["failed"] ?? 0) + 1;
      hash[`failure:${values[5]}`] = (hash[`failure:${values[5]}`] ?? 0) + 1;
      this.lists.set(failuresKey, [values[6], ...(this.lists.get(failuresKey) ?? [])]
        .slice(0, Number(values[7])));
    }
    this.hashes.set(key, hash);
    return 1;
  }
}
