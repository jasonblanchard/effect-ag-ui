import {
  chat,
  chatParamsFromRequest,
  toServerSentEventsResponse,
  toolDefinition,
} from "@tanstack/ai";
import { anthropicText } from "@tanstack/ai-anthropic";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const getCurrentTime = toolDefinition({
  name: "getCurrentTime",
  description: "Get the current date and time on the server as an ISO string",
  inputSchema: z.object({}),
  outputSchema: z.object({ time: z.string() }),
}).server(async () => ({ time: new Date().toISOString() }));

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { messages, threadId, runId } =
          await chatParamsFromRequest(request);

        const stream = chat({
          adapter: anthropicText("claude-haiku-5-5"),
          messages,
          tools: [getCurrentTime],
          threadId,
          runId,
        });

        return toServerSentEventsResponse(stream);
      },
    },
  },
});