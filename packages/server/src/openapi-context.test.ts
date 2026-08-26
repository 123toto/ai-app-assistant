import { describe, expect, it } from "vitest";
import { filterOpenApiContext } from "./openapi-context.js";

describe("filterOpenApiContext", () => {
  it("removes host-defined paths, schemas and tags without mutating the input", () => {
    const document = {
      openapi: "3.0.0",
      paths: {
        "/assessment/items": { get: {} },
        "/ai-docs/ask": { post: {} }
      },
      components: { schemas: { Item: {}, AiDocsConfiguration: {} } },
      tags: [{ name: "Assessment" }, { name: "AI documentation" }]
    };
    const result = filterOpenApiContext(document, {
      excludePathPrefixes: ["/ai-docs"],
      excludeSchemaNames: /ai.?docs/i,
      excludeTagNames: /ai documentation/i
    }) as typeof document;

    expect(Object.keys(result.paths)).toEqual(["/assessment/items"]);
    expect(Object.keys(result.components.schemas)).toEqual(["Item"]);
    expect(result.tags).toEqual([{ name: "Assessment" }]);
    expect(Object.keys(document.paths)).toHaveLength(2);
  });
});
