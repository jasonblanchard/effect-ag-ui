## Context

See proposal.md for the motivation. Current state of the code:

- `src/routes/api/generate.ts` runs an Effect `AnthropicLanguageModel` with a `GetCurrentTime` toolkit. It already shows the main gap: `generateText`/`streamText` *resolve* tool calls but never send the results back to the model, so the caller has to loop.
- `src/routes/api/chat.ts` is TanStack AI's own `chat()` endpoint. It serves as a reference recording of what a working AG-UI stream looks like for the same tool.
- `src/routes/chat.tsx` renders `useChat` with `fetchServerSentEvents`.

Constraints found while investigating:

- TanStack AI's server encoder (`toWireChunk`) strips events down to AG-UI spec keys, so the TanStack client consumes plain AG-UI. The only extra it emits is `metadata.tanstack`.
- TanStack's own server marks agent-loop rounds with a non-spec "intermediate" `RUN_FINISHED` (`metadata.tanstack.finishReason: "tool_calls"`), so one run can contain several `RUN_FINISHED` events. We do not copy this.
- Effect's `Response.StreamPart` already has start/delta/end lifecycles for text, reasoning and tool params. It also has `tool-call`, `tool-result`, `finish` and `error` parts, so outbound translation is mostly a direct mapping.
- AG-UI tool messages carry `toolCallId` but no tool name, while Effect's `Prompt` tool-result part requires `name`.

## Goals / Non-Goals

**Goals:**
- Produce an AG-UI event stream that conforms to the spec, using only types from `@ag-ui/core`. No runtime dependency on TanStack AI in the adapter.
- Run server-side tools (Effect `Toolkit` + handler layer) inside a single run.
- Keep event translation a pure stream transformation that can be tested without a model.
- Interrupt the Effect fiber, and with it the provider HTTP request, when the client disconnects.

**Non-Goals:**
- Client-side tools, i.e. `RunAgentInput.tools` executed in the browser and continued by a new POST. The inbound `tools` field is accepted and ignored for now.
- Shared state (`STATE_SNAPSHOT`/`STATE_DELTA`), activities, interrupts/resume, subagents.
- Server-side persistence of threads.
- Multimodal input. Non-text content parts are dropped with a warning, never rejected: AG-UI forbids failing a run over a part the producer can't use.
- Packaging as a standalone library. The adapter lives in this app's `src/` for now.

## Decisions

### 1. Four plain functions, not one handler

```
fromRunAgentInput : unknown → Effect<{ input: RunAgentInput, prompt: Prompt }, AgUiInputError>
agentLoop         : (prompt, toolkit, { maxSteps }) → Stream<LoopPart, AiError, LanguageModel | ToolHandlers>
toAgUiEvents      : (input) → (Stream<LoopPart, AiError>) → Stream<AgUiEvent, never>
toSseResponse     : Stream<AgUiEvent, never, R> → Effect<Response, never, R>
```

`LoopPart` is `Response.StreamPart | StepStart | StepEnd | StepLimit`. The step markers are emitted by `agentLoop` around each model call, and `StepLimit` when `maxSteps` stops it. `fromRequest(request)` is a convenience over `fromRunAgentInput` that reads the body as JSON.

*Why:* each piece can be tested on its own. Above all, `toAgUiEvents` can be driven from hand-built `StreamPart` arrays. A single `handler({ model, toolkit })` wrapper can come later when we package this.
*Alternative:* one opaque handler. Rejected for now because it hides the seams we most need to test.

### 2. Server-side agent loop with `STEP_*` events (loop A)

`agentLoop` calls `chat.streamText({ prompt: [], toolkit })` repeatedly and forwards every part. After each call it checks the `finish` part. If the reason is `tool-calls` and fewer than `maxSteps` steps have run, it continues. Otherwise it stops. Each model call is one AG-UI step:

```
RUN_STARTED
  STEP_STARTED  step-1
    TEXT_MESSAGE_* / TOOL_CALL_START/ARGS/END / TOOL_CALL_RESULT
  STEP_FINISHED step-1
  STEP_STARTED  step-2
    TEXT_MESSAGE_*
  STEP_FINISHED step-2
RUN_FINISHED
```

*Why:* this keeps exactly one `RUN_STARTED`/terminal pair per HTTP request, which matches the spec. Steps are the spec's own way to mark sub-phases of a run, and clients that don't care about them can ignore them.
*Alternatives:* (B) copy TanStack's intermediate `RUN_FINISHED`, rejected because it isn't spec. (C) end the run after tool calls and let the client re-POST, rejected because it only fits client-side tools (a Non-Goal).

