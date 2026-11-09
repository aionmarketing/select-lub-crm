/**
 * `drain-outbox` — the worker job that sends queued WhatsApp messages.
 *
 * Moved from `apps/worker/src/outbox/drain.ts`. {@link drainOnce} handles one
 * row, {@link drainOutbox} loops to the per-tick cap, and {@link job} wraps the
 * loop for the kernel's registry, whose per-job flag is now what keeps two ticks
 * from overlapping (the old worker kept its own `drainState` for that).
 *
 * THREE TRANSACTIONS, NEVER ONE AROUND THE SEND (W2-C12). The claim commits in
 * its own `db.tx("channel")`; Evolution is awaited outside any transaction; the
 * result is written in another. A claimed row is therefore visible as `claimed`
 * for the length of the send, which is what `reclaim-stuck` looks for.
 *
 * THE MESSAGE INSERT IS AN EVENT (W3-C4, resolved in 4A). On a send that returns
 * a provider timestamp, the old drain inserted the canonical outbound `message`
 * itself — a write to `conversations`' table. It publishes
 * `channel/outbound-sent` instead, and the worker's composition root subscribes
 * `conversations`' `insertSentMessages`, which inserts under its own role.
 *
 * CONFIRM FIRST, THEN PUBLISH (owner rulings, 2026-09-25). Evolution has
 * accepted the send by then, so the confirm is the fact that must not be lost.
 * The publish used to come first, and a subscriber that threw left the row
 * `claimed`: `reclaim-stuck` requeued it after the claim timeout and the customer
 * got the message twice. Now a publish failure is logged and never undoes the
 * confirm. The thread bubble is not lost with it: the SEND_MESSAGE webhook for
 * the same provider id inserts the canonical message, the same path a send with
 * no usable timestamp already relies on (`apps/worker/test/channel-wiring.test.ts`).
 *
 * A SEND THAT MIGHT HAVE ARRIVED IS NEVER RESENT (`hold-unknown-outcome-sends`,
 * owner rule 2026-09-25). The Evolution client bounds each send and says what a
 * failure proves. Only a `retryable` failure (the request never reached
 * Evolution) goes back to `queued`. A `refused` or `unknown` one is `failed` at
 * once, and a person decides whether to resend. If the process dies after
 * Evolution accepted a send but before `markConfirmed` commits, `reclaim-stuck`
 * now fails the row as `send_outcome_unknown` instead of requeuing it: the window
 * that used to close into a second send closes into a held message.
 *
 * A 404 ALSO MARKS THE CONNECTION DISCONNECTED (`outbox-404-marks-disconnected`,
 * owner 2026-10-07). Evolution answers 404 from its instance guard: the instance
 * does not exist. Blocking the row alone left the stored `connection_state`
 * saying CONNECTED, so the scheduled due tick, which reads that column, unblocked
 * the copy after every 5-minute stale window and the drain called Evolution again
 * — forever. The state is written through `updateConnectionState`, dated the
 * instant before the send, so a `connection.update` received after the send began
 * still wins.
 */
import type { Db } from "../../../kernel/db.js";
import { publish } from "../../../kernel/events.js";
import type { Job } from "../../../kernel/jobs.js";
import { updateConnectionState } from "../contracts/connections.js";
import { outboundSent, type OutboundSent } from "../contracts/outbound-sent.js";
import { OUTBOX_SEND_OUTCOME_UNKNOWN } from "../contracts/send-outcome.js";
import type { EvolutionSend, EvolutionSendResult } from "../internal/ports.js";
import { dispatchSend } from "./dispatch.js";
import { claimQueued, markBlocked, markConfirmed, markFailedNow, markFailedQueued, type ClaimedOutbox } from "./queries.js";

export {
  claimQueued,
  markBlocked,
  markConfirmed,
  markFailedNow,
  markFailedQueued,
  type ClaimedOutbox,
} from "./queries.js";
export { OUTBOX_RETRY_BACKOFF_MS, OUTBOX_RETRY_MAX_ATTEMPTS, type EvolutionSend } from "../internal/ports.js";

/** Maximum outbox sends attempted per tick. */
export const OUTBOX_DRAIN_PER_TICK_CAP = 50;

/** Tick interval when none is given; the worker passes `WORKER_OUTBOX_POLL_MS`. */
export const DRAIN_OUTBOX_EVERY_MS = 1_000;

/** Terminal outcome of processing one claimed outbox row. */
export type DrainOutcome = "empty" | "confirmed" | "blocked" | "requeued" | "failed";

/** What the drain needs. */
export type DrainOutboxDeps = {
  db: Db;
  evolution: EvolutionSend;
  /** Log sink; message bodies never reach it. Defaults to a no-op. */
  log?: (message: string) => void;
  /** Sends per tick; defaults to {@link OUTBOX_DRAIN_PER_TICK_CAP}. */
  cap?: number;
  /** Job interval; defaults to {@link DRAIN_OUTBOX_EVERY_MS}. */
  everyMs?: number;
};

function outboundType(messageType: string): OutboundSent["messageType"] {
  return messageType === "image" ||
    messageType === "audio" ||
    messageType === "document" ||
    messageType === "video"
    ? messageType
    : "text";
}

/** An error's name, plus its `code` when it has one; never its message. */
function errorTag(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? `${error.name} ${code}` : error.name;
}

/**
 * Sends one claimed row, turning a throw into an unknown outcome. The Evolution
 * client never throws, but a port that did must not leave the row `claimed` for
 * the reclaim pass: the request may have gone out.
 */
async function sendClaimed(evolution: EvolutionSend, claimed: ClaimedOutbox): Promise<EvolutionSendResult> {
  try {
    return await dispatchSend(evolution, claimed);
  } catch (error: unknown) {
    return { ok: false, kind: "unknown", error: `thrown ${errorTag(error)}` };
  }
}

