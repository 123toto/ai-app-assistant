import "reflect-metadata";
import { PATH_METADATA } from "@nestjs/common/constants";
import { describe, expect, it, vi } from "vitest";
import {
  createManagedAiAppAssistantNestModule,
  handleManagedAiAppAssistantNestRequest,
  type AiAppAssistantNestRequest,
  type AiAppAssistantNestResponse
} from "./nest.js";
import type { AiAppAssistantNestManagedServer } from "./nest.js";

describe("Nest connector", () => {
  it("owns the catch-all controller under the configured path", () => {
    const dynamicModule = createManagedAiAppAssistantNestModule({
      path: "/assistant/",
      useFactory: () => ({}) as never
    });
    const controller = dynamicModule.controllers?.[0] as object;
    expect(Reflect.getMetadata(PATH_METADATA, controller)).toBe("assistant");
  });

  it("forwards parsed JSON and the native request to the managed server", async () => {
    const handle = vi.fn(async (_request: Request, native?: AiAppAssistantNestRequest) =>
      new Response(JSON.stringify({ user: native?.user }), {
        headers: { "content-type": "application/json" }
      })
    );
    const server = { fetch: { handle } } as unknown as AiAppAssistantNestManagedServer<AiAppAssistantNestRequest>;
    const chunks: Uint8Array[] = [];
    const response: AiAppAssistantNestResponse = {
      statusCode: 0,
      setHeader: vi.fn(),
      write(chunk) { chunks.push(chunk); return true; },
      end: vi.fn()
    };
    const request: AiAppAssistantNestRequest = {
      method: "POST",
      originalUrl: "/api/ai-app-assistant/ask",
      headers: { host: "localhost", "content-type": "application/json" },
      body: { question: "Explain" },
      user: { id: "user-1" }
    };

    await handleManagedAiAppAssistantNestRequest(server, request, response);

    const webRequest = handle.mock.calls[0]?.[0] as Request;
    expect(await webRequest.json()).toEqual({ question: "Explain" });
    expect(new TextDecoder().decode(Buffer.concat(chunks))).toContain("user-1");
    expect(response.statusCode).toBe(200);
  });
});
