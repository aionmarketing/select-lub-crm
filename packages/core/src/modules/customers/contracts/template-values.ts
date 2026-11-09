/**
 * The customer name and titular plate a conversation's template preview
 * interpolates — conversations' `templateValues` port, built over the cadastro
 * store.
 *
 * Moved from `apps/api/src/app.ts` in wave 5.2 with the read unchanged (it was
 * the old tags route's): the linked customer when it is this loja's, else the
 * loja's customer by phone, and that customer's titular plate. Read outside any
 * conversations transaction; each store call runs in its own `customers` one.
 */
import type { CadastroLink } from "../../conversations/contracts/get-cadastro-link.js";
import type { CadastroStore } from "./cadastro-store/port.js";

/**
 * @param cadastroStore - The customers store the composition root built.
 * @returns The port conversations' `createHttpPlugin` takes as `templateValues`.
 */
export function templateValuesFrom(cadastroStore: CadastroStore) {
  return async (unitId: string, link: CadastroLink) => {
    let customer = null;
    if (link.customerId) {
      const byId = await cadastroStore.getCustomer(link.customerId);
      if (byId && byId.unitId === unitId) {
        customer = byId;
      }
    }
    if (!customer) {
      customer = await cadastroStore.findCustomerByPhone(unitId, link.phone);
    }
    const titular = customer ? await cadastroStore.getVehicleForCustomer(customer.id) : null;
    return { nome_cliente: customer?.name ?? null, placa: titular?.plate ?? null };
  };
}
