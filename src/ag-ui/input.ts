import { Effect, Schema } from "effect";
import { Prompt } from "effect/ai";

// Structurally aligned with `RunAgentInputSchema` from `@ag-ui/core`. Unknown
// keys are ignored, so newer clients sending extra fields still decode.

const TextInputPart = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});

// Any non-text part (image, audio, document, ...). Kept loose: these parts are
// dropped with a warning, since the spec forbids failing a run over them.
const OtherInputPart = Schema.Struct({ type: Schema.String });

const InputContent = Schema.Union([
  Schema.String,
  Schema.Array(Schema.Union([TextInputPart, OtherInputPart])),
]);

const ToolCall = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("function"),
  function: Schema.Struct({
    name: Schema.String,
    arguments: Schema.String,
  }),
});

const SystemMessage = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals(["system", "developer"]),
  content: Schema.String,
});

const UserMessage = Schema.Struct({
  id: Schema.String,
  role: Schema.Literal("user"),
  content: InputContent,
});

const AssistantMessage = Schema.Struct({
  id: Schema.String,
  role: Schema.Literal("assistant"),
  content: Schema.optional(Schema.String),
  toolCalls: Schema.optional(Schema.Array(ToolCall)),
});

const ToolMessage = Schema.Struct({
  id: Schema.String,
  role: Schema.Literal("tool"),
  toolCallId: Schema.String,
  content: InputContent,
  error: Schema.optional(Schema.String),
});

// Reasoning and activity messages are not model input; accepted and dropped.
const IgnoredMessage = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals(["reasoning", "activity"]),
});

const knownRoles = new Set(["system", "developer", "user", "assistant", "tool", "reasoning", "activity"]);

// A role from a newer protocol version: stripped with a warning. Known roles
// are excluded so a malformed known message still fails to decode.
const UnknownMessage = Schema.Struct({
  id: Schema.String,
  role: Schema.String.check(Schema.makeFilter((role) => !knownRoles.has(role))).pipe(
    Schema.brand("UnknownRole"),
  ),
});

const isUnknownMessage = (message: typeof Message.Type): message is typeof UnknownMessage.Type =>
  !knownRoles.has(message.role);

const Message = Schema.Union([
  SystemMessage,
  UserMessage,
  AssistantMessage,
  ToolMessage,
  IgnoredMessage,
  UnknownMessage,
]);

const Context = Schema.Struct({
  description: Schema.String,
  value: Schema.String,
});

export const RunAgentInput = Schema.Struct({
  threadId: Schema.String,
  runId: Schema.String,
  parentRunId: Schema.optional(Schema.String),
  state: Schema.optional(Schema.Unknown),
  messages: Schema.Array(Message),
  tools: Schema.optional(Schema.Array(Schema.Unknown)),
  context: Schema.optional(Schema.Array(Context)),
  forwardedProps: Schema.optional(Schema.Unknown),
});

export type RunAgentInput = typeof RunAgentInput.Type;

export class AgUiInputError extends Schema.TaggedError<AgUiInputError>()(
  "AgUiInputError",
  { message: Schema.String },
) {}

const fail = (message: string) => Effect.fail(new AgUiInputError({ message }));

const parseIfJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** The text parts joined; any other part is dropped with a warning. */
const textOf = Effect.fnUntraced(function* (
  content: typeof InputContent.Type,
  at: string,
) {
  if (typeof content === "string") return content;
  const texts: Array<string> = [];
  for (const part of content) {
    if (part.type === "text" && "text" in part) {
      texts.push(part.text);
    } else {
      yield* Effect.logWarning(`${at}: dropped unsupported content part "${part.type}"`);
    }
  }
  return texts.join("");
});

const toPrompt = Effect.fnUntraced(function* (input: RunAgentInput) {
  const messages: Array<Prompt.MessageEncoded> = [];
  const toolNames = new Map<string, string>();

  if (input.context && input.context.length > 0) {
    messages.push({
      role: "system",
      content: input.context
        .map((entry) => `${entry.description}:\n${entry.value}`)
        .join("\n\n"),
    });
  }

  for (const [index, message] of input.messages.entries()) {
    const at = `messages[${index}]`;
    if (isUnknownMessage(message)) {
      yield* Effect.logWarning(`${at}: dropped message with unknown role "${message.role}"`);
      continue;
    }
    switch (message.role) {
      case "system":
      case "developer":
        messages.push({ role: "system", content: message.content });
        break;
      case "user":
        messages.push({
          role: "user",
          content: yield* textOf(message.content, at),
        });
        break;
      case "assistant": {
        const parts: Array<Prompt.AssistantMessagePartEncoded> = [];
        if (message.content) parts.push({ type: "text", text: message.content });
        for (const call of message.toolCalls ?? []) {
          // Tools without arguments may stream an empty string.
          const args = call.function.arguments.trim() || "{}";
          let params: unknown;
          try {
            params = JSON.parse(args);
          } catch {
            return yield* fail(
              `${at}: tool call "${call.id}" has arguments that are not valid JSON`,
            );
          }
          toolNames.set(call.id, call.function.name);
          parts.push({ type: "tool-call", id: call.id, name: call.function.name, params });
        }
        if (parts.length > 0) messages.push({ role: "assistant", content: parts });
        break;
      }
      case "tool": {
        const name = toolNames.get(message.toolCallId);
        if (name === undefined) {
          return yield* fail(
            `${at}: tool result for unknown tool call "${message.toolCallId}"`,
          );
        }
        const text = yield* textOf(message.content, at);
        const content = parseIfJson(text);
        const part: Prompt.ToolResultPartEncoded = {
          type: "tool-result",
          id: message.toolCallId,
          name,
          isFailure: message.error !== undefined,
          // `error` sits alongside the content, so the model sees both.
          result: message.error === undefined
            ? content
            : { error: message.error, ...(text === "" ? {} : { content }) },
        };
        // Results for one assistant turn belong together in a single message.
        const previous = messages.at(-1);
        if (previous?.role === "tool") {
          messages[messages.length - 1] = {
            ...previous,
            content: [...previous.content, part],
          };
        } else {
          messages.push({ role: "tool", content: [part] });
        }
        break;
      }
      case "reasoning":
      case "activity":
        break;
    }
  }

  return yield* Effect.try({
    try: () => Prompt.make(messages),
    catch: (error) =>
      new AgUiInputError({ message: `Invalid conversation: ${String(error)}` }),
  });
});

/**
 * Decode an AG-UI `RunAgentInput` body and convert its messages into an Effect
 * `Prompt`. The `tools`, `state` and `forwardedProps` fields are accepted but
 * not used.
 */
export const fromRunAgentInput = Effect.fnUntraced(function* (body: unknown) {
  const input = yield* Schema.decodeUnknownEffect(RunAgentInput)(body).pipe(
    Effect.mapError(
      (error) => new AgUiInputError({ message: `Invalid RunAgentInput: ${error.message}` }),
    ),
  );
  const prompt = yield* toPrompt(input);
  return { input, prompt };
});

/** Read a request body as JSON and decode it with `fromRunAgentInput`. */
export const fromRequest = (request: Request) =>
  Effect.tryPromise({
    try: () => request.json(),
    catch: () => new AgUiInputError({ message: "Request body is not valid JSON" }),
  }).pipe(Effect.flatMap(fromRunAgentInput));
