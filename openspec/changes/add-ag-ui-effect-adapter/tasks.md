## 1. Setup

- [x] 1.1 Add `@ag-ui/core` as a direct dependency (same version TanStack pulls in, `1.0.0`) and confirm its types import cleanly from `src/`
- [x] 1.2 Add a test runner (`vitest` + `@effect/vitest` matching `effect@4`) with a `test` script, and confirm an empty test passes
- [x] 1.3 Create the adapter module folder `src/ag-ui/` with one file per function (`input.ts`, `loop.ts`, `events.ts`, `sse.ts`) and an `index.ts` that re-exports them

## 2. Inbound: `fromRunAgentInput`

- [x] 2.1 Define an Effect `Schema` for `RunAgentInput` and its message union (system, developer, user, assistant with `toolCalls`, tool, reasoning, activity) that matches `@ag-ui/core` in structure
- [x] 2.2 Map AG-UI messages to `Prompt` messages per design §5: build the `toolCallId → name` index, parse `arguments`, parse-if-JSON tool `content`, map `error` to `isFailure`, drop reasoning/activity
- [x] 2.3 Fold `context[]` into one system message; accept and ignore `state`, `tools`, `forwardedProps`
- [x] 2.4 Return a typed `AgUiInputError` for bad JSON, schema failure, and unknown `toolCallId` (non-text content parts are dropped, see 8.1)
- [x] 2.5 Unit tests: plain user turn, a history with a tool round-trip, context entries, each `AgUiInputError` case

## 3. Outbound: `toAgUiEvents`

- [x] 3.1 Define the `LoopPart` type (`Response.StreamPart | StepStart | StepEnd`) and the accumulator state (step assistant id, open text/reasoning, started tool calls, usage)
- [x] 3.2 Map text and reasoning parts to `TEXT_MESSAGE_*` / `REASONING_*` events, with the step-scoped id strategy from design §4 and ids from `IdGenerator`
- [x] 3.3 Map `tool-params-*` to `TOOL_CALL_START/ARGS/END` with `parentMessageId`, and synthesize START/ARGS/END from a bare `tool-call` only when it wasn't already started
- [x] 3.4 Map `tool-result` to `TOOL_CALL_RESULT` with a new `messageId`, `role: "tool"`, and JSON `content` (including failures)
- [x] 3.5 Bracket with `RUN_STARTED` and `RUN_FINISHED` (echoing `threadId`/`runId`, `usage` summed per model) and `STEP_STARTED`/`STEP_FINISHED` from the step markers
- [x] 3.6 Turn upstream failures and `error` parts into the close-open-things + `RUN_ERROR { message, code }` sequence, so the output stream type is `Stream<AgUiEvent, never>`; log the full error
- [x] 3.7 Unit tests from hand-built part arrays with a deterministic `IdGenerator`: text only, reasoning then text, streamed tool params, bare `tool-call`, both (dedupe), tool failure, error mid-text, error before output
- [x] 3.8 Add a test helper that validates every event against the `@ag-ui/core` zod schemas and checks lifecycle rules (one run, terminal last, START/END pairing, unique message ids). Run it on every 3.7 case

## 4. Agent loop: `agentLoop`

- [x] 4.1 Seed `Chat.fromPrompt(prompt)` and run `chat.streamText({ prompt: [], toolkit })` per step, emitting `StepStart`/`StepEnd` around each call
- [x] 4.2 After each step drains, continue only when the finish reason is `tool-calls` and the step count is below `maxSteps` (default 5); log a warning and emit a `step-limit` marker when the cap stops the loop
- [x] 4.3 Test with a scripted fake `LanguageModel` layer: a tool round followed by an answer gives two steps with history carried over; a model that never stops tool-calling stops at `maxSteps`

## 5. Transport: `toSseResponse`

- [x] 5.1 Encode events as `data: <json>\n\n` and build a `Response` with SSE headers via `Stream.toReadableStreamWith` (forwards `request.signal`)
- [x] 5.2 Test that cancelling the returned body's reader interrupts the producing stream (finalizer runs) and no more events are pulled

## 6. Route and wiring

- [x] 6.1 Add `src/routes/api/agent.ts`: a `POST` handler that uses the same Anthropic model and `GetCurrentTime` toolkit layers as `generate.ts`, chains `fromRunAgentInput → agentLoop → toAgUiEvents → toSseResponse`, and maps `AgUiInputError` to a 400 JSON response
- [x] 6.2 Regenerate the route tree and confirm `npm run build` type-checks
- [x] 6.3 Point `src/routes/chat.tsx` at `fetchServerSentEvents("/api/agent")`, leaving `/api/chat` in place as the reference

## 7. Validation

- [x] 7.1 `curl` the new route with the same `RunAgentInput` used for `/api/chat`, then check the recorded stream by eye against the reference and with the 3.8 checker
- [ ] 7.2 In the browser `/chat` page: ask for the current time, confirm the streamed answer renders and loading ends, then send a follow-up in the same conversation and confirm it succeeds (tool-call history round-trip)
  - Done with TanStack `ChatClient` (the client inside `useChat`) in Node: both turns pass. Still to do: a click-through of the `/chat` page itself (Chrome extension wasn't connected)
- [x] 7.3 Cancellation: press Stop mid-response and confirm from server logs (finalizer / interrupt) that the fiber and Anthropic request were aborted, including under Nitro. If not, add the `request.signal` race from the design's Risks section
- [x] 7.4 Consume the endpoint with `@ag-ui/client` (dev dependency) and its event verification if it has one; record the result, and document any client difference found (e.g. TanStack grouping) in design.md, not by working around it in the adapter

## 8. Review fixes (AG-UI 1.0 conformance)

- [x] 8.1 Drop non-text content parts in user and tool messages with a warning instead of a 400; answer an all-dropped tool result with `""`
- [x] 8.2 End a run stopped by `maxSteps` with `RUN_FINISHED { outcome: { type: "cancelled" } }`
- [x] 8.3 Send `protocolVersion: "1.0"` on `RUN_STARTED`, and check it in the conformance checker
- [x] 8.4 Keep tool failures (handler errors and undecodable parameters) inside the run as failed results, whatever the tool's `failureMode`; test with a tool that really fails
- [x] 8.5 Pass a tool message's `error` text to the model alongside its content
- [x] 8.6 Report `RUN_FINISHED.usage` as one entry per model
- [x] 8.7 Drop messages with unknown roles with a warning
- [x] 8.8 Send a fixed message for `INTERNAL_ERROR`
