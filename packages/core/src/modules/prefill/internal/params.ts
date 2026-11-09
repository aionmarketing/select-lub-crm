/**
 * The path parameter and empty error body prefill's routes share: copies of
 * `apps/api/src/http/schemas.ts`'s `conversationIdParams` and `notFoundBody`,
 * which a module may not import. The same zod shapes.
 */
import { z } from "zod";

/** `{}` — the body of every prefill error status. */
export const emptyBody = z.object({});

/** `/conversations/:id`. */
export const conversationParams = z.object({ id: z.string().min(1) });
