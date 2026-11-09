/**
 * The attendant's stored fill volumes (`quotes/oil-attendant-fill`, background-oil-research D24):
 * a volume typed on a missing-volume quote and kept with "Guardar para este modelo", per identity.
 *
 * Insert-only: a later value is a new row, and the latest row per identity is the one read, so
 * every value typed stays auditable. It is a human input, never a cited source: the row carries no
 * publisher, document, page, URL or excerpt, and storing it writes nothing else — not the
 * compatibility cache, not a grade source, not research. Research never reads this table; only
 * the quote does, while the identity's latest cache row has no usable liters.
 */
import { randomUUID } from "node:crypto";
import type { DbClient } from "@select-lub/core/db";
import { identityKey, type IdentityFields } from "../research/identity-key.js";
import type { ResearchIdentity } from "../research/enqueue.js";

/** One stored volume, with its author's display name. */
export type AttendantFillRow = {
  id: string;
  identityKey: string;
  liters: number;
  recordedByUserId: string;
  /** The user's display name, read from `user.name`. */
  recordedBy: string;
  recordedAt: Date;
};

/** The port. Each call runs on whatever client it is handed (a `db.tx("quotes", …)` in a slice). */
export type AttendantFillStore = {
  /**
   * Inserts one volume for the identity; never updates or deletes a row.
   *
   * @param input.liters - The in-service volume, already validated (> 0, at most two decimals).
   * @param input.recordedByUserId - The session user.
   */
  insert(input: { identity: ResearchIdentity; liters: number; recordedByUserId: string; recordedAt?: Date }): Promise<AttendantFillRow>;
  /**
   * The latest volume stored for the identity: the newest `recorded_at`, then the greater id.
   *
   * @returns The row, or null when none was kept or the identity is incomplete.
   */
  latest(identity: IdentityFields): Promise<AttendantFillRow | null>;
};

const SELECT = {
  id: true,
  identityKey: true,
  liters: true,
  recordedByUserId: true,
  recordedAt: true,
  recordedBy: { select: { name: true } },
} as const;

type Selected = {
  id: string;
  identityKey: string;
  liters: { toNumber(): number };
  recordedByUserId: string;
  recordedAt: Date;
  recordedBy: { name: string };
};

function rowOf(row: Selected): AttendantFillRow {
  return {
    id: row.id,
    identityKey: row.identityKey,
    liters: row.liters.toNumber(),
    recordedByUserId: row.recordedByUserId,
    recordedBy: row.recordedBy.name,
    recordedAt: row.recordedAt,
  };
}

/**
 * The Postgres adapter, over `oil_attendant_fill`.
 *
 * @param tx - The client: under `db.tx("quotes", …)` every query carries the `quotes` role.
 */
export function createPrismaAttendantFillStore(tx: DbClient): AttendantFillStore {
  return {
    async insert({ identity, liters, recordedByUserId, recordedAt }) {
      const key = identityKey(identity);
      if (!key) throw new Error("oil attendant fill: an incomplete identity has nothing to key a volume by");
      const row = await tx.oilAttendantFill.create({
        data: {
          id: randomUUID(),
          identityKey: key,
          make: identity.make,
          year: identity.year,
          model: identity.model,
          version: identity.version,
          liters,
          recordedByUserId,
          ...(recordedAt ? { recordedAt } : {}),
        },
        select: SELECT,
      });
      return rowOf(row);
    },
    async latest(identity) {
      const key = identityKey(identity);
      if (!key) return null;
      const row = await tx.oilAttendantFill.findFirst({
        where: { identityKey: key },
        orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
        select: SELECT,
      });
      return row ? rowOf(row) : null;
    },
  };
}
