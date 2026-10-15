import { describe, expect, it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { AiError, IdGenerator, Response } from "effect/ai";
import { stepEnd, stepLimit, stepStart, toAgUiEvents, type AgUiEvent, type LoopPart } from "./events";
import { checkRun } from "./testing/conformance";

const part = Response.makePart as (type: string, params: object) => LoopPart;

const usage = new Response.Usage({
  inputTokens: { total: 10, uncached: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
});
const finish = (reason: Response.FinishReason) => part("finish", { reason, usage });

const text = (id: string, ...deltas: Array<string>) => [
  part("text-start", { id }),
  ...deltas.map((delta) => part("text-delta", { id, delta })),
  part("text-end", { id }),
];

const toolResult = (id: string, encodedResult: unknown, isFailure = false) =>
  part("tool-result", {
    id,
    name: "GetCurrentTime",
    result: encodedResult,
    encodedResult,
    isFailure,
    providerExecuted: false,
    preliminary: false,
  });

const run = (parts: ReadonlyArray<LoopPart>, failure?: unknown) => {
  let next = 0;
  const ids: IdGenerator.Service = { generateId: () => Effect.sync(() => `id-${++next}`) };
  const source = failure === undefined
    ? Stream.fromIterable(parts)
    : Stream.concat(Stream.fromIterable(parts), Stream.fail(failure));
  return source.pipe(
    toAgUiEvents({ threadId: "t1", runId: "r1" }),
    Stream.runCollect,
    Effect.provideService(IdGenerator.IdGenerator, ids),
  );
};

const types = (events: ReadonlyArray<AgUiEvent>) => events.map((event) => event.type);

const expectConformant = (events: ReadonlyArray<AgUiEvent>) =>
  expect(checkRun(events)).toEqual([]);

describe("toAgUiEvents", () => {
  it.effect("text only", () =>
    Effect.gen(function* () {
      const events = yield* run([stepStart, ...text("0", "Hel", "lo"), finish("stop"), stepEnd]);
      expectConformant(events);
      expect(types(events)).toEqual([
        "RUN_STARTED",
        "STEP_STARTED",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
        "STEP_FINISHED",
        "RUN_FINISHED",
      ]);
      expect(events[0]).toMatchObject({ threadId: "t1", runId: "r1", protocolVersion: "1.0" });
      expect(events.at(-1)).not.toHaveProperty("outcome");
      expect(events[2]).toMatchObject({ messageId: "id-1", role: "assistant" });
      expect(events.at(-1)).toMatchObject({
        threadId: "t1",
        runId: "r1",
        usage: [{ inputTokens: 10, outputTokens: 5, totalTokens: 15 }],
      });
    }));

  it.effect("reasoning then text use distinct message ids", () =>
    Effect.gen(function* () {
      const events = yield* run([
        stepStart,
        part("reasoning-start", { id: "0" }),
        part("reasoning-delta", { id: "0", delta: "hmm" }),
        part("reasoning-end", { id: "0" }),
        ...text("1", "Answer"),
        finish("stop"),
        stepEnd,
      ]);
      expectConformant(events);
      expect(types(events)).toEqual([
        "RUN_STARTED",
        "STEP_STARTED",
        "REASONING_START",
        "REASONING_MESSAGE_START",
        "REASONING_MESSAGE_CONTENT",
        "REASONING_MESSAGE_END",
        "REASONING_END",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
        "STEP_FINISHED",
        "RUN_FINISHED",
      ]);
      expect(events[3]).toMatchObject({ role: "reasoning" });
    }));

  it.effect("streamed tool params, then a tool-call part, are not duplicated", () =>
    Effect.gen(function* () {
      const events = yield* run([
        stepStart,
        ...text("0", "Checking."),
        part("tool-params-start", { id: "call_1", name: "GetCurrentTime", providerExecuted: false }),
        part("tool-params-delta", { id: "call_1", delta: "{}" }),
        part("tool-params-end", { id: "call_1" }),
        part("tool-call", { id: "call_1", name: "GetCurrentTime", params: {}, providerExecuted: false }),
        toolResult("call_1", { time: "now" }),
        finish("tool-calls"),
        stepEnd,
        stepStart,
        ...text("0", "It is now."),
        finish("stop"),
        stepEnd,
      ]);
      expectConformant(events);
      expect(types(events)).toEqual([
        "RUN_STARTED",
        "STEP_STARTED",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
        "TOOL_CALL_START",
        "TOOL_CALL_ARGS",
        "TOOL_CALL_END",
        "TOOL_CALL_RESULT",
        "STEP_FINISHED",
        "STEP_STARTED",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
        "STEP_FINISHED",
        "RUN_FINISHED",
      ]);
      const [textStart, toolStart, result] = [events[2], events[5], events[8]];
      // The first text message and the tool call share the step's assistant id.
      expect(toolStart).toMatchObject({
        toolCallId: "call_1",
        toolCallName: "GetCurrentTime",
        parentMessageId: (textStart as { messageId: string }).messageId,
      });
      expect(result).toMatchObject({
        toolCallId: "call_1",
        role: "tool",
        content: '{"time":"now"}',
      });
      expect(events[1]).toMatchObject({ stepName: "step-1" });
      expect(events[10]).toMatchObject({ stepName: "step-2" });
      // One usage entry per model, summed across both steps.
      expect((events.at(-1) as { usage: Array<unknown> }).usage).toEqual([
        { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      ]);
    }));

  it.effect("a tool call streamed without argument deltas gets empty-object args", () =>
    Effect.gen(function* () {
      const events = yield* run([
        stepStart,
        part("tool-params-start", { id: "call_1", name: "GetCurrentTime", providerExecuted: false }),
        part("tool-params-end", { id: "call_1" }),
        part("tool-call", { id: "call_1", name: "GetCurrentTime", params: {}, providerExecuted: false }),
        stepEnd,
      ]);
      expectConformant(events);
      expect(events.slice(2, 5)).toMatchObject([
        { type: "TOOL_CALL_START" },
        { type: "TOOL_CALL_ARGS", delta: "{}" },
        { type: "TOOL_CALL_END" },
      ]);
    }));

  it.effect("a bare tool-call part is expanded to START/ARGS/END", () =>
    Effect.gen(function* () {
      const events = yield* run([
        stepStart,
        part("tool-call", { id: "call_1", name: "Echo", params: { x: 1 }, providerExecuted: false }),
        toolResult("call_1", "x"),
        finish("tool-calls"),
        stepEnd,
      ]);
      expectConformant(events);
      expect(types(events).slice(2, 6)).toEqual([
        "TOOL_CALL_START",
        "TOOL_CALL_ARGS",
        "TOOL_CALL_END",
        "TOOL_CALL_RESULT",
      ]);
      expect(events[3]).toMatchObject({ delta: '{"x":1}' });
    }));

  it.effect("a failed tool still produces a result with the failure as content", () =>
    Effect.gen(function* () {
      const events = yield* run([
        stepStart,
        part("tool-call", { id: "call_1", name: "GetCurrentTime", params: {}, providerExecuted: false }),
        toolResult("call_1", { error: "clock broke" }, true),
        finish("tool-calls"),
        stepEnd,
      ]);
      expectConformant(events);
      expect(events.find((event) => event.type === "TOOL_CALL_RESULT")).toMatchObject({
        content: '{"error":"clock broke"}',
      });
    }));

  it.effect("preliminary tool results are skipped", () =>
    Effect.gen(function* () {
      const events = yield* run([
        stepStart,
        part("tool-call", { id: "call_1", name: "T", params: {}, providerExecuted: false }),
        part("tool-result", {
          id: "call_1",
          name: "T",
          result: 1,
          encodedResult: 1,
          isFailure: false,
          providerExecuted: false,
          preliminary: true,
        }),
        toolResult("call_1", 2),
        stepEnd,
      ]);
      expectConformant(events);
      const results = events.filter((event) => event.type === "TOOL_CALL_RESULT");
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ content: "2" });
    }));

  it.effect("an error mid-text closes the message and step, then RUN_ERROR", () =>
    Effect.gen(function* () {
      const error = new AiError.AiError({
        module: "Test",
        method: "streamText",
        reason: new AiError.UnknownError({ description: "provider exploded" }),
      });
      const events = yield* run(
        [stepStart, part("text-start", { id: "0" }), part("text-delta", { id: "0", delta: "Hal" })],
        error,
      );
      expectConformant(events);
      expect(types(events)).toEqual([
        "RUN_STARTED",
        "STEP_STARTED",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
        "STEP_FINISHED",
        "RUN_ERROR",
      ]);
      expect(events.at(-1)).toMatchObject({ code: "UnknownError" });
      expect((events.at(-1) as { message: string }).message).toBeTruthy();
    }));

  it.effect("an error before any output", () =>
    Effect.gen(function* () {
      const events = yield* run([stepStart], new Error("nope"));
      expectConformant(events);
      expect(types(events)).toEqual(["RUN_STARTED", "STEP_STARTED", "STEP_FINISHED", "RUN_ERROR"]);
      // Unexpected errors are not described to the client.
      expect(events.at(-1)).toMatchObject({ message: "Internal error", code: "INTERNAL_ERROR" });
    }));

  it.effect("usage is kept per model", () =>
    Effect.gen(function* () {
      const events = yield* run([
        part("response-metadata", { id: "a", modelId: "small", timestamp: undefined }),
        stepStart, finish("tool-calls"), stepEnd,
        part("response-metadata", { id: "b", modelId: "large", timestamp: undefined }),
        stepStart, finish("stop"), stepEnd,
      ]);
      expectConformant(events);
      expect((events.at(-1) as { usage: Array<unknown> }).usage).toMatchObject([
        { model: "small", totalTokens: 15 },
        { model: "large", totalTokens: 15 },
      ]);
    }));

  it.effect("a step-limit marker finishes the run as cancelled", () =>
    Effect.gen(function* () {
      const events = yield* run([
        stepStart,
        part("tool-call", { id: "call_1", name: "T", params: {}, providerExecuted: false }),
        toolResult("call_1", 1),
        finish("tool-calls"),
        stepEnd,
        stepLimit,
      ]);
      expectConformant(events);
      expect(events.at(-1)).toMatchObject({
        type: "RUN_FINISHED",
        outcome: { type: "cancelled" },
        usage: [{ totalTokens: 15 }],
      });
      expect(events.at(-1)).not.toHaveProperty("result");
    }));

  it.effect("an error part ends the run with RUN_ERROR", () =>
    Effect.gen(function* () {
      const events = yield* run([
        stepStart,
        ...text("0", "a"),
        part("error", { error: new Error("overloaded") }),
        ...text("1", "never"),
      ]);
      expectConformant(events);
      expect(events.at(-1)).toMatchObject({
        type: "RUN_ERROR",
        message: "overloaded",
        code: "MODEL_ERROR",
      });
      expect(events.filter((event) => event.type === "TEXT_MESSAGE_START")).toHaveLength(1);
    }));
});

describe("checkRun", () => {
  it("flags lifecycle violations", () => {
    expect(checkRun([])).toEqual(["no events"]);
    expect(
      checkRun([
        { type: "TEXT_MESSAGE_START", messageId: "m" },
        { type: "RUN_FINISHED", threadId: "t", runId: "r" },
        { type: "STEP_STARTED", stepName: "s" },
      ]),
    ).toEqual([
      "#0: first event is not RUN_STARTED",
      "#1: RUN_FINISHED with open: text m",
      "#2: STEP_STARTED after terminal event",
    ]);
  });
});
