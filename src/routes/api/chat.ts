import {
  chat,
  chatParamsFromRequest,
  toServerSentEventsResponse,
} from "@tanstack/ai";
import { anthropicText } from "@tanstack/ai-anthropic";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { messages, threadId, runId } =
          await chatParamsFromRequest(request);

        const stream = chat({
          adapter: anthropicText("claude-haiku-5-5"),
          messages,
          threadId,
          runId,
        });

        return toServerSentEventsResponse(stream);
      },
    },
  },
});