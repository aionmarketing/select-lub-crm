/**
 * Fastify `onRequest` hook: validates JWT, loads CRM profile, and resolves `X-Unit-Id`.
 * Populates `request.crm*` fields consumed by route handlers.
 *
 * Moved here from `apps/api/src/auth/hook.ts` in wave 5.2 with its behaviour
 * unchanged. It replaces the kernel's earlier `registerAuthHook`
 * (`kernel/auth.ts`), which had no callers and lacked the `X-Unit-Id`
 * resolution and the 403. The `request.crm*` fields and `unitIdOf` are declared
 * in `../request.ts`.
 */
import type { FastifyInstance } from "fastify";
import type { GetUser } from "./get-user.js";
import {
  bearerToken,
  isHealthPath,
  isUnauthenticatedAssetRequest,
  isUnitExemptPath,
  requestPath,
  resolveCurrentUnit,
} from "./resolve-unit.js";

/**
 * The one read this hook makes about its caller: CRM profile and memberships.
 *
 * `accounts` implements it over `user` and `user_unit` (`createCallerDirectory`),
 * in a single transaction, and the composition root passes that in. Declared
 * here rather than imported because the kernel may not depend on a module.
 * Structural, so the accounts object satisfies it as it is.
 */
export type CallerDirectory = {
  loadCaller(id: string): Promise<{
    user: { id: string; email: string; name: string } | null;
    unitIds: string[];
  }>;
};

/**
 * Registers JWT auth, unit scoping, and 401/403 responses on protected API routes.
 *
 * @param app - Fastify instance to attach the `onRequest` hook to.
 * @param deps - JWT validator, and the caller directory the profile and
 *   memberships are read from.
 * @returns Nothing; mutates `request.crm*` fields on authenticated requests.
 */
export function registerAuthHook(
  app: FastifyInstance,
  deps: { getUser: GetUser; authStore: CallerDirectory },
) {
  app.addHook("onRequest", async (request, reply) => {
    const path = requestPath(request.url);
    if (isHealthPath(request.method, path)) {
      return;
    }
    if (isUnauthenticatedAssetRequest(request.method, path)) {
      return;
    }

    const token = bearerToken(request.headers.authorization);
    if (!token) {
      return reply.code(401).send({});
    }

    const authUser = await deps.getUser(token);
    if (!authUser) {
      return reply.code(401).send({});
    }

    const { user: crmUser, unitIds } = await deps.authStore.loadCaller(authUser.id);
    request.crmUserId = authUser.id;
    request.crmEmail = crmUser?.email ?? authUser.email;
    request.crmName = crmUser?.name ?? "";
    request.crmUnitIds = unitIds;

    if (isUnitExemptPath(request.method, path)) {
      return;
    }

    const header = typeof request.headers["x-unit-id"] === "string" ? request.headers["x-unit-id"] : undefined;
    const current = resolveCurrentUnit(header, unitIds);
    if (!current) {
      return reply.code(403).send({});
    }
    request.crmCurrentUnitId = current;
  });
}