If `maxSteps` runs out while the model still wants tools, `agentLoop` logs a warning and emits a `StepLimit` marker. The run then ends with `RUN_FINISHED { outcome: { type: "cancelled" } }` and no `result`: the spec forbids reporting a run stopped by a producer limit as success. (The alternative, one last model call without tools so the model writes an answer, is also spec-correct; we chose cancelled for now.)

**Tool failures stay inside the run.** Effect tools default to `failureMode: "error"`, under which a failing handler, or parameters the model got wrong, fail the whole stream. `agentLoop` wraps the toolkit's `handle` so every failure becomes a failed `tool-result` (encoded with the tool's failure schema, falling back to `{ error: message }`), which is what `failureMode: "return"` would do. The model sees the failure and the loop continues. Defects still fail the run.

### 3. Stateless per request; `Chat` holds history only within the request

The client sends the full history on every POST. `fromRunAgentInput` builds a `Prompt`, and `agentLoop` seeds `Chat.fromPrompt(prompt)`. `Chat` adds each step's output, including tool results, to its history, so step N+1 sees the results of step N. Nothing outlives the request. `threadId`/`runId` from the input are echoed in `RUN_STARTED`/`RUN_FINISHED`.

*Alternative:* building `Prompt` by hand between steps. Rejected because `Chat` already does exactly this.

### 4. Outbound mapping (`toAgUiEvents`)

A `Stream.mapAccum` over `LoopPart` with state `{ stepAssistantId, openText, openReasoning, startedToolCalls, toolNames, usage[] }`. It emits zero or more events per part:

| Effect part | AG-UI event(s) |
|---|---|
| *(stream start)* | `RUN_STARTED { threadId, runId, protocolVersion: "1.0" }` |
| `StepStart` / `StepEnd` | `STEP_STARTED` / `STEP_FINISHED { stepName: "step-<n>" }` |
| `text-start/delta/end` | `TEXT_MESSAGE_START { role: "assistant" }` / `_CONTENT` / `_END` |
| `reasoning-start/delta/end` | `REASONING_START` + `REASONING_MESSAGE_START { role: "reasoning" }` / `REASONING_MESSAGE_CONTENT` / `REASONING_MESSAGE_END` + `REASONING_END` |
| `tool-params-start/delta/end` | `TOOL_CALL_START { toolCallId, toolCallName, parentMessageId }` / `TOOL_CALL_ARGS` / `TOOL_CALL_END` |
| `tool-call` | nothing if already started via params. Otherwise START + one ARGS (`JSON.stringify(params)`) + END |
| `tool-result` | `TOOL_CALL_RESULT { messageId: <new>, toolCallId, role: "tool", content }` |
| `finish` | record usage (no event) |
| `StepLimit` | mark the run cancelled (no event) |
| `error` part | treated like a stream failure (see 6) |
| `response-metadata`, `source`, `file` | dropped (could later become `RAW`/`CUSTOM`) |
| *(stream end)* | `RUN_FINISHED { threadId, runId, usage, outcome? }` |

**IDs.** Effect's part ids are per-block provider ids and may repeat across steps, so they are not used as AG-UI `messageId`s. Each step mints one assistant message id. The first text block in the step uses it, and every tool call in the step uses it as `parentMessageId`, which groups text and tool calls into one assistant message. Any further text block in the same step gets its own new id. Reasoning blocks and tool results always get new ids. Tool call ids pass through unchanged (`toolu_…`), because they have to round-trip in the next request's `toolCalls`/`toolCallId`.

**Tool results.** `content` is `JSON.stringify(encodedResult)`. On `isFailure`, the content is the JSON-encoded error. AG-UI has no failure flag on the event.

**Empty arguments.** Providers send no `tool-params-delta` for tools without parameters (observed with Anthropic). A tool call that reaches its END without any args gets one `TOOL_CALL_ARGS { delta: "{}" }` first, so the concatenated arguments always parse as a JSON object.

**Usage.** One `TokenUsage` entry is recorded per step (`model` from `response-metadata`, input/output/total/reasoning/cached tokens), then summed per model with `aggregateTokenUsage` from `@ag-ui/core`, because the spec wants one `RUN_FINISHED.usage` entry per provider and model. `provider` is left out because the adapter doesn't know which provider sits behind `LanguageModel`.

IDs come from Effect's `IdGenerator` service so tests can make them deterministic.

### 5. Inbound mapping (`fromRunAgentInput`)

The body is decoded with an Effect `Schema` for `RunAgentInput`, kept structurally aligned with `@ag-ui/core`, and then turned into `Prompt` messages:

| AG-UI message | Effect `Prompt` |
|---|---|
| `system`, `developer` | `system` text |
| `user` (string, or text content parts) | `user` text parts |
| `assistant { content?, toolCalls? }` | `assistant` with text part + `tool-call { id, name, params: JSON.parse(arguments) }` |
| `tool { toolCallId, content, error? }` | `tool` with `tool-result { id, name: <looked up>, result, isFailure: error !== undefined }`; `result` is parse-if-JSON(text), or `{ error, content? }` when `error` is set |
| `reasoning`, `activity` | dropped |

