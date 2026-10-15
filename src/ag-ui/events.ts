import {
  aggregateTokenUsage,
  EventType,
  PROTOCOL_VERSION,
  type Event as AgUiEvent,
  type TokenUsage,
} from "@ag-ui/core";
import { Cause, Effect, Option, Stream } from "effect";
import { AiError, IdGenerator, type Response } from "effect/ai";

export type { AgUiEvent };

/** Emitted by the agent loop around each model call. */
export interface StepStart {
  readonly type: "step-start";
}
export interface StepEnd {
  readonly type: "step-end";
}

/** Emitted by the agent loop when it stops because of its step limit. */
export interface StepLimit {
  readonly type: "step-limit";
}

export type LoopPart = Response.StreamPart<any> | StepStart | StepEnd | StepLimit;

export const stepStart: StepStart = { type: "step-start" };
export const stepEnd: StepEnd = { type: "step-end" };
export const stepLimit: StepLimit = { type: "step-limit" };

/** An `error` part from the model stream, surfaced as a stream failure. */
class StreamPartError extends Error {
  constructor(readonly error: unknown) {
    super(error instanceof Error ? error.message : String(error));
  }
}

const describeError = (cause: Cause.Cause<unknown>) => {
  if (Cause.hasInterruptsOnly(cause)) {
    return { message: "The run was interrupted", code: "INTERRUPTED" };
  }
  const error = Cause.squash(cause);
  if (AiError.isAiError(error)) {
    return { message: error.message, code: error.reason._tag };
  }
  if (error instanceof StreamPartError) {
    return { message: error.message, code: "MODEL_ERROR" };
  }
  // Anything else is a bug; its details stay in the server log.
  return { message: "Internal error", code: "INTERNAL_ERROR" };
};

const toTokenUsage = (
  usage: Response.Usage,
  model: string | undefined,
): TokenUsage => {
  const input = usage.inputTokens.total;
  const output = usage.outputTokens.total;
  return {
    model,
    inputTokens: input,
    outputTokens: output,
    totalTokens:
      input !== undefined && output !== undefined ? input + output : undefined,
    reasoningTokens: usage.outputTokens.reasoning,
    cachedInputTokens: usage.inputTokens.cacheRead,
    cacheWriteInputTokens: usage.inputTokens.cacheWrite,
  };
};

/**
 * Per-run translation state. Effect part ids are provider block ids that can
 * repeat across steps, so AG-UI message ids are minted here instead. Tool call
 * ids pass through unchanged because they round-trip in the next request.
 */
class Translator {
  private step = 0;
  private stepOpen = false;
  /** Shared by the step's first text message and all of its tool calls. */
  private assistantId: string | undefined;
  private assistantIdUsed = false;
  private readonly openText = new Map<string, string>();
  private readonly openReasoning = new Map<string, string>();
  /** Open tool calls, and whether any argument delta has been sent yet. */
  private readonly openToolCalls = new Map<string, boolean>();
  private readonly startedToolCalls = new Set<string>();
  private readonly usage: Array<TokenUsage> = [];
  private model: string | undefined;
  private cancelled = false;

  constructor(
    private readonly input: {
      readonly threadId: string;
      readonly runId: string;
    },
    private readonly ids: IdGenerator.Service,
  ) {}

  runStarted(): AgUiEvent {
    return {
      type: EventType.RUN_STARTED,
      threadId: this.input.threadId,
      runId: this.input.runId,
      protocolVersion: PROTOCOL_VERSION,
    };
  }

