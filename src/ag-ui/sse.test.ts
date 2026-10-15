import { EventType } from "@ag-ui/core";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Stream } from "effect";
import type { AgUiEvent } from "./events";
import { toSseResponse } from "./sse";

const started: AgUiEvent = { type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" };
const finished: AgUiEvent = { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" };

/** A run that emits one event and then hangs, recording when it is torn down. */
const hangingRun = Effect.gen(function* () {
  const finalized = yield* Deferred.make<void>();
  const events = Stream.make(started).pipe(
    Stream.concat(Stream.never),
    Stream.ensuring(Deferred.succeed(finalized, undefined)),
  );
  return { events, finalized };
});

describe("toSseResponse", () => {
  it.effect("frames each event as an SSE data message", () =>
    Effect.gen(function* () {
      const response = yield* toSseResponse(Stream.make(started, finished));
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      const body = yield* Effect.promise(() => response.text());
      expect(body).toBe(`data: ${JSON.stringify(started)}\n\ndata: ${JSON.stringify(finished)}\n\n`);
    }));

  it.live("cancelling the body interrupts the producing stream", () =>
    Effect.gen(function* () {
      const { events, finalized } = yield* hangingRun;
      const response = yield* toSseResponse(events);
      const reader = response.body!.getReader();

      const first = yield* Effect.promise(() => reader.read());
      expect(new TextDecoder().decode(first.value)).toContain("RUN_STARTED");

      yield* Effect.promise(() => reader.cancel());
      yield* Deferred.await(finalized).pipe(Effect.timeout("1 second"));
    }));

  it.live("aborting the signal interrupts the producing stream", () =>
    Effect.gen(function* () {
      const { events, finalized } = yield* hangingRun;
      const controller = new AbortController();
      const response = yield* toSseResponse(events, { signal: controller.signal });
      const reader = response.body!.getReader();
      yield* Effect.promise(() => reader.read());

      controller.abort();
      yield* Deferred.await(finalized).pipe(Effect.timeout("1 second"));
      // The body ends cleanly rather than erroring.
      const rest = yield* Effect.promise(() => reader.read());
      expect(rest.done).toBe(true);
    }));
});
