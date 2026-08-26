# Programmatic usage

This guide covers the framework-neutral API and the optional framework connectors.

## Install

```bash
npm install @123toto/ai-app-assistant-server
npm install @123toto/ai-app-assistant-client
```

`@123toto/ai-app-assistant-contracts` is installed transitively. The server also includes the Vercel AI SDK and the built-in OpenAI, Anthropic, Mistral and Google providers.

## Minimal backend

```ts
import { readFile } from "node:fs/promises";
import { createAiDocsServer } from "@123toto/ai-app-assistant-server";

const [guide, openapi] = await Promise.all([
  readFile("./APP_GUIDE.md", "utf8"),
  readFile("./openapi.json", "utf8").then(JSON.parse)
]);

const aiDocs = createAiDocsServer({
  model: process.env.AI_DOCS_MODEL ?? "mistral:mistral-small-latest",
  documents: [
    { id: "guide", title: "Application guide", mediaType: "text/markdown", content: guide },
    { id: "openapi", title: "API documentation", mediaType: "application/json", content: openapi }
  ],
  http: {
    resolveContext: request => authentication.currentUser(request),
    authorize: user => permissions.requireAssistantAccess(user)
  }
});

// Next.js, Hono and other Fetch-compatible runtimes.
export const POST = (request: Request) => aiDocs.fetch.handle(request);
```

The model identifier selects the provider and its environment variable:

| Identifier | Environment variable |
| --- | --- |
| `openai:model` | `OPENAI_API_KEY` |
| `anthropic:model` | `ANTHROPIC_API_KEY` |
| `mistral:model` | `MISTRAL_API_KEY` |
| `google:model` or `gemini:model` | `GOOGLE_API_KEY` |
| `ollama:model` | None by default |

Handlers fail closed when no authentication strategy is configured. Use `http: { allowAnonymous: true }` only for an intentionally public prototype.

For native Node.js HTTP, Express, Fastify or Nest adapters that expose raw request and response objects:

```ts
import { createAiDocsNodeHttpListener } from "@123toto/ai-app-assistant-server";

const listener = createAiDocsNodeHttpListener(aiDocs.fetch);
```

## Managed backend

Use `createManagedAiDocsServer` when the application needs persisted provider settings, encrypted API keys, access rules, quotas, audit history, model discovery or telemetry.

```ts
import { createManagedAiDocsServer } from "@123toto/ai-app-assistant-server";

const aiDocs = createManagedAiDocsServer({
  documents,
  configuration: {
    storage: { type: "redis", client: redis, prefix: "my-app:ai-docs:" },
    encryptionKey: process.env.AI_DOCS_SECRET_ENCRYPTION_KEY!,
    defaultConfiguration: {
      provider: "mistral",
      model: "mistral-small-latest",
      access: { mode: "roles", roles: ["AI_ASSISTANT_USER"] }
    },
    resolveDefaultApiKey: provider => secrets.forProvider(provider),
    defaultQuota: { maxRequests: 20, windowSeconds: 3600 }
  },
  runtime: {
    transformRequest: (input, user) => privacy.sanitizeRequest(input, user),
    transformResponse: (output, user) => privacy.sanitizeResponse(output, user)
  },
  http: {
    resolveIdentity: request => authentication.currentUser(request),
    authorizeAdministration: user => permissions.requireAssistantAdmin(user),
    listRoles: () => directory.roles(),
    listUsers: user => directory.usersVisibleTo(user)
  }
});

await aiDocs.initialize();
```

Documents can be replaced after application bootstrap, for example when an OpenAPI document is generated at runtime:

```ts
await aiDocs.setDocuments([
  { id: "guide", title: "Application guide", content: guide },
  { id: "openapi", title: "API documentation", content: openapi }
]);
```

### Express

```ts
import { createManagedAiDocsExpressHandler } from "@123toto/ai-app-assistant-server/express";

app.use("/api/ai-docs", createManagedAiDocsExpressHandler(aiDocs));
```

### Nest

```ts
import { createManagedAiDocsServer } from "@123toto/ai-app-assistant-server";
import { createManagedAiDocsNestModule } from "@123toto/ai-app-assistant-server/nest";

export const AiDocsModule = createManagedAiDocsNestModule({
  path: "ai-docs",
  imports: [AuthenticationModule],
  inject: [AuthenticationService],
  useFactory: (auth: AuthenticationService) => createManagedAiDocsServer({
    configuration,
    http: {
      resolveIdentity: (_request, nativeRequest) => auth.currentUser(nativeRequest),
      authorizeAdministration: user => auth.requireAssistantAdmin(user)
    }
  })
});
```

The connectors own the routes and transport DTOs. The host application supplies identity, authorization, document loading and business-specific privacy rules.

## Universal browser UI

```ts
import "@123toto/ai-app-assistant-client/web-component";
```

```html
<ai-docs-assistant
  endpoint="/api/ai-docs/ask"
  stream-endpoint="/api/ai-docs/ask/stream"
  assistant-name="Application assistant"
></ai-docs-assistant>
```

The Web Component can be used from plain HTML, React, Vue, Svelte or Angular. It captures the rendered page, supports element selection, streams responses and manages retry, cancellation and conversation state.

The optional generic settings screen uses the managed endpoints:

```ts
import "@123toto/ai-app-assistant-client/settings-web-component";
```

```html
<ai-docs-settings endpoint="/api/ai-docs"></ai-docs-settings>
```

## Headless browser client

```ts
import { capturePage, createAiDocsClient } from "@123toto/ai-app-assistant-client";

const client = createAiDocsClient({
  endpoint: "/api/ai-docs/ask",
  streamEndpoint: "/api/ai-docs/ask/stream"
});

const page = capturePage();
const answer = await client.ask({
  question: "What can I do on this page?",
  html: page.html,
  htmlTruncated: page.htmlTruncated
});
```

Use `AiDocsAssistantController` when the application wants the standard conversation lifecycle with a custom UI.

## Angular connector

```ts
import { provideAiDocs } from "@123toto/ai-app-assistant-client/angular";

export const appConfig = {
  providers: [
    provideAiDocs({
      endpoint: "/api/ai-docs/ask",
      streamEndpoint: "/api/ai-docs/ask/stream",
      accessEndpoint: "/api/ai-docs/access"
    })
  ]
};
```

`AiDocsAssistantComponent`, `AiDocsService` and `AiDocsSettingsService` remain optional. They reuse the same framework-neutral client and contracts.

## Custom models

Consumers can inject a Vercel AI SDK `LanguageModel` or implement `AnswerGenerator` without changing the client protocol:

```ts
import type { AnswerGenerator } from "@123toto/ai-app-assistant-server";

const generator: AnswerGenerator = {
  modelId: "custom:model",
  async generate(bundle, signal) {
    return callCustomModel(bundle, signal);
  }
};
```

## Production checklist

- Keep provider and encryption keys in backend secrets.
- Require authenticated identities for assistant routes.
- Restrict configuration and telemetry routes to administrators.
- Apply application-specific request and response redaction where needed.
- Use a shared quota and configuration store when running several instances.
- Exclude sensitive DOM subtrees with client capture options or `data-sensitive`.
