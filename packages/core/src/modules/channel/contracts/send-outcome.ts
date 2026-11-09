/**
 * The `last_error` token for a send whose outcome is unknown
 * (`hold-unknown-outcome-sends`, owner rule 2026-09-25).
 *
 * A contract because it crosses modules: the drain and the reclaim pass write it,
 * and conversations' thread read tells an unknown outcome ("Envio incerto") from
 * any other failure ("Não enviada") by comparing against it.
 */

/**
 * Written on an outbox row that failed without proof the message was not sent.
 * Such a row is never requeued, reclaimed to `queued` or unblocked automatically.
 */
export const OUTBOX_SEND_OUTCOME_UNKNOWN = "send_outcome_unknown";
