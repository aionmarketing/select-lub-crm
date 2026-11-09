/**
 * The channel module: the WhatsApp transport through Evolution. It owns
 * `whatsapp_connection`, `webhook_event` and `outbox_message`. The only file the
 * composition roots import; other modules reach it through `contracts/`.
 *
 * - `createJobs(deps)` registers the two loops, `drain-outbox` and
 *   `reclaim-stuck`.
 * - `reconcileConnection` and `backfillHistory` are functions the worker calls
 *   itself: the reconcile on its heartbeat, after the ingest retry pass, so the
 *   two stay serialized (ruling Q2-A); the backfill once at start-up, behind the
 *   seed guard that stays with ingest.
 * - `createWebhookPlugin(deps)` mounts `receive-webhook` on the worker's app, and
 *   `createHttpPlugin(deps)` mounts `get-channel-status` on the api's.
 * - The Evolution ports and their HTTP adapters are exported for the
 *   composition roots to build and bind, as `quotes` exports `OilResearchPorts`.
 */
import type { Db } from "../../kernel/db.js";
import { registerSlice, type HttpPlugin } from "../../kernel/http.js";
import type { RegisterJob } from "../../kernel/jobs.js";
import { job as drainOutboxJob } from "./drain-outbox/index.js";
import { route as getChannelStatusRoute } from "./get-channel-status/index.js";
import type { EvolutionSend } from "./internal/ports.js";
import { job as reclaimStuckJob } from "./reclaim-stuck/index.js";
import { route as receiveWebhookRoute, type ReceiveWebhookDeps } from "./receive-webhook/index.js";

export { summarizeWebhook, WEBHOOK_PATH, type ReceiveWebhookDeps } from "./receive-webhook/index.js";

/**
 * Builds the api's plugin: `get-channel-status`.
 *
 * @param deps.instanceName - Resolves the configured Evolution instance name.
 * @returns The plugin the api's composition root calls with its app.
 */
export function createHttpPlugin(deps: { instanceName: () => string }): HttpPlugin {
  return (app) => {
    registerSlice(app, "channel", "get-channel-status", getChannelStatusRoute(deps));
  };
}

/**
 * Builds the worker's plugin: `receive-webhook`. The worker's app must have the
 * database handle bound, or the route answers 503 `database_unset`.
 *
 * @param deps - The webhook secret and the log sink.
 * @returns The plugin the worker's composition root calls with its app.
 */
export function createWebhookPlugin(deps: ReceiveWebhookDeps): HttpPlugin {
  return (app) => {
    registerSlice(app, "channel", "receive-webhook", receiveWebhookRoute(deps));
  };
}

export { reconcileConnection } from "./reconcile-connection/index.js";
export { backfillHistory, HISTORY_MAX_PAGES_PER_CHAT, type BackfillHistoryOptions } from "./backfill-history/index.js";
// `drainOnce` is exported for the worker's composition tests, which drive one
// send and then the ingest subscriber it publishes to; production drains only
// through the registered job.
export { drainOnce, OUTBOX_DRAIN_PER_TICK_CAP, type DrainOutboxDeps } from "./drain-outbox/index.js";
export { RECLAIM_CLAIM_TIMEOUT_MS } from "./reclaim-stuck/index.js";
export {
  createEvolutionConnectionState,
  createEvolutionHistory,
  createEvolutionSend,
  EVOLUTION_CONNECTION_STATE_TIMEOUT_MS,
  EVOLUTION_MEDIA_SEND_TIMEOUT_MS,
  EVOLUTION_TEXT_SEND_TIMEOUT_MS,
  HISTORY_PAGE_SIZE,
} from "./internal/evolution.js";
// The api's live probe, media fetch and instance-name resolver, for its composition root (4A).
export { fetchEvolutionConnected, fetchEvolutionMedia } from "./internal/live-probe.js";
export { resolveEvolutionInstanceName } from "./internal/instance-name.js";
export {
  OUTBOX_RETRY_BACKOFF_MS,
  OUTBOX_RETRY_MAX_ATTEMPTS,
  type ConnectionState,
  type EvolutionConnectionState,
  type EvolutionConnectionStateResult,
  type EvolutionHistory,
  type EvolutionMediaFetchResult,
  type EvolutionSend,
  type EvolutionSendFailureKind,
  type EvolutionSendResult,
} from "./internal/ports.js";

/** What the module's jobs need, held in the closure `createJobs` builds. */
export type ChannelJobDeps = {
  db: Db;
  evolution: EvolutionSend;
  log?: (message: string) => void;
  /** `WORKER_OUTBOX_POLL_MS`; the drain's interval. */
  outboxPollMs?: number;
  /** `WORKER_OUTBOX_CLAIM_TIMEOUT_MS`; the reclaim's interval and age cutoff. */
  claimTimeoutMs?: number;
};

/**
 * Builds the module's job registration: `drain-outbox` and `reclaim-stuck`.
 *
 * @param deps - The database handle, the Evolution send port, and the intervals.
 * @returns The module's `jobs(register)`.
 */
export function createJobs(deps: ChannelJobDeps): (register: RegisterJob) => void {
  return (register) => {
    register(
      drainOutboxJob({
        db: deps.db,
        evolution: deps.evolution,
        ...(deps.log ? { log: deps.log } : {}),
        ...(deps.outboxPollMs === undefined ? {} : { everyMs: deps.outboxPollMs }),
      }),
    );
    register(
      reclaimStuckJob({
        db: deps.db,
        ...(deps.claimTimeoutMs === undefined ? {} : { claimTimeoutMs: deps.claimTimeoutMs }),
      }),
    );
  };
}
