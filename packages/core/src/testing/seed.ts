/**
 * Row factories for tests that run inside a test transaction.
 *
 * Every helper writes through the client it is given, so inside
 * `withTestTransaction` the rows vanish with the rollback. Each is idempotent
 * within one transaction for the same explicit identifier, so a test may call
 * a helper twice (for instance once in a shared `beforeEach` and once inline)
 * without tripping a unique constraint.
 *
 * Tests assert on the ids these return, never on absolute counts: a worktree
 * database also holds the pristine base and, usually, the demo seed.
 */
import { randomUUID } from "node:crypto";
import type { DbClient } from "@select-lub/core/db";

function suffix(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

/**
 * Creates a unit.
 *
 * @param tx - Transaction client.
 * @param input - Optional `id` and `name`; both generated when omitted.
 * @returns The unit's id and name.
 */
export async function seedUnit(
  tx: DbClient,
  input: { id?: string; name?: string } = {},
): Promise<{ id: string; name: string }> {
  const id = input.id ?? `t-unit-${suffix()}`;
  const name = input.name ?? `Test unit ${id}`;
  const row = await tx.unit.upsert({
    where: { id },
    create: { id, name },
    update: { name },
    select: { id: true, name: true },
  });
  return row;
}

/**
 * Creates a WhatsApp connection in a unit.
 *
 * @param tx - Transaction client.
 * @param input - The owning `unitId`; optional `instanceName` (generated when
 *   omitted) and `connectionState` (default `CONNECTED`, since most routes
 *   refuse a disconnected channel).
 * @returns The connection's id, instance name and unit id.
 */
export async function seedConnection(
  tx: DbClient,
  input: { unitId: string; instanceName?: string; connectionState?: string },
): Promise<{ id: string; instanceName: string; unitId: string }> {
  const instanceName = input.instanceName ?? `t-instance-${suffix()}`;
  const connectionState = input.connectionState ?? "CONNECTED";
  return tx.whatsAppConnection.upsert({
    where: { instanceName },
    create: { unitId: input.unitId, instanceName, connectionState },
    update: { unitId: input.unitId, connectionState },
    select: { id: true, instanceName: true, unitId: true },
  });
}

/**
 * Creates a CRM user with memberships in the given units.
 *
 * @param tx - Transaction client.
 * @param input - `units` the user belongs to; optional `id` (a UUID, generated
 *   when omitted), `email` and `name`.
 * @returns The user's id, email and the unit ids it is a member of.
 */
export async function seedUser(
  tx: DbClient,
  input: { units: readonly string[]; id?: string; email?: string; name?: string },
): Promise<{ id: string; email: string; unitIds: string[] }> {
  const id = input.id ?? randomUUID();
  const email = input.email ?? `${id}@test.local`;
  const name = input.name ?? `Test user ${id.slice(0, 8)}`;
  await tx.user.upsert({
    where: { id },
    create: { id, email, name },
    update: { email, name },
  });
  await tx.userUnit.deleteMany({ where: { userId: id } });
  if (input.units.length > 0) {
    await tx.userUnit.createMany({
      data: input.units.map((unitId) => ({ userId: id, unitId })),
      skipDuplicates: true,
    });
  }
  return { id, email, unitIds: [...input.units] };
}

/**
 * Creates a conversation on a connection.
 *
 * The conversation's unit is whatever unit the connection belongs to; that is
 * how the Prisma adapters scope it (`whatsappConnection: { unitId }`), and it
 * is the join the in-memory fakes never modelled.
 *
 * @param tx - Transaction client.
 * @param input - The `connectionId`; optional `chatKey` (digits; generated when
 *   omitted), `remoteJid` (derived from the chat key), timestamps.
 * @returns The conversation's id, chat key and connection id.
 */
export async function seedConversation(
  tx: DbClient,
  input: {
    connectionId: string;
    chatKey?: string;
    remoteJid?: string;
    startedAt?: Date;
    lastMessageAt?: Date;
  },
): Promise<{ id: string; chatKey: string; whatsappConnectionId: string }> {
  const chatKey = input.chatKey ?? `5519${randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "0")}`;
  const remoteJid = input.remoteJid ?? `${chatKey}@s.whatsapp.net`;
  const now = new Date();
  return tx.conversation.upsert({
    where: {
      whatsappConnectionId_chatKey: { whatsappConnectionId: input.connectionId, chatKey },
    },
    create: {
      whatsappConnectionId: input.connectionId,
      remoteJid,
      chatKey,
      startedAt: input.startedAt ?? now,
      lastMessageAt: input.lastMessageAt ?? now,
    },
    update: { remoteJid },
    select: { id: true, chatKey: true, whatsappConnectionId: true },
  });
}
