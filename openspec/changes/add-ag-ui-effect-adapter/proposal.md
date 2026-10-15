## Why

Effect's AI library (`effect/ai`) gives us typed models, toolkits and streaming. But its `Response.StreamPart` stream is Effect's own format, so no off-the-shelf agent UI can read it. AG-UI is the open protocol those UIs speak. If an Effect language model can be served as a spec-compliant AG-UI endpoint, any AG-UI client can drive it without coupling the server to any one client library.

## What Changes

- Add a small set of plain functions that adapt Effect AI to AG-UI over HTTP:
  - decode an AG-UI `RunAgentInput` request body into an Effect `Prompt`
  - run a server-side agent loop that feeds tool results back to the model until it stops calling tools
  - translate the Effect stream into AG-UI events with correct lifecycle, including `RUN_STARTED`, `STEP_*`, `TEXT_MESSAGE_*`, `REASONING_*`, `TOOL_CALL_*`, `RUN_FINISHED` and `RUN_ERROR`
  - encode the events as Server-Sent Events, and abort the model request when the client disconnects
- Add a new API route that serves the existing `GetCurrentTime` toolkit through these functions.
- Point the existing `/chat` page (`useChat` from `@tanstack/ai-react`) at the new route to validate it against a real AG-UI client.
- The adapter does not depend on TanStack AI. Only the validation UI uses TanStack.

## Capabilities

### New Capabilities
- `ag-ui-agent-endpoint`: An HTTP endpoint that accepts an AG-UI `RunAgentInput`, runs an Effect language model with server-side tools, and streams a spec-compliant AG-UI event sequence back as SSE, with error and cancellation behavior.

### Modified Capabilities

## Impact

- **New code**: an adapter module under `src/` (four functions, plus a `fromRequest` convenience) and a new API route.
- **Modified code**: `src/routes/chat.tsx` switches its `fetchServerSentEvents` URL to the new route. `src/routes/api/chat.ts` (the TanStack reference) and `src/routes/api/generate.ts` stay as they are for comparison.
- **Dependencies**: `@ag-ui/core` becomes a direct dependency, used for protocol types only. It is already installed transitively. `@ag-ui/client` may be added as a dev dependency to check conformance.
- **Runtime**: one Anthropic request per agent-loop step. The number of steps is capped by a max-steps limit.
