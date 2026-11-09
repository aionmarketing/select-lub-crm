/**
 * One short token shared by every live Programar mensagem artifact in a run.
 *
 * The spec brands each message body with it and `ensure-service.ts` brands the
 * fallback OS, so a rerun never collides with the rows a finished run left behind.
 */
import { randomUUID } from "node:crypto";

/** Short unique token for this Playwright run. */
export const LIVE_RUN_ID = randomUUID().slice(0, 8);