/**
 * Claims one queued row, sends it through Evolution, and records the outcome.
 *
 * @param deps - The database handle, the Evolution port and an optional log.
 * @returns `"empty"` when nothing was claimable; `"confirmed"` on a successful
 *   send; `"blocked"` when the instance does not exist; `"requeued"` after a
 *   retryable failure (the row may have reached `failed` on its last attempt);
 *   `"failed"` when the send was refused or its outcome is unknown.
 */
export async function drainOnce(deps: DrainOutboxDeps): Promise<DrainOutcome> {
  const log = deps.log ?? (() => undefined);
  const claimed = await claimQueued(deps.db);
  if (!claimed) {
    return "empty";
  }
  log(`outbox claimed ${claimed.id} conversation ${claimed.conversationId}`);
  // Dates a 404's connection-state write, as the reconcile dates its probe.
  const sendStartedAt = new Date();
  const sent = await sendClaimed(deps.evolution, claimed);
  if (!sent.ok) {
    const sanitized = sent.error.slice(0, 120);
    switch (sent.kind) {
      case "disconnected":
        await markBlocked(deps.db, claimed.id, sanitized);
        try {
          await updateConnectionState(deps.db, {
            connectionId: claimed.whatsappConnectionId,
            state: "DISCONNECTED",
            observedAt: sendStartedAt,
          });
          log(`outbox blocked ${claimed.id} connection ${claimed.whatsappConnectionId} marked disconnected`);
        } catch (error: unknown) {
          // The row is already blocked, which is the fact that matters. A failed
          // state write must not end the tick for the messages behind it; the
          // next 404 or the heartbeat reconcile writes the state again.
          log(`outbox blocked ${claimed.id}; marking connection ${claimed.whatsappConnectionId} disconnected failed: ${errorTag(error)}`);
        }
        return "blocked";
      case "retryable":
        await markFailedQueued(deps.db, claimed.id, sanitized);
        log(`outbox failed ${claimed.id} retryable: ${sanitized}`);
        return "requeued";
      case "refused":
        await markFailedNow(deps.db, claimed.id, sanitized);
        log(`outbox failed ${claimed.id} refused: ${sanitized}`);
        return "failed";
      case "unknown":
        // The detail goes to the log; the row carries the one token the thread reads.
        await markFailedNow(deps.db, claimed.id, OUTBOX_SEND_OUTCOME_UNKNOWN);
        log(`outbox failed ${claimed.id} outcome unknown: ${sanitized}`);
        return "failed";
    }
  }
  await markConfirmed(deps.db, claimed.id, sent.externalMessageId);
  if (sent.providerTimestamp) {
    try {
      await publish(outboundSent, {
        whatsappConnectionId: claimed.whatsappConnectionId,
        remoteJid: claimed.remoteJid,
        chatKey: claimed.customerPhoneNormalized,
        externalMessageId: sent.externalMessageId,
        direction: "outbound",
        messageType: outboundType(claimed.messageType),
        textBody: claimed.textBody,
        providerTimestamp: sent.providerTimestamp,
      });
    } catch (error: unknown) {
      // The error's name and code only: a Prisma error message can quote the
      // values it was given, and the body must never reach the log.
      log(`outbox publish failed ${claimed.id} provider ${sent.externalMessageId}: ${errorTag(error)}`);
    }
  } else {
    // Evolution's send response had no usable root `messageTimestamp`. We never
    // fall back to wall-clock here (outbox-send-provider-timestamp); the later
    // SEND_MESSAGE/MESSAGES_UPSERT webhook for the same provider id is expected
    // to insert the canonical message with Evolution's own timestamp. That
    // webhook can independently lack a usable timestamp too, in which case no
    // canonical message is ever created for this send — log it so that state is
    // observable.
    log(`outbox confirmed without timestamp ${claimed.id} provider ${sent.externalMessageId}`);
  }
  log(`outbox confirmed ${claimed.id}`);
  return "confirmed";
}

/**
 * Drains up to the cap. Stops early only when nothing is claimable: a retryable
 * failure no longer ends the tick, because the backoff in `claimQueued` keeps the
 * failed row from being re-claimed, so the loop carries on sending everything
 * behind it.
 *
 * Has no overlap guard of its own. The job registry runs one tick of this job at
 * a time; a caller outside the registry that can overlap must guard it.
 *
 * @param deps - As for {@link drainOnce}, plus the optional cap.
 */
export async function drainOutbox(deps: DrainOutboxDeps): Promise<void> {
  const cap = deps.cap ?? OUTBOX_DRAIN_PER_TICK_CAP;
  for (let i = 0; i < cap; i++) {
    const outcome = await drainOnce(deps);
    // `"requeued"` used to break here, and that was a deliberate rule rather than
    // an oversight: it stopped a failed row being re-claimed immediately by the
    // oldest-first claim and hot-looping through this cap. The backoff in
    // `claimQueued` now prevents that instead, which is the same guard without
    // also stopping every other message. Combined with text rows never reaching a
    // terminal state, breaking here meant one undeliverable message halted the
    // whole outbox indefinitely.
    if (outcome === "empty") {
      break;
    }
  }
}

/**
 * The job, for the kernel's registry.
 *
 * @param deps - As for {@link drainOutbox}, plus the optional interval.
 * @returns A job named `channel/drain-outbox`.
 */
export function job(deps: DrainOutboxDeps): Job {
  return {
    name: "channel/drain-outbox",
    everyMs: deps.everyMs ?? DRAIN_OUTBOX_EVERY_MS,
    run: () => drainOutbox(deps),
  };
}
