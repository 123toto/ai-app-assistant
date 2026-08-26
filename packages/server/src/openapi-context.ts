import type { OpenApiDocument } from "./types.js";

export interface FilterOpenApiContextOptions {
  /** Path prefixes that must never be sent to the assistant. */
  excludePathPrefixes?: string[];
  /** Schema names that must never be sent to the assistant. */
  excludeSchemaNames?: RegExp;
  /** Tag names that must never be sent to the assistant. */
  excludeTagNames?: RegExp;
}

/**
 * Returns a copy of an OpenAPI document stripped of operational assistant APIs
 * or any other host-defined paths that should not become model context.
 */
export function filterOpenApiContext(
  document: OpenApiDocument,
  options: FilterOpenApiContextOptions = {}
): OpenApiDocument {
  const prefixes = (options.excludePathPrefixes ?? []).map(normalizePrefix);
  const source = document as OpenApiDocument & { tags?: Array<{ name?: string }> };
  const filtered: OpenApiDocument & { tags?: Array<{ name?: string }> } = {
    ...source,
    paths: Object.fromEntries(
      Object.entries(source.paths ?? {}).filter(([path]) =>
        !prefixes.some((prefix) => normalizePrefix(path).startsWith(prefix))
      )
    ),
    ...(source.components ? {
      components: {
        ...source.components,
        schemas: Object.fromEntries(
          Object.entries(source.components.schemas ?? {}).filter(([name]) =>
            !options.excludeSchemaNames?.test(name)
          )
        )
      }
    } : {})
  };
  if (Array.isArray(source.tags)) {
    filtered.tags = source.tags.filter((tag) => !options.excludeTagNames?.test(tag.name ?? ""));
  }
  return filtered;
}

function normalizePrefix(path: string): string {
  const normalized = `/${path.trim().replace(/^\/+|\/+$/g, "")}`;
  return normalized === "/" ? normalized : normalized.toLowerCase();
}
