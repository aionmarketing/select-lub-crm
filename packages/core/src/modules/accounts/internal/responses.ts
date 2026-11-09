/**
 * The empty JSON object accounts answers its error statuses with.
 *
 * All five routes answer 401, 403, 404 and 409 with `{}` and nothing else. It
 * was `notFoundBody` in `apps/api/src/http/schemas.ts`, which a module may not
 * import, so the one schema the five slices share is defined here. It is the
 * same `z.object({})`, so the serialised body is byte-identical.
 */
import { z } from "zod";

/** `{}` — the body of every accounts error response. */
export const emptyBody = z.object({});
