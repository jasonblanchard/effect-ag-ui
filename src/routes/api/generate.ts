import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { createFileRoute } from "@tanstack/react-router";
import { Config, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { Chat, Tool, Toolkit } from "effect/ai";
import { FetchHttpClient } from "effect/http";

const GenerateRequest = Schema.Struct({
  prompt: Schema.String,
});

const GetCurrentTime = Tool.make("GetCurrentTime", {
  description: "Get the current date and time on the server as an ISO string",
  success: Schema.Struct({ time: Schema.String }),
});

const Tools = Toolkit.make(GetCurrentTime);

const ToolsLayer = Tools.toLayer({
  GetCurrentTime: () => Effect.sync(() => ({ time: new Date().toISOString() })),
});

const AnthropicClientLayer = AnthropicClient.layerConfig({
  apiKey: Config.Redacted("ANTHROPIC_API_KEY"),
}).pipe(Layer.provide(FetchHttpClient.layer));

const ModelLayer = AnthropicLanguageModel.model("claude-haiku-5-5").pipe(
  Layer.provide(AnthropicClientLayer),
);

const runtime = ManagedRuntime.make(Layer.mergeAll(ModelLayer, ToolsLayer));

const MAX_STEPS = 5;

const generate = Effect.fn("generate")(function* (request: Request) {
  const body = yield* Effect.tryPromise(() => request.json());
  const { prompt } = yield* Schema.decodeUnknownEffect(GenerateRequest)(body);
  const toolkit = yield* Tools;
  const chat = yield* Chat.empty;

  // generateText resolves tool calls but doesn't send the results back to the
  // model, so keep going until it stops asking for tools.
  let response = yield* chat.generateText({ prompt, toolkit });
  for (let step = 1; step < MAX_STEPS && response.finishReason === "tool-calls"; step++) {
    response = yield* chat.generateText({ prompt: [], toolkit });
  }

  return Response.json({ text: response.text });
});

export const Route = createFileRoute("/api/generate")({
  server: {
    handlers: {
      POST: ({ request }) =>
        runtime.runPromise(
          generate(request).pipe(
            Effect.catchTags({
              UnknownError: () =>
                Effect.succeed(
                  Response.json({ error: "Invalid JSON body" }, { status: 400 }),
                ),
              SchemaError: (error) =>
                Effect.succeed(
                  Response.json({ error: error.message }, { status: 400 }),
                ),
              AiError: (error) =>
                Effect.logError(error).pipe(
                  Effect.as(
                    Response.json({ error: error.message }, { status: 502 }),
                  ),
                ),
            }),
          ),
        ),
    },
  },
});
