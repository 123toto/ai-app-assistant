# @123toto/ai-app-assistant-server

Framework-neutral Node.js backend for contextual in-app AI documentation.

```bash
npm install @123toto/ai-app-assistant-server
```

Node.js 20 or later is required.

## Minimal server

```ts
import { createAiDocsServer } from "@123toto/ai-app-assistant-server";

const aiDocs = createAiDocsServer({
  model: "mistral:mistral-small-latest",
  documents,
  http: {
    resolveContext: request => auth.currentUser(request),
    authorize: user => auth.requireAssistantAccess(user)
  }
});

export const POST = (request: Request) => aiDocs.fetch.handle(request);
```

The selected provider reads its conventional API key from the backend environment. `allowAnonymous: true` is available only for deliberately public prototypes.

## Managed server

`createManagedAiDocsServer()` adds optional administration features without changing the minimal API:

- provider and model discovery;
- encrypted API-key persistence;
- connection tests and key revocation;
- access rules, quotas and audit history;
- Redis synchronization across instances;
- aggregated usage and normalized failure telemetry;
- complete Fetch API handlers for chat and administration.

```ts
import { createManagedAiDocsServer } from "@123toto/ai-app-assistant-server";

const aiDocs = createManagedAiDocsServer({
  configuration: {
    storage: { type: "redis", client: redis },
    encryptionKey: process.env.AI_DOCS_SECRET_ENCRYPTION_KEY!,
    defaultConfiguration: {
      provider: "mistral",
      model: "mistral-small-latest",
      access: { mode: "all" }
    },
    resolveDefaultApiKey: () => process.env.MISTRAL_API_KEY
  },
  documents,
  http: {
    resolveIdentity: request => auth.currentUser(request),
    authorizeAdministration: user => auth.requireAdmin(user)
  }
});

await aiDocs.initialize();
```

Documents may also be loaded after application bootstrap with `aiDocs.setDocuments(documents)`.

## Framework connectors

```ts
import { createManagedAiDocsExpressHandler } from "@123toto/ai-app-assistant-server/express";

app.use("/api/ai-docs", createManagedAiDocsExpressHandler(aiDocs));
```

For Nest, import `createManagedAiDocsNestModule` from `@123toto/ai-app-assistant-server/nest`. Nest, RxJS and reflect-metadata are optional peer dependencies and are not required by other consumers.

Native Node and Fetch-compatible runtimes can use `createAiDocsNodeHttpListener` or the standard `Request`/`Response` handlers.

## Providers

OpenAI, Anthropic, Mistral, Google/Gemini and Ollama are supported through `provider:model` identifiers. Consumers may inject any Vercel AI SDK model or implement the provider-neutral `AnswerGenerator` interface.

## Telemetry

The managed server records counts, durations, token usage and normalized failures. It never records questions, HTML, user identities or credentials. Redis persistence is selected automatically when managed Redis storage is configured; use `telemetry: false` to disable it.

Full documentation: [github.com/123toto/ai-app-assistant](https://github.com/123toto/ai-app-assistant)