  onPart = Effect.fnUntraced(function* (
    this: Translator,
    part: LoopPart,
  ): Effect.fn.Return<ReadonlyArray<AgUiEvent>, StreamPartError> {
    switch (part.type) {
      case "step-start": {
        const events = this.closeStep();
        this.step += 1;
        this.stepOpen = true;
        this.assistantId = yield* this.ids.generateId();
        this.assistantIdUsed = false;
        events.push({
          type: EventType.STEP_STARTED,
          stepName: this.stepName(),
        });
        return events;
      }
      case "step-end":
        return this.closeStep();

      case "text-start":
        return [yield* this.startText(part.id)];
      case "text-delta": {
        const events: Array<AgUiEvent> = [];
        if (!this.openText.has(part.id))
          events.push(yield* this.startText(part.id));
        events.push({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: this.openText.get(part.id)!,
          delta: part.delta,
        });
        return events;
      }
      case "text-end":
        return this.endText(part.id);

      case "reasoning-start":
        return yield* this.startReasoning(part.id);
      case "reasoning-delta": {
        const events: Array<AgUiEvent> = [];
        if (!this.openReasoning.has(part.id))
          events.push(...(yield* this.startReasoning(part.id)));
        events.push({
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: this.openReasoning.get(part.id)!,
          delta: part.delta,
        });
        return events;
      }
      case "reasoning-end":
        return this.endReasoning(part.id);

      case "tool-params-start":
        return [this.startToolCall(part.id, part.name)];
      case "tool-params-delta":
        if (!this.openToolCalls.has(part.id)) return [];
        this.openToolCalls.set(part.id, true);
        return [
          {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: part.id,
            delta: part.delta,
          },
        ];
      case "tool-params-end":
        return this.endToolCall(part.id);

      case "tool-call": {
        // Already streamed through tool-params-*: only make sure it is closed.
        if (this.startedToolCalls.has(part.id))
          return this.endToolCall(part.id);
        const start = this.startToolCall(part.id, part.name);
        this.openToolCalls.set(part.id, true);
        return [
          start,
          {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: part.id,
            delta: JSON.stringify(part.params ?? {}),
          },
          ...this.endToolCall(part.id),
        ];
      }

      case "tool-result": {
        if (part.preliminary) return [];
        return [
          ...this.endToolCall(part.id),
          {
            type: EventType.TOOL_CALL_RESULT,
            messageId: yield* this.ids.generateId(),
            toolCallId: part.id,
            role: "tool",
            content: JSON.stringify(part.encodedResult ?? null),
          },
        ];
      }

      case "response-metadata":
        if (part.modelId !== undefined) this.model = part.modelId;
        return [];
      case "finish":
        this.usage.push(toTokenUsage(part.usage, this.model));
        return [];
      case "step-limit":
        this.cancelled = true;
        return [];
      case "error":
        return yield* Effect.fail(new StreamPartError(part.error));

      default:
        // tool-approval-request, file and source parts are not mapped (yet).
        return [];
    }
  });

  onEnd(): ReadonlyArray<AgUiEvent> {
    return [
      ...this.closeStep(),
      {
        type: EventType.RUN_FINISHED,
        threadId: this.input.threadId,
        runId: this.input.runId,
        // A run stopped by the step limit did not complete, so it must not
        // read as success.
        ...(this.cancelled ? { outcome: { type: "cancelled" } } : {}),
        // One entry per model, summed across steps.
        ...(this.usage.length > 0 ? { usage: aggregateTokenUsage(this.usage) } : {}),
      },
    ];
  }

  onError(cause: Cause.Cause<unknown>): ReadonlyArray<AgUiEvent> {
    return [
      ...this.closeStep(),
      { type: EventType.RUN_ERROR, ...describeError(cause) },
    ];
  }

  private stepName() {
    return `step-${this.step}`;
  }

  private startText = Effect.fnUntraced(function* (
    this: Translator,
    id: string,
  ) {
    let messageId: string;
    if (this.assistantId !== undefined && !this.assistantIdUsed) {
      messageId = this.assistantId;
      this.assistantIdUsed = true;
    } else {
      messageId = yield* this.ids.generateId();
    }
    this.openText.set(id, messageId);
    return {
      type: EventType.TEXT_MESSAGE_START,
      messageId,
      role: "assistant",
    } satisfies AgUiEvent as AgUiEvent;
  });

