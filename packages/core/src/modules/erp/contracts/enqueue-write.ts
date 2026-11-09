/**
 * Queues one write the CRM owes the ERP: the only way anything writes
 * `erp_outbox`.
 *
 * Enqueueing is a request to a transport, so it is a contract function rather
 * than an event (design D7). The first caller is `customers` (4B), when a
 * shared field changes; until then nothing enqueues, and `drain-outbox` is
 * exported but not registered. `services` writes nothing back: its only service
 * rows come FROM the ERP (W3-C8).
 *
 * The row is sized to today's only write-back, the sync engine's per-field
 * `put(erpRecordId, fields, integrationCode)`. `versions` carries the
 * field-sync versions the write was computed from, so the enqueuing module can
 * later mark the fields synced only if nothing moved while the row waited.
 */
import type { CrmFieldValue } from "../../../kernel/clients/erp-mock.js";
import type { OmieSharedFieldKey } from "../../../shared/web/omie-field-keys.js";
import type { Db } from "../../../kernel/db.js";

/** The field-sync versions one field's value was read at. */
export type FieldVersions = { localVersion: number; externalVersion: number };

/** One write for the ERP. */
export type ErpWrite = {
  /** Which CRM row changed. `erp_outbox_entity_check` allows these two. */
  entity: "customer" | "vehicle";
  entityId: string;
  /** The ERP record the write goes to: today the customer's Omie id, for vehicle fields too. */
  erpRecordId: string;
  /** Omie's `codigo_cliente_integracao`, when the write links by CRM id. */
  integrationCode?: string | null;
  /** The values to push, keyed by shared field. */
  fields: Partial<Record<OmieSharedFieldKey, CrmFieldValue>>;
  /** The versions each field was read at. */
  versions?: Partial<Record<OmieSharedFieldKey, FieldVersions>> | null;
  /**
   * Makes the enqueue idempotent: a second call with the same key returns the
   * first row and writes nothing.
   */
  idempotencyKey?: string | null;
};

/** The queued row, as the enqueuer needs to know it. */
export type QueuedErpWrite = { id: string; status: string; created: boolean };

/**
 * Queues one ERP write.
 *
 * @param db - The database handle; the insert runs in its own `erp` transaction.
 * @param write - What to push, and where.
 * @returns The row's id and status, and whether this call created it.
 */
export async function enqueueErpWrite(db: Db, write: ErpWrite): Promise<QueuedErpWrite> {
  const data = {
    entity: write.entity,
    entityId: write.entityId,
    erpRecordId: write.erpRecordId,
    integrationCode: write.integrationCode ?? null,
    fields: write.fields,
    versions: write.versions ?? undefined,
    idempotencyKey: write.idempotencyKey ?? null,
  };
  const key = write.idempotencyKey;
  return db.tx("erp", async (tx) => {
    if (!key) {
      const row = await tx.erpOutbox.create({ data, select: { id: true, status: true } });
      return { ...row, created: true };
    }
    // ON CONFLICT DO NOTHING, then read the row by its key. A find-then-create
    // would let two concurrent enqueues both miss, and the loser's insert would
    // abort its transaction on the unique index.
    const inserted = await tx.erpOutbox.createMany({ data: [data], skipDuplicates: true });
    const row = await tx.erpOutbox.findUniqueOrThrow({
      where: { idempotencyKey: key },
      select: { id: true, status: true },
    });
    return { ...row, created: inserted.count === 1 };
  });
}
