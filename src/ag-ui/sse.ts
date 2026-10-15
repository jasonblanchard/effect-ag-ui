import { Effect, Stream } from "effect";
import type { AgUiEvent } from "./events";

const encoder = new TextEncoder();

/** Frame one event as an SSE message: `data: <json>` followed by a blank line. */
export const encodeSse = (event: AgUiEvent): Uint8Array =>
  encoder.encode(`data: ${JSON.stringify(event)}\n\n`);

/**
 * Serve an AG-UI event stream as a `text/event-stream` response. Cancelling the
 * body (client disconnect) or aborting `signal` interrupts the producing fiber,
 * which aborts any in-flight model request.
 */
export const toSseResponse = <R>(
  events: Stream.Stream<AgUiEvent, never, R>,
  options?: { readonly signal?: AbortSignal | undefined },
): Effect.Effect<Response, never, R> =>
  Effect.map(Effect.context<R>(), (context) => {
    const body = events.pipe(
      Stream.map(encodeSse),
      Stream.toReadableStreamWith(context, { signal: options?.signal }),
    );
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });
