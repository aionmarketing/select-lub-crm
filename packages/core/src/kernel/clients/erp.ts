/**
 * The ERP port.
 *
 * The real ERP is two-way and is not the Omie API the repository integrates
 * today, so the port is declared in terms of what the modules need — pull a
 * page of customers, push a write back — and `erp-mock.ts` binds today's
 * Omie adapter (`erp-mock/`, absorbed from `@select-lub/omie` in wave 5.1b)
 * behind it. When the real one arrives it is another adapter, bound at the
 * composition root; no module changes.
 */
import type { OmieAdapter } from "./erp-mock/adapter.js";

/** What `erp/run-pull` and `erp/drain-outbox` are handed. */
export interface ErpPort {
  /** Today's Omie adapter, until the port's own shape is settled in wave 3A. */
  readonly adapter: OmieAdapter;
}

let bound: ErpPort | undefined;

/**
 * Binds the ERP adapter at the composition root.
 *
 * @param port - The adapter to use for this process.
 */
export function bindErp(port: ErpPort): void {
  bound = port;
}

/**
 * The bound ERP port.
 *
 * @throws When nothing was bound — a slice reaching a port the root did not
 *   wire is a wiring bug, and should say so rather than act on a fake.
 */
export function erp(): ErpPort {
  if (!bound) throw new Error("erp port is not bound; call bindErp at the composition root");
  return bound;
}
