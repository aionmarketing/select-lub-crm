/**
 * `services` — the workshop's service orders (OS) and the vehicle returns they
 * open. Owns `service`, `service_item`, `vehicle_return` and `interval_rule`
 * (`ownership.json`).
 *
 * The only file a composition root imports. It exports {@link createHttpPlugin},
 * the five read-only routes; their paths are unchanged from
 * `apps/api/src/services`. Everything another module calls is in `contracts/`,
 * reached as `@select-lub/core/modules/services/contracts`: the ERP import and
 * the return reconcile (`erp`'s pull), archive and unarchive (`scheduling`), and
 * the return-date classification (Follow-up). There is no create route and no
 * `service-recorded` event: the ERP import is the only writer of `service`
 * (W3-C8).
 */
import { registerSlice, type HttpPlugin } from "../../kernel/http.js";
import { route as getServiceRoute } from "./get-service/index.js";
import { route as listConversationServicesRoute } from "./list-conversation-services/index.js";
import { route as listCustomerServicesRoute } from "./list-customer-services/index.js";
import { route as listUnitServicesRoute } from "./list-unit-services/index.js";
import { route as listVehicleServicesRoute } from "./list-vehicle-services/index.js";

/**
 * Services' HTTP plugin. It takes no ports: every route reads the database and
 * nothing else.
 *
 * @returns The plugin that registers the five route slices.
 */
export function createHttpPlugin(): HttpPlugin {
  return (app) => {
    registerSlice(app, "services", "list-unit-services", listUnitServicesRoute);
    registerSlice(app, "services", "get-service", getServiceRoute);
    registerSlice(app, "services", "list-customer-services", listCustomerServicesRoute);
    registerSlice(app, "services", "list-vehicle-services", listVehicleServicesRoute);
    registerSlice(app, "services", "list-conversation-services", listConversationServicesRoute);
  };
}
