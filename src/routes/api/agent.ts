import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { agentLoop, fromRequest, toAgUiEvents, toSseResponse } from "~/ag-ui";
import { runtime, Tools } from "~/utils/ai";

const MAX_STEPS = 5;

const run = Effect.fn("agent")(
  function* (request: Request) {
    const { input, prompt } = yield* fromRequest(request);
    const toolkit = yield* Tools;
    const events = agentLoop({ prompt, toolkit, maxSteps: MAX_STEPS }).pipe(
      toAgUiEvents(input),
    );
    return yield* toSseResponse(events, { signal: request.signal });
  },
  Effect.catchTag("AgUiInputError", (error) =>
    Effect.succeed(Response.json({ error: error.message }, { status: 400 })),
  ),
);

export const Route = createFileRoute("/api/agent")({
  server: {
    handlers: {
      POST: ({ request }) => runtime.runPromise(run(request)),
    },
  },
});
