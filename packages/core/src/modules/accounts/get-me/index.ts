/**
 * `GET /auth/me` — the caller's own profile, memberships and current unit.
 *
 * Reads nothing from the database: the auth hook has already loaded the caller
 * into the `request.crm*` fields, and this answers from them. The path is
 * unit-exempt in the hook (`isUnitExemptPath`), so a caller with two lojas and
 * no `X-Unit-Id` still gets a 200 here — that is how the SPA learns which lojas
 * to offer before it has picked one.
 */
import type { FastifyRequest } from "fastify";
import { resolveCurrentUnit } from "../../../kernel/auth/resolve-unit.js";
import type { SliceRoute } from "../../../kernel/http.js";
import { meSchema, type Me } from "../contracts/http.js";
import { emptyBody } from "../internal/responses.js";

/** Response schemas: the profile, or `{}` when the hook refused the caller. */
export const schema = { response: { 200: meSchema, 401: emptyBody } };

/**
 * Builds the caller's profile from what the hook resolved.
 *
 * `currentUnitId` is left out, not nulled, when it does not resolve. The name
 * falls back to the e-mail for a caller with no CRM name.
 *
 * @param request - The request, with the hook's `crm*` fields set.
 * @returns The `Me` body.
 */
export async function handler(request: FastifyRequest): Promise<Me> {
  const unitIds = request.crmUnitIds ?? [];
  const header = typeof request.headers["x-unit-id"] === "string" ? request.headers["x-unit-id"] : undefined;
  const currentUnitId = resolveCurrentUnit(header, unitIds) ?? undefined;
  const email = request.crmEmail ?? "";
  const name = request.crmName && request.crmName.length > 0 ? request.crmName : email;
  return {
    id: request.crmUserId ?? "",
    email,
    name,
    unitIds,
    ...(currentUnitId ? { currentUnitId } : {}),
  };
}

/** The slice's route; the path is the hook's unit-exempt `/auth/me`, unchanged. */
export const route: SliceRoute<typeof schema> = {
  method: "GET",
  path: "/auth/me",
  schema,
  handler,
};
