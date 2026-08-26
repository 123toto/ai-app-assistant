# Public API

Only package exports listed below are part of the supported API. Internal `src` files must not be imported directly.

## Server

| Entry point | Main exports |
| --- | --- |
| `@123toto/ai-app-assistant-server` | `createAiAppAssistantServer`, `createManagedAiAppAssistantServer`, `createAiAppAssistantNodeHttpListener`, model adapters, configuration, quota, telemetry and storage primitives |
| `@123toto/ai-app-assistant-server/ai-sdk` | Vercel AI SDK generator and provider error types |
| `@123toto/ai-app-assistant-server/express` | `createManagedAiAppAssistantExpressHandler` |
| `@123toto/ai-app-assistant-server/nest` | `createManagedAiAppAssistantNestModule`, `MANAGED_AI_APP_ASSISTANT_SERVER` |

The managed HTTP API exposes these relative routes:

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/access` | Assistant availability and conversation limit |
| `POST` | `/ask` | Complete answer |
| `POST` | `/ask/stream` | NDJSON streamed answer |
| `GET` | `/configuration` | Safe effective configuration |
| `GET` | `/providers` | Provider catalogue |
| `GET` | `/configuration/options` | Optional roles and users |
| `POST` | `/models` | Model discovery |
| `POST` | `/configuration/test` | Connection test |
| `PUT` | `/configuration` | Validate and save configuration |
| `DELETE` | `/configuration/api-key` | Revoke a persisted key |
| `GET` | `/telemetry` | Aggregate operational metrics |
| `GET` | `/telemetry/failures` | Recent normalized failures |

Configuration and telemetry routes require the host application's administration authorization hook.

## Client

| Entry point | Main exports |
| --- | --- |
| `@123toto/ai-app-assistant-client` | `createAiAppAssistantClient`, `AiAppAssistantController`, capture and picker utilities |
| `@123toto/ai-app-assistant-client/web-component` | `<ai-app-assistant>` and `defineAiAppAssistantElement` |
| `@123toto/ai-app-assistant-client/settings` | Headless settings client and controller |
| `@123toto/ai-app-assistant-client/settings-web-component` | `<ai-app-assistant-settings>` and `defineAiAppAssistantSettingsElement` |
| `@123toto/ai-app-assistant-client/angular` | `provideAiAppAssistant`, `AiAppAssistantService`, `AiAppAssistantComponent`, `AiAppAssistantSettingsService` |

## Contracts

`@123toto/ai-app-assistant-contracts` exports the Zod schemas and inferred TypeScript types used by both ends of the protocol, including:

- `AiAppAssistantRequest` and `AiAppAssistantResponse`;
- `AiAppAssistantTransportEvent`;
- managed configuration, access, provider and model contracts;
- token-usage and evidence contracts;
- `PROTOCOL_VERSION`.

Applications normally receive this package transitively. Install it directly only when application code needs to validate or construct protocol messages.

## Compatibility policy

The first public release starts at `0.1.0`. Until `1.0.0`, breaking changes may occur in minor versions and will be documented in release notes. Patch versions preserve the exported API and protocol.
