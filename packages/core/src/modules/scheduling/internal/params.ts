/**
 * Path parameters and the empty error body scheduling's routes share.
 *
 * Copies of `apps/api/src/http/schemas.ts`'s `conversationIdParams`,
 * `serviceIdParams`, `scheduleParams` and `notFoundBody`, which a module may
 * not import. Byte-for-byte the same zod shapes, so a request the api accepted
 * is still accepted and every error body is still `{}`.
 */
import { z } from "zod";

/** `{}` — the body of every scheduling error status that carries no reason. */
export const emptyBody = z.object({});

/** `/:id` — a conversation, a service, or a scheduled message, by its own id. */
export const idParams = z.object({ id: z.string().min(1) });

/** `/conversations/:id/scheduled-messages/:scheduleId`. */
export const scheduleParams = z.object({
  id: z.string().min(1),
  scheduleId: z.string().min(1),
});

/** `/vehicle-returns/:returnId`. */
export const returnParams = z.object({ returnId: z.string().min(1) });

/** `/return-reminders/:reminderMessageId`. */
export const reminderMessageParams = z.object({ reminderMessageId: z.string().min(1) });
