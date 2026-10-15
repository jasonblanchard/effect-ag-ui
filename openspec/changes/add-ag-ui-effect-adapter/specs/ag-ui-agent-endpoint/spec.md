## Purpose

An HTTP endpoint that serves a language-model agent over the AG-UI protocol. It accepts an AG-UI `RunAgentInput`, runs the model with server-side tools, and streams a spec-compliant AG-UI event sequence back as Server-Sent Events, so any AG-UI client can drive it.

## ADDED Requirements

### Requirement: Accept AG-UI run input
The endpoint SHALL accept an HTTP POST whose JSON body is an AG-UI `RunAgentInput` (`threadId`, `runId`, `messages`, and optional `state`, `tools`, `context`, `forwardedProps`). It SHALL treat `messages` as the complete conversation history and SHALL NOT need any server-side state from earlier requests.

#### Scenario: First user turn
- **WHEN** a client POSTs a `RunAgentInput` with one `user` message whose `content` is a string
- **THEN** the endpoint responds with status 200 and an AG-UI event stream answering that message

#### Scenario: Continuing a conversation that included a tool call
- **WHEN** a client POSTs history containing an `assistant` message with `toolCalls` and a `tool` message whose `toolCallId` matches one of those calls
- **THEN** the model receives that tool call and its result as prior context and the request succeeds

#### Scenario: Context entries
- **WHEN** the input includes `context` entries
- **THEN** their descriptions and values are given to the model as system instructions

#### Scenario: Client-declared tools are ignored
- **WHEN** the input includes a non-empty `tools` array
- **THEN** the request succeeds and those tools are not offered to the model

#### Scenario: Unsupported content parts are dropped
- **WHEN** a `user` or `tool` message contains a content part that is not text (for example an image)
- **THEN** that part is dropped with a server-side warning, the remaining text is used, and the request succeeds

#### Scenario: Tool result with only unsupported parts
- **WHEN** every content part of a `tool` message is dropped
- **THEN** the model still receives a result for that call, with empty-string content

#### Scenario: Tool message with an error
- **WHEN** a `tool` message has an `error`
- **THEN** the model receives the result as a failure that includes the `error` text alongside any content

#### Scenario: Unknown message role
- **WHEN** a message has a `role` this endpoint does not know
- **THEN** that message is dropped with a server-side warning and the request succeeds

### Requirement: Reject invalid run input before streaming
The endpoint SHALL validate the request body before starting a run. If the body is invalid, it SHALL respond with HTTP status 400 and a JSON error body, and SHALL NOT open an event stream.

#### Scenario: Malformed JSON
- **WHEN** the request body is not valid JSON
- **THEN** the response is status 400 with a JSON `error` field

#### Scenario: Missing required fields
- **WHEN** the body lacks `threadId`, `runId`, or `messages`
- **THEN** the response is status 400 with a JSON `error` field

#### Scenario: Tool result for an unknown tool call
- **WHEN** a `tool` message's `toolCallId` matches no earlier assistant tool call
- **THEN** the response is status 400 with a JSON `error` field


### Requirement: Stream AG-UI events as Server-Sent Events
For valid input, the endpoint SHALL respond with `Content-Type: text/event-stream`. Each AG-UI event SHALL be sent as one SSE message of the form `data: <JSON event>` followed by a blank line. Every event SHALL be valid against the AG-UI event schema for its `type`.

#### Scenario: SSE framing
- **WHEN** a valid run is streamed
- **THEN** every SSE message carries exactly one JSON-encoded AG-UI event in its `data` field

#### Scenario: Schema validity
- **WHEN** each streamed event is checked against the `@ag-ui/core` schema for its type
- **THEN** every event passes

### Requirement: Run lifecycle
Each response stream SHALL contain exactly one run. The first event SHALL be `RUN_STARTED` carrying the input's `threadId` and `runId`, and `protocolVersion: "1.0"`. The last event SHALL be exactly one terminal event, either `RUN_FINISHED` (with the same `threadId` and `runId`) or `RUN_ERROR`. No event SHALL follow the terminal event.

#### Scenario: Successful run
- **WHEN** the model answers without errors
- **THEN** the stream begins with `RUN_STARTED` and ends with a single `RUN_FINISHED` whose `threadId` and `runId` equal the input's, and which has no `outcome` (success)

#### Scenario: Protocol version declared
- **WHEN** any run starts
- **THEN** `RUN_STARTED.protocolVersion` is `"1.0"`

#### Scenario: Token usage reported
- **WHEN** a run finishes successfully
- **THEN** `RUN_FINISHED.usage` contains one entry per model, with token counts summed over every call to that model during the run

### Requirement: Steps per model call
Each model call within a run SHALL be wrapped in a `STEP_STARTED` / `STEP_FINISHED` pair with matching `stepName`. Step names SHALL be unique within the run.

#### Scenario: Single model call
- **WHEN** the model answers without calling tools
- **THEN** the run contains exactly one step pair, with all text events inside it

#### Scenario: Tool round then answer
- **WHEN** the model calls a tool and then answers using the result
- **THEN** the run contains two step pairs, in order, with distinct step names

### Requirement: Streamed text messages
Assistant text SHALL be streamed as `TEXT_MESSAGE_START` (with `role: "assistant"`), zero or more `TEXT_MESSAGE_CONTENT` deltas, then `TEXT_MESSAGE_END`, all sharing one `messageId`. A `messageId` SHALL NOT be started twice within a run.

