# AI App Assistant

Framework-neutral packages for adding a contextual AI App Assistant to an existing application.

The assistant answers questions from:

- stable application documents loaded by the backend;
- the rendered HTML of the current page;
- an optional DOM element selected by the user;
- the question and recent conversation turns.

It does not require route mappings, OpenAPI `operationId` values or custom DOM attributes.

## Packages

| Package | Purpose |
| --- | --- |
| `@123toto/ai-app-assistant-server` | Node.js backend, LLM adapters, managed configuration, quotas and HTTP connectors |
| `@123toto/ai-app-assistant-client` | Headless browser client, Web Components and an optional Angular connector |
| `@123toto/ai-app-assistant-contracts` | Shared Zod schemas and TypeScript transport types; installed transitively |

## Install

```bash
npm install @123toto/ai-app-assistant-server
npm install @123toto/ai-app-assistant-client
```

The server package includes the Vercel AI SDK and built-in connectors for OpenAI, Anthropic, Mistral and Google. Consumers do not install a provider package unless they want to inject their own AI SDK model.

Node.js 20 or later is required.

## Backend quick start

```ts
import { createAiAppAssistantServer } from "@123toto/ai-app-assistant-server";

const aiAppAssistant = createAiAppAssistantServer({
  model: process.env.AI_APP_ASSISTANT_MODEL ?? "mistral:mistral-small-latest",
  documents: [
    {
      id: "application-guide",
      title: "Application guide",
      mediaType: "text/markdown",
      content: applicationGuide
    },
    {
      id: "openapi",
      title: "API documentation",
      mediaType: "application/vnd.oai.openapi+json",
      content: openApiDocument
    }
  ],
  http: {
    resolveContext: request => authentication.currentUser(request),
    authorize: user => permissions.requireAssistantAccess(user)
  }
});

// Fetch-compatible frameworks such as Next.js, Hono or serverless runtimes.
export const POST = (request: Request) => aiAppAssistant.fetch.handle(request);
```

`mistral:*` reads `MISTRAL_API_KEY` from the backend environment. The API key is never included in browser code or assistant responses.

## Browser quick start

```ts
import "@123toto/ai-app-assistant-client/web-component";
```

```html
<ai-app-assistant
  endpoint="/api/ai-app-assistant/ask"
  stream-endpoint="/api/ai-app-assistant/ask/stream"
  assistant-name="Application assistant"
></ai-app-assistant>
```

The Web Component works in plain HTML, React, Vue, Svelte and Angular. It owns page capture, DOM selection, conversation state, streaming, retry and cancellation.

## Managed production setup

Applications that need an administration screen can opt into the managed server. It adds encrypted provider configuration, access rules, per-user quotas, model discovery, audit history, Redis synchronization and safe telemetry.

```ts
import { createManagedAiAppAssistantServer } from "@123toto/ai-app-assistant-server";

const aiAppAssistant = createManagedAiAppAssistantServer({
  configuration: {
    storage: { type: "redis", client: redis, prefix: "my-app:ai-app-assistant:" },
    encryptionKey: process.env.AI_APP_ASSISTANT_SECRET_ENCRYPTION_KEY!,
    defaultConfiguration: {
      provider: "mistral",
      model: "mistral-small-latest",
      access: { mode: "roles", roles: ["AI_ASSISTANT_USER"] }
    },
    resolveDefaultApiKey: provider => secrets.forProvider(provider),
    defaultQuota: { maxRequests: 20, windowSeconds: 3600 }
  },
  documents,
  runtime: {
    transformRequest: (input, user) => privacy.sanitizeRequest(input, user),
    transformResponse: (output, user) => privacy.presentResponse(output, user)
  },
  http: {
    resolveIdentity: request => authentication.currentUser(request),
    authorizeAdministration: user => permissions.requireAssistantAdmin(user),
    listRoles: () => directory.roles(),
    listUsers: user => directory.usersVisibleTo(user)
  }
});

await aiAppAssistant.initialize();
```

The application remains responsible only for identity, business-specific privacy rules, its document sources and optional visual customization.

### Express

```ts
import { createManagedAiAppAssistantExpressHandler } from "@123toto/ai-app-assistant-server/express";

app.use("/api/ai-app-assistant", createManagedAiAppAssistantExpressHandler(aiAppAssistant));
```

### Nest

`@123toto/ai-app-assistant-server/nest` provides a dynamic module with its own catch-all controller. The host application does not declare AI App Assistant endpoints or duplicate DTOs.

### Generic settings UI

```ts
import "@123toto/ai-app-assistant-client/settings-web-component";
```

```html
<ai-app-assistant-settings endpoint="/api/ai-app-assistant"></ai-app-assistant-settings>
```

Angular applications may instead use `provideAiAppAssistant`, `AiAppAssistantComponent` and `AiAppAssistantSettingsService` from `@123toto/ai-app-assistant-client/angular`.

## Built-in model identifiers

| Identifier | Backend environment variable |
| --- | --- |
| `openai:model` | `OPENAI_API_KEY` |
| `anthropic:model` | `ANTHROPIC_API_KEY` |
| `mistral:model` | `MISTRAL_API_KEY` |
| `google:model` or `gemini:model` | `GOOGLE_API_KEY` |
| `ollama:model` | No key required by default |

Any Vercel AI SDK `LanguageModel` or custom `AnswerGenerator` can be injected instead.

## Security defaults

- HTTP handlers fail closed until authentication is configured.
- Provider keys stay in the backend and are never returned by configuration endpoints.
- Persisted keys require AES-256-GCM encryption or a custom secret protector.
- Browser capture removes form values and `[data-sensitive]` subtrees by default.
- Prompts, page HTML, user identities and credentials are excluded from telemetry.
- Host applications can transform requests, streamed events and responses to enforce their own privacy rules.

## Documentation

- [Programmatic usage](./docs/programmatic-usage.md)
- [Architecture](./docs/architecture.md)
- [Public API](./docs/public-api.md)
- [NPM release checklist](./docs/npm-release.md)

## Development

```bash
pnpm install
pnpm check
```

## License

[MIT](./LICENSE) © 2026 123toto.