  private endText(id: string): Array<AgUiEvent> {
    const messageId = this.openText.get(id);
    if (messageId === undefined) return [];
    this.openText.delete(id);
    return [{ type: EventType.TEXT_MESSAGE_END, messageId }];
  }

  private startReasoning = Effect.fnUntraced(function* (
    this: Translator,
    id: string,
  ) {
    const messageId = yield* this.ids.generateId();
    this.openReasoning.set(id, messageId);
    return [
      { type: EventType.REASONING_START, messageId },
      { type: EventType.REASONING_MESSAGE_START, messageId, role: "reasoning" },
    ] satisfies Array<AgUiEvent> as Array<AgUiEvent>;
  });

  private endReasoning(id: string): Array<AgUiEvent> {
    const messageId = this.openReasoning.get(id);
    if (messageId === undefined) return [];
    this.openReasoning.delete(id);
    return [
      { type: EventType.REASONING_MESSAGE_END, messageId },
      { type: EventType.REASONING_END, messageId },
    ];
  }

  private startToolCall(toolCallId: string, toolCallName: string): AgUiEvent {
    this.startedToolCalls.add(toolCallId);
    this.openToolCalls.set(toolCallId, false);
    return {
      type: EventType.TOOL_CALL_START,
      toolCallId,
      toolCallName,
      ...(this.assistantId !== undefined
        ? { parentMessageId: this.assistantId }
        : {}),
    };
  }

  private endToolCall(toolCallId: string): Array<AgUiEvent> {
    const sentArgs = this.openToolCalls.get(toolCallId);
    if (sentArgs === undefined) return [];
    this.openToolCalls.delete(toolCallId);
    const end: AgUiEvent = { type: EventType.TOOL_CALL_END, toolCallId };
    // Providers stream nothing for tools without parameters; the arguments
    // must still read as a JSON object.
    if (sentArgs) return [end];
    return [{ type: EventType.TOOL_CALL_ARGS, toolCallId, delta: "{}" }, end];
  }

  /** Close everything still open in the current step, then the step itself. */
  private closeStep(): Array<AgUiEvent> {
    const events: Array<AgUiEvent> = [];
    for (const id of [...this.openReasoning.keys()])
      events.push(...this.endReasoning(id));
    for (const id of [...this.openText.keys()])
      events.push(...this.endText(id));
    for (const id of [...this.openToolCalls.keys()])
      events.push(...this.endToolCall(id));
    if (this.stepOpen) {
      this.stepOpen = false;
      events.push({ type: EventType.STEP_FINISHED, stepName: this.stepName() });
    }
    return events;
  }
}

/**
 * Translate an agent-loop stream into a complete AG-UI run: `RUN_STARTED`
 * first, then exactly one `RUN_FINISHED` or `RUN_ERROR` last. Failures in the
 * source stream become `RUN_ERROR`, so the result never fails.
 */
export const toAgUiEvents =
  (input: { readonly threadId: string; readonly runId: string }) =>
  <E, R>(
    parts: Stream.Stream<LoopPart, E, R>,
  ): Stream.Stream<AgUiEvent, never, R> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const ids = yield* Effect.serviceOption(IdGenerator.IdGenerator).pipe(
          Effect.map(Option.getOrElse(() => IdGenerator.defaultIdGenerator)),
        );
        const translator = new Translator(input, ids);
        return parts.pipe(
          Stream.mapEffect((part) => translator.onPart(part)),
          Stream.flattenIterable,
          Stream.concat(
            Stream.suspend(() => Stream.fromIterable(translator.onEnd())),
          ),
          Stream.catchCause((cause) =>
            Effect.logError("AG-UI run failed", cause).pipe(
              Effect.as(translator.onError(cause)),
              Stream.fromIterableEffect,
            ),
          ),
          Stream.prepend([translator.runStarted()]),
        );
      }),
    );
