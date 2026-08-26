import { describe, expect, it } from "vitest";
import { filterOpenApiContext } from "./openapi-context.js";

describe("filterOpenApiContext", () => {
  it("removes host-defined paths, schemas and tags without mutating the input", () => {
    const document = {
      openapi: "3.0.0",
      paths: {
        "/assessment/items": { get: {} },
        "/ai-app-assistant/ask": { post: {} }
      },
      components: { schemas: { Item: {}, AiAppAssistantConfiguration: {} } },
      tags: [{ name: "Assessment" }, { name: "AI App Assistant" }]
    };
    const result = filterOpenApiContext(document, {
      excludePathPrefixes: ["/ai-app-assistant"],
      excludeSchemaNames: /ai.?app.?assistant/i,
      excludeTagNames: /ai app assistant/i
    }) as typeof document;

    expect(Object.keys(result.paths)).toEqual(["/assessment/items"]);
    expect(Object.keys(result.components.schemas)).toEqual(["Item"]);
    expect(result.tags).toEqual([{ name: "Assessment" }]);
    expect(Object.keys(document.paths)).toHaveLength(2);
  });
});
