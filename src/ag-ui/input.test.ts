import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { fromRequest, fromRunAgentInput } from "./input";

const base = { threadId: "t1", runId: "r1", state: {}, tools: [], context: [], forwardedProps: {} };

const decodeError = (body: unknown) =>
  fromRunAgentInput(body).pipe(Effect.flip, Effect.map((error) => error._tag));

describe("fromRunAgentInput", () => {
  it.effect("decodes a plain user turn", () =>
    Effect.gen(function* () {
      const { input, prompt } = yield* fromRunAgentInput({
        ...base,
        messages: [{ id: "m1", role: "user", content: "hi" }],
      });
      expect(input.threadId).toBe("t1");
      expect(input.runId).toBe("r1");
      expect(prompt.content).toHaveLength(1);
      const [message] = prompt.content;
      expect(message.role).toBe("user");
      expect(message.content).toMatchObject([{ type: "text", text: "hi" }]);
    }));

  it.effect("joins text content parts", () =>
    Effect.gen(function* () {
      const { prompt } = yield* fromRunAgentInput({
        ...base,
        messages: [
          {
            id: "m1",
            role: "user",
            content: [
              { type: "text", text: "a" },
              { type: "text", text: "b" },
            ],
          },
        ],
      });
      expect(prompt.content[0].content).toMatchObject([{ type: "text", text: "ab" }]);
    }));

  it.effect("maps a tool round-trip with the tool name looked up by id", () =>
    Effect.gen(function* () {
      const { prompt } = yield* fromRunAgentInput({
        ...base,
        messages: [
          { id: "m1", role: "user", content: "time?" },
          {
            id: "m2",
            role: "assistant",
            content: "Checking.",
            toolCalls: [
              { id: "call_1", type: "function", function: { name: "GetCurrentTime", arguments: "" } },
              { id: "call_2", type: "function", function: { name: "Echo", arguments: '{"x":1}' } },
            ],
          },
          { id: "m3", role: "tool", toolCallId: "call_1", content: '{"time":"now"}' },
          { id: "m4", role: "tool", toolCallId: "call_2", content: "partial", error: "User declined" },
          { id: "m5", role: "assistant", content: "It is now." },
        ],
      });

      expect(prompt.content.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "tool",
        "assistant",
      ]);
      expect(prompt.content[1].content).toMatchObject([
        { type: "text", text: "Checking." },
        { type: "tool-call", id: "call_1", name: "GetCurrentTime", params: {} },
        { type: "tool-call", id: "call_2", name: "Echo", params: { x: 1 } },
      ]);
      expect(prompt.content[2].content).toMatchObject([
        { type: "tool-result", id: "call_1", name: "GetCurrentTime", isFailure: false, result: { time: "now" } },
        {
          type: "tool-result",
          id: "call_2",
          name: "Echo",
          isFailure: true,
          result: { error: "User declined", content: "partial" },
        },
      ]);
    }));

  it.effect("folds context into a leading system message and drops reasoning/activity", () =>
    Effect.gen(function* () {
      const { prompt } = yield* fromRunAgentInput({
        ...base,
        context: [{ description: "User timezone", value: "America/New_York" }],
        tools: [{ name: "clientTool", description: "ignored", parameters: {} }],
        messages: [
          { id: "m0", role: "developer", content: "Be brief." },
          { id: "r1", role: "reasoning", content: "thinking" },
          { id: "a1", role: "activity", activityType: "progress", content: {} },
          { id: "m1", role: "user", content: "hi" },
        ],
      });
      expect(prompt.content.map((message) => message.role)).toEqual(["system", "system", "user"]);
      expect(prompt.content[0].content).toBe("User timezone:\nAmerica/New_York");
      expect(prompt.content[1].content).toBe("Be brief.");
    }));

  it.effect("rejects a body missing required fields", () =>
    Effect.gen(function* () {
      expect(yield* decodeError({ messages: [] })).toBe("AgUiInputError");
      expect(yield* decodeError({ threadId: "t", runId: "r" })).toBe("AgUiInputError");
    }));

  it.effect("rejects a tool result for an unknown tool call", () =>
    Effect.gen(function* () {
      const error = yield* fromRunAgentInput({
        ...base,
        messages: [{ id: "m1", role: "tool", toolCallId: "nope", content: "x" }],
      }).pipe(Effect.flip);
      expect(error.message).toContain('unknown tool call "nope"');
    }));

  it.effect("drops non-text content parts instead of failing", () =>
    Effect.gen(function* () {
      const image = { type: "image", source: { type: "url", value: "https://x" } };
      const { prompt } = yield* fromRunAgentInput({
        ...base,
        messages: [
          { id: "m1", role: "user", content: [{ type: "text", text: "What is this?" }, image] },
          {
            id: "m2",
            role: "assistant",
            toolCalls: [{ id: "c", type: "function", function: { name: "Screenshot", arguments: "{}" } }],
          },
          { id: "m3", role: "tool", toolCallId: "c", content: [image] },
        ],
      });
      expect(prompt.content[0].content).toMatchObject([{ type: "text", text: "What is this?" }]);
      // A result whose every part was dropped is still answered, with "".
      expect(prompt.content[2].content).toMatchObject([
        { type: "tool-result", id: "c", isFailure: false, result: "" },
      ]);
    }));

  it.effect("a declined tool call with no content passes the error text on", () =>
    Effect.gen(function* () {
      const { prompt } = yield* fromRunAgentInput({
        ...base,
        messages: [
          {
            id: "m1",
            role: "assistant",
            toolCalls: [{ id: "c", type: "function", function: { name: "T", arguments: "{}" } }],
          },
          { id: "m2", role: "tool", toolCallId: "c", content: "", error: "User declined" },
        ],
      });
      expect(prompt.content[1].content).toMatchObject([
        { type: "tool-result", isFailure: true, result: { error: "User declined" } },
      ]);
    }));

  it.effect("drops messages with an unknown role, but still rejects malformed known ones", () =>
    Effect.gen(function* () {
      const { prompt } = yield* fromRunAgentInput({
        ...base,
        messages: [
          { id: "m0", role: "narrator", content: "from a future version" },
          { id: "m1", role: "user", content: "hi" },
        ],
      });
      expect(prompt.content.map((message) => message.role)).toEqual(["user"]);
      expect(yield* decodeError({ ...base, messages: [{ id: "m1", role: "user" }] })).toBe(
        "AgUiInputError",
      );
    }));

  it.effect("rejects tool call arguments that are not JSON", () =>
    Effect.gen(function* () {
      const error = yield* fromRunAgentInput({
        ...base,
        messages: [
          {
            id: "m1",
            role: "assistant",
            toolCalls: [{ id: "c", type: "function", function: { name: "T", arguments: "{" } }],
          },
        ],
      }).pipe(Effect.flip);
      expect(error.message).toContain("not valid JSON");
    }));
});

describe("fromRequest", () => {
  it.effect("rejects a body that is not JSON", () =>
    Effect.gen(function* () {
      const request = new Request("http://x", { method: "POST", body: "{not json" });
      const error = yield* fromRequest(request).pipe(Effect.flip);
      expect(error.message).toBe("Request body is not valid JSON");
    }));
});
