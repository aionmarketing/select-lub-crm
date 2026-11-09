/**
 * Skip / fail / run decision for the live Programar mensagem suite.
 *
 * Oracle: `live-scheduled-messages` repo-foundation requirement
 * "Local live Programar mensagem may send to 5519000000002".
 */
import { LIVE_SCHEDULE_CHAT_KEY, FORBIDDEN_SCHEDULE_CHAT_KEY } from "./ids.js";

/** Database classification used by the gate (mirrors `shouldRunLiveTests` outcomes). */
export type LiveDbTarget =
  | { kind: "absent" }
  | { kind: "local" }
  | { kind: "remote"; host: string; allowRemote: boolean }
  | { kind: "unparseable" };

/** Conversation row the live suite may schedule on. */
export type LiveScheduleConversation = {
  id: string;
  chatKey: string;
  customerId: string | null;
  unitId: string;
  connectionState: string;
};

/** Gate result: skip (unequipped), fail (misconfigured), or ready to run. */
export type LiveScheduleGateResult =
  | { kind: "skip"; reason: string }
  | { kind: "fail"; message: string }
  | { kind: "ready"; conversation: LiveScheduleConversation };

/**
 * Decides whether the live suite may run.
 *
 * @param input.optIn - `E2E_LIVE_SCHEDULE` raw value; only `"1"` opts in
 * @param input.db - Classified `DATABASE_URL`
 * @param input.conversation - Row for `5519000000002`, or null when missing
 * @returns Skip, fail, or the conversation to drive
 */
export function evaluateLiveScheduleGate(input: {
  optIn: string | undefined;
  db: LiveDbTarget;
  conversation: LiveScheduleConversation | null;
}): LiveScheduleGateResult {
  if (input.optIn !== "1") {
    return { kind: "skip", reason: "E2E_LIVE_SCHEDULE is not 1" };
  }
  if (input.db.kind === "absent") {
    return { kind: "skip", reason: "DATABASE_URL is unset" };
  }
  if (input.db.kind === "unparseable") {
    return {
      kind: "fail",
      message:
        "Refusing to run database-writing tests: DATABASE_URL is not a readable URL. Unset DATABASE_URL to skip these suites, or set it to a local database to run them.",
    };
  }
  if (input.db.kind === "remote" && !input.db.allowRemote) {
    return {
      kind: "fail",
      message: [
        `Refusing to run database-writing tests against ${input.db.host}.`,
        "These suites create and delete rows. Point DATABASE_URL at a local",
        "database, or set LIVE_TESTS_ALLOW_REMOTE=1 if this really is a",
        "disposable test database.",
      ].join(" "),
    };
  }
  if (!input.conversation) {
    return {
      kind: "skip",
      reason: `no conversation with chatKey ${LIVE_SCHEDULE_CHAT_KEY}`,
    };
  }
  if (input.conversation.chatKey === FORBIDDEN_SCHEDULE_CHAT_KEY) {
    return {
      kind: "fail",
      message: `refusing to schedule to ${FORBIDDEN_SCHEDULE_CHAT_KEY}`,
    };
  }
  if (input.conversation.chatKey !== LIVE_SCHEDULE_CHAT_KEY) {
    return {
      kind: "fail",
      message: `live dest chatKey is ${input.conversation.chatKey}, expected ${LIVE_SCHEDULE_CHAT_KEY}`,
    };
  }
  if (input.conversation.connectionState !== "CONNECTED") {
    return {
      kind: "fail",
      message: `instance is not CONNECTED (${input.conversation.connectionState})`,
    };
  }
  return { kind: "ready", conversation: input.conversation };
}
