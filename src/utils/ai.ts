import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { Config, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { FetchHttpClient } from "effect/http";

const GetCurrentTime = Tool.make("GetCurrentTime", {
  description: "Get the current date and time on the server as an ISO string",
  success: Schema.Struct({ time: Schema.String }),
});

export const Tools = Toolkit.make(GetCurrentTime);

const ToolsLayer = Tools.toLayer({
  GetCurrentTime: () => Effect.sync(() => ({ time: new Date().toISOString() })),
});

const AnthropicClientLayer = AnthropicClient.layerConfig({
  apiKey: Config.Redacted("ANTHROPIC_API_KEY"),
}).pipe(Layer.provide(FetchHttpClient.layer));

const ModelLayer = AnthropicLanguageModel.model("claude-haiku-5-5").pipe(
  Layer.provide(AnthropicClientLayer),
);

export const runtime = ManagedRuntime.make(Layer.mergeAll(ModelLayer, ToolsLayer));
