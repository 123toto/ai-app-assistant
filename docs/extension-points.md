# Extension points

AI App Assistant keeps application-specific concerns at its edges. This page separates supported extension contracts from convenience adapters that may be added later.

## What is extensible today

| Concern | Current extension point | Built-in conveniences |
| --- | --- | --- |
| Browser UI | Headless client and controller | Web Component and Angular connector |
| Backend transport | Fetch-compatible handlers and Node HTTP listener | Express and Nest connectors |
| Model provider | `AnswerGenerator` or an injected Vercel AI SDK model | OpenAI, Anthropic, Mistral, Google and Ollama identifiers |
| Documents | `DocumentationSource[]` and runtime `setDocuments()` | String and JSON-compatible content, including Markdown and OpenAPI |
| Authentication | `resolveContext` or `resolveIdentity` callbacks | Application-defined users, roles and authorization |
| Persistence | `AiAppAssistantKeyValueStore` | Memory and Redis stores |
| Privacy | Request, stream-event and response transforms | Safe browser capture and telemetry defaults |

The core protocol does not need to change when one of these implementations changes.

## Document source adapter pattern

The current release does not include a plugin registry or packaged connectors for every document system. A host application can adapt any source into the stable document contract:

```ts
import type { DocumentationSource } from "@123toto/ai-app-assistant-server";

interface DocumentAdapter<TSource> {
  load(source: TSource, signal?: AbortSignal): Promise<DocumentationSource[]>;
}

const knowledgeApiAdapter: DocumentAdapter<{ baseUrl: string; token: string }> = {
  async load(source, signal) {
    const response = await fetch(`${source.baseUrl}/assistant-documents`, {
      headers: { authorization: `Bearer ${source.token}` },
      signal
    });
    if (!response.ok) throw new Error(`Document loading failed: ${response.status}`);

    const documents = await response.json() as Array<{
      id: string;
      title: string;
      markdown: string;
    }>;

    return documents.map(document => ({
      id: document.id,
      title: document.title,
      mediaType: "text/markdown",
      content: document.markdown
    }));
  }
};

const documents = await knowledgeApiAdapter.load({
  baseUrl: process.env.KNOWLEDGE_API_URL!,
  token: process.env.KNOWLEDGE_API_TOKEN!
});

await aiAppAssistant.setDocuments(documents);
```

Keep source credentials in the backend. The adapter should define refresh timing, source-specific access control and any domain redaction required before content reaches the assistant.

Packaged adapters for common wikis, object stores or CMSs can implement this pattern later. They are not part of the current release.

## Authentication bridge pattern

Authentication remains the host application's responsibility. This is already provider-neutral: a cookie session, JWT, API gateway identity or framework-specific user object can all be resolved through the same hook.

```ts
const aiAppAssistant = createManagedAiAppAssistantServer({
  configuration,
  http: {
    resolveIdentity: async request => {
      const session = await applicationAuth.readSession(request);
      return { id: session.user.id, label: session.user.name, roles: session.user.roles };
    },
    authorizeAdministration: identity => {
      if (!identity.roles?.includes("assistant-admin")) throw new Error("Forbidden");
    }
  }
});
```

Future authentication packages would only be convenience bridges. They should not make the core own login, token issuance or the application's user directory.

## Model adapter pattern

Implement `AnswerGenerator` when a provider or inference runtime is not covered by the built-in model identifiers:

```ts
import type { AnswerGenerator } from "@123toto/ai-app-assistant-server";

const generator: AnswerGenerator = {
  modelId: "internal:assistant-model",
  capabilities: {
    contextWindowTokens: 32_000,
    maxOutputTokens: 2_000,
    estimatedCharactersPerToken: 4
  },
  async generate(bundle, signal) {
    return internalInference.generateStructuredAnswer(bundle, signal);
  }
};
```

The browser transport and validated answer contract remain unchanged.
