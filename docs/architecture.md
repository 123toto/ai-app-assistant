# Architecture

## Request flow

```text
application documents ──┐
rendered page HTML ──────┼─> evidence preparation ─> LLM ─> validated answer
selected element ────────┤
question + conversation ─┘
```

The browser captures the current page and optional selected element. The backend combines them with stable application documents, calls the configured model and validates the structured response before returning it.

## Package boundaries

| Package | Responsibility |
| --- | --- |
| `@123toto/ai-app-assistant-contracts` | Shared schemas and transport types |
| `@123toto/ai-app-assistant-server` | Evidence preparation, LLM adapters, validation, confidence, retries and optional managed services |
| `@123toto/ai-app-assistant-client` | Page capture, element selection, transport, conversation state and optional UI |

The core server uses standard `Request`, `Response`, `ReadableStream` and NDJSON. Express and Nest are optional adapters. The browser core has no framework dependency; Web Components and Angular are optional entry points.

## Host application responsibilities

| Library provides | Host application provides |
| --- | --- |
| Chat lifecycle and transport | Mount point and optional visual customization |
| Built-in model resolution and managed adapter lifecycle | Provider secret, host-owned inference adapter or custom generator |
| Document preparation and budgeting | Document sources and refresh timing |
| Generic settings, quotas and audit | Identity and authorization rules |
| Memory and Redis adapters | Existing Redis client or custom storage |
| Generic redaction hooks | Domain-specific privacy policy |

All managed features are optional. A minimal integration only needs a configured server endpoint and a browser client.

## Documents and context

A document may contain Markdown, plain text or JSON-compatible data such as OpenAPI. The host application loads external sources; the library serializes, deduplicates and caches them in memory.

For each question, the library allocates the available model context between the selected element, current page and stable documents. Model capabilities can be overridden for local or newly released models.

No route mapping, OpenAPI `operationId` or custom DOM identifier is required.

## Managed mode

The managed server adds:

- provider and model configuration;
- encrypted API-key persistence;
- model discovery and connection testing;
- access rules and per-user quotas;
- configuration ownership and audit history;
- memory or Redis-backed synchronization and telemetry;
- a complete HTTP API for the generic settings UI.

The host still owns the authenticated identity, administrator policy and any user directory exposed to the settings screen.

Host applications may register inference adapters for private gateways or cloud
runtimes. Built-in providers remain enabled by default for compatibility and
can be excluded explicitly. Adapter credentials and token renewal stay inside
the host application; the generic settings UI hides those host-managed fields
while retaining model and policy administration. The managed runtime continues
to own connection status, access, quotas, telemetry and safe transport.

## Reliability

Provider-independent stream events cover preparation, partial content, retry and completion. Retry is limited to transient network, timeout, rate-limit and provider failures. Deterministic configuration or context-size failures fail immediately.

Structured answers distinguish supported, partially supported and unsupported conclusions. Unknown evidence references are removed and confidence is derived from the evidence actually retained.

## Security boundaries

- Provider keys remain on the backend and are never returned by configuration endpoints.
- Persisted keys require AES-256-GCM encryption or a custom secret protector.
- HTTP handlers fail closed until authentication is configured.
- Form values and `[data-sensitive]` subtrees are excluded from browser capture by default.
- HTML and documents are treated as untrusted prompt data.
- Telemetry excludes prompts, page HTML, credentials and user identities.
- Host hooks can sanitize requests, stream events and final responses.
