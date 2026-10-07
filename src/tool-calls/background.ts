import type { SessionNotification } from "@agentclientprotocol/sdk";
import { AIR_ASYNC_TASKS_CAPABILITY, withAirMeta } from "../air-extension.js";

/**
 * Marks the Bash `tool_call_update` whose command detached into the background.
 *
 * A backgrounded Bash call returns as soon as the command is handed off, so the
 * card reaches `completed` while the command itself runs on for minutes. ACP has
 * no tool-call status for "still running elsewhere", so this marker is what lets
 * a client render the card as backgrounded work instead of finished work. It
 * rides the update the tool result already emits, so it costs no extra
 * notification and cannot arrive out of order.
 *
 * Only structured data marks a call: the `backgroundTaskId` of the tool
 * result, an SDK task of the call that went to the background, or a
 * `run_in_background` input. The text of the result never marks a call.
 *
 * The command's own lifecycle -- progress, completion, the stop control -- is
 * published separately as an async task; this says only that the card has one.
 * The marker is an AIR presentation contract, so a provider-neutral client can
 * receive the lifecycle without receiving an AIR namespace.
 */
export function backgroundedBashToolCall(
  notification: SessionNotification,
  backgroundedToolCallIds: ReadonlySet<string>,
  airAsyncTasksSupported: boolean,
): SessionNotification {
  const update = notification.update;
  if (
    !airAsyncTasksSupported ||
    update.sessionUpdate !== "tool_call_update" ||
    !backgroundedToolCallIds.has(update.toolCallId)
  ) {
    return notification;
  }
  return {
    ...notification,
    update: {
      ...update,
      _meta: withAirMeta(update._meta, AIR_ASYNC_TASKS_CAPABILITY, { backgrounded: true }),
    },
  };
}