The tool name comes from an index of `toolCallId → name` built from earlier assistant `toolCalls`. A tool message with an unknown id is a decode error. `context[]` entries become one extra system message. `state`, `tools` and `forwardedProps` are accepted and ignored. Non-text content parts in user and tool messages are dropped with a warning; a tool message left with no text is answered with `""`. A message with a role this code doesn't know is dropped with a warning (known roles are excluded from that fallback, so a malformed known message is still a decode error).

A decode error happens before any event is written, so it returns HTTP 400 with a JSON body, not an SSE stream.

### 6. Errors become `RUN_ERROR`; the event stream itself never fails

`toAgUiEvents` catches the upstream failure channel (`AiError`, or an `error` part). It closes any open text/reasoning messages, tool calls and the current step with their END/FINISHED events, then emits `RUN_ERROR { message, code: <error _tag> }` as the last event. Its output type is `Stream<AgUiEvent, never>`. The full error is logged on the server, and only the message reaches the client. For anything that isn't an `AiError` or an `error` part (i.e. a bug), the message is a fixed `"Internal error"` with code `INTERNAL_ERROR`.

*Why:* a stream that just stops is reported as "truncated" by clients. A terminal event is always required.

### 7. SSE encoding and cancellation (`toSseResponse`)

Each event becomes `data: ${JSON.stringify(event)}\n\n`, with `Content-Type: text/event-stream`, `Cache-Control: no-cache` and `Connection: keep-alive`. No `event:` or `id:` lines. The stream becomes the `Response` body via `Stream.toReadableStreamWith(context, { signal: request.signal })`, using the route's `ManagedRuntime` services. (`toReadableStreamEffect` doesn't forward a signal.) Two paths interrupt the producing fiber: body cancellation and request abort. Interruption runs the Effect HTTP client's finalizers, which abort the Anthropic request.

*Why our own encoder:* it's three lines, and it keeps the adapter independent of `@tanstack/ai` (`toServerSentEventsResponse`) and of `@ag-ui/encoder`.

### 8. Types from `@ag-ui/core`; validate with two clients

`@ag-ui/core` is added as a direct dependency for its event and message TypeScript types. Conformance is checked two ways:
1. `useChat` (`@tanstack/ai-react`) on `/chat`, pointed at the new route. This is the success criterion.
2. AG-UI's own client (`@ag-ui/client`, dev dependency) consuming the endpoint. Its event-ordering verification gives a stricter, client-independent conformance check. It has one (`verifyEvents`). The test-only lifecycle checker (`src/ag-ui/testing/conformance.ts`) was built anyway and runs in the unit tests.

**Validation results:**
- `@ag-ui/client` `HttpAgent.run()` piped through `verifyEvents()`: passes for a tool round-trip run. `runAgent()` builds `user → assistant{toolCalls} → tool → assistant`, and a follow-up turn built from that history succeeds.
- TanStack `ChatClient` (the client inside `useChat`) with `fetchServerSentEvents`: two turns with no errors, and `isLoading` ends after each run. Messages are grouped the same way as against TanStack's own `/api/chat`: the tool call and result in one assistant message, the answer in the next. No difference needed handling.
- Our checker on live recordings: no violations, after the empty-arguments fix above. That fix came from a live run; the unit tests didn't cover the case.

## Risks / Trade-offs

- [Nitro may not cancel the response body on client disconnect, so the fiber keeps running] → Resolved: `ChatClient.stop()` mid-answer interrupted the loop fiber under both `vite dev` and the production Nitro server (`.output/server`). The `request.signal` option is wired in as well.
- [The TanStack client may handle `TOOL_CALL_RESULT` without TanStack's intermediate `RUN_FINISHED` differently, e.g. in tool-call grouping] → Covered by the `/chat` validation task. The spec-correct stream wins, and any client gaps are documented, not patched around.
- [Provider streams a `tool-call` without preceding `tool-params-*`, or both] → the `startedToolCalls` set dedupes, and both paths are unit-tested.
- [`Chat.streamText` updates history only when its stream completes] → the loop checks the finish reason only after each step's stream has fully drained, which is also the natural step boundary.
- [Tool-result `content` loses structure because it is JSON-stringified] → this is acceptable. AG-UI `content` is a string, and the next request round-trips it through parse-if-JSON.
- [Unbounded loops cost tokens] → `maxSteps` (default 5, same as `generate.ts`).

## Migration Plan

New code only. `/api/chat` (TanStack reference) and `/api/generate` stay in place, and `/chat` simply switches its URL. Rollback means pointing `/chat` back at `/api/chat`.
