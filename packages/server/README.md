# @123toto/ai-app-assistant-server

Framework-neutral Node.js backend for contextual AI App Assistant integrations.

```bash
npm install @123toto/ai-app-assistant-server
```

Node.js 20 or later is required.

## Minimal server

```ts
import { createAiAppAssistantServer } from "@123toto/ai-app-assistant-server";

const aiAppAssistant = createAiAppAssistantServer({
  model: "mistral:mistral-small-latest",
  documents,
  http: {
    resolveContext: request => auth.currentUser(request),
    authorize: user => auth.requireAssistantAccess(user)
  }
});

export const POST = (request: Request) => aiAppAssistant.fetch.handle(request);
```

The selected provider reads its conventional API key from the backend environment. `allowAnonymous: true` is available only for deliberately public prototypes.

## Managed server

`createManagedAiAppAssistantServer()` adds optional administration features without changing the minimal API:

- provider and model discovery;
- encrypted API-key persistence;
- connection tests and key revocation;
- access rules, quotas and audit history;
- Redis synchronization across instances;
- aggregated usage and normalized failure telemetry;
- complete Fetch API handlers for chat and administration.

```ts
import { createManagedAiAppAssistantServer } from "@123toto/ai-app-assistant-server";

const aiAppAssistant = createManagedAiAppAssistantServer({
  configuration: {
    enabled: process.env.AI_APP_ASSISTANT_LLM_ENABLED === "true",
    storage: { type: "redis", client: redis },
    encryptionKey: process.env.AI_APP_ASSISTANT_SECRET_ENCRYPTION_KEY!,
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

await aiAppAssistant.initialize();
```

For deployments exposing one provider at a time, the library maps generic
runtime values without requiring provider-specific environment variables:

```ts
const deployment = createAiAppAssistantDeploymentDefaults({
  enabled: env.AI_APP_ASSISTANT_LLM_ENABLED,
  provider: env.AI_APP_ASSISTANT_PROVIDER,
  model: env.AI_APP_ASSISTANT_LLM_MODEL,
  apiKey: env.AI_APP_ASSISTANT_API_KEY,
  baseURL: env.AI_APP_ASSISTANT_LOCAL_LLM_BASE_URL
});
```

`baseURL` is required for the local `ollama` provider. API keys and encryption
keys must come from a runtime secret store; they must never be committed or
embedded in an application image.

`enabled: false` disables every provider operation while keeping the host
application and the read-only administration endpoints available.

Documents may also be loaded after application bootstrap with `aiAppAssistant.setDocuments(documents)`.

## Framework connectors

```ts
import { createManagedAiAppAssistantExpressHandler } from "@123toto/ai-app-assistant-server/express";

app.use("/api/ai-app-assistant", createManagedAiAppAssistantExpressHandler(aiAppAssistant));
```

For Nest, import `createManagedAiAppAssistantNestModule` from `@123toto/ai-app-assistant-server/nest`. Nest, RxJS and reflect-metadata are optional peer dependencies and are not required by other consumers.

Native Node and Fetch-compatible runtimes can use `createAiAppAssistantNodeHttpListener` or the standard `Request`/`Response` handlers.

## Providers

OpenAI, Anthropic, Mistral, Google/Gemini and Ollama are supported through `provider:model` identifiers. Consumers may inject any Vercel AI SDK model or implement the provider-neutral `AnswerGenerator` interface.

Managed applications can register an `AiAppAssistantInferenceAdapter` for a
corporate AI gateway or another cloud runtime. Set
`includeBuiltInProviders: false` to expose only host-approved adapters. Adapter
authentication remains application-owned; no public-provider API key is
required unless the adapter explicitly declares `requiresApiKey: true`.
Custom adapters are host-managed by default, so the generic settings UI hides
provider credentials and endpoint controls while retaining model selection,
connection tests, access rules and quotas. Set `connectionManagement:
"settings"` only when administrators may configure the connection in that UI.

See the [extension-point guide](https://github.com/123toto/ai-app-assistant/blob/main/docs/extension-points.md#model-adapter-pattern)
for the complete managed-server example.

## Telemetry

The managed server records counts, durations, token usage and normalized failures. It never records questions, HTML, user identities or credentials. Redis persistence is selected automatically when managed Redis storage is configured; use `telemetry: false` to disable it.

Full documentation: [github.com/123toto/ai-app-assistant](https://github.com/123toto/ai-app-assistant)
