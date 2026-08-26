# @123toto/ai-app-assistant-contracts

Shared Zod schemas and TypeScript transport types for `@123toto/ai-app-assistant-server` and `@123toto/ai-app-assistant-client`.

The package is installed transitively by the server and client. Install it directly only when an application needs to validate the wire protocol itself:

```bash
npm install @123toto/ai-app-assistant-contracts
```

```ts
import {
  aiAppAssistantRequestSchema,
  aiAppAssistantResponseSchema,
  type AiAppAssistantRequest,
  type AiAppAssistantResponse
} from "@123toto/ai-app-assistant-contracts";
```

Full documentation: [github.com/123toto/ai-app-assistant](https://github.com/123toto/ai-app-assistant)
