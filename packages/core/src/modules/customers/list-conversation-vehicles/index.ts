/**
 * `list-conversation-vehicles` — GET `/conversations/:id/vehicles`. Lists the vehicles of a conversation's customer, refreshing a linked customer from Omie first.
 *
 * Each vehicle whose identity's oil research someone waits on or runs, while research is not
 * stopped, carries `oilResearch: { status: "researching" }`, read through the quotes contract
 * `readActiveOilResearch` (background-oil-research D18) — a read only, and a failure to read
 * lists the vehicles without it.
 *
 * Moved from `apps/api/src/cadastro/routes.ts` (4B) with the handler body
 * unchanged except for where its dependencies come from: the cadastro and
 * plate-origin stores run each call in `db.tx("customers", …)`, the Omie adapter
 * is the one `createHttpPlugin` was given (called outside any transaction), and a conversation is
 * reached through the conversations contracts.
 */
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { Db } from "../../../kernel/db.js";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { readActiveOilResearch } from "../../quotes/contracts/read-active-oil-research.js";
import { createCadastroStore } from "../contracts/cadastro-store/index.js";
import { conversationVehiclesSchema, type Vehicle } from "../contracts/http.js";
import { conversationIdParams, notFoundBody } from "../contracts/routes.js";
import { resolveCadastroCustomer } from "../internal/conversation-customer.js";
import { vehicleDtoWithOrigins } from "../internal/plate-origin.js";
import { createPlateOriginStore } from "../contracts/cadastro-store/plate-origin.js";
import { refreshLinkedCustomer } from "../internal/resync-from-erp.js";
import type { CustomerPorts } from "../internal/ports.js";

/** Request and response schemas, as the old route declared them. */
export const schema = {
  params: conversationIdParams,
  response: { 200: conversationVehiclesSchema, 404: notFoundBody },
};

/**
 * Handles the request.
 *
 * @param request - The parsed request.
 * @param reply - The reply.
 * @param omieAdapter - The Omie adapter `createHttpPlugin` was given.
 * @param readResearch - Reads which vehicles are being researched (quotes' `readActiveOilResearch`).
 * @returns The response body.
 */
export async function handler(
  request: FastifyRequest<{ Params: z.infer<typeof conversationIdParams> }>,
  reply: FastifyReply,
  omieAdapter: CustomerPorts["omieAdapter"],
  readResearch: typeof readActiveOilResearch = readActiveOilResearch,
) {
  const db = request.server.db;
  const cadastroStore = createCadastroStore(db);
  const originStore = createPlateOriginStore(db);
  const unitId = unitIdOf(request);
  if (!unitId) {
    return reply.code(404).send({});
  }
  const resolved = await resolveCadastroCustomer(db, unitId, request.params.id);
  if (resolved.missing) {
    return reply.code(404).send({});
  }
  if (!resolved.customer) {
    return { customerId: null, vehicles: [] };
  }
  const customer = await refreshLinkedCustomer(cadastroStore, omieAdapter, resolved.customer);
  if (!customer) {
    return { customerId: null, vehicles: [] };
  }
  const rows = await cadastroStore.listVehicles(customer.id);
  const vehicles = await Promise.all(rows.map((row) => vehicleDtoWithOrigins(row, originStore)));
  return { customerId: customer.id, vehicles: await markResearched(db, vehicles, readResearch, request.log) };
}

/**
 * Marks each vehicle whose identity's oil research someone waits on or runs, and research is not
 * stopped (background-oil-research D18), through the quotes contract. A read-only lookup: it writes
 * nothing and starts no research. A failure to read leaves the list unmarked rather than failing it.
 */
async function markResearched(db: Db, vehicles: Vehicle[], readResearch: typeof readActiveOilResearch, log: FastifyBaseLogger): Promise<Vehicle[]> {
  let active: Set<string>;
  try {
    active = await db.tx("customers", (tx) => readResearch(tx, vehicles, new Date()));
  } catch (error) {
    log.warn({ event: "oil_research_read_failed", err: error }, "customers: the oil research state could not be read; vehicles listed without it");
    return vehicles;
  }
  return vehicles.map((vehicle) => (active.has(vehicle.id) ? { ...vehicle, oilResearch: { status: "researching" as const } } : vehicle));
}

/**
 * The route, over the module's ports.
 *
 * @param ports - The Omie adapter, from `createHttpPlugin`'s closure.
 * @param readResearch - The quotes contract that reads the research state; a test passes one that fails.
 * @returns The route to register.
 */
export function route(ports: CustomerPorts, readResearch: typeof readActiveOilResearch = readActiveOilResearch): SliceRoute<typeof schema> {
  return {
    method: "GET",
    path: "/conversations/:id/vehicles",
    schema,
    handler: (request: Parameters<typeof handler>[0], reply: FastifyReply) =>
      handler(request, reply, ports.omieAdapter, readResearch),
  };
}
