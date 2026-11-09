/**
 * Closed vocabulary for `Message.origin`: live ingest versus demo seed.
 *
 * Prisma stores a string (same style as `Customer.origin`). Writes go through
 * these constants so a third value is a type error at the call site. The one copy:
 * ingest, the demo seed, the scrub and `@select-lub/core/db` all read it from here
 * (a second copy in `kernel/prisma/` existed until `packages/db` was absorbed).
 */

/** Canonical message that arrived from WhatsApp (webhook, CRM send, or REST history). */
export const MESSAGE_ORIGIN_LIVE = "LIVE";

/** Canonical message invented by the demo seed. */
export const MESSAGE_ORIGIN_SEED = "SEED";

/** Origins the schema accepts. */
export const MESSAGE_ORIGINS = [MESSAGE_ORIGIN_LIVE, MESSAGE_ORIGIN_SEED] as const;

/** Origin stored on `Message.origin`. */
export type MessageOrigin = (typeof MESSAGE_ORIGINS)[number];
