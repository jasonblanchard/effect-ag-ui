import { EventSchema } from "@ag-ui/core/schemas";

const isJsonObject = (text: string) => {
  try {
    const value = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
};

/**
 * Check a single run's events against the AG-UI event schemas and the
 * lifecycle rules from the `ag-ui-agent-endpoint` spec. Returns a list of
 * violations; an empty list means the run conforms.
 */
export const checkRun = (events: ReadonlyArray<unknown>): Array<string> => {
  const problems: Array<string> = [];
  const fail = (index: number, message: string) => problems.push(`#${index}: ${message}`);

  const openText = new Set<string>();
  const openReasoningMessages = new Set<string>();
  const openReasoning = new Set<string>();
  const openToolCalls = new Set<string>();
  const endedToolCalls = new Set<string>();
  const toolArgs = new Map<string, string>();
  const openSteps = new Set<string>();
  const seenSteps = new Set<string>();
  const messageIds = new Set<string>();
  let run: { threadId: string; runId: string } | undefined;
  let terminated = false;

  const claimMessageId = (index: number, id: string) => {
    if (messageIds.has(id)) fail(index, `messageId "${id}" reused`);
    messageIds.add(id);
  };

  if (events.length === 0) problems.push("no events");

  events.forEach((raw, index) => {
    const parsed = EventSchema.safeParse(raw);
    if (!parsed.success) {
      fail(index, `schema: ${parsed.error.message}`);
      return;
    }
    const event = parsed.data as any;

    if (terminated) fail(index, `${event.type} after terminal event`);
    if (index === 0 && event.type !== "RUN_STARTED") fail(index, "first event is not RUN_STARTED");

    switch (event.type) {
      case "RUN_STARTED":
        if (run !== undefined) fail(index, "second RUN_STARTED");
        if (event.protocolVersion === undefined) fail(index, "RUN_STARTED without protocolVersion");
        run = { threadId: event.threadId, runId: event.runId };
        break;
      case "RUN_FINISHED":
      case "RUN_ERROR": {
        terminated = true;
        if (event.type === "RUN_FINISHED" && run &&
          (event.threadId !== run.threadId || event.runId !== run.runId)) {
          fail(index, "RUN_FINISHED ids differ from RUN_STARTED");
        }
        const open = [
          ...[...openText].map((id) => `text ${id}`),
          ...[...openReasoningMessages].map((id) => `reasoning message ${id}`),
          ...[...openReasoning].map((id) => `reasoning ${id}`),
          ...[...openToolCalls].map((id) => `tool call ${id}`),
          ...[...openSteps].map((name) => `step ${name}`),
        ];
        if (open.length > 0) fail(index, `${event.type} with open: ${open.join(", ")}`);
        break;
      }

      case "STEP_STARTED":
        if (seenSteps.has(event.stepName)) fail(index, `step "${event.stepName}" reused`);
        seenSteps.add(event.stepName);
        openSteps.add(event.stepName);
        break;
      case "STEP_FINISHED":
        if (!openSteps.delete(event.stepName)) fail(index, `STEP_FINISHED for unopened "${event.stepName}"`);
        break;

      case "TEXT_MESSAGE_START":
        claimMessageId(index, event.messageId);
        openText.add(event.messageId);
        break;
      case "TEXT_MESSAGE_CONTENT":
        if (!openText.has(event.messageId)) fail(index, `content for unopened text ${event.messageId}`);
        break;
      case "TEXT_MESSAGE_END":
        if (!openText.delete(event.messageId)) fail(index, `end for unopened text ${event.messageId}`);
        break;

      case "REASONING_START":
        claimMessageId(index, event.messageId);
        openReasoning.add(event.messageId);
        break;
      case "REASONING_MESSAGE_START":
        if (!openReasoning.has(event.messageId)) fail(index, `reasoning message outside REASONING_START`);
        openReasoningMessages.add(event.messageId);
        break;
      case "REASONING_MESSAGE_CONTENT":
        if (!openReasoningMessages.has(event.messageId)) fail(index, `content for unopened reasoning ${event.messageId}`);
        break;
      case "REASONING_MESSAGE_END":
        if (!openReasoningMessages.delete(event.messageId)) fail(index, `end for unopened reasoning ${event.messageId}`);
        break;
      case "REASONING_END":
        if (openReasoningMessages.has(event.messageId)) fail(index, "REASONING_END before REASONING_MESSAGE_END");
        if (!openReasoning.delete(event.messageId)) fail(index, `REASONING_END for unopened ${event.messageId}`);
        break;

      case "TOOL_CALL_START":
        if (openToolCalls.has(event.toolCallId) || endedToolCalls.has(event.toolCallId)) {
          fail(index, `tool call ${event.toolCallId} started twice`);
        }
        openToolCalls.add(event.toolCallId);
        toolArgs.set(event.toolCallId, "");
        break;
      case "TOOL_CALL_ARGS":
        if (!openToolCalls.has(event.toolCallId)) fail(index, `args for unopened tool call ${event.toolCallId}`);
        toolArgs.set(event.toolCallId, (toolArgs.get(event.toolCallId) ?? "") + event.delta);
        break;
      case "TOOL_CALL_END":
        if (!openToolCalls.delete(event.toolCallId)) fail(index, `end for unopened tool call ${event.toolCallId}`);
        endedToolCalls.add(event.toolCallId);
        if (!isJsonObject(toolArgs.get(event.toolCallId) ?? "")) {
          fail(index, `tool call ${event.toolCallId} arguments are not a JSON object`);
        }
        break;
      case "TOOL_CALL_RESULT":
        if (!endedToolCalls.has(event.toolCallId)) fail(index, `result for tool call ${event.toolCallId} that has not ended`);
        claimMessageId(index, event.messageId);
        break;
    }
  });

  if (events.length > 0 && !terminated) problems.push("no terminal RUN_FINISHED or RUN_ERROR");
  return problems;
};
