# Extension points

AI App Assistant keeps application-specific concerns at its edges. This page separates supported extension contracts from convenience adapters that may be added later.

## What is extensible today

| Concern | Current extension point | Built-in conveniences |
| --- | --- | --- |
| Browser UI | Headless client and controller | Web Component and Angular connector |
| Backend transport | Fetch-compatible handlers and Node HTTP listener | Express and Nest connectors |
| Model provider | `AiAppAssistantInferenceAdapter`, `AnswerGenerator` or an injected Vercel AI SDK model | OpenAI, Anthropic, Mistral, Google and Ollama identifiers |
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

Register `AiAppAssistantInferenceAdapter` when a managed application must call a
corporate gateway or cloud runtime instead of a built-in public provider. The
adapter owns endpoint selection, authentication and token renewal. The library
only receives a generator and safe model metadata:

```ts
import {
  createAiSdkGenerator,
  createManagedAiAppAssistantServer,
  type AiAppAssistantInferenceAdapter
} from "@123toto/ai-app-assistant-server";

// Application-owned client. It may use a private endpoint, workload identity,
// a rotating token, or any provider package selected by the application.
const corporateGateway = createCorporateGatewayClient();

const gatewayAdapter: AiAppAssistantInferenceAdapter = {
  id: "corporate-gateway",
  label: "Corporate AI Gateway",
  // This is the default for custom adapters. Authentication and endpoint
  // controls are therefore never exposed by the generic settings screen.
  connectionManagement: "host",
  createGenerator: async ({ model }) => createAiSdkGenerator({
    model: await corporateGateway.languageModel(model),
    modelId: `corporate-gateway:${model}`
  }),
  listModels: async () => corporateGateway.listModels()
};

const aiAppAssistant = createManagedAiAppAssistantServer({
  configuration: {
    enabled: process.env.AI_APP_ASSISTANT_LLM_ENABLED === "true",
    inferenceAdapters: [gatewayAdapter],
    // Enterprise hosts can completely remove the public-provider choices.
    includeBuiltInProviders: false,
    defaultConfiguration: {
      provider: gatewayAdapter.id,
      model: process.env.AI_APP_ASSISTANT_LLM_MODEL!,
      access: { mode: "all" }
    }
  },
  http
});
```

`testConnection` is optional. When omitted, the managed runtime performs a real
bounded generation and validates the structured answer before reporting the
adapter as connected. `listModels` is also optional; omit it for a deployment
with one fixed model.

Using `createAiSdkGenerator` is the preferred path when the gateway can supply a
Vercel AI SDK `LanguageModel`: the library keeps its prompt, structured schema,
retry, timeout and streaming behavior. Implement `AnswerGenerator` directly
only when the inference runtime cannot expose an AI SDK-compatible model:

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

The adapter id is a configuration identifier, not a provider credential.
Custom adapters default to `connectionManagement: "host"`: the generic settings
screen displays the adapter label and model but hides provider selection, API
key and base URL controls. Model discovery, connection testing, access rules,
quotas and conversation limits remain available.

An adapter that authenticates through workload identity or an
application-owned secret normally leaves `requiresApiKey` unset. Set both
`connectionManagement: "settings"` and `requiresApiKey: true` only when the
generic settings API is deliberately allowed to receive and persist an adapter
key. Built-in public providers retain this settings-managed behavior.
