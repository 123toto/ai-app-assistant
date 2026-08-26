# @123toto/ai-app-assistant-client

Framework-neutral browser client and optional UI for `@123toto/ai-app-assistant-server`.

```bash
npm install @123toto/ai-app-assistant-client
```

## Web Component

```ts
import "@123toto/ai-app-assistant-client/web-component";
```

```html
<ai-app-assistant
  endpoint="/api/ai-app-assistant/ask"
  stream-endpoint="/api/ai-app-assistant/ask/stream"
></ai-app-assistant>
```

The component handles page capture, DOM element selection, streaming, retry, cancellation and conversation state. It can be used from plain HTML, React, Vue, Svelte or Angular.

Runtime headers and visual labels can be configured programmatically:

```ts
document.querySelector("ai-app-assistant")?.configure({
  endpoint: "/api/ai-app-assistant/ask",
  headers: () => ({ authorization: `Bearer ${auth.token()}` }),
  assistantName: "Application assistant"
});
```

## Headless client

Import `createAiAppAssistantClient`, `AiAppAssistantController`, `capturePage` or `pickElement` from `@123toto/ai-app-assistant-client` when the application owns the complete UI.

## Angular connector

```ts
import { AiAppAssistantComponent, provideAiAppAssistant } from "@123toto/ai-app-assistant-client/angular";

bootstrapApplication(AppComponent, {
  providers: [provideAiAppAssistant({
    endpoint: "/api/ai-app-assistant/ask",
    streamEndpoint: "/api/ai-app-assistant/ask/stream",
    managedEndpoint: "/api/ai-app-assistant"
  })]
});
```

Angular and RxJS are optional peer dependencies. The main package and Web Components do not load Angular.

## Settings

The optional `@123toto/ai-app-assistant-client/settings-web-component` entry point registers a generic administration screen. Applications with their own UI can use `@123toto/ai-app-assistant-client/settings` instead.

## Capture privacy

Form values and `[data-sensitive]` subtrees are removed by default. Additional application-specific selectors can be provided through `redactSelectors`. Authentication and final privacy enforcement remain backend responsibilities.

Full documentation: [github.com/123toto/ai-app-assistant](https://github.com/123toto/ai-app-assistant)