#### Scenario: Incremental text
- **WHEN** the model streams a text answer
- **THEN** the client receives `TEXT_MESSAGE_CONTENT` deltas as they arrive, which concatenate to the full answer, bracketed by START and END with the same `messageId`

#### Scenario: Text in multiple steps
- **WHEN** the model emits text in two different steps
- **THEN** each text message has a distinct `messageId`

### Requirement: Streamed reasoning
When the model emits reasoning, it SHALL be streamed as `REASONING_START`, `REASONING_MESSAGE_START` (with `role: "reasoning"`), `REASONING_MESSAGE_CONTENT` deltas, `REASONING_MESSAGE_END`, and `REASONING_END`, sharing one `messageId` that is distinct from any assistant text message id.

#### Scenario: Model reasons before answering
- **WHEN** the model produces reasoning and then text
- **THEN** the reasoning events are fully closed before the text message starts, and the two use different `messageId`s

### Requirement: Server-side tool execution within one run
When the model requests a tool the server provides, the endpoint SHALL stream the call as `TOOL_CALL_START` (with `toolCallId`, `toolCallName`, and `parentMessageId`), `TOOL_CALL_ARGS` delta(s), and `TOOL_CALL_END`. It SHALL execute the tool, emit `TOOL_CALL_RESULT`, and call the model again with the result, all inside the same run, until the model stops requesting tools or a maximum number of steps is reached.

#### Scenario: Tool call round-trip
- **WHEN** the user asks for the current time
- **THEN** the stream contains `TOOL_CALL_START` for `GetCurrentTime`, its ARGS and END, a `TOOL_CALL_RESULT` with that `toolCallId` and `role: "tool"`, and then a text message that uses the result, all before a single `RUN_FINISHED`

#### Scenario: Tool call arguments are complete JSON
- **WHEN** all `TOOL_CALL_ARGS` deltas for one `toolCallId` are concatenated
- **THEN** the result parses as a JSON object containing the tool's parameters

#### Scenario: Tool call ids round-trip
- **WHEN** a client sends back the history it received, including `toolCalls` and `tool` messages using the streamed `toolCallId`s
- **THEN** the request is accepted (see "Accept AG-UI run input")

#### Scenario: Tool result message id
- **WHEN** a `TOOL_CALL_RESULT` is emitted
- **THEN** its `messageId` is new and not used by any other message in the run

#### Scenario: Tool failure
- **WHEN** a tool handler fails, whatever the tool's `failureMode`
- **THEN** a `TOOL_CALL_RESULT` is still emitted for that call with the failure described in `content`, the model is called again, and the run does not end with `RUN_ERROR`

#### Scenario: Invalid tool arguments from the model
- **WHEN** the model calls a tool with arguments that do not decode against the tool's parameters
- **THEN** a `TOOL_CALL_RESULT` describing the failure is emitted and the model is called again

#### Scenario: Step limit reached
- **WHEN** the model keeps requesting tools after the maximum number of steps
- **THEN** no further model call is made and the run ends with `RUN_FINISHED` carrying `outcome: { type: "cancelled" }` and no `result`

### Requirement: Errors end the run with RUN_ERROR
If the model or provider fails after the stream has started, the endpoint SHALL close any open text message, reasoning message, tool call, or step with its END/FINISHED event, then emit `RUN_ERROR` with a human-readable `message` and an error `code`, and then end the stream. Internal error details SHALL NOT be sent beyond the message and code. An unexpected (non-model) error SHALL be reported with a fixed message and code `INTERNAL_ERROR`; its details stay in the server log.

#### Scenario: Provider error mid-answer
- **WHEN** the provider fails after `TEXT_MESSAGE_START` has been sent
- **THEN** the client receives `TEXT_MESSAGE_END` for that message and `STEP_FINISHED` for the current step, followed by `RUN_ERROR` as the final event

#### Scenario: Provider error before any output
- **WHEN** the provider rejects the first model call
- **THEN** the stream is `RUN_STARTED`, `STEP_STARTED`, `STEP_FINISHED`, then `RUN_ERROR` as the final event

#### Scenario: Unexpected internal error
- **WHEN** the run fails with an error that is not a model or provider error
- **THEN** `RUN_ERROR` has code `INTERNAL_ERROR` and a fixed message that does not include the error's own text

### Requirement: Cancellation on client disconnect
When the client aborts the request or disconnects, the endpoint SHALL stop the run: it SHALL cancel any in-flight model request and SHALL NOT start further model calls or tool executions for that run.

#### Scenario: User presses Stop mid-stream
- **WHEN** the client aborts the HTTP request while text is streaming
- **THEN** the in-flight provider request is aborted and no further steps run

#### Scenario: Disconnect during tool execution
- **WHEN** the client disconnects while a tool is executing
- **THEN** no further model call is made for that run

### Requirement: Compatible with AG-UI clients
The endpoint SHALL be usable, unchanged, by AG-UI clients that consume SSE, including `useChat` with `fetchServerSentEvents` from `@tanstack/ai-react`.

#### Scenario: TanStack AI chat UI
- **WHEN** the `/chat` page's `useChat` is pointed at the endpoint and the user asks for the current time
- **THEN** the page shows the assistant's streamed answer, the loading state ends when the run finishes, and a follow-up message in the same conversation succeeds

#### Scenario: Stop button
- **WHEN** the user presses Stop in the `/chat` page during a response
- **THEN** the UI leaves the loading state and the server stops the run
