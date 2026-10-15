import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import { LanguageModel, type Prompt, type Response, Tool, Toolkit } from "effect/ai";
import { agentLoop } from "./loop";

// Default failureMode ("error"): the loop must still keep failures in the run.
const GetCurrentTime = Tool.make("GetCurrentTime", {
  parameters: Schema.Struct({ zone: Schema.optional(Schema.String) }),
  success: Schema.Struct({ time: Schema.String }),
  failure: Schema.Struct({ reason: Schema.String }),
});
const Tools = Toolkit.make(GetCurrentTime);
const ToolsLayer = Tools.toLayer({
  GetCurrentTime: () => Effect.succeed({ time: "2026-10-13T00:00:00.000Z" }),
});
const FailingToolsLayer = Tools.toLayer({
  GetCurrentTime: () => Effect.fail({ reason: "clock broke" }),
});

const usage = {
  inputTokens: { total: 1 },
  outputTokens: { total: 1 },
};

const toolCallStep: ReadonlyArray<Response.StreamPartEncoded> = [
  { type: "tool-call", id: "call_1", name: "GetCurrentTime", params: {} },
  { type: "finish", reason: "tool-calls", usage },
];
const answerStep: ReadonlyArray<Response.StreamPartEncoded> = [
  { type: "text-start", id: "0" },
  { type: "text-delta", id: "0", delta: "It is midnight." },
  { type: "text-end", id: "0" },
  { type: "finish", reason: "stop", usage },
];

/** A model that plays back one scripted response per call and records prompts. */
const scriptedModel = (script: (call: number) => ReadonlyArray<Response.StreamPartEncoded>) => {
  const prompts: Array<Prompt.Prompt> = [];
  const layer = Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: (options) => {
        prompts.push(options.prompt);
        return Stream.fromIterable(script(prompts.length));
      },
    }),
  );
  return { prompts, layer };
};

const runLoop = (
  model: ReturnType<typeof scriptedModel>,
  maxSteps?: number,
  tools: typeof ToolsLayer = ToolsLayer,
) =>
  Effect.gen(function* () {
    const toolkit = yield* Tools;
    return yield* agentLoop({
      prompt: [{ role: "user", content: "What time is it?" }],
      toolkit,
      maxSteps,
    }).pipe(Stream.runCollect);
  }).pipe(Effect.provide(Layer.merge(model.layer, tools)));

describe("agentLoop", () => {
  it.effect("runs a tool round then answers, carrying history between steps", () =>
    Effect.gen(function* () {
      const model = scriptedModel((call) => (call === 1 ? toolCallStep : answerStep));
      const parts = yield* runLoop(model);

      expect(parts.map((part) => part.type)).toEqual([
        "step-start",
        "tool-call",
        "tool-result",
        "finish",
        "step-end",
        "step-start",
        "text-start",
        "text-delta",
        "text-end",
        "finish",
        "step-end",
      ]);

      expect(model.prompts).toHaveLength(2);
      const second = model.prompts[1].content;
      expect(second.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
      expect(second[2].content).toMatchObject([
        { type: "tool-result", id: "call_1", result: { time: "2026-10-13T00:00:00.000Z" } },
      ]);
    }));

  it.effect("stops at maxSteps when the model keeps calling tools", () =>
    Effect.gen(function* () {
      const model = scriptedModel(() =>
        toolCallStep.map((part) =>
          part.type === "tool-call" ? { ...part, id: `call_${Math.random()}` } : part,
        ),
      );
      const parts = yield* runLoop(model, 3);
      expect(model.prompts).toHaveLength(3);
      expect(parts.filter((part) => part.type === "step-start")).toHaveLength(3);
      expect(parts.slice(-2).map((part) => part.type)).toEqual(["step-end", "step-limit"]);
    }));

  it.effect("a failing tool handler becomes a failed result and the loop continues", () =>
    Effect.gen(function* () {
      const model = scriptedModel((call) => (call === 1 ? toolCallStep : answerStep));
      const parts = yield* runLoop(model, undefined, FailingToolsLayer);
      expect(parts.find((part) => part.type === "tool-result")).toMatchObject({
        id: "call_1",
        isFailure: true,
        encodedResult: { reason: "clock broke" },
      });
      expect(model.prompts).toHaveLength(2);
      expect(model.prompts[1].content[2].content).toMatchObject([
        { type: "tool-result", id: "call_1", isFailure: true, result: { reason: "clock broke" } },
      ]);
    }));

  it.effect("parameters the model got wrong become a failed result", () =>
    Effect.gen(function* () {
      const badCall: ReadonlyArray<Response.StreamPartEncoded> = [
        { type: "tool-call", id: "call_1", name: "GetCurrentTime", params: { zone: 42 } },
        { type: "finish", reason: "tool-calls", usage },
      ];
      const model = scriptedModel((call) => (call === 1 ? badCall : answerStep));
      const parts = yield* runLoop(model);
      expect(parts.find((part) => part.type === "tool-result")).toMatchObject({ isFailure: true });
      expect(model.prompts).toHaveLength(2);
      expect(parts.at(-1)?.type).toBe("step-end");
    }));

  it.effect("a single answer is one step", () =>
    Effect.gen(function* () {
      const model = scriptedModel(() => answerStep);
      const parts = yield* runLoop(model);
      expect(model.prompts).toHaveLength(1);
      expect(parts.filter((part) => part.type === "step-start")).toHaveLength(1);
    }));
});
