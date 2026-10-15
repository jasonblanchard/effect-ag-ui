import { Effect, Predicate, Schema, Stream } from "effect";
import { Chat, type Prompt, type Response, Tool, type Toolkit } from "effect/ai";
import { stepEnd, stepLimit, stepStart, type LoopPart } from "./events";

/**
 * Make every tool behave as if it were defined with `failureMode: "return"`:
 * a handler failure, or parameters the model got wrong, becomes a failed
 * `tool-result` the model can react to, instead of failing the whole run.
 * Defects still fail the run.
 */
const returnFailures = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.WithHandler<Tools>,
): Toolkit.WithHandler<Tools> => {
  const failure = (name: PropertyKey, error: unknown) => {
    const tool = toolkit.tools[name as keyof Tools] as Tool.Any | undefined;
    const encode: Effect.Effect<unknown, unknown> = tool === undefined
      ? Effect.fail(undefined)
      : Schema.encodeUnknownEffect(Tool.failureResultSchema(tool))(error) as Effect.Effect<unknown, unknown>;
    return encode.pipe(
      Effect.orElseSucceed(() => ({
        error: Predicate.hasProperty(error, "message") ? String(error.message) : String(error),
      })),
      Effect.map((encodedResult) => ({
        result: error,
        encodedResult,
        isFailure: true,
        preliminary: false,
      }) as Tool.HandlerResult<any>),
    );
  };
  const handle: Toolkit.WithHandler<Tools>["handle"] = (name, params, toolCallId, options) =>
    toolkit.handle(name, params, toolCallId, options).pipe(
      Effect.map(Stream.catch((error) => Stream.fromEffect(failure(name, error)))),
      Effect.catch((error) => Effect.succeed(Stream.fromEffect(failure(name, error)))),
    );
  return { tools: toolkit.tools, handle };
};

/**
 * Run the model with server-side tools until it stops requesting them, or
 * until `maxSteps` model calls have been made. Each model call is bracketed by
 * step markers. `Chat` appends each step's output (including tool results) to
 * the history, so every step sees the results of the one before it.
 *
 * A failing tool is answered with a failed result rather than ending the run.
 * Hitting `maxSteps` emits a `step-limit` marker, which ends the run as
 * cancelled.
 */
export const agentLoop = <Tools extends Record<string, Tool.Any>>(options: {
  readonly prompt: Prompt.RawInput;
  readonly toolkit: Toolkit.WithHandler<Tools>;
  readonly maxSteps?: number;
}) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const maxSteps = options.maxSteps ?? 5;
      const chat = yield* Chat.fromPrompt(options.prompt);
      const toolkit = returnFailures(options.toolkit);
      const streamModel = () => chat.streamText({ prompt: [], toolkit });
      type Steps = Stream.Stream<
        LoopPart,
        Stream.Error<ReturnType<typeof streamModel>>,
        Stream.Services<ReturnType<typeof streamModel>>
      >;

      const step = (n: number): Steps => {
        let finishReason: Response.FinishReason | undefined;
        const model = streamModel().pipe(
          Stream.tap((part) =>
            Effect.sync(() => {
              if (part.type === "finish") finishReason = part.reason;
            }),
          ),
        );

        // Decided only after the step's stream has drained, which is also
        // when `Chat` has written the step into its history.
        const next = Stream.suspend((): Steps => {
          if (finishReason !== "tool-calls") return Stream.empty;
          if (n < maxSteps) return step(n + 1);
          return Stream.fromEffect(
            Effect.logWarning(`Agent loop stopped after ${maxSteps} steps`).pipe(
              Effect.as<LoopPart>(stepLimit),
            ),
          );
        });

        return Stream.make<Array<LoopPart>>(stepStart).pipe(
          Stream.concat(model),
          Stream.concat(Stream.make(stepEnd)),
          Stream.concat(next),
        );
      };

      return step(1);
    }),
  );
