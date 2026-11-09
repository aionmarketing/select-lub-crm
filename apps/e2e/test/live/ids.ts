/**
 * Chat key and fixture ids for the opt-in live Programar mensagem suite.
 *
 * Dest is 19 00000-0002. Never `5519000000001`.
 */
export const LIVE_SCHEDULE_CHAT_KEY = "5519000000002";

/** WhatsApp JID Nova conversa would store for `LIVE_SCHEDULE_CHAT_KEY`. */
export const LIVE_SCHEDULE_REMOTE_JID = `${LIVE_SCHEDULE_CHAT_KEY}@s.whatsapp.net`;

/** Forbidden dest from the previous designated-test number. */
export const FORBIDDEN_SCHEDULE_CHAT_KEY = "5519000000001";

/** Preferred service id upserted when the live conversation has no free OS. */
export const LIVE_SCHEDULE_SERVICE_ID = "e2e-live-sched-svc";

/**
 * Builds a run-unique service id for when every existing OS is occupied.
 *
 * A completed run leaves its schedule `SENT`, which occupies its OS for good, so
 * a second run needs a fresh one rather than a hard failure.
 *
 * @param runId - Short unique token for this run
 * @returns Service id derived from `LIVE_SCHEDULE_SERVICE_ID`
 */
export function liveScheduleServiceId(runId: string): string {
  return `${LIVE_SCHEDULE_SERVICE_ID}-${runId}`;
}
