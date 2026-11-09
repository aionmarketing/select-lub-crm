/**
 * The reads and writes of `user` and `user_unit` that more than one part of
 * accounts needs.
 *
 * Two slices share them — `create-user` inserts a profile and sets its units,
 * `set-user-units` reads a profile and replaces its units — and so does the
 * authentication hook, which still lives in `apps/api` (wave 2 correction
 * W2-C1) and reads the caller's profile and memberships on every request.
 *
 * The query functions take the transaction client rather than a `Db`, so a
 * slice can run several of them inside the one `db.tx("accounts", …)` that
 * makes its work atomic. {@link createCallerDirectory} is the other way in: it
 * wraps the hook's two reads in one `db.tx` for a caller that is not a slice.
 *
 * Moved from `apps/api/src/auth/prisma.ts` and `auth/store.ts`. Each read now
 * names its columns with `select`, so a column added to `user` later cannot
 * reach a caller by accident. `replaceUnitIds` lost its own `runInTransaction`:
 * atomicity now comes from the caller's `db.tx`, which is one transaction.
 */
import type { Db, DbClient } from "../../../kernel/db.js";

/** A CRM profile, keyed by the identity provider's user id. */
export type CrmUser = { id: string; email: string; name: string };

/**
 * Loads the CRM profile for an identity-provider user.
 *
 * @param tx - The transaction client, under the accounts role.
 * @param id - The identity provider's user id, not the e-mail.
 * @returns The profile, or `null` when no `user` row exists for that id.
 */
export async function findCrmUser(tx: DbClient, id: string): Promise<CrmUser | null> {
  return tx.user.findUnique({
    where: { id },
    select: { id: true, email: true, name: true },
  });
}

/**
 * Lists the units a user belongs to.
 *
 * @param tx - The transaction client, under the accounts role.
 * @param userId - The identity provider's user id.
 * @returns Unit ids, in no promised order; empty when the user has none.
 */
export async function listUnitIdsFor(tx: DbClient, userId: string): Promise<string[]> {
  const rows = await tx.userUnit.findMany({ where: { userId }, select: { unitId: true } });
  return rows.map((row) => row.unitId);
}

/**
 * Inserts a CRM profile.
 *
 * @param tx - The transaction client, under the accounts role.
 * @param row - The profile, whose `id` is the one the identity provider returned.
 * @throws Prisma `P2002` when the e-mail or the id is already registered.
 */
export async function insertCrmUser(tx: DbClient, row: CrmUser): Promise<void> {
  await tx.user.create({
    data: { id: row.id, email: row.email, name: row.name },
    select: { id: true },
  });
}

/**
 * A membership list with each unit once, first occurrence kept.
 *
 * `user_unit`'s primary key is (user, unit), so inserting `[a, a]` is a unique
 * violation. A repeated id in a request body is the client's slip, not a
 * conflict, and must not surface as one.
 *
 * @param unitIds - As the client sent them.
 * @returns The same ids, without repeats.
 */
export function distinctUnitIds(unitIds: readonly string[]): string[] {
  return [...new Set(unitIds)];
}

/**
 * Replaces a user's whole membership set.
 *
 * Not atomic on its own: it is a delete then an insert, and relies on the
 * caller's `db.tx` to make the pair one transaction. Repeated ids are collapsed
 * here, so no caller can hit the (user, unit) primary key with its own input.
 *
 * @param tx - The transaction client, under the accounts role.
 * @param userId - Whose memberships are replaced.
 * @param unitIds - The complete new set; any unit not in it is removed.
 */
export async function replaceUnitIds(
  tx: DbClient,
  userId: string,
  unitIds: readonly string[],
): Promise<void> {
  await tx.userUnit.deleteMany({ where: { userId } });
  await tx.userUnit.createMany({
    data: distinctUnitIds(unitIds).map((unitId) => ({ userId, unitId })),
  });
}

/** What the authentication hook knows about its caller from the CRM. */
export type Caller = {
  /** The caller's CRM profile, or `null` when none exists. */
  user: CrmUser | null;
  /** Every unit the caller belongs to; empty when none. */
  unitIds: string[];
};

/** The one read the authentication hook makes about its caller. */
export interface CallerDirectory {
  /** The caller's profile and memberships. */
  loadCaller(id: string): Promise<Caller>;
}

/**
 * The caller read, for the authentication hook in `apps/api`.
 *
 * Profile and memberships are read in **one** `db.tx("accounts", …)`. The hook
 * runs on every authenticated request, and each `db.tx` costs BEGIN,
 * SAVEPOINT, SET ROLE, RELEASE, RESET and COMMIT round trips on top of its
 * queries, so two separate transactions would double that on the API's hottest
 * path. Both are quick reads with nothing external inside, so grouping them
 * holds no transaction open for long.
 *
 * @param db - The handle the composition root bound.
 * @returns The caller read, over `db`.
 */
export function createCallerDirectory(db: Db): CallerDirectory {
  return {
    loadCaller: (id) =>
      db.tx("accounts", async (tx) => ({
        user: await findCrmUser(tx, id),
        unitIds: await listUnitIdsFor(tx, id),
      })),
  };
}
