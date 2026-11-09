/**
 * Identifier generation.
 *
 * Prisma's `@default(cuid())` generates ids for rows the ORM inserts. This is
 * for the cases that need one before the insert — an id referenced by a second
 * row written in the same transaction, or an idempotency key.
 */
import { randomUUID } from "node:crypto";

/**
 * A new identifier.
 *
 * @returns A UUID v4. Not a cuid: this is for ids the application mints, and
 *   mixing generators inside one column would make the source ambiguous. Every
 *   column that Prisma defaults keeps defaulting.
 */
export function newId(): string {
  return randomUUID();
}
